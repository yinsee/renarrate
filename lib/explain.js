import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { exists, PYTHON } from './tools.js';

const SCRIPT_PATH = path.resolve('parse_video.py');

// Run parse_video.py in --json mode; stdout is JSON, stderr is forwarded for logs.
function runParseVideo({ pythonBin, videoPath, intervalSeconds, maxFrames }) {
  return new Promise((resolve, reject) => {
    const args = [SCRIPT_PATH, videoPath, '--json', `--interval=${intervalSeconds}`, `--max-frames=${maxFrames}`];
    const proc = spawn(pythonBin, args, {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`parse_video.py exited with code ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch (err) {
        reject(new Error(`parse_video.py returned invalid JSON: ${err.message}\n---\n${out.slice(0, 600)}`));
      }
    });
  });
}

// Spread each entry's text across [entry.ts, nextEntry.ts) as fake word-level timestamps.
// The final entry extends by a 3s tail so it has non-zero duration.
function entriesToWords(entries, tailSeconds = 3) {
  const words = [];
  for (let i = 0; i < entries.length; i++) {
    const start = entries[i].ts;
    const end = i + 1 < entries.length ? entries[i + 1].ts : start + tailSeconds;
    const span = Math.max(0.2, end - start);
    const tokens = String(entries[i].text || '').split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const step = span / tokens.length;
    for (let k = 0; k < tokens.length; k++) {
      words.push({
        start: start + k * step,
        end: start + (k + 1) * step,
        text: tokens[k],
      });
    }
  }
  return words;
}

function entriesToRawSegments(entries, tailSeconds = 3) {
  return entries.map((e, i) => ({
    start: e.ts,
    end: i + 1 < entries.length ? entries[i + 1].ts : e.ts + tailSeconds,
    text: e.text,
  }));
}

export async function explainVideo({
  videoPath,
  cachePath,
  force = false,
  pythonBin = PYTHON,
  intervalSeconds = 2,
  maxFrames = 64,
}) {
  let data;
  if (!force && cachePath && (await exists(cachePath))) {
    data = JSON.parse(await readFile(cachePath, 'utf8'));
  } else {
    data = await runParseVideo({ pythonBin, videoPath, intervalSeconds, maxFrames });
    if (cachePath) await writeFile(cachePath, JSON.stringify(data, null, 2), 'utf8');
  }
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (entries.length === 0) {
    throw new Error('parse_video.py returned no timestamped entries');
  }
  const words = entriesToWords(entries);
  const rawSegments = entriesToRawSegments(entries);
  return { words, rawSegments, entries };
}
