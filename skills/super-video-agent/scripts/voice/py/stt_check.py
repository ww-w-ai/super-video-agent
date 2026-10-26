#!/usr/bin/env python3
"""
Super Video Agent STT round-trip check — transcribes synthesized narration lines back
to text with mlx-whisper (Apple silicon) or faster-whisper (CUDA / CPU), so voice.mjs can verify a generated line
actually says what it was supposed to say (references/voice.md "Did the
voice say the line?"). The model is loaded ONCE for every line in the batch.

Usage:
  python stt_check.py <voiceDir> <linesJson>

<linesJson> is a path to a JSON file: [{"id": "l1", "wav": "line-l1.wav"}, ...]
`wav` may be relative to <voiceDir> or absolute.

Env:
  SVA_STT_BACKEND   "mlx" (default) or "faster-whisper"; both run the same weights with the
                    same decoding (greedy with temperature fallback, no previous-text
                    conditioning, word timestamps), so the doubt threshold means the same
  SVA_STT_MODEL     "small" (default), "turbo", or a repo / local folder for the backend
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

# Transcripts hold any script; never let the console code page (cp949 on Korean Windows) decide.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

MODEL_NOT_DOWNLOADED_EXIT = 3
SAMPLE_RATE = 16000
FRAME_SEC = 0.01

MODELS = {
    "small": "mlx-community/whisper-small-mlx",
    "turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}

# The same Whisper weights converted for CTranslate2 (stt-engine.mjs FW_MODEL_REPOS is the same table).
FW_MODELS = {
    "small": "Systran/faster-whisper-small",
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}

# mlx-whisper's transcribe() defaults, spelled out for faster-whisper (whose own default is beam 5).
FW_DECODE = {
    "beam_size": 1,
    "best_of": 1,
    "temperature": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
    "compression_ratio_threshold": 2.4,
    "log_prob_threshold": -1.0,
    "no_speech_threshold": 0.6,
    "condition_on_previous_text": False,
    "word_timestamps": True,
    "vad_filter": False,
}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def resolve_model(name, backend="mlx"):
    return (FW_MODELS if backend == "faster-whisper" else MODELS).get(name, name)


def add_cuda_dll_dirs():
    """On Windows the pip CUDA wheels (nvidia-cublas-cu12, nvidia-cudnn-cu12) keep their DLLs in
    nvidia/<lib>/bin, which the loader does not search by itself."""
    if os.name != "nt":
        return
    import importlib.util

    for pkg in ("nvidia.cublas", "nvidia.cudnn"):
        try:
            spec = importlib.util.find_spec(pkg)
        except ModuleNotFoundError:
            continue
        for root in (spec.submodule_search_locations or []) if spec else []:
            d = os.path.join(root, "bin")
            if os.path.isdir(d):
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def load_faster_whisper(repo):
    """The model on the GPU at float16 when CUDA is there (the precision mlx uses), else int8 on CPU."""
    add_cuda_dll_dirs()
    import ctranslate2
    from faster_whisper import WhisperModel

    if ctranslate2.get_cuda_device_count() > 0:
        device, compute = "cuda", "float16"
    else:
        device, compute = "cpu", "int8"
    log(f"[stt_check] faster-whisper on {device} ({compute})")
    return WhisperModel(repo, device=device, compute_type=compute, local_files_only=True)


def ensure_cached(repo, backend="mlx"):
    """Fail with MODEL_NOT_DOWNLOADED_EXIT when the model is not already on disk."""
    if os.path.isdir(repo):
        return True
    try:
        if backend == "faster-whisper":
            # faster-whisper downloads only the files it loads, so ask with its own file list.
            from faster_whisper.utils import download_model

            download_model(repo, local_files_only=True)
        else:
            from huggingface_hub import snapshot_download

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


def transcribe_one_fw(model, wav_path, language):
    segments, _ = model.transcribe(wav_path, language=language, **FW_DECODE)
    segments = list(segments)
    heard = "".join(seg.text for seg in segments).strip()
    words = [
        {"w": w.word.strip(), "start": w.start, "end": w.end}
        for seg in segments
        for w in (seg.words or [])
        if w.word.strip()
    ]
    return heard, trim_to_sound(wav_path, words)


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

    backend = os.environ.get("SVA_STT_BACKEND") or "mlx"
    repo = resolve_model(os.environ.get("SVA_STT_MODEL") or "small", backend)
    language = os.environ.get("SVA_STT_LANG") or "ko"
    progress = os.environ.get("SVA_STT_PROGRESS")

    if backend == "faster-whisper":
        import faster_whisper  # noqa: F401 — a missing package fails here, before the cache check
    else:
        import mlx_whisper

    if not ensure_cached(repo, backend):
        log(f"[stt_check] model {repo} is not in the local cache")
        return MODEL_NOT_DOWNLOADED_EXIT
    log(f"[stt_check] {len(lines)} line(s), backend={backend}, model={repo}, language={language}")
    model = load_faster_whisper(repo) if backend == "faster-whisper" else None

    results = []
    for entry in lines:
        lid = entry["id"]
        wav = entry["wav"]
        wav_path = wav if os.path.isabs(wav) else os.path.join(voice_dir, wav)
        if model is not None:
            heard, words = transcribe_one_fw(model, wav_path, language)
        else:
            heard, words = transcribe_one(mlx_whisper, repo, wav_path, language)
        log(f"[stt_check] {lid} -> {heard}")
        results.append({"id": lid, "heard": heard, "words": words})
        save_progress(progress, results)

    print(json.dumps(results, ensure_ascii=False))
    log("[stt_check] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
