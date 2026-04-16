# renarrate

Re-narrate a screen-recording demo in a different voice and personality.

`renarrate` takes a raw `.mov` screen recording, transcribes it with Whisper, rewrites the narration through a local LLM in the style of a chosen *variant* (David Attenborough, Elon Musk, Donald Trump, Morgan Freeman, Samuel L. Jackson, John Wick, Caesar the ape, etc.), re-speaks it with that person's cloned voice via F5-TTS, and remuxes everything into a new MP4 with burned-in subtitles — preserving the original video's pacing.

Runs 100% locally. The F5-TTS backend auto-selects between [**MLX**](https://github.com/lucasnewman/f5-tts-mlx) (Apple Silicon) and [**PyTorch**](https://github.com/SWivid/F5-TTS) (Linux / CUDA), so the same code works on Macs *and* in Docker. Hardware video encoding auto-detects too: `videotoolbox` on Mac, `nvenc` on CUDA, `libx264` fallback.

## Example

```
node process-video.js --variant=god rpa1.mov
```

Produces `out/rpa1/rpa1.god.mp4` — your software demo, narrated by Morgan Freeman.

## Variants

| Variant     | Voice              | Style                                       |
|-------------|--------------------|---------------------------------------------|
| `final`     | David Attenborough | NatGeo documentary narrator                 |
| `god`       | Morgan Freeman     | Solemn, omniscient narrator                 |
| `elon`      | Elon Musk          | Hesitant founder stage-demo with fillers    |
| `trump`     | Donald Trump       | Stage-rally oratory, superlatives           |
| `slj`       | Samuel L. Jackson  | Emphatic, profane, urgent                   |
| `johnwick`  | Keanu Reeves       | Terse, deadly, John Wick deadpan            |
| `caveman`   | Caesar (Ape)       | Broken-English, 3–9 word sentences          |

Each variant is a prompt + voice-reference pair in `lib/variants.js`.

## Install

### macOS (native, MLX backend)

```bash
brew install ffmpeg yt-dlp
pip3 install -U openai-whisper f5-tts-mlx
npm install
```

### Linux / CUDA (PyTorch backend)

```bash
sudo apt install ffmpeg python3 python3-pip
pip install -U openai-whisper f5-tts
npm install
export PYTHON_BIN=/usr/bin/python3
```

### Docker (easiest)

```bash
docker compose up --build
# web UI → http://localhost:8080
```

The compose stack runs the Node app plus an Ollama sidecar, so you get an LLM out of the box. Pull a model into Ollama the first time:

```bash
docker compose exec ollama ollama pull gemma3:4b
```

Renders, uploaded inputs, and voice references are volume-mounted from `./out`, `./uploads`, and `./models/voices`.

### LLM server (native installs)

Native installs also need a local OpenAI-compatible LLM server (default `http://localhost:11433/v1`). Tested with `gemma-4-e4b-it-8bit` on [mlx-omlx](https://github.com/ml-explore/mlx-examples). Avoid reasoning models like Qwen3.5 for this — they burn token budget on chain-of-thought before any JSON is produced.

Startup checks for: `ffmpeg`, `ffprobe`, `openai-whisper`, **either** `f5_tts_mlx` or `f5_tts` Python module, the selected variant's voice reference under `models/voices/<name>.{wav,txt}`, and the LLM server.

## Usage

### CLI

```
node process-video.js --variant=<name> <input.mov> [more...]

Flags:
  --variant=<name>     final | god | elon | trump | slj | johnwick | caveman
  --force              ignore cache, re-run every stage
  --whisper-model=<m>  default small.en
  --llm-model=<id>     override LLM model name
  --llm-url=<url>      override LLM base URL (default http://localhost:11433/v1)
  --language=<code>    default en
```

Outputs are written to `out/<base>/<base>.<variant>.mp4`. Variants coexist for the same input.

### Web UI

```bash
npm run web
# → http://localhost:8080
```

Upload a `.mov`, pick a variant, watch stage-by-stage progress stream in over Server-Sent Events, and download the finished MP4 when it's ready. The UI also has a **Preview** button that synthesizes a short audition clip of any text in the selected voice — handy for comparing variants before committing to a full render. Env vars: `PORT` (default `8080`), `LLM_URL`, `LLM_MODEL`, `WHISPER_MODEL`, `PYTHON_BIN`.

## Adding a new voice

```bash
./scripts/extract-voice.sh <name> <youtube_url> <start_sec> <duration_sec>
```

Downloads via `yt-dlp`, trims with `ffmpeg` to 24 kHz mono, and transcribes with Whisper `small.en`. Hand-edit `models/voices/<name>.txt` if Whisper mis-hears. Keep the clip 8–15s of clean mono speech.

## Adding a new variant

Add an entry to `VARIANTS` in `lib/variants.js`:

```js
mystyle: {
  systemPrompt: MYSTYLE_PROMPT + COMMON_RULES,
  lengthScale: 1.0,        // F5-TTS --speed
  suffix: 'mystyle',       // output filename tag
  chunkSize: 80,           // null = single LLM call; integer = chunked
  voiceName: 'some_voice', // models/voices/<name>.{wav,txt}
},
```

`COMMON_RULES` already enforces the JSON output contract, token-preservation rules, and sentence-index invariants. The prompt only needs to describe the voice and tone.

## Pipeline

```
.mov ─▶ ffmpeg (extract WAV)
     ─▶ Whisper (word-level timestamps)
     ─▶ LLM (resegment + rewrite in variant style)
     ─▶ F5-TTS MLX (clone voice, synthesize per sentence)
     ─▶ schedule sentences to original video pacing
     ─▶ SRT from post-synthesis timings
     ─▶ ffmpeg (remux video + new audio + burned subtitles)
     ─▶ .<variant>.mp4
```

See [`CLAUDE.md`](./CLAUDE.md) for the full stage-by-stage description, cache layout, and known gotchas (F5-TTS MLX duration predictor bug, multi-sentence workaround, LLM JSON truncation handling).

## License

Voice references in `models/voices/` are used for personal experimentation with cloned-voice synthesis. Respect the original speakers' rights and applicable laws before publishing any output.
