"""
Persistent F5-TTS worker — loads the model once, then processes
JSON-line requests from stdin and writes JSON-line responses to stdout.

Auto-detects MLX (Mac) vs PyTorch (Linux/Docker).

Protocol:
  Ready signal (stdout):  {"ready":true,"backend":"mlx"|"pytorch"}
  Request  (stdin):       {"ref_audio":str,"ref_text":str,"text":str,"output":str,"speed":float}
  Response (stdout):      {"ok":true,"duration":float} | {"ok":false,"error":str}
"""

import json
import sys
import time

backend = None

# ---------------------------------------------------------------------------
# MLX backend
# ---------------------------------------------------------------------------

def init_mlx():
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    from f5_tts_mlx.generate import (
        F5TTS, SAMPLE_RATE, FRAMES_PER_SEC, TARGET_RMS,
        convert_char_to_pinyin, estimated_duration,
    )
    model = F5TTS.from_pretrained("lucasnewman/f5-tts-mlx")

    def synthesize(ref_audio_path, ref_text, text, output_path, speed):
        audio, sr = sf.read(ref_audio_path)
        if sr != SAMPLE_RATE:
            raise ValueError(f"Reference audio must be {SAMPLE_RATE}Hz, got {sr}Hz")
        audio = mx.array(audio)
        rms = mx.sqrt(mx.mean(mx.square(audio)))
        if rms < TARGET_RMS:
            audio = audio * TARGET_RMS / rms

        duration = int(
            estimated_duration(audio, ref_text, text, speed) * FRAMES_PER_SEC
        )
        gen_text = convert_char_to_pinyin([ref_text + " " + text])

        wave, _ = model.sample(
            mx.expand_dims(audio, axis=0),
            text=gen_text,
            duration=duration,
            steps=8,
            method="rk4",
            speed=speed,
            cfg_strength=2.0,
            sway_sampling_coef=-1.0,
            seed=None,
        )
        wave = wave[audio.shape[0]:]
        mx.eval(wave)

        generated_duration = wave.shape[0] / SAMPLE_RATE
        sf.write(output_path, np.array(wave), SAMPLE_RATE)
        return generated_duration

    return synthesize


# ---------------------------------------------------------------------------
# PyTorch backend
# ---------------------------------------------------------------------------

def init_pytorch():
    import torch
    import torchaudio
    import soundfile as sf
    from importlib.resources import files
    from omegaconf import OmegaConf
    from f5_tts.infer.utils_infer import (
        load_model, load_vocoder, infer_process, preprocess_ref_audio_text,
    )
    from f5_tts.utils import get_class

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"

    vocoder = load_vocoder(vocoder_name="vocos", is_local=False, device=device)

    model_cfg = OmegaConf.load(str(files("f5_tts").joinpath("configs/F5TTS_Base.yaml")))
    model_cls = get_class(f"f5_tts.model.{model_cfg.model.backbone}")
    model_arc = model_cfg.model.arch

    try:
        from cached_path import cached_path as _cached_path
        ckpt_file = str(_cached_path("hf://SWivid/F5-TTS/F5TTS_Base/model_1200000.safetensors"))
    except Exception:
        ckpt_file = ""

    vocab_file = str(files("f5_tts").joinpath("infer/examples/vocab.txt"))

    ema_model = load_model(
        model_cls, model_arc, ckpt_file,
        mel_spec_type="vocos", vocab_file=vocab_file, device=device,
    )

    def synthesize(ref_audio_path, ref_text, text, output_path, speed):
        ref_audio, ref_text_clean = preprocess_ref_audio_text(ref_audio_path, ref_text)
        wave, sample_rate, _ = infer_process(
            ref_audio, ref_text_clean, text,
            ema_model, vocoder,
            mel_spec_type="vocos",
            speed=speed,
            device=device,
            show_info=lambda *a: None,
        )
        sf.write(output_path, wave, sample_rate)
        return len(wave) / sample_rate

    return synthesize


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

class _StderrRedirect:
    """Replace sys.stdout temporarily so library print() calls don't corrupt the JSON protocol."""
    def write(self, s):
        sys.stderr.write(s)
    def flush(self):
        sys.stderr.flush()

_real_stdout = sys.stdout


def main():
    sys.stdout = _StderrRedirect()

    synthesize = None
    backend_name = None

    try:
        synthesize = init_mlx()
        backend_name = "mlx"
    except ImportError:
        pass

    if synthesize is None:
        try:
            synthesize = init_pytorch()
            backend_name = "pytorch"
        except ImportError as e:
            _real_stdout.write(json.dumps({"ok": False, "error": f"No F5-TTS backend: {e}"}) + "\n")
            _real_stdout.flush()
            sys.exit(1)

    _real_stdout.write(json.dumps({"ready": True, "backend": backend_name}) + "\n")
    _real_stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            t0 = time.monotonic()
            duration = synthesize(
                req["ref_audio"], req["ref_text"], req["text"],
                req["output"], req.get("speed", 1.0),
            )
            elapsed = time.monotonic() - t0
            _real_stdout.write(json.dumps({
                "ok": True, "duration": round(duration, 3), "elapsed": round(elapsed, 3),
            }) + "\n")
        except Exception as e:
            _real_stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
        _real_stdout.flush()


if __name__ == "__main__":
    main()
