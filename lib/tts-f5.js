import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { exists, PYTHON, pythonModuleAvailable } from './tools.js';

// F5-TTS backend dispatcher. At first call, picks MLX (Mac/Apple Silicon) when the
// f5_tts_mlx Python module is importable, otherwise dynamic-imports the PyTorch
// adapter from ./tts-f5-pytorch.js (Linux/Docker). The choice is cached for the
// lifetime of the process.
//
// MLX path constraints discovered empirically:
//  - must pass --estimate-duration true (the neural duration predictor returns ~0s otherwise)
//  - each call must contain a SINGLE sentence — f5-tts-mlx's multi-sentence branch has a
//    compounding duration bug, so we sanitize internal .!?;: to commas before calling.
const F5_MODULE = 'f5_tts_mlx.generate';
const MAX_CHARS_PER_CALL = 90;

let _backend = null;
async function chooseBackend() {
  if (_backend) return _backend;
  const hasMlx = await pythonModuleAvailable(PYTHON, 'f5_tts_mlx');
  if (hasMlx) {
    _backend = { name: 'mlx', synth: synthF5Mlx };
  } else {
    const { synthF5Pytorch } = await import('./tts-f5-pytorch.js');
    _backend = { name: 'pytorch', synth: synthF5Pytorch };
  }
  console.log(`[tts] backend=${_backend.name}`);
  return _backend;
}

export async function synthF5(args) {
  const backend = await chooseBackend();
  return backend.synth(args);
}

function runPythonModule(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, ['-m', F5_MODULE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let combined = '';
    proc.stderr.on('data', (d) => { combined += d.toString(); });
    proc.stdout.on('data', (d) => { combined += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(combined);
      else reject(new Error(`f5-tts-mlx exited ${code}\n--- last 1500 chars ---\n${combined.slice(-1500)}`));
    });
  });
}

// f5-tts-mlx splits on [.!?;:] internally; if it sees >1 terminator it enters a buggy
// multi-sentence path. Replace every .!?;: with a comma and append exactly one trailing `.`.
export function sanitizeForMlx(text) {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const body = trimmed.replace(/[.!?;:]/g, ',').replace(/[,\s]+$/, '');
  return `${body}.`;
}

export function splitForF5(text, maxChars = MAX_CHARS_PER_CALL) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];

  const clauses = [];
  const pieces = trimmed.split(/(?<=[.!?;,:])\s+/);
  let current = '';
  for (const piece of pieces) {
    const candidate = current ? `${current} ${piece}` : piece;
    if (candidate.length > maxChars && current.length > 0) {
      clauses.push(current.trim());
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) clauses.push(current.trim());

  const out = [];
  for (const c of clauses) {
    if (c.length <= maxChars) {
      out.push(c);
      continue;
    }
    const words = c.split(/\s+/);
    let buf = '';
    for (const w of words) {
      const cand = buf ? `${buf} ${w}` : w;
      if (cand.length > maxChars && buf.length > 0) {
        out.push(buf);
        buf = w;
      } else {
        buf = cand;
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${err.slice(-500)}`));
    });
  });
}

export async function loadVoiceRef(voiceDir, voiceName) {
  const audioPath = path.join(voiceDir, `${voiceName}.wav`);
  const textPath = path.join(voiceDir, `${voiceName}.txt`);
  if (!(await exists(audioPath))) {
    throw new Error(`voice reference audio missing: ${audioPath}`);
  }
  if (!(await exists(textPath))) {
    throw new Error(`voice reference text missing: ${textPath}`);
  }
  const refText = (await readFile(textPath, 'utf8')).trim();
  if (refText.length === 0) {
    throw new Error(`voice reference text is empty: ${textPath}`);
  }
  return { refAudio: path.resolve(audioPath), refText };
}

async function synthF5Single({ refAudio, refText, text, outputWav, speed }) {
  const sanitized = sanitizeForMlx(text);
  const args = [
    '--ref-audio', refAudio,
    '--ref-text', refText,
    '--text', sanitized,
    '--output', outputWav,
    '--speed', String(speed),
    '--estimate-duration', 'true',
  ];
  await runPythonModule(args);
  if (!(await exists(outputWav))) {
    throw new Error(`f5-tts-mlx produced no output at ${outputWav}`);
  }
}

async function synthF5Mlx({ refAudio, refText, text, outputWav, speed = 1.0 }) {
  const pieces = splitForF5(text);
  if (pieces.length === 1) {
    await synthF5Single({ refAudio, refText, text: pieces[0], outputWav, speed });
    return;
  }

  const outputDir = path.dirname(outputWav);
  const base = path.basename(outputWav, '.wav');
  const partDir = path.join(outputDir, `${base}.parts`);
  await mkdir(partDir, { recursive: true });

  const partPaths = [];
  for (let i = 0; i < pieces.length; i++) {
    const partPath = path.join(partDir, `part_${String(i).padStart(2, '0')}.wav`);
    await synthF5Single({ refAudio, refText, text: pieces[i], outputWav: partPath, speed });
    partPaths.push(partPath);
  }

  const listPath = path.join(partDir, 'concat.txt');
  const listBody = partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await writeFile(listPath, listBody, 'utf8');
  await runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0',
    '-i', listPath,
    '-c:a', 'pcm_s16le',
    outputWav,
  ]);
}
