#!/usr/bin/env python3
"""
Super Video Agent Qwen3-TTS batch voice-clone synthesis — model loaded ONCE for all
of plan.json's lines.

Per-line time budget with retry, duration + tail-clip gating (reject
too-short or tail-clipped takes while budget remains; keep the best
candidate seen if none fully passes), float32 on MPS (float16/bfloat16
crash with inf/nan on voice clone).

Usage:
  python qwen3_batch.py <job.json> <outDir>

Job JSON:
  {"model": "Qwen/Qwen3-TTS-12Hz-1.7B-Base", "device": "mps",
   "lang": "Korean", "refAudio": "...", "refText": "...", "budgetSec": 20,
   "lines": [{"id": "l1", "say": "..."}]}

Writes <outDir>/<id>.wav at the model's native sample rate — this script
deliberately does not resample; voice.mjs resamples to 48kHz mono.

Prints one JSON line per synthesized line to STDOUT (progress/logs go to
STDERR so STDOUT stays a clean JSON-lines stream):
  {"id": "l1", "wav": "<outDir>/l1.wav", "durationSec": 1.83,
   "attempts": 2, "flag": "OK"}
flag is one of OK | SHORT | TAIL.
"""
import sys
import os
import json
import time

# Qwen3 ends files right after the last syllable with no trailing silence, so a
# wide tail window always contains that syllable. A cut is speech still
# sounding in the final few milliseconds; a clean end has decayed to near zero.
TAIL_MS = 30
# RMS below this (about -54 dBFS) over the final TAIL_MS = the last syllable
# decayed on its own. The old 0.02 (-34 dBFS) passed takes whose "요" was still
# sounding at the cut, which listeners hear as a clipped ending.
TAIL_OK = 0.002
LOUD_DB = -35  # a 10 ms window above this is speech
SILENT_DB = -60  # the first window below this after the last speech is where the voice has stopped
FADE_MS = 15
DEFAULT_BUDGET_SEC = 20.0
DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def import_qwen_tts_quietly():
    """Import qwen_tts without the SoX banner.

    qwen_tts imports the `sox` package, which runs `sox -h` in a shell at
    import and logs "SoX could not be found!" when the binary is absent.
    qwen3 synthesis never calls SoX, so that banner (and the shell's
    "sox: command not found") is noise. Only this import is muted; an import
    error still raises with its traceback.
    """
    import logging
    logging.getLogger("sox").setLevel(logging.ERROR)
    saved = os.dup(2)
    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, 2)
        from qwen_tts import Qwen3TTSModel
    finally:
        os.dup2(saved, 2)
        os.close(devnull)
        os.close(saved)
    return Qwen3TTSModel


def tail_peak(wav, sr):
    """RMS over the final TAIL_MS of the waveform."""
    import numpy as np

    n = int(TAIL_MS / 1000 * sr)
    seg = wav[-n:] if 0 < n <= len(wav) else wav
    return float(np.sqrt(np.mean(np.square(seg)))) if len(seg) else 0.0


