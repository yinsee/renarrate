"""
Video parsing script using Gemma 4 multimodal model (MLX, Apple Silicon).
Model: gemma-4-26b-a4b-it-4bit (local MLX-quantized)

Requirements:
    pip install -U mlx-vlm av Pillow

Usage:
    python parse_video.py <video_path> [prompt]        # human-readable + writes .srt next to video
    python parse_video.py <video_path> --json [prompt] # emits {entries:[{ts,text}], analysis} to stdout
                                                       # (all other prints go to stderr)

Flags (anywhere in argv):
    --interval=<seconds>     frame sampling interval (default 2.0)
    --max-frames=<count>     safety cap to keep VLM context bounded (default 64)
"""

import sys
from pathlib import Path

MODEL_PATH = str(Path.home() / ".omlx/models/gemma-4-26b-a4b-it-4bit")


def log(msg: str):
    """Info log that never collides with JSON stdout."""
    print(msg, file=sys.stderr, flush=True)


def load_model():
    from mlx_vlm import load
    log(f"Loading model from: {MODEL_PATH}")
    model, processor = load(MODEL_PATH)
    log("Model loaded.")
    return model, processor


def extract_frames(video_path: str, interval: float = 2.0, max_frames: int = 64, max_width: int = 1024):
    """
    Sample one frame every `interval` seconds (capped at `max_frames`), burn the
    timestamp onto each, and downscale.

    Returns a list of (PIL.Image, timestamp_seconds) tuples.
    """
    import av
    from PIL import ImageDraw

    container = av.open(video_path)
    video_stream = container.streams.video[0]
    time_base = video_stream.time_base

    duration = None
    if container.duration:
        duration = float(container.duration) / 1_000_000.0
    elif video_stream.duration:
        duration = float(video_stream.duration * time_base)

    sampled = []
    if duration and duration > 0:
        n = min(max_frames, max(1, int(duration // interval) + 1))
        effective = duration / max(1, n - 1) if n > 1 else interval
        log(f"Video ≈ {duration:.2f}s; sampling {n} frame(s) at ~{effective:.2f}s interval (requested={interval}s, cap={max_frames}).")
        for i in range(n):
            target = min(duration - 0.05, i * interval) if n > 1 else 0.0
            target_pts = int(target / float(time_base))
            try:
                container.seek(target_pts, stream=video_stream, backward=True, any_frame=False)
            except Exception:
                container.seek(0)
            chosen = None
            for frame in container.decode(video=0):
                fts = float(frame.pts * time_base) if frame.pts is not None else 0.0
                if fts >= target - 0.1:
                    chosen = (frame.to_image(), fts)
                    break
            if chosen:
                sampled.append(chosen)
    else:
        log(f"Duration unavailable; decoding up to {max_frames} frames linearly.")
        for i, frame in enumerate(container.decode(video=0)):
            if i >= max_frames:
                break
            ts = float(frame.pts * time_base) if frame.pts is not None else float(i)
            sampled.append((frame.to_image(), ts))

    container.close()

    frames = []
    for img, ts in sampled:
        if img.width > max_width:
            ratio = max_width / img.width
            img = img.resize((max_width, int(img.height * ratio)))
        draw = ImageDraw.Draw(img)
        label = f"[{int(ts)//60:02d}:{int(ts)%60:02d}]"
        draw.text((12, 12), label, fill=(0, 0, 0))
        draw.text((10, 10), label, fill=(255, 255, 0))
        frames.append((img, ts))

    log(f"Extracted {len(frames)} frames from '{video_path}'.")
    return frames


def parse_video(video_path: str, prompt: str = None, interval: float = 2.0, max_frames: int = 64):
    """
    Analyze a video file using the local Gemma 4 MLX model.

    Args:
        video_path: Path to the video file.
        prompt: Question or instruction for the model (optional).
        interval: Seconds between sampled frames (default 2.0).
        max_frames: Safety cap for total frames to keep VLM context bounded (default 64).

    Returns:
        str: Model's response.
    """
    import tempfile
    import os
    from mlx_vlm import generate
    from mlx_vlm.prompt_utils import apply_chat_template

    if prompt is None:
        prompt = (
            "You are narrating a screen recording for an audience that cannot see it. "
            "For EACH timestamped frame (the [mm:ss] label burned into the top-left is its time in the video), "
            "write ONE sentence in present tense describing what is happening on screen at that moment. "
            "Output format, exactly one entry per line, no extra commentary:\n"
            "[mm:ss] Short sentence describing what happens at that time.\n"
            "Use the SAME [mm:ss] values visible in each frame. Do not skip frames. "
            "Be specific about UI elements, actions, or content visible."
        )

    frames = extract_frames(video_path, interval=interval, max_frames=max_frames)
    model, processor = load_model()

    # Save frames as temp PNG files — mlx-vlm generate() expects file paths
    tmp_dir = tempfile.mkdtemp()
    frame_paths = []
    for i, (frame, ts) in enumerate(frames):
        path = os.path.join(tmp_dir, f"frame_{i:04d}.png")
        frame.save(path)
        frame_paths.append(path)

    try:
        formatted_prompt = apply_chat_template(
            processor, model.config, prompt, num_images=len(frame_paths)
        )

        log("Running inference...")
        response = generate(
            model,
            processor,
            formatted_prompt,
            image=frame_paths,
            max_tokens=4096,
            verbose=False,
        )
    finally:
        for path in frame_paths:
            os.remove(path)
        os.rmdir(tmp_dir)

    return response


def parse_entries(analysis_text: str):
    """Extract [mm:ss]-prefixed entries into a sorted list of {ts, text} dicts."""
    import re

    # Accept [mm:ss], [mm.ss], [m:ss] — the vision model sometimes emits the frame
    # label with a dot instead of a colon.
    pattern = re.compile(r'\*{0,2}\[(\d{1,2})[:.](\d{1,2})\]\*{0,2}\s+(.*)')
    entries = []
    seen = set()
    for line in analysis_text.split('\n'):
        line = line.strip()
        m = pattern.match(line)
        if not m:
            continue
        mm, ss, text = int(m.group(1)), int(m.group(2)), m.group(3).strip()
        ts = mm * 60 + ss
        # dedupe exact (ts, text) duplicates — the model occasionally emits each line twice
        key = (ts, text)
        if key in seen:
            continue
        seen.add(key)
        entries.append({"ts": ts, "text": text})
    entries.sort(key=lambda e: e["ts"])
    return entries


def generate_srt(analysis_text: str, output_path: str):
    entries = parse_entries(analysis_text)
    if not entries:
        log("No timestamped entries found; skipping SRT generation.")
        return

    def fmt(s):
        h, rem = divmod(s, 3600)
        m, sec = divmod(rem, 60)
        return f"{h:02d}:{m:02d}:{sec:02d},000"

    lead = 2  # show subtitle this many seconds before the action
    srt_lines = []
    for i, e in enumerate(entries):
        ts = e["ts"]
        start = max(0, ts - lead)
        end = ts
        if end <= start:
            end = start + 1
        srt_lines.append(str(i + 1))
        srt_lines.append(f"{fmt(start)} --> {fmt(end)}")
        srt_lines.append(e["text"])
        srt_lines.append('')

    with open(output_path, 'w') as f:
        f.write('\n'.join(srt_lines))

    log(f"SRT written to: {output_path}")


def main():
    usage = "Usage: python parse_video.py <video_path> [--json] [--interval=<sec>] [--max-frames=<n>] [prompt]"
    args = sys.argv[1:]
    if not args:
        print(usage, file=sys.stderr)
        sys.exit(1)

    json_mode = False
    interval = 2.0
    max_frames = 64
    positional = []
    for a in args:
        if a == "--json":
            json_mode = True
        elif a.startswith("--interval="):
            try:
                interval = float(a.split("=", 1)[1])
            except ValueError:
                print(f"Invalid --interval value: {a}", file=sys.stderr)
                sys.exit(1)
        elif a.startswith("--max-frames="):
            try:
                max_frames = int(a.split("=", 1)[1])
            except ValueError:
                print(f"Invalid --max-frames value: {a}", file=sys.stderr)
                sys.exit(1)
        else:
            positional.append(a)

    if not positional:
        print(usage, file=sys.stderr)
        sys.exit(1)

    if interval <= 0:
        print(f"--interval must be positive, got {interval}", file=sys.stderr)
        sys.exit(1)
    if max_frames <= 0:
        print(f"--max-frames must be positive, got {max_frames}", file=sys.stderr)
        sys.exit(1)

    video_path = positional[0]
    prompt = positional[1] if len(positional) > 1 else None

    result = parse_video(video_path, prompt=prompt, interval=interval, max_frames=max_frames)
    analysis = result.text if hasattr(result, 'text') else str(result)

    if json_mode:
        import json
        entries = parse_entries(analysis)
        json.dump({"entries": entries, "analysis": analysis}, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()
        return

    print("\n--- Video Analysis ---")
    print(analysis)

    srt_path = str(Path(video_path).with_suffix('.srt'))
    generate_srt(analysis, srt_path)


if __name__ == "__main__":
    main()
