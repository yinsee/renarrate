import { writeFile } from 'node:fs/promises';

export function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

export function segmentsToSrt(segments) {
  return segments
    .map((seg, i) => {
      const start = formatSrtTime(seg.start);
      const end = formatSrtTime(seg.end);
      const text = seg.text.trim();
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');
}

export async function writeSrt(path, segments) {
  await writeFile(path, segmentsToSrt(segments), 'utf8');
}
