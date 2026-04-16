import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { resolveTools, describeTool, exists, pythonModuleAvailable, PYTHON } from './tools.js';
import { extractAudio, transcribe, probeDuration } from './transcribe.js';
import { beautify } from './beautify.js';
import { synthesizeAndSchedule } from './tts.js';
import { writeSrt } from './srt.js';
import { remux } from './remux.js';
import { getVariant } from './variants.js';

export const PIPELINE_DEFAULTS = {
  whisperModel: process.env.WHISPER_MODEL || 'small.en',
  language: 'en',
  llmModel: process.env.LLM_MODEL || 'gemma-4-e4b-it-8bit',
  llmUrl: process.env.LLM_URL || 'http://localhost:11433/v1',
  variant: 'final',
};

export async function checkPrereqs(opts) {
  const problems = [];
  const tools = await resolveTools();

  if (!tools.ffmpeg) problems.push('missing binary: ffmpeg');
  if (!tools.ffprobe) problems.push('missing binary: ffprobe');
  if (!tools.whisper) problems.push('missing: openai-whisper (neither `whisper` CLI nor `python -m whisper`)');

  if (!(await exists(PYTHON))) {
    problems.push(`missing python at ${PYTHON} (override with PYTHON_BIN env var)`);
  } else {
    const [hasMlx, hasPytorch] = await Promise.all([
      pythonModuleAvailable(PYTHON, 'f5_tts_mlx'),
      pythonModuleAvailable(PYTHON, 'f5_tts'),
    ]);
    if (!hasMlx && !hasPytorch) {
      problems.push('missing F5-TTS backend: install f5-tts-mlx (Mac) or f5-tts (Linux/CUDA)');
    }
  }

  const variant = getVariant(opts.variant);
  const voiceWav = path.resolve('models/voices', `${variant.voiceName}.wav`);
  const voiceTxt = path.resolve('models/voices', `${variant.voiceName}.txt`);
  if (!(await exists(voiceWav))) {
    problems.push(`missing voice reference for variant=${opts.variant}: ${voiceWav}`);
  }
  if (!(await exists(voiceTxt))) {
    problems.push(`missing voice transcript for variant=${opts.variant}: ${voiceTxt}`);
  }

  try {
    const res = await fetch(`${opts.llmUrl.replace(/\/$/, '')}/models`);
    if (!res.ok) {
      problems.push(`LLM server at ${opts.llmUrl} returned ${res.status}`);
    } else {
      const data = await res.json();
      const ids = (data.data || []).map((m) => m.id);
      if (!ids.includes(opts.llmModel)) {
        problems.push(`LLM server does not serve model "${opts.llmModel}" (has: ${ids.join(', ')})`);
      }
    }
  } catch (err) {
    problems.push(`cannot reach LLM server at ${opts.llmUrl}: ${err.message}`);
  }

  return { tools, problems };
}

export function describePrereqs(tools, opts) {
  return [
    `  ffmpeg:  ${describeTool(tools.ffmpeg)}`,
    `  ffprobe: ${describeTool(tools.ffprobe)}`,
    `  whisper: ${describeTool(tools.whisper)}`,
    `  python:  ${PYTHON}`,
    `  LLM:     ${opts.llmUrl}  model=${opts.llmModel}`,
  ].join('\n');
}

export async function processFile({ inputPath, opts, tools, onProgress }) {
  const emit = (stage, message, extra = {}) => {
    if (onProgress) onProgress({ stage, message, ...extra });
  };

  const abs = path.resolve(inputPath);
  if (!(await exists(abs))) {
    throw new Error(`input not found: ${abs}`);
  }

  const variant = getVariant(opts.variant);
  const base = path.basename(abs, path.extname(abs));
  const workDir = path.resolve('out', base);
  const variantDir = path.join(workDir, variant.suffix);
  await mkdir(variantDir, { recursive: true });

  emit('start', `=== ${base} [variant=${variant.suffix}] ===`, { base, variant: variant.suffix });

  const audioWav = path.join(workDir, 'audio.wav');
  emit('extract', '[1/6] extracting audio');
  await extractAudio({
    ffmpeg: tools.ffmpeg,
    inputPath: abs,
    outputWavPath: audioWav,
  });

  emit('transcribe', '[2/6] transcribing');
  const { words, rawSegments } = await transcribe({
    whisper: tools.whisper,
    wavPath: audioWav,
    outputDir: workDir,
    model: opts.whisperModel,
    language: opts.language,
  });
  await writeSrt(path.join(workDir, 'raw.srt'), rawSegments);
  emit('transcribe', `       ${words.length} words, ${rawSegments.length} raw segments`);

  if (words.length === 0) {
    throw new Error('transcription produced zero words');
  }

  emit('beautify', `[3/6] beautifying via LLM (${variant.suffix}, model=${opts.llmModel}${variant.chunkSize ? `, chunkSize=${variant.chunkSize}` : ''})`);
  const beautified = await beautify({
    words,
    llmUrl: opts.llmUrl,
    llmModel: opts.llmModel,
    systemPrompt: variant.systemPrompt,
    chunkSize: variant.chunkSize,
    validate: variant.validate,
    maxSentenceWords: variant.maxSentenceWords,
    cachePath: path.join(variantDir, 'beautified.json'),
    force: opts.force,
  });
  emit('beautify', `       ${beautified.length} sentences`);

  const srtPath = path.join(variantDir, 'beautified.srt');

  emit('synth', `[4/6] synthesizing voice (f5 voice=${variant.voiceName}, lengthScale=${variant.lengthScale})`);
  const videoDuration = await probeDuration(tools.ffprobe, abs);
  const voiceWav = path.join(variantDir, 'voice.wav');
  const { updatedSegments, totalVoiceDuration } = await synthesizeAndSchedule({
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    segments: beautified,
    segDir: path.join(variantDir, 'voice'),
    lengthScale: variant.lengthScale,
    voiceName: variant.voiceName,
    voiceRefDir: path.resolve('models/voices'),
    outputWav: voiceWav,
  });
  await writeSrt(srtPath, updatedSegments);
  const freezeExtendSeconds = Math.max(0, totalVoiceDuration - videoDuration);
  emit('synth', `       video=${videoDuration.toFixed(1)}s voice=${totalVoiceDuration.toFixed(1)}s extend=${freezeExtendSeconds.toFixed(1)}s`);

  emit('mux', '[5/6] final mux');
  const outputPath = path.join(workDir, `${base}.${variant.suffix}.mp4`);
  await remux({
    ffmpeg: tools.ffmpeg,
    videoPath: abs,
    voiceWav,
    srtPath,
    outputPath,
    freezeExtendSeconds,
    force: opts.force,
  });

  emit('done', `[6/6] done -> ${path.relative(process.cwd(), outputPath)}`, { outputPath });
  return { outputPath };
}
