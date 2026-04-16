#!/usr/bin/env node
import process from 'node:process';

import { PIPELINE_DEFAULTS, checkPrereqs, describePrereqs, processFile } from './lib/pipeline.js';
import { VARIANTS } from './lib/variants.js';
import { killWorker } from './lib/tts-f5.js';

function parseArgs(argv) {
  const opts = { ...PIPELINE_DEFAULTS, force: false, inputs: [] };
  for (const arg of argv) {
    if (arg === '--force') opts.force = true;
    else if (arg.startsWith('--llm-model=')) opts.llmModel = arg.split('=')[1];
    else if (arg.startsWith('--llm-url=')) opts.llmUrl = arg.split('=')[1];
    else if (arg.startsWith('--language=')) opts.language = arg.split('=')[1];
    else if (arg.startsWith('--output-language=')) opts.outputLanguage = arg.split('=')[1];
    else if (arg.startsWith('--variant=')) opts.variant = arg.split('=')[1];
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    else opts.inputs.push(arg);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.inputs.length === 0) {
    console.error('usage: node process-video.js <input.mov> [more...]');
    console.error('flags:');
    console.error('  --force');
    console.error(`  --variant=${Object.keys(VARIANTS).join('|')}`);
    console.error('  --output-language=en|zh');
    console.error('  --llm-model=gemma-4-e4b-it-8bit');
    console.error('  --llm-url=http://localhost:11433/v1');
    process.exit(2);
  }

  const { tools, problems } = await checkPrereqs(opts);
  if (problems.length > 0) {
    console.error('\nPrerequisite check failed:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nInstall hints:');
    console.error('  ffmpeg:         brew install ffmpeg');
    console.error('  whisper.cpp:    brew install whisper-cpp (+ download ggml-small.en.bin to models/whisper-cpp/)');
    console.error('  f5-tts-mlx:     pip3 install -U f5-tts-mlx     (Mac)');
    console.error('  f5-tts:         pip install -U f5-tts          (Linux/CUDA)');
    console.error('  voice refs:     ./scripts/extract-voice.sh <name> <url> <start> <duration>');
    process.exit(1);
  }

  console.log('Tools:');
  console.log(describePrereqs(tools, opts));

  const onProgress = ({ message }) => console.log(message);
  for (const input of opts.inputs) {
    console.log('');
    await processFile({ inputPath: input, opts, tools, onProgress });
  }
  killWorker();
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
