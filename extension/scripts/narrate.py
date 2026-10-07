#!/usr/bin/env python3
"""Voice-over for the demo film (used by scripts/film.mjs, runs in its own venv with piper-tts).

  narrate.py config <out.onnx.json>                       write a standard Piper config for an espeak-based English voice
  narrate.py synth  <spec.json> <out_dir>                 synthesize every scene; writes scene-<id>.wav + manifest.json
  narrate.py mix    <manifest.json> <timeline.json> <out.wav> <seconds>   place each scene's audio at its start time

Each scene is a list of chunks {"say": spoken text, "show": caption text}. Chunks are synthesized one by one, so every
caption has an exact start and end inside the scene; pauses follow the punctuation of the chunk.
"""
import json
import sys
import wave
from pathlib import Path

import numpy as np

SR = 22050


def write_wav(path, samples):
    pcm = np.clip(samples, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((pcm * 32767).astype(np.int16).tobytes())


def cmd_config(out):
    from piper.phoneme_ids import DEFAULT_PHONEME_ID_MAP

    cfg = {
        "audio": {"sample_rate": SR, "quality": "medium"},
        "espeak": {"voice": "en-us"},
        "language": {"code": "en_US"},
        "inference": {"noise_scale": 0.667, "length_scale": 1.0, "noise_w": 0.8},
        "phoneme_type": "espeak",
        "phoneme_map": {},
        "phoneme_id_map": DEFAULT_PHONEME_ID_MAP,
        "num_symbols": 256,
        "num_speakers": 1,
        "speaker_id_map": {},
        "piper_version": "1.0.0",
    }
    Path(out).write_text(json.dumps(cfg))


def pause_after(text):
    t = text.rstrip()
    if t.endswith((".", "!", "?")):
        return 0.42
    if t.endswith((",", ":", ";", "-")):
        return 0.22
    return 0.12


def cmd_synth(spec_path, out_dir):
    from piper import PiperVoice
    from piper.config import SynthesisConfig

    spec = json.loads(Path(spec_path).read_text())
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    voice = PiperVoice.load(spec["model"], config_path=spec["config"])
    syn = SynthesisConfig(length_scale=spec.get("length_scale", 1.05), noise_scale=spec.get("noise_scale", 0.6), noise_w_scale=spec.get("noise_w", 0.75))
    manifest = {"sample_rate": SR, "scenes": []}
    for scene in spec["scenes"]:
        parts, chunks, t = [], [], 0.0
        for i, ch in enumerate(scene["chunks"]):
            audio = np.concatenate([c.audio_float_array for c in voice.synthesize(ch["say"], syn_config=syn)])
            # trim the model's own leading/trailing near-silence so the pauses below are the only gaps
            loud = np.where(np.abs(audio) > 0.01)[0]
            if len(loud):
                audio = audio[max(0, loud[0] - int(0.02 * SR)): loud[-1] + int(0.06 * SR)]
            dur = len(audio) / SR
            chunks.append({"show": ch["show"], "start": round(t, 3), "end": round(t + dur, 3)})
            parts.append(audio)
            t += dur
            if i < len(scene["chunks"]) - 1:
                gap = pause_after(ch["say"])
                parts.append(np.zeros(int(gap * SR), dtype=np.float32))
                t += gap
        samples = np.concatenate(parts) * 0.9
        write_wav(out / f"scene-{scene['id']}.wav", samples)
        manifest["scenes"].append({"id": scene["id"], "duration": round(len(samples) / SR, 3), "chunks": chunks})
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))


def cmd_mix(manifest_path, timeline_path, out_wav, seconds):
    manifest = json.loads(Path(manifest_path).read_text())
    timeline = json.loads(Path(timeline_path).read_text())
    base = Path(manifest_path).parent
    total = np.zeros(int(float(seconds) * SR) + SR, dtype=np.float32)
    for scene in manifest["scenes"]:
        start = timeline.get(scene["id"])
        if start is None:
            continue
        with wave.open(str(base / f"scene-{scene['id']}.wav")) as w:
            audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        i = int(start * SR)
        total[i: i + len(audio)] += audio[: max(0, len(total) - i)]
    write_wav(out_wav, total[: int(float(seconds) * SR)])


if __name__ == "__main__":
    mode, *args = sys.argv[1:]
    {"config": cmd_config, "synth": cmd_synth, "mix": cmd_mix}[mode](*args)
