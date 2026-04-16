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

async function resolve(binary, pythonModule) {
  if (await which(binary)) return { cmd: binary, prefixArgs: [] };
  if (pythonModule && (await pythonModuleAvailable(PYTHON, pythonModule))) {
    return { cmd: PYTHON, prefixArgs: ['-m', pythonModule] };
  }
  return null;
}

export async function resolveTools() {
  const [ffmpeg, ffprobe, whisper] = await Promise.all([
    which('ffmpeg'),
    which('ffprobe'),
    resolve('whisper', 'whisper'),
  ]);

  return {
    ffmpeg: ffmpeg ? { cmd: 'ffmpeg', prefixArgs: [] } : null,
    ffprobe: ffprobe ? { cmd: 'ffprobe', prefixArgs: [] } : null,
    whisper,
  };
}

export function describeTool(tool) {
  if (!tool) return '(missing)';
  return tool.prefixArgs.length ? `${tool.cmd} ${tool.prefixArgs.join(' ')}` : tool.cmd;
}