def trim_at_silence(wav, sr):
    """Cut the take where the voice has decayed to silence after its last
    syllable, then fade the final FADE_MS. A take that never reaches silence
    (a clipped ending) keeps its length and gets a longer fade so it does not click."""
    import numpy as np

    wav = np.asarray(wav, dtype=np.float32)
    win = max(1, int(0.01 * sr))
    n = len(wav) // win
    if n == 0:
        return wav
    rms = np.sqrt(np.mean(np.square(wav[: n * win].reshape(n, win)), axis=1))
    loud = np.where(rms > 10 ** (LOUD_DB / 20))[0]
    if len(loud) == 0:
        return wav
    after = np.where(rms[loud[-1]:] < 10 ** (SILENT_DB / 20))[0]
    if len(after):
        end = min(len(wav), (loud[-1] + after[0] + 1) * win)
        fade = int(FADE_MS / 1000 * sr)
    else:
        end = len(wav)
        fade = int(4 * FADE_MS / 1000 * sr)
    out = wav[:end].copy()
    fade = min(fade, len(out))
    out[len(out) - fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    return out


# The model clips a sentence's last syllable when the sentence is the end of
# the take. So every line is spoken as "<line>. 끝." — the line ends as a full
# sentence with its falling tone, the trailing word keeps the model talking
# through it, and the take is cut in the pause before "끝".
# The slate word is spoken in the line's own language so the model does not switch accent.
# Each is one short word, so it fits TRAILER_MS.
TRAILERS = {
    "Korean": " 끝.",
    "English": " End.",
    "Chinese": "完。",
    "Japanese": "以上。",
    "German": " Ende.",
    "French": " Fin.",
    "Russian": " Всё.",
    "Portuguese": " Fim.",
    "Spanish": " Fin.",
    "Italian": " Fine.",
}
DEFAULT_TRAILER = " End."
SENTENCE_END = ".!?~。！？"
GAP_DB = -45  # a pause is a run of windows below this
MIN_GAP_MS = 80  # a sentence-end pause; shorter dips are gaps between words
TRAILER_MS = (80, 450)  # how long the spoken slate word may run


def with_trailer(text, lang="Korean"):
    t = text.rstrip()
    end = "。" if lang in ("Chinese", "Japanese") else "."
    return (t if t[-1:] in SENTENCE_END else t + end) + TRAILERS.get(lang, DEFAULT_TRAILER)


def _rms10(wav, sr):
    import numpy as np

    win = max(1, int(0.01 * sr))
    n = len(wav) // win
    return np.sqrt(np.mean(np.square(wav[: n * win].reshape(n, win)), axis=1)), win


def _fade_out(out, sr, ms):
    import numpy as np

    fade = min(int(ms / 1000 * sr), len(out))
    out[len(out) - fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    return out


def cut_before_trailer(wav, sr):
    """Find the spoken trailer (the last short burst of speech after a real
    pause) and cut inside that pause, where the line's own last syllable has
    decayed most. Returns (wav, level_at_cut) or None when the take has no
    such pause (the model ran the words together or dropped the trailer)."""
    import numpy as np

    wav = np.asarray(wav, dtype=np.float32)
    rms, win = _rms10(wav, sr)
    loud = np.where(rms > 10 ** (LOUD_DB / 20))[0]
    if len(loud) == 0:
        return None
    quiet = rms < 10 ** (GAP_DB / 20)
    end = loud[-1]
    on = end  # walk back through the trailer; dips under 30 ms stay inside it
    g_start = 0
    while on > 0:
        if not quiet[on - 1]:
            on -= 1
            continue
        k = on
        while k > 0 and quiet[k - 1]:
            k -= 1
        if on - k >= 3:
            g_start = k
            break
        on = k
    trailer_ms = (end - on + 1) * 10
    g_end = on
    gap_ms = (g_end - g_start) * 10 if on > 0 else 0
    if gap_ms < MIN_GAP_MS or not (TRAILER_MS[0] <= trailer_ms <= TRAILER_MS[1]):
        return None
    gap = rms[g_start:g_end]
    silent = np.where(gap < 10 ** (SILENT_DB / 20))[0]
    cut = g_start + (silent[0] if len(silent) else int(np.argmin(gap)))
    out = _fade_out(wav[: (cut + 1) * win].copy(), sr, FADE_MS)
    return out, float(rms[cut])


def synth_one(model, text, lang, ref_audio, ref_text, budget):
    """Speak `text` with the trailer and cut before it, retrying within
    `budget` seconds until a take has a clear pause before the trailer and the
    line's ending decayed to silence there. Falls back to the plain line
    (trimmed at silence) when no take had that pause.
    Returns (wav, sr, dur, level_at_end, attempts, flag)."""
    # Floor from character count: a Hangul syllable takes ~0.1 s, a Latin letter ~0.05 s.
    # Seconds per character, a floor: one Hangul or CJK character is a syllable, a Latin letter is not.
    per_char = {"Korean": 0.08, "Chinese": 0.1, "Japanese": 0.06}.get(lang, 0.035)
    min_dur = max(0.3, len(text) * per_char)
    best = None  # (wav, sr, dur, level)
    t0 = time.time()
    attempts = 0
    while time.time() - t0 < budget:
        attempts += 1
        wavs, sr = model.generate_voice_clone(
            text=with_trailer(text, lang), language=lang, ref_audio=ref_audio, ref_text=ref_text,
        )
        cut = cut_before_trailer(wavs[0], sr)
        if cut is None:
            continue
        wav, level = cut
        dur = len(wav) / sr
        if dur < min_dur:
            continue
        if best is None or level < best[3]:
            best = (wav, sr, dur, level)
        if level <= TAIL_OK:
            break  # the line's ending decayed to silence before the trailer
    if best is None:
        attempts += 1
        wavs, sr = model.generate_voice_clone(
            text=text, language=lang, ref_audio=ref_audio, ref_text=ref_text,
        )
        wav = trim_at_silence(wavs[0], sr)
        best = (wav, sr, len(wav) / sr, tail_peak(wavs[0], sr))
    wav, sr, dur, level = best
    flag = "OK" if (dur >= min_dur and level <= TAIL_OK) else ("SHORT" if dur < min_dur else "TAIL")
    return wav, sr, dur, level, attempts, flag


def main():
    if len(sys.argv) < 3:
        log("usage: qwen3_batch.py <job.json> <outDir>")
        return 2
    job_path, out_dir = sys.argv[1], sys.argv[2]
    job = json.load(open(job_path, encoding="utf-8"))

    model_id = job.get("model") or DEFAULT_MODEL
    device = job.get("device") or "mps"
    lang = job.get("lang") or "Korean"
    ref_audio = job.get("refAudio")
    ref_text = job.get("refText")
    budget = float(job.get("budgetSec") or DEFAULT_BUDGET_SEC)
    lines = job.get("lines") or []

    if not ref_audio or not ref_text:
        log("FATAL: job JSON must set refAudio and refText for qwen3 voice cloning")
        return 2

    os.makedirs(out_dir, exist_ok=True)

    import torch
    import soundfile as sf
    Qwen3TTSModel = import_qwen_tts_quietly()

    log(f"[qwen3_batch] loading model once ({model_id}, {device})...")
    # clone on MPS/CPU requires float32 (float16/bfloat16 -> inf/nan crash).
    model = Qwen3TTSModel.from_pretrained(model_id, device_map=device, dtype=torch.float32)
    log(f"[qwen3_batch] model ready. {len(lines)} line(s), per-line budget {budget}s")

    for entry in lines:
        lid = entry["id"]
        text = entry.get("say") or entry.get("text") or ""
        wav, sr, dur, tp, attempts, flag = synth_one(model, text, lang, ref_audio, ref_text, budget)
        out_wav = os.path.join(out_dir, f"{lid}.wav")
        sf.write(out_wav, wav, sr)
        log(f"[qwen3_batch] {lid} dur={dur:.2f}s tail={tp:.3f} attempts={attempts} -> {flag}")
        print(
            json.dumps(
                {"id": lid, "wav": out_wav, "durationSec": round(dur, 3), "attempts": attempts, "flag": flag}
            ),
            flush=True,
        )

    log("[qwen3_batch] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
