import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, PYTHON, runFfmpeg } from './tools.js';

const MAX_CHARS_PER_CALL = 90;
const WORKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'f5_worker.py');

// --- persistent worker management ---

let _worker = null;
let _workerReady = null;

function getWorker() {
  if (_workerReady) return _workerReady;
  _workerReady = new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [WORKER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });

    const rl = createInterface({ input: proc.stdout });
    let first = true;

    rl.on('line', (line) => {
      if (first) {
        first = false;
        try {
          const msg = JSON.parse(line);
          if (msg.ready) {
            _worker = { proc, rl, pending: [] };
            console.log(`[tts] f5 worker ready, backend=${msg.backend}`);
            resolve(_worker);
          } else {
            reject(new Error(`f5 worker init failed: ${msg.error || line}`));
          }
        } catch {
          reject(new Error(`f5 worker bad init: ${line}`));
        }
        return;
      }
      const cb = _worker.pending.shift();
      if (cb) cb(line);
    });

    proc.on('error', (err) => {
      _workerReady = null;
      _worker = null;
      reject(err);
    });
    proc.on('close', (code) => {
      if (_worker) {
        for (const cb of _worker.pending) {
          cb(JSON.stringify({ ok: false, error: `worker exited ${code}` }));
        }
      }
      _workerReady = null;
      _worker = null;
    });
  });
  return _workerReady;
}

function workerRequest(req) {
  return new Promise(async (resolve, reject) => {
    try {
      const w = await getWorker();
      w.pending.push((line) => {
        try {
          const res = JSON.parse(line);
          if (res.ok) resolve(res);
          else reject(new Error(res.error));
        } catch {
          reject(new Error(`bad worker response: ${line}`));
        }
      });
      w.proc.stdin.write(JSON.stringify(req) + '\n');
    } catch (err) {
      reject(err);
    }
  });
}

export function killWorker() {
  if (_worker) {
    _worker.proc.stdin.end();
    _worker.proc.kill();
    _worker = null;
    _workerReady = null;
  }
}

// --- text preprocessing ---

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

// --- voice reference loading ---

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

// --- synthesis ---

async function synthF5Single({ refAudio, refText, text, outputWav, speed }) {
  const sanitized = sanitizeForMlx(text);
  const res = await workerRequest({
    ref_audio: refAudio,
    ref_text: refText,
    text: sanitized,
    output: outputWav,
    speed,
  });
  if (!(await exists(outputWav))) {
    throw new Error(`f5 worker produced no output at ${outputWav}`);
  }
  return res;
}

export async function synthF5({ refAudio, refText, text, outputWav, speed = 1.0 }) {
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
  await rm(partDir, { recursive: true, force: true });
}
