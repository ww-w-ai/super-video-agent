#!/usr/bin/env python3
"""
Super Video Agent STT round-trip check — transcribes synthesized narration lines back
to text with mlx-whisper, so voice.mjs can verify a generated line
actually says what it was supposed to say (references/voice.md "Did the
voice say the line?"). The model is loaded ONCE for every line in the batch.

Usage:
  python stt_check.py <voiceDir> <linesJson>

<linesJson> is a path to a JSON file: [{"id": "l1", "wav": "line-l1.wav"}, ...]
`wav` may be relative to <voiceDir> or absolute.

Env:
  SVA_STT_MODEL     "small" (default), "turbo", or an mlx-whisper repo / local folder
  SVA_STT_LANG      transcription language code (default "ko")
  SVA_STT_PROGRESS  path of a JSON file rewritten after every line with the results so
                    far, so a run that dies midway still leaves the finished lines
  HF_HUB_OFFLINE=1  set by the caller; a model that is not in the local cache then
                    ends the run with exit code 3 instead of downloading it.

Prints a single JSON array to STDOUT:
  [{"id": "l1", "heard": "...", "words": [{"w": "...", "start": 0.21, "end": 0.78}, ...]}, ...]
(word times in seconds from the start of the clip)
(never JSON-lines — the whole result at once). Progress/logs go to STDERR.
"""
import sys
import os
import json
import subprocess

MODEL_NOT_DOWNLOADED_EXIT = 3
SAMPLE_RATE = 16000
FRAME_SEC = 0.01

MODELS = {
    "small": "mlx-community/whisper-small-mlx",
    "turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def resolve_model(name):
    return MODELS.get(name, name)


def ensure_cached(repo):
    """Fail with MODEL_NOT_DOWNLOADED_EXIT when the model is not already on disk."""
    if os.path.isdir(repo):
        return True
    from huggingface_hub import snapshot_download

    try:
        snapshot_download(repo, local_files_only=True)
        return True
    except Exception:
        return False


def decode_audio(wav_path):
    """Mono float32 samples at 16 kHz, through ffmpeg."""
    import numpy as np

    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", wav_path, "-f", "s16le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def trim_to_sound(wav_path, words):
    """Whisper's word boundaries run edge to edge, so a pause before a word is counted as part of
    it. Move each word's start forward to where its sound begins and its end back to where it
    stops (10 ms frames louder than a tenth of the clip's loud level)."""
    if not words:
        return words
    import numpy as np

    audio = decode_audio(wav_path)
    hop = int(SAMPLE_RATE * FRAME_SEC)
    n = len(audio) // hop
    if n == 0:
        return words
    rms = np.sqrt(np.mean(audio[: n * hop].reshape(n, hop) ** 2, axis=1))
    loud = rms >= 0.1 * np.percentile(rms, 95)
    out = []
    for w in words:
        a, b = int(w["start"] / FRAME_SEC), min(n, int(np.ceil(w["end"] / FRAME_SEC)))
        idx = np.nonzero(loud[a:b])[0]
        if len(idx):
            start, end = (a + idx[0]) * FRAME_SEC, (a + idx[-1] + 1) * FRAME_SEC
        else:
            start, end = w["start"], w["end"]
        out.append({"w": w["w"], "start": round(float(start), 3), "end": round(float(end), 3)})
    return out


def save_progress(path, results):
    """Rewrite the progress file whole, so a reader never sees half a file."""
    if not path:
        return
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False)
    os.replace(tmp, path)


def transcribe_one(mlx_whisper, repo, wav_path, language):
    out = mlx_whisper.transcribe(
        wav_path,
        path_or_hf_repo=repo,
        language=language,
        word_timestamps=True,
        condition_on_previous_text=False,
    )
    heard = (out.get("text") or "").strip()
    words = [
        {"w": w["word"].strip(), "start": w["start"], "end": w["end"]}
        for seg in out.get("segments", [])
        for w in (seg.get("words") or [])
        if w.get("word", "").strip()
    ]
    return heard, trim_to_sound(wav_path, words)


def main():
    if len(sys.argv) < 3:
        log("usage: stt_check.py <voiceDir> <linesJson>")
        return 2
    voice_dir, lines_json_path = sys.argv[1], sys.argv[2]
    with open(lines_json_path, encoding="utf-8") as f:
        lines = json.load(f)

    if not lines:
        print(json.dumps([]))
        return 0

    repo = resolve_model(os.environ.get("SVA_STT_MODEL") or "small")
    language = os.environ.get("SVA_STT_LANG") or "ko"
    progress = os.environ.get("SVA_STT_PROGRESS")

    import mlx_whisper

    if not ensure_cached(repo):
        log(f"[stt_check] model {repo} is not in the local cache")
        return MODEL_NOT_DOWNLOADED_EXIT
    log(f"[stt_check] {len(lines)} line(s), model={repo}, language={language}")

    results = []
    for entry in lines:
        lid = entry["id"]
        wav = entry["wav"]
        wav_path = wav if os.path.isabs(wav) else os.path.join(voice_dir, wav)
        heard, words = transcribe_one(mlx_whisper, repo, wav_path, language)
        log(f"[stt_check] {lid} -> {heard}")
        results.append({"id": lid, "heard": heard, "words": words})
        save_progress(progress, results)

    print(json.dumps(results, ensure_ascii=False))
    log("[stt_check] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
