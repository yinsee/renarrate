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

// whisper.cpp with `-sow -ml 1` emits one entry per WORD in transcription[].
// Each entry: {offsets:{from,to}, text}  (offsets are milliseconds).
// Note: -sow -ml 1 produces contiguous timestamps with no silence gaps, so we
// synthesize debug segments by splitting on sentence-ending punctuation in word text.
// rawSegments is only used to write raw.srt for debugging — the main pipeline works
// from word-level data directly.
function parseWhisperCpp(raw) {
  const words = [];
  for (const seg of raw.transcription || []) {
    const text = (seg.text || '').trim();
    if (!text) continue;
    const start = (seg.offsets?.from ?? 0) / 1000;
    const end = (seg.offsets?.to ?? 0) / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    words.push({ start, end, text });
  }

  const rawSegments = [];
  let curStart = 0;
  let curEnd = 0;
  let curWords = [];
  for (const w of words) {
    if (curWords.length === 0) curStart = w.start;
    curWords.push(w.text);
    curEnd = w.end;
    if (/[.!?]["')\]]*$/.test(w.text)) {
      rawSegments.push({ start: curStart, end: curEnd, text: curWords.join(' ') });
      curWords = [];
    }
  }
  if (curWords.length) {
    rawSegments.push({ start: curStart, end: curEnd, text: curWords.join(' ') });
  }
  return { words, rawSegments };
}

async function runWhisperCpp({ whisperCpp, wavPath, outputDir, language }) {
  const base = path.basename(wavPath, path.extname(wavPath));
  const outBase = path.join(outputDir, base);
  await new Promise((resolve, reject) => {
    const proc = spawn(whisperCpp.cli, [
      '-m', whisperCpp.model,
      '-f', wavPath,
      '-l', language || 'en',
      '-sow', '-ml', '1',
      '-oj', '-of', outBase,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`whisper-cli exited ${code}`))));
  });
}

export async function transcribe({ whisperCpp, wavPath, outputDir, language = 'en' }) {
  if (!whisperCpp) throw new Error('whisper.cpp not configured');
  const base = path.basename(wavPath, path.extname(wavPath));
  const jsonPath = path.join(outputDir, `${base}.json`);

  if (!(await exists(jsonPath))) {
    await runWhisperCpp({ whisperCpp, wavPath, outputDir, language });
  }

  const raw = JSON.parse(await readFile(jsonPath, 'utf8'));
  if (!Array.isArray(raw.transcription)) {
    throw new Error(`unrecognized whisper.cpp output schema in ${jsonPath}`);
  }
  return parseWhisperCpp(raw);
}
