import { spawn } from 'node:child_process';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { exists } from './tools.js';
import { sanitizeForMlx, splitForF5 } from './tts-f5.js';

// PyTorch backend for F5-TTS — used when running outside macOS (e.g. Linux Docker).
// Wraps the `f5-tts_infer-cli` binary (installed by `pip install f5-tts`).
//
// Key differences from the MLX path:
//   - PyTorch CLI splits its output into --output_dir + --output_file (basename),
//     while the MLX module takes a single --output filename. We bridge by writing into
//     a temp dir and renaming.
//   - The PyTorch CLI handles multi-sentence input correctly, but we still call
//     `sanitizeForMlx` and `splitForF5` to keep behavior identical across backends —
//     synthesis quality is the same and it removes one source of cross-backend drift.

const F5_CLI = process.env.F5_TTS_CLI || 'f5-tts_infer-cli';

function runCli(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(F5_CLI, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let combined = '';
    proc.stderr.on('data', (d) => { combined += d.toString(); });
    proc.stdout.on('data', (d) => { combined += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(combined);
      else reject(new Error(`${F5_CLI} exited ${code}\n--- last 1500 chars ---\n${combined.slice(-1500)}`));
    });
  });
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

async function synthF5SinglePytorch({ refAudio, refText, text, outputWav, speed }) {
  const sanitized = sanitizeForMlx(text);
  const outDir = path.dirname(outputWav);
  const outName = path.basename(outputWav);
  await mkdir(outDir, { recursive: true });

  const args = [
    '-r', refAudio,
    '-s', refText,
    '-t', sanitized,
    '-o', outDir,
    '-w', outName,
    '--speed', String(speed),
  ];
  await runCli(args);

  if (!(await exists(outputWav))) {
    throw new Error(`f5-tts_infer-cli produced no output at ${outputWav}`);
  }
}

export async function synthF5Pytorch({ refAudio, refText, text, outputWav, speed = 1.0 }) {
  const pieces = splitForF5(text);
  if (pieces.length === 1) {
    await synthF5SinglePytorch({ refAudio, refText, text: pieces[0], outputWav, speed });
    return;
  }

  const outputDir = path.dirname(outputWav);
  const base = path.basename(outputWav, '.wav');
  const partDir = path.join(outputDir, `${base}.parts`);
  await mkdir(partDir, { recursive: true });

  const partPaths = [];
  for (let i = 0; i < pieces.length; i++) {
    const partPath = path.join(partDir, `part_${String(i).padStart(2, '0')}.wav`);
    await synthF5SinglePytorch({ refAudio, refText, text: pieces[i], outputWav: partPath, speed });
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
