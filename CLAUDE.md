# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js pipeline that takes a demo screen-recording (`rpa*.mov`), rewrites the spoken narration through a local LLM, re-speaks it with a cloned voice via F5-TTS, and remuxes the result into a new MP4 with burned-in subtitles. Each rewriting "variant" (NatGeo, Caveman, Elon, Trump, God, etc.) is a prompt-plus-voice-reference pair defined in `lib/variants.js`.

Two entry points share the same pipeline module (`lib/pipeline.js`):
- **CLI** — `process-video.js` for batch/interactive runs.
- **Web UI** — `lib/server.js` + `web/index.html` for upload-and-watch in a browser, with live SSE progress.

The TTS backend uses a **persistent Python worker** (`lib/f5_worker.py`) spawned on first synthesis call. The worker loads the F5-TTS model once and processes sentences over a stdin/stdout JSON-lines protocol, auto-selecting between **F5-TTS MLX** (Mac) and **F5-TTS PyTorch** (Linux/Docker) at startup. `lib/tts-f5.js` manages the worker lifecycle.

## Running it

### CLI

```
node process-video.js --variant=<name> <input.mov> [more...]
```

Common flags: `--force` (ignore cache), `--variant=natgeo|johnwick|caveman|elon|trump|god|slj`, `--output-language=en|zh` (EN default; narration is rewritten and synthesized in this language), `--language=en` (whisper *input* transcription language — distinct from output), `--llm-model=<id>`, `--llm-url=http://localhost:11433/v1`.

### Web UI

```
npm run web   # production-style, no reload
npm run dev   # node --watch, auto-restarts on lib/web/process-video.js edits
              # → http://localhost:8080
```

`lib/server.js` is a zero-dependency `node:http` server:
- `GET /` serves `web/index.html` (upload form + variant picker + live log + collapsible preview).
- `GET /variants` returns `{variants: [...]}` from `VARIANTS`.
- `GET /languages` returns `{languages: [{code,name,...}], default}` from `LANGUAGES` in `lib/languages.js`.
- `POST /preview` takes `{text, variant, outputLanguage?}` JSON, runs `beautifyText` + `synthF5`, streams the resulting WAV back with the rewritten text in `X-Rewritten-Text` — lets the UI audition a voice/tone on a short snippet without uploading a video.
- `POST /jobs` takes a multipart upload (`file`, `variant`, `outputLanguage?`). The file is **hashed** (sha256, first 12 chars) and saved as `uploads/<hash>.<ext>`; re-uploading the same bytes skips the write. Returns `{jobId}`. `processFile` runs asynchronously and short-circuits if the cached MP4 already exists (path includes language suffix — see "Pipeline").
- `GET /jobs/:id/events` is a Server-Sent Events stream of `{stage, message, ...}` progress events (same events the CLI prints). Cached events are replayed on reconnect.
- `GET /jobs/:id/output` streams the final MP4 with `Content-Disposition: inline` so the browser plays it in a new tab rather than forcing a download.

Job state is in-memory (`jobs: Map`) and not persisted — single-user, reset on restart. Env vars: `PORT` (default `8080`), plus all the pipeline env vars below.

### Prereqs

Checked at startup by `lib/pipeline.js::checkPrereqs`:
- `ffmpeg`, `ffprobe` on `$PATH`.
- `whisper.cpp`: the `whisper-cli` binary on `$PATH` (or via `WHISPER_CPP_CLI`) **and** a GGML model file — default `models/whisper-cpp/ggml-medium.bin` (multilingual; auto-downloaded from HuggingFace on first run if missing), with legacy fallback to `ggml-small.en.bin` if already on disk. Override with `WHISPER_CPP_MODEL` / `WHISPER_CPP_MODEL_DIR`.
- Python at `PYTHON_BIN` (default `/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13`) importing **either** `f5_tts_mlx` (Mac) **or** `f5_tts` (Linux/CUDA). If neither imports, the run aborts with an install hint for both.
- Variant's voice reference at `models/voices/<voiceName>.{wav,txt}`.
- LLM server reachable at `--llm-url` and serving the configured model (hits `/models`, checks for the ID in the returned list).

