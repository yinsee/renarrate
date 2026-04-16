import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

// Override with PYTHON_BIN for non-Mac environments (e.g. Linux container uses /usr/bin/python3).
export const PYTHON = process.env.PYTHON_BIN || '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13';

export async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

export function runTool(tool, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(tool.cmd, [...tool.prefixArgs, ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
      ...opts,
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${tool.cmd} exited with code ${code}`));
    });
  });
}

function which(cmd) {
  return new Promise((resolve) => {
    const proc = spawn('which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    proc.on('error', () => resolve(null));
  });
}

export function pythonModuleAvailable(python, mod) {
  return new Promise((resolve) => {
    const proc = spawn(python, ['-c', `import ${mod}`], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function captureCmd(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => resolve(out));
    proc.on('error', () => resolve(''));
  });
}

// Auto-detect the best hwaccel combo ffmpeg was built with.
// Preference order: Apple videotoolbox > NVIDIA cuda/nvenc > software libx264.
// Decode and encode are decided independently — if hw decode is available but the
// matching hw encoder isn't, we still get the (free) decode speedup and fall back
// to libx264 for the encode.
async function detectHwAccel(ffmpegCmd = 'ffmpeg') {
  const [hwaccels, encoders] = await Promise.all([
    captureCmd(ffmpegCmd, ['-hide_banner', '-hwaccels']),
    captureCmd(ffmpegCmd, ['-hide_banner', '-encoders']),
  ]);
  const hasVtDecode = /\bvideotoolbox\b/.test(hwaccels);
  const hasVtEncode = /h264_videotoolbox/.test(encoders);
  const hasCudaDecode = /\bcuda\b/.test(hwaccels);
  const hasNvenc = /h264_nvenc/.test(encoders);

  let decodeArgs = [];
  let encoder = 'libx264';
  let qualityArgs = ['-crf', '20', '-preset', 'medium'];
  let name = 'libx264';

  if (hasVtDecode) decodeArgs = ['-hwaccel', 'videotoolbox'];
  else if (hasCudaDecode) decodeArgs = ['-hwaccel', 'cuda'];

  if (hasVtEncode) {
    encoder = 'h264_videotoolbox';
    // h264_videotoolbox's -q:v range is 0-100 (higher = better). 65 ≈ CRF 20 visually
    // for a screen recording. -allow_sw 1 lets it fall back to software if the hw
    // encoder rejects the stream for any reason.
    qualityArgs = ['-q:v', '65', '-allow_sw', '1'];
    name = 'videotoolbox';
  } else if (hasNvenc) {
    encoder = 'h264_nvenc';
    qualityArgs = ['-rc', 'vbr', '-cq', '20', '-preset', 'p4'];
    name = 'nvenc';
  }

  return { name, decodeArgs, encoder, qualityArgs };
}

async function downloadWhisperModel(modelPath) {
  const { createWriteStream } = await import('node:fs');
  const { mkdir, rename } = await import('node:fs/promises');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const path = await import('node:path');

  const name = path.basename(modelPath);
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${name}`;
  await mkdir(path.dirname(modelPath), { recursive: true });
  process.stderr.write(`[whisper] downloading ${name} from ${url}\n`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const tmp = `${modelPath}.downloading`;
  const file = createWriteStream(tmp);
  let loaded = 0;
  let lastPct = -1;
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (chunk) => {
    loaded += chunk.length;
    if (total) {
      const pct = Math.floor((loaded / total) * 100);
      if (pct !== lastPct) {
        process.stderr.write(`\r[whisper] ${(loaded / 1e6).toFixed(1)}MB / ${(total / 1e6).toFixed(1)}MB (${pct}%)`);
        lastPct = pct;
      }
    }
  });
  await pipeline(stream, file);
  process.stderr.write('\n');
  await rename(tmp, modelPath);
}

async function resolveWhisperCpp() {
  const cliEnv = process.env.WHISPER_CPP_CLI;
  const cli = cliEnv || (await which('whisper-cli'));
  if (!cli) return null;
  const modelEnv = process.env.WHISPER_CPP_MODEL;
  const modelDir = process.env.WHISPER_CPP_MODEL_DIR || 'models/whisper-cpp';

  let model;
  if (modelEnv) {
    model = modelEnv;
  } else {
    const preferred = `${modelDir}/ggml-medium.bin`;
    const legacy = `${modelDir}/ggml-small.en.bin`;
    if (await exists(preferred)) model = preferred;
    else if (await exists(legacy)) model = legacy;
    else model = preferred;
  }

  if (!(await exists(model))) {
    const path = await import('node:path');
    const name = path.basename(model);
    if (!/^ggml-[a-zA-Z0-9.-]+\.bin$/.test(name)) return null;
    try {
      await downloadWhisperModel(model);
    } catch (err) {
      process.stderr.write(`[whisper] auto-download failed: ${err.message}\n`);
      return null;
    }
  }
  return { cli, model };
}

export async function resolveTools() {
  const [ffmpeg, ffprobe, whisperCpp] = await Promise.all([
    which('ffmpeg'),
    which('ffprobe'),
    resolveWhisperCpp(),
  ]);

  const hwaccel = ffmpeg ? await detectHwAccel('ffmpeg') : null;

  return {
    ffmpeg: ffmpeg ? { cmd: 'ffmpeg', prefixArgs: [] } : null,
    ffprobe: ffprobe ? { cmd: 'ffprobe', prefixArgs: [] } : null,
    whisperCpp,
    hwaccel,
  };
}

export function describeTool(tool) {
  if (!tool) return '(missing)';
  return tool.prefixArgs.length ? `${tool.cmd} ${tool.prefixArgs.join(' ')}` : tool.cmd;
}

export function runFfmpeg(args) {
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
