#!/usr/bin/env python3
"""
Super Video Agent MeloTTS-Korean batch synthesis — model loaded ONCE for all of
plan.json's lines.

Includes a MeCab stub workaround for KR-only builds where mecab-python3
won't install (MeloTTS's cleaner.py unconditionally imports every language
module, including japanese.py's bare `import MeCab`; KR synthesis via
g2pkk never calls into it).

Usage:
  python melo_batch.py <job.json> <outDir>

Job JSON:
  {"speed": 1.0, "speaker": "KR", "lines": [{"id": "l1", "say": "..."}]}

Writes <outDir>/<id>.wav (MeloTTS's native sample rate; voice.mjs
resamples to 48kHz mono).

Prints one JSON line per synthesized line to STDOUT (progress/logs go to
STDERR so STDOUT stays a clean JSON-lines stream):
  {"id": "l1", "wav": "<outDir>/l1.wav", "durationSec": 1.2}
"""
import sys
import os
import json
import wave


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def install_mecab_stub_if_missing():
    try:
        import MeCab  # noqa: F401

        return
    except Exception:
        pass
    import types

    class _StubTagger:  # never used for KR; Japanese path is dead here.
        def parse(self, *a, **k):
            raise RuntimeError("MeCab stub: Japanese TTS not supported in this KR-only build")

        parseToNode = parse

    stub = types.ModuleType("MeCab")
    stub.Tagger = lambda *a, **k: _StubTagger()
    sys.modules["MeCab"] = stub


def main():
    if len(sys.argv) < 3:
        log("usage: melo_batch.py <job.json> <outDir>")
        return 2
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    speed = float(job.get("speed") or 1.0)
    speaker_req = job.get("speaker") or "KR"
    lines = job.get("lines") or []

    install_mecab_stub_if_missing()

    try:
        from melo.api import TTS
    except ImportError:
        log("MeloTTS not installed. Install it in the venv pointed to by SVA_MELO_PYTHON.")
        return 2

    device = "cpu"  # CPU is real-time for MeloTTS; MPS has a known KO issue.
    log("[melo_batch] loading model once (MeloTTS-KR, cpu)...")
    model = TTS(language="KR", device=device)
    # spk2id is a HParams object (not a plain dict) — supports
    # __contains__/__getitem__/values() but not .get().
    speaker_ids = model.hps.data.spk2id
    speaker_id = speaker_ids[speaker_req] if speaker_req in speaker_ids else next(iter(speaker_ids.values()))
    log(f"[melo_batch] model ready. {len(lines)} line(s), speed={speed}")

    for entry in lines:
        lid = entry["id"]
        text = entry.get("say") or entry.get("text") or ""
        out_wav = os.path.join(out_dir, f"{lid}.wav")
        model.tts_to_file(text, speaker_id, out_wav, speed=speed)
        with wave.open(out_wav, "rb") as w:
            rate = w.getframerate()
            dur = (w.getnframes() / rate) if rate else 0.0
        log(f"[melo_batch] {lid} dur={dur:.2f}s")
        print(json.dumps({"id": lid, "wav": out_wav, "durationSec": round(dur, 3)}), flush=True)

    log("[melo_batch] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
