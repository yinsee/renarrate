import { mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { resolveTools, describeTool, exists, pythonModuleAvailable, PYTHON } from './tools.js';
import { extractAudio, transcribe, probeDuration } from './transcribe.js';
import { beautify } from './beautify.js';
import { explainVideo } from './explain.js';
import { synthesizeAndSchedule } from './tts.js';
import { writeSrt } from './srt.js';
import { remux } from './remux.js';
import { getVariant } from './variants.js';
import { getLanguage } from './languages.js';

export const PIPELINE_DEFAULTS = {
  language: 'en',
  outputLanguage: 'en',
  llmModel: process.env.LLM_MODEL || 'gemma-4-e4b-it-8bit',
  llmUrl: process.env.LLM_URL || 'http://localhost:11433/v1',
  variant: 'natgeo',
  explain: false,
  explainInterval: 2,
  explainMaxFrames: 64,
  slowVideo: false,
};

export async function checkPrereqs(opts) {
  const problems = [];
  const tools = await resolveTools();

  if (!tools.ffmpeg) problems.push('missing binary: ffmpeg');
  if (!tools.ffprobe) problems.push('missing binary: ffprobe');
  if (!opts.explain && !tools.whisperCpp) {
    problems.push('missing whisper.cpp: brew install whisper-cpp (or build from source), then place ggml-small.en.bin in models/whisper-cpp/');
  }

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
    if (opts.explain) {
      const [hasVlm, hasAv] = await Promise.all([
        pythonModuleAvailable(PYTHON, 'mlx_vlm'),
        pythonModuleAvailable(PYTHON, 'av'),
      ]);
      if (!hasVlm || !hasAv) {
        problems.push('explain mode needs: pip install -U mlx-vlm av Pillow');
      }
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
    `  whisper: ${tools.whisperCpp.cli} (model=${tools.whisperCpp.model})`,
    `  hwaccel: ${tools.hwaccel?.name || 'libx264'} (encoder=${tools.hwaccel?.encoder || 'libx264'})`,
    `  python:  ${PYTHON}`,
    `  LLM:     ${opts.llmUrl}  model=${opts.llmModel}`,
  ].join('\n');
}

// sha256-hash the file contents to a stable short id. Matches the web server's
// upload-dedup scheme, so CLI and web share out/<hash>/ caches for the same bytes.
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex').slice(0, 12)));
  });
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
  const outputLanguage = getLanguage(opts.outputLanguage || 'en');
  const langTag = outputLanguage.code === 'en' ? '' : outputLanguage.code;
  const explainTag = opts.explain ? 'explain' : '';
  const slowTag = opts.slowVideo ? 'slow' : '';
  const base = path.basename(abs, path.extname(abs));
  const hash = await hashFile(abs);
  const workDir = path.resolve('out', hash);
  // variantDir only varies by inputs that affect stages 3-5 (beautify/synth/srt),
  // so slowTag is intentionally omitted here — stretching happens only at mux time.
  const variantDirParts = [variant.suffix, langTag, explainTag].filter(Boolean);
  const variantDir = path.join(workDir, variantDirParts.join('-'));
  await mkdir(variantDir, { recursive: true });

  const outputSuffixParts = [variant.suffix, langTag, explainTag, slowTag].filter(Boolean);
  const outputPath = path.join(workDir, `${base}.${outputSuffixParts.join('.')}.mp4`);

  const stageLabelParts = [variant.suffix];
  if (langTag) stageLabelParts.push(`lang=${langTag}`);
  if (explainTag) stageLabelParts.push('explain');
  if (slowTag) stageLabelParts.push('slow');
  const stageLabel = stageLabelParts.join(', ');

  if (!opts.force && (await exists(outputPath))) {
    emit('start', `=== ${base} (${hash}) [${stageLabel}] === (cached)`, { base, hash, variant: variant.suffix, outputLanguage: outputLanguage.code, explain: !!opts.explain });
    emit('mux', `output exists, skipping -> ${path.relative(process.cwd(), outputPath)}`, { outputPath });
    return { outputPath };
  }

  emit('start', `=== ${base} (${hash}) [${stageLabel}] ===`, { base, hash, variant: variant.suffix, outputLanguage: outputLanguage.code, explain: !!opts.explain });

  let words;
  let rawSegments;

  if (opts.explain) {
    const explainInterval = Number(opts.explainInterval) || PIPELINE_DEFAULTS.explainInterval;
    const explainMaxFrames = Number(opts.explainMaxFrames) || PIPELINE_DEFAULTS.explainMaxFrames;
    const explainJson = path.join(workDir, `explain-${explainInterval}s.json`);
    const explainCached = await exists(explainJson);
    emit('extract', `[1/6] parsing video (parse_video.py / gemma-4-vision, ${explainInterval}s interval)${explainCached ? ' (cached)' : ''}`);
    emit('transcribe', `[2/6] converting frames to timestamped narration${explainCached ? ' (cached)' : ''}`);
    ({ words, rawSegments } = await explainVideo({
      videoPath: abs,
      cachePath: explainJson,
      force: opts.force,
      intervalSeconds: explainInterval,
      maxFrames: explainMaxFrames,
    }));
  } else {
    const audioWav = path.join(workDir, 'audio.wav');
    const audioCached = await exists(audioWav);
    emit('extract', `[1/6] extracting audio${audioCached ? ' (cached)' : ''}`);
    if (!audioCached) {
      await extractAudio({
        ffmpeg: tools.ffmpeg,
        inputPath: abs,
        outputWavPath: audioWav,
      });
    }

    const whisperJson = path.join(workDir, 'audio.json');
    const transcribeCached = await exists(whisperJson);
    emit('transcribe', `[2/6] transcribing (whisper.cpp)${transcribeCached ? ' (cached)' : ''}`);
    ({ words, rawSegments } = await transcribe({
      whisperCpp: tools.whisperCpp,
      wavPath: audioWav,
      outputDir: workDir,
      language: opts.language,
    }));
  }

  await writeSrt(path.join(workDir, opts.explain ? 'raw.explain.srt' : 'raw.srt'), rawSegments);
  emit('transcribe', `       ${words.length} words, ${rawSegments.length} raw segments`);

  if (words.length === 0) {
    throw new Error(opts.explain ? 'parse_video produced zero entries' : 'transcription produced zero words');
  }

  emit('beautify', `[3/6] beautifying via LLM (${variant.suffix}, model=${opts.llmModel}${variant.chunkSize ? `, chunkSize=${variant.chunkSize}` : ''}${langTag ? `, lang=${langTag}` : ''})`);
  const beautified = await beautify({
    words,
    llmUrl: opts.llmUrl,
    llmModel: opts.llmModel,
    systemPrompt: variant.systemPrompt,
    chunkSize: variant.chunkSize,
    validate: variant.validate,
    maxSentenceWords: variant.maxSentenceWords,
    outputLanguage,
    explain: !!opts.explain,
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
    onSegment: (i, total, dur, text) => {
      emit('synth', `       [${i + 1}/${total}] ${dur.toFixed(1)}s "${text}"`);
    },
  });
  await writeSrt(srtPath, updatedSegments);
  const overflow = Math.max(0, totalVoiceDuration - videoDuration);
  let freezeExtendSeconds = overflow;
  let videoStretchFactor = 1;
  if (opts.slowVideo && overflow > 0.05 && videoDuration > 0) {
    videoStretchFactor = totalVoiceDuration / videoDuration;
    freezeExtendSeconds = 0;
  }
  const stretchNote = videoStretchFactor !== 1
    ? ` stretch=${videoStretchFactor.toFixed(3)}x`
    : ` extend=${freezeExtendSeconds.toFixed(1)}s`;
  emit('synth', `       video=${videoDuration.toFixed(1)}s voice=${totalVoiceDuration.toFixed(1)}s${stretchNote}`);

  emit('mux', `[5/6] final mux (video=${tools.hwaccel?.name || 'libx264'})`);
  await remux({
    ffmpeg: tools.ffmpeg,
    videoPath: abs,
    voiceWav,
    srtPath,
    outputPath,
    freezeExtendSeconds,
    videoStretchFactor,
    hwaccel: tools.hwaccel,
    force: opts.force,
  });

  emit('mux', `[6/6] done -> ${path.relative(process.cwd(), outputPath)}`, { outputPath });
  return { outputPath };
}
