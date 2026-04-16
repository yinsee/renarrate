import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runTool } from './tools.js';
import { probeDuration } from './transcribe.js';
import { synthF5, loadVoiceRef } from './tts-f5.js';

// Must match f5-tts-mlx's native output sample rate. The concat demuxer used below
// does NOT resample mismatched inputs — it concatenates raw packets. If silence is
// generated at a different rate than the TTS clips, every clip ends up time-stretched
// by the rate ratio, drifting voice and SRT out of sync over the length of the video.
const TARGET_SAMPLE_RATE = 24000;

export async function synthesizeAndSchedule({
  ffmpeg,
  ffprobe,
  segments,
  segDir,
  lengthScale = 1.0,
  voiceRefDir,
  voiceName,
  outputWav,
}) {
  if (!voiceName) throw new Error('voiceName is required (F5 voice reference)');
  await rm(segDir, { recursive: true, force: true });
  await mkdir(segDir, { recursive: true });

  const f5Ref = await loadVoiceRef(voiceRefDir, voiceName);

  const scheduled = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segPath = path.join(segDir, `seg_${String(i).padStart(3, '0')}.wav`);
    await synthF5({
      refAudio: f5Ref.refAudio,
      refText: f5Ref.refText,
      text: seg.text,
      outputWav: segPath,
      speed: lengthScale,
    });
    const duration = await probeDuration(ffprobe, segPath);
    scheduled.push({ ...seg, ttsPath: segPath, ttsDuration: duration });
    console.log(`       [${i + 1}/${segments.length}] synth ${duration.toFixed(1)}s`);
  }

  const concatEntries = [];
  let cursor = 0;
  const updatedSegments = [];

  for (let i = 0; i < scheduled.length; i++) {
    const s = scheduled[i];
    const anchor = Math.max(cursor, s.start);
    const gap = anchor - cursor;
    if (gap > 0.01) {
      const silencePath = path.join(segDir, `gap_${String(i).padStart(3, '0')}.wav`);
      await runTool(ffmpeg, [
        '-y',
        '-f', 'lavfi',
        '-i', `anullsrc=r=${TARGET_SAMPLE_RATE}:cl=mono`,
        '-t', gap.toFixed(4),
        '-c:a', 'pcm_s16le',
        silencePath,
      ]);
      concatEntries.push(silencePath);
    }
    concatEntries.push(s.ttsPath);
    const newStart = anchor;
    const newEnd = newStart + s.ttsDuration;
    updatedSegments.push({ start: newStart, end: newEnd, text: s.text });
    cursor = newEnd;
  }

  const listPath = path.join(segDir, 'concat.txt');
  const listBody = concatEntries.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await writeFile(listPath, listBody, 'utf8');

  await runTool(ffmpeg, [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-ar', String(TARGET_SAMPLE_RATE),
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    outputWav,
  ]);

  const totalVoiceDuration = cursor;
  return { updatedSegments, totalVoiceDuration };
}
