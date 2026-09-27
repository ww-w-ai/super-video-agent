#!/usr/bin/env python3
"""
Super Video Agent STT round-trip check — transcribes synthesized narration lines back
to text with faster-whisper, so voice.mjs can verify a generated line
actually says what it was supposed to say (references/voice.md "Did the
voice say the line?"). Model is loaded ONCE for every line in the batch.

Usage:
  python stt_check.py <voiceDir> <linesJson>

<linesJson> is a path to a JSON file: [{"id": "l1", "wav": "line-l1.wav"}, ...]
`wav` may be relative to <voiceDir> or absolute.

Env:
  SVA_STT_MODEL  faster-whisper model name (default "small")
  SVA_STT_LANG   transcription language code (default "ko")
  HF_HUB_OFFLINE=1    set by the caller to force offline model loading;
                      this script does not set it itself.

Prints a single JSON array to STDOUT: [{"id": "l1", "heard": "..."}, ...]
(never JSON-lines — the whole result at once). Progress/logs go to STDERR.
"""
import sys
import os
import json


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def main():
    if len(sys.argv) < 3:
        log("usage: stt_check.py <voiceDir> <linesJson>")
        return 2
    voice_dir, lines_json_path = sys.argv[1], sys.argv[2]
    lines = json.load(open(lines_json_path, encoding="utf-8"))

    if not lines:
        print(json.dumps([]))
        return 0

    model_name = os.environ.get("SVA_STT_MODEL") or "small"
    language = os.environ.get("SVA_STT_LANG") or "ko"

    from faster_whisper import WhisperModel

    log(f"[stt_check] loading model once ({model_name})...")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    log(f"[stt_check] model ready. {len(lines)} line(s), language={language}")

    results = []
    for entry in lines:
        lid = entry["id"]
        wav = entry["wav"]
        wav_path = wav if os.path.isabs(wav) else os.path.join(voice_dir, wav)
        segments, _ = model.transcribe(wav_path, language=language, beam_size=5)
        heard = "".join(seg.text for seg in segments).strip()
        log(f"[stt_check] {lid} -> {heard}")
        results.append({"id": lid, "heard": heard})

    print(json.dumps(results, ensure_ascii=False))
    log("[stt_check] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
