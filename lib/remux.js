import path from 'node:path';
import { exists, runTool } from './tools.js';

const FORCE_STYLE = [
  'Alignment=2',
  'MarginV=40',
  'FontName=Helvetica',
  'FontSize=11',
  'PrimaryColour=&H00FFFFFF&',
  'BackColour=&H80000000&',
  'BorderStyle=4',
  'Outline=1',
  'Shadow=0',
].join(',');

const SOFTWARE_HWACCEL = {
  name: 'libx264',
  decodeArgs: [],
  encoder: 'libx264',
  qualityArgs: ['-crf', '20', '-preset', 'medium'],
};

export async function remux({
  ffmpeg,
  videoPath,
  voiceWav,
  srtPath,
  outputPath,
  freezeExtendSeconds = 0,
  hwaccel = SOFTWARE_HWACCEL,
  force = false,
}) {
  if (!force && await exists(outputPath)) return;

  const cwd = path.dirname(srtPath);
  const srtName = path.basename(srtPath);

  const filters = [];
  if (freezeExtendSeconds > 0.05) {
    filters.push(`tpad=stop_mode=clone:stop_duration=${freezeExtendSeconds.toFixed(3)}`);
  }
  filters.push(`subtitles=${srtName}:force_style='${FORCE_STYLE}'`);
  const vf = filters.join(',');

  await runTool(ffmpeg, [
    '-y',
    ...hwaccel.decodeArgs,
    '-i', videoPath,
    '-i', voiceWav,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-vf', vf,
    '-c:v', hwaccel.encoder,
    ...hwaccel.qualityArgs,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    outputPath,
  ], { cwd });
}
