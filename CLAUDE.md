# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js pipeline that takes a demo screen-recording (`rpa*.mov`), rewrites the spoken narration through a local LLM, re-speaks it with a cloned voice via F5-TTS (MLX backend), and remuxes the result into a new MP4 with burned-in subtitles. Each rewriting "variant" (NatGeo, Caveman, Elon, Trump, God, etc.) is a prompt-plus-voice-reference pair defined in `lib/variants.js`.

## Running it

```
node process-video.js --variant=<name> <input.mov> [more...]
```

Common flags: `--force` (ignore cache), `--variant=final|humor|johnwick|caveman|elon|trump|god|slj`, `--llm-model=<id>`, `--llm-url=http://localhost:11433/v1`.

Prereqs checked at startup: `ffmpeg`, `ffprobe`, `openai-whisper` (CLI or `python3 -m whisper`), the `f5_tts_mlx` Python module importable by `/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13`, the selected variant's voice reference at `models/voices/<voiceName>.{wav,txt}`, and the LLM server at `--llm-url` serving the configured model. Missing prereqs print install hints (pip3 install -U openai-whisper / f5-tts-mlx, brew install ffmpeg yt-dlp) and exit non-zero.

To add/refresh a voice reference: `./scripts/extract-voice.sh <name> <youtube_url> <start_sec> <duration_sec>` — downloads via yt-dlp, trims with ffmpeg to 24 kHz mono, and transcribes with whisper `small.en`. Edit `models/voices/<name>.txt` by hand if whisper mis-hears.

## Pipeline (process-video.js → lib/*)

Six stages per input file, each cached under `out/<base>/[variant/]`:

1. **extract audio** (`lib/transcribe.js::extractAudio`): ffmpeg → `audio.wav` 16 kHz mono (cached, shared by all variants of the same source).
2. **transcribe** (`lib/transcribe.js::transcribe`): openai-whisper with `--word_timestamps True`. Returns `{ words: [{start,end,text}], rawSegments }` — word-level timestamps are load-bearing for stage 3.
3. **beautify / resegment** (`lib/beautify.js::beautify`): the LLM is the *sentence boundary decider* as well as the rewriter. Input format is `{note, mustKeep, words:[{i,text}]}`; output is `{"sentences":[{"firstWord","lastWord","text"}]}`. `validateSentences` enforces that sentences cover `[0..N-1]` contiguously with no gaps/overlaps, and `validateMustKeep` rejects output that drops any token extracted by `extractMustKeepTokens` (numbers, percentages, ALL-CAPS acronyms like `OCR`, snake/camelCase identifiers). Long videos are split into `chunkSize`-word chunks with the system prompt re-injected per chunk to stop tone drift; each chunk has 5 escalating retries where the previous failure message is passed back as a correction note (`PREVIOUS ATTEMPT FAILED: ...`). Optional `variant.validate` runs after `validateMustKeep` for variant-specific constraints (e.g. profanity density for `johnwick`). `extractJson` is token-tolerant: it strips `<think>`, `<eos>`, and other chat-template markers, and string-aware-balances unclosed braces because gemma routinely truncates at `]}`.
4. **synthesize + schedule** (`lib/tts.js::synthesizeAndSchedule` → `lib/tts-f5.js::synthF5`): per sentence, spawn `python3 -m f5_tts_mlx.generate` with the variant's `voiceName` reference (`--ref-audio`, `--ref-text`, `--text`, `--output`, `--speed`, **`--estimate-duration true`**). The MLX backend has two latent bugs (see gotchas) so each chunk is pre-processed by `splitForF5` (≤90-char clauses to keep memory bounded) **and** `sanitizeForMlx` (rewrite every `.!?;:` to a comma, append exactly one terminal `.`) before the call. Multi-chunk outputs are concatenated via ffmpeg concat demuxer. Each synthesized clip's real duration is measured with ffprobe; the final concat demuxer resamples everything to 22050 Hz mono PCM in one pass. Scheduling then places each sentence at `max(cursor, original_start)` — this is why the voice track maintains the original video's pacing but never cuts a word mid-sentence. `lengthScale` becomes f5-tts-mlx's `--speed`. The returned `updatedSegments` carry the *new* (post-synthesis) start/end times for the SRT.
5. **SRT** (`lib/srt.js`): written from `updatedSegments`, not from the LLM-rewrite boundaries.
6. **remux** (`lib/remux.js::remux`): single ffmpeg call maps the original video + synthesized voice + burns the SRT with `force_style='Alignment=2,MarginV=40,FontName=Helvetica,FontSize=11,...,BorderStyle=4'` (bottom-center, translucent box background). When the synthesized narration is longer than the source video, `freezeExtendSeconds` applies `tpad=stop_mode=clone` before the subtitles filter to hold the last frame for the overflow.

Outputs are named `out/<base>/<base>.<variant.suffix>.mp4` so variants coexist.

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
- **Per-call Python import tax**: each sentence pays ~3–5 seconds of Python startup + model load on top of generation time. The PyTorch f5-tts_infer-cli is still installed at `/Library/Frameworks/Python.framework/Versions/3.13/bin/f5-tts_infer-cli` as a fallback, but the active backend is MLX. A persistent-process FastAPI wrapper would eliminate the import tax — not built yet.
- **`splitForF5` (≤90 chars) is still load-bearing**: even on MLX, very long single-call inputs slow generation disproportionately and risk memory issues. Keep the 90-char cap until proven safe to relax.
- **Whisper SSL cert failure**: on this machine, whisper's Python urllib hits `CERTIFICATE_VERIFY_FAILED` when downloading models. Models are pre-downloaded with curl into `~/.cache/whisper/` (e.g. `small.en.pt`). If a new whisper model is requested, fetch it with curl first — don't let whisper auto-download.
- **LLM truncation**: gemma-4-e4b-it-8bit on the local omlx server reliably truncates long JSON outputs at `]` and emits an `<eos>` token without closing the outer `}`. The `balanceJson` + special-token strip in `extractJson` handles this. Do not use `Qwen3.5-9B-MLX-4bit` for JSON-structured tasks — it emits reasoning preambles that consume the token budget before any JSON is produced, regardless of `enable_thinking` flags (see auto-memory).
- **Voice reference transcripts are not required to be accurate**. F5-TTS is forgiving. The transcript file exists so F5 can get *approximate* phonemic grounding from the reference audio; slight whisper errors are fine, but obviously wrong transcripts (e.g. whisper hallucinated "Thanks for watching!" on a silent ambient clip) produce garbage synthesis.
- **Per-variant cache layout**: stages 1 and 2 (audio extraction + whisper transcription) cache under `out/<base>/` because they're variant-independent. Stages 3-6 (beautify, synth, SRT, mux) cache under `out/<base>/<variant>/`. `--force` blows away both.
- **johnwick was previously called vulgar**. Any stale `vulgar/` directories under `out/` are from before the rename and can be deleted.
- **Piper is gone**. If you see references to piper-tts, `--piper-model`, or `models/piper/`, they're stale — the pipeline is f5-tts-mlx only now.
