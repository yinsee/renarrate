#!/bin/bash
# Extract a short reference audio clip from a YouTube video for voice cloning.
#
# Usage:
#   scripts/extract-voice.sh <name> <youtube_url> <start_seconds> <duration_seconds>
#
# Example:
#   scripts/extract-voice.sh morgan_freeman https://youtu.be/xxxxx 30 12
#
# Produces:
#   models/voices/<name>.wav       (24 kHz mono, ready for F5-TTS)
#   models/voices/<name>.txt       (whisper transcript of the clip)

set -euo pipefail

if [ $# -ne 4 ]; then
  echo "usage: $0 <name> <youtube_url> <start_seconds> <duration_seconds>" >&2
  exit 2
fi

NAME=$1
URL=$2
START=$3
DURATION=$4

mkdir -p models/voices
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

echo "[1/3] downloading audio from $URL"
yt-dlp -f "bestaudio/best" -x --audio-format wav --audio-quality 0 \
  -o "$TMP/src.%(ext)s" "$URL"

SRC=$(ls "$TMP"/src.wav 2>/dev/null || ls "$TMP"/src.* | head -1)
if [ -z "${SRC:-}" ]; then
  echo "error: yt-dlp produced no file" >&2
  exit 1
fi

echo "[2/3] trimming to ${DURATION}s starting at ${START}s"
ffmpeg -y -ss "$START" -t "$DURATION" -i "$SRC" \
  -ar 24000 -ac 1 -c:a pcm_s16le \
  "models/voices/$NAME.wav" 2>&1 | tail -5

echo "[3/3] transcribing reference with whisper"
python3 -m whisper "models/voices/$NAME.wav" \
  --model small.en --language en \
  --output_format txt \
  --output_dir models/voices \
  --verbose False --fp16 False 2>&1 | tail -3

# whisper writes <name>.txt next to the wav; clean it up
if [ -f "models/voices/$NAME.txt" ]; then
  # Trim whitespace + collapse blank lines
  tr -s ' \n' ' ' < "models/voices/$NAME.txt" > "models/voices/$NAME.txt.tmp"
  mv "models/voices/$NAME.txt.tmp" "models/voices/$NAME.txt"
  echo
  echo "✓ models/voices/$NAME.wav"
  echo "✓ models/voices/$NAME.txt"
  echo "  transcript: $(cat models/voices/$NAME.txt)"
else
  echo "warning: no transcript produced" >&2
fi