`lib/tools.js::detectHwAccel` autodetects encoder — `videotoolbox` on Mac, `h264_nvenc` on CUDA, `libx264` fallback — by grepping `ffmpeg -hwaccels` and `-encoders`. Decode and encode are decided independently.

Environment variables:
- `PYTHON_BIN` — Python binary for F5-TTS and module probes.
- `LLM_URL`, `LLM_MODEL` — defaults `http://localhost:11433/v1` and `gemma-4-e4b-it-8bit`.
- `WHISPER_CPP_CLI`, `WHISPER_CPP_MODEL`, `WHISPER_CPP_MODEL_DIR` — overrides for whisper.cpp binary/model resolution.
- `F5_TTS_CLI` — legacy PyTorch CLI name. The persistent worker no longer uses it.
- `PORT` — web server port.

To add/refresh a voice reference: `./scripts/extract-voice.sh <name> <youtube_url> <start_sec> <duration_sec>` — downloads via yt-dlp, trims with ffmpeg to 24 kHz mono, and transcribes with whisper. Edit `models/voices/<name>.txt` by hand if the transcription mis-hears.

## Pipeline (process-video.js → lib/*)

**Full-pipeline cache short-circuit**: before running any stage, `processFile` checks for `out/<base>/<base>.<variant.suffix>[.<lang>].mp4` (lang suffix omitted for EN); if it exists and `--force` is not set, the entire pipeline is skipped and the cached output path is returned. Combined with hash-based upload filenames from the web UI, this makes re-rendering the same video with a different variant touch only stages 3–6.

Six stages per input file, each cached under `out/<base>/[<variant>[-<lang>]/]` (lang suffix only for non-EN):

