import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exists, runTool } from './tools.js';

export async function extractAudio({ ffmpeg, inputPath, outputWavPath }) {
  if (await exists(outputWavPath)) return;
  await runTool(ffmpeg, [
    '-y', '-i', inputPath,
    '-ac', '1', '-ar', '16000', '-vn',
    outputWavPath,
  ]);
}

export function probeDuration(ffprobe, filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobe.cmd, [
      ...ffprobe.prefixArgs,
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}`));
      const d = parseFloat(out.trim());
      if (!Number.isFinite(d)) return reject(new Error(`ffprobe returned invalid duration: ${out}`));
      resolve(d);
    });
  });
}

export async function transcribe({ whisper, wavPath, outputDir, model = 'small.en', language = 'en' }) {
  const base = path.basename(wavPath, path.extname(wavPath));
  const jsonPath = path.join(outputDir, `${base}.json`);

  if (!(await exists(jsonPath))) {
    await runTool(whisper, [
      wavPath,
      '--model', model,
      '--language', language,
      '--output_format', 'json',
      '--output_dir', outputDir,
      '--word_timestamps', 'True',
      '--verbose', 'False',
      '--fp16', 'False',
    ]);
  }

  const raw = JSON.parse(await readFile(jsonPath, 'utf8'));
  const words = [];
  for (const seg of raw.segments || []) {
    for (const w of seg.words || []) {
      if (w && typeof w.start === 'number' && typeof w.end === 'number' && w.word) {
        words.push({
          start: w.start,
          end: w.end,
          text: w.word.trim(),
        });
      }
    }
  }

  const rawSegments = (raw.segments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));

  return { words, rawSegments };
}