1. **extract audio** (`lib/transcribe.js::extractAudio`): ffmpeg → `audio.wav` 16 kHz mono (cached, shared by all variants of the same source).
2. **transcribe** (`lib/transcribe.js::transcribe`): `whisper-cli` (from whisper.cpp) with `-sow -ml 1` flags, which emits one JSON entry per word in `transcription[]`. Output cached at `audio.json` next to `audio.wav`. Returns `{ words: [{start,end,text}], rawSegments }` — word-level timestamps are load-bearing for stage 3. `rawSegments` is only used to write `raw.srt` for debugging.
3. **beautify / resegment** (`lib/beautify.js::beautify`): the LLM is the *sentence boundary decider* as well as the rewriter. Input format is `{note, mustKeep, words:[{i,text}]}`; output is `{"sentences":[{"firstWord","lastWord","text"}]}`. `validateSentences` enforces that sentences cover `[0..N-1]` contiguously with no gaps/overlaps, and `validateMustKeep` rejects output that drops any token extracted by `extractMustKeepTokens` (numbers, percentages, ALL-CAPS acronyms like `OCR`, snake/camelCase identifiers). Long videos are split into `chunkSize`-word chunks with the system prompt re-injected per chunk to stop tone drift; each chunk has 5 escalating retries where the previous failure message is passed back as a correction note (`PREVIOUS ATTEMPT FAILED: ...`). Optional `variant.validate` runs after `validateMustKeep` for variant-specific constraints (e.g. profanity density for `johnwick`). `extractJson` is token-tolerant: it strips `<think>`, `<eos>`, and other chat-template markers, and string-aware-balances unclosed braces because gemma routinely truncates at `]}`. When `outputLanguage.code !== 'en'`, `languagePromptPrefix` is **prepended** to the variant's system prompt (stronger signal than an appendix — Gemma drifts back to English when the directive is only at the tail), and the variant's English-only `validate` is skipped (profanity regexes won't match non-EN text). Per-language `profanityGuidance` (see `lib/languages.js`) is injected so `johnwick`/`slj` use native curse words (e.g. 妈的/操 for ZH) instead of leaving English ones.
4. **synthesize + schedule** (`lib/tts.js::synthesizeAndSchedule` → `lib/tts-f5.js::synthF5`): per sentence, send a request to the persistent F5 worker (`lib/f5_worker.py`). The worker is spawned on first call and stays alive for the Node process lifetime, eliminating the ~10s Python startup + model load overhead per sentence. On Mac the worker uses `f5_tts_mlx` (calling `F5TTS.from_pretrained` + `f5tts.sample` directly); on Linux/Docker it uses `f5_tts.infer.utils_infer` (PyTorch). Both paths go through the *same* `splitForF5` + `sanitizeForMlx` preprocessing in `tts-f5.js` so quality stays identical across platforms. Each chunk is pre-processed by `splitForF5` (≤90-char clauses to keep memory bounded) **and** `sanitizeForMlx` (rewrite every `.!?;:` to a comma, append exactly one terminal `.`) before the call. Multi-chunk outputs are concatenated via ffmpeg concat demuxer. Each synthesized clip's real duration is measured with ffprobe; the final concat demuxer resamples everything to 22050 Hz mono PCM in one pass. Scheduling then places each sentence at `max(cursor, original_start)` — this is why the voice track maintains the original video's pacing but never cuts a word mid-sentence. `lengthScale` becomes F5's `--speed`. The returned `updatedSegments` carry the *new* (post-synthesis) start/end times for the SRT.
5. **SRT** (`lib/srt.js`): written from `updatedSegments`, not from the LLM-rewrite boundaries.
6. **remux** (`lib/remux.js::remux`): single ffmpeg call maps the original video + synthesized voice + burns the SRT with `force_style='Alignment=2,MarginV=40,FontName=Helvetica,FontSize=11,...,BorderStyle=4'` (bottom-center, translucent box background). When the synthesized narration is longer than the source video, `freezeExtendSeconds` applies `tpad=stop_mode=clone` before the subtitles filter to hold the last frame for the overflow. The encoder/decoder is whichever `detectHwAccel` picked at startup — `h264_videotoolbox` on Mac (`-q:v 65 -allow_sw 1`), `h264_nvenc` on CUDA (`-rc vbr -cq 20 -preset p4`), or software `libx264` (`-crf 20 -preset medium`).

Outputs are named `out/<base>/<base>.<variant.suffix>[.<lang>].mp4` so variants and languages coexist side-by-side.

`lib/pipeline.js::processFile` is the entry point both `process-video.js` and `lib/server.js` call. It emits progress events through an `onProgress({stage, message, ...})` callback — the CLI prints each `message`, the web server forwards them into the SSE stream. Keep new stages in `processFile` so both entry points pick them up.

## Docker

`Dockerfile` + `docker-compose.yml` run the web UI with an Ollama sidecar:

```
docker compose up --build
# → http://localhost:8080
```

- Image is `node:20-bookworm-slim` with `ffmpeg`, `python3`, and **PyTorch** `f5-tts` installed via pip (`--break-system-packages`). MLX does not run in Linux containers — the container always uses the PyTorch backend (still through the persistent `f5_worker.py`).
- `whisper.cpp` is built from source in the Dockerfile (`cmake` → `whisper-cli` binary at `/usr/local/bin/whisper-cli`). The GGML model file is **not** baked in — it's bind-mounted from the host via `./models/whisper-cpp`, so the host controls which model is active.
- `out/`, `models/voices/`, `models/whisper-cpp/`, and `uploads/` are mounted from the host so renders, voice refs, and whisper models survive container rebuilds.
- The `ollama` sidecar serves the LLM on `:11434`, with its own volume for model storage. Defaults: `LLM_URL=http://ollama:11434/v1`, `LLM_MODEL=gemma3:4b` — override via compose environment.
- Inside the container, `PYTHON_BIN=/usr/bin/python3` (not the Mac framework path). Docker intentionally does **not** hot-reload — `npm run dev` is host-only.

## Adding a new variant

Drop an entry into `VARIANTS` in `lib/variants.js`:

```js
mystyle: {
  systemPrompt: MYSTYLE_PROMPT + COMMON_RULES,  // COMMON_RULES provides the sentences[] JSON schema contract
  lengthScale: 1.0,                              // F5 --speed
  suffix: 'mystyle',                             // goes in output filename
  chunkSize: 80,                                 // null = single LLM call, integer = chunked
  validate: optionalValidator,                   // optional; throws to trigger retry
  voiceName: 'some_voice',                       // must match models/voices/<name>.{wav,txt}
},
```

`COMMON_RULES` (the tail appended to every prompt) already spells out the JSON output contract, the contiguous-index rule, the mustKeep contract, and the "preserve numbers/technical terms" rule. New prompts only need to describe the voice/tone.

## Non-obvious gotchas

- **f5-tts-mlx duration predictor is broken**: without `--estimate-duration true`, the neural duration predictor returns ~0.04s per call and the output is silence. `synthF5Single` always passes `--estimate-duration true`. Do not remove it.
- **f5-tts-mlx multi-sentence path is broken**: when `f5_tts_mlx.generate.split_sentences()` sees more than one of `[.!?;:]` in the input, it enters a per-sentence loop where the duration estimator uses the *full* text length on every iteration, producing absurdly long compounded audio. `sanitizeForMlx()` works around this by replacing internal terminators with commas and ensuring exactly one trailing `.`. Always call `sanitizeForMlx` before passing text to f5-tts-mlx.
- **F5 worker is persistent and must be killed**: `lib/f5_worker.py` is spawned once by `tts-f5.js` and stays alive, keeping the Node event loop open. CLI callers must call `killWorker()` after processing is done (see `process-video.js`). The web server intentionally never kills it. The worker communicates via JSON-lines on stdin/stdout; all library `print()` calls are redirected to stderr so they don't corrupt the protocol. The worker auto-detects MLX vs PyTorch at startup.
- **`splitForF5` (≤90 chars) is still load-bearing**: even on MLX, very long single-call inputs slow generation disproportionately and risk memory issues. Keep the 90-char cap until proven safe to relax.
- **LLM truncation**: gemma-4-e4b-it-8bit on the local omlx server reliably truncates long JSON outputs at `]` and emits an `<eos>` token without closing the outer `}`. The `balanceJson` + special-token strip in `extractJson` handles this. Do not use `Qwen3.5-9B-MLX-4bit` for JSON-structured tasks — it emits reasoning preambles that consume the token budget before any JSON is produced, regardless of `enable_thinking` flags (see auto-memory).
- **Voice reference transcripts are not required to be accurate**. F5-TTS is forgiving. The transcript file exists so F5 can get *approximate* phonemic grounding from the reference audio; slight errors are fine, but obviously wrong transcripts (e.g. the transcriber hallucinated "Thanks for watching!" on a silent ambient clip) produce garbage synthesis.
- **Per-variant cache layout**: stages 1 and 2 (audio extraction + whisper transcription) cache under `out/<base>/` because they're variant- and language-independent. Stages 3-6 (beautify, synth, SRT, mux) cache under `out/<base>/<variant>/` (EN) or `out/<base>/<variant>-<lang>/` (non-EN) so different languages don't clobber each other. The full-MP4 existence check at the top of `processFile` short-circuits all six stages. `--force` bypasses both layers.
- **Subtitle font + CJK**: `lib/remux.js` burns subtitles with `FontName=Helvetica`, which has no CJK glyphs. On macOS libass silently falls back to `PingFang.ttc` (you'll see "Error opening font: PingFangUI.ttc" warnings in ffmpeg output — harmless, those are earlier fallback attempts). On Linux/Docker there is no PingFang, so non-EN subtitles render as tofu boxes. If you need CJK on Linux, bundle a font under `models/fonts/` and pass `fontsdir=<abs path>` to the `subtitles=` filter, then switch `FontName` to something with CJK coverage (e.g. `Noto Sans CJK SC`).
- **SSE `done` event ownership**: only the server emits the terminal `{stage:'done', outputUrl}` event. The pipeline uses `emit('mux', ...)` for its final log line to avoid colliding with the server's terminal event, since the web client closes the SSE connection on the first `done` it sees. Don't change the pipeline back to emitting `done` without also updating the client.
- **johnwick was previously called vulgar**. Any stale `vulgar/` directories under `out/` are from before the rename and can be deleted. Similarly, `humor` was removed — stale `humor/` dirs can go.
- **Piper and the old per-call Python spawn are gone**. No `piper-tts`, `--piper-model`, `models/piper/`, `tts-f5-pytorch.js`, or per-sentence `python -m f5_tts_mlx.generate` subprocesses. Everything goes through `lib/f5_worker.py`.
