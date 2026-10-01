// Builds the ffmpeg filter_complex that mixes library sound cues
// (design.md §2.5 "Sound") into a film's audio: each cue is trimmed to
// maxSec (or its own length), given a 30ms fade-out, peak-normalized to
// -6 dBFS then `gainDb`, delayed to its cue time, ducked under narration
// (references/sound.md "Mix" — meta.sound.sfxDuckDb, default -6dB, unless
// duckDb is 0 or no narrationWindows are given), and summed with narration
// (+ optional page SFX) into `[premaster]` — the mix before mastering. A
// pure function of its inputs so the graph shape can be unit-tested
// without ffmpeg: render.mjs supplies each cue's measured peak dB and trim
// length, then two-pass masters `[premaster]` itself (see masterGainFilter
// below).
import fs from "node:fs";
import { buildDuckVolumeExpr } from "./duck.mjs";
import { measureLoudness } from "./audio-analysis.mjs";
import { computeLineGainDb, lineNeedsLimiter, lineLevelFilter } from "./line-level.mjs";

const FADE_OUT_SEC = 0.03;
const TARGET_PEAK_DB = -6;

// Final mastering target, shared by every mix this file feeds (render.mjs's
// muxAudio/muxBedOnly, dub.mjs's mixDubAudio). Two-pass static gain, not
// loudnorm: single-pass loudnorm is a dynamic normalizer that ramps its gain
// up over the file, so a 40s narration measured about -30 LUFS momentary at
// its first line and -12 at its last, although every line wav had already
// been leveled to -16 LUFS individually (line-level.mjs). Masters instead
// measure the finished mix once (pass 1, to a temp wav) and apply one static
// `volume` gain (+ a peak limiter only if that gain would cross the true-peak
// ceiling) in pass 2 — the same measured-gain-then-limiter shape
// line-level.mjs uses per line, reused here for the whole mix.
export const MASTER_TARGET_LUFS = -16;
export const MASTER_MAX_TRUE_PEAK_DB = -1.5;
// asetpts: a filter chain ending in a gain (or limiter) leaves one gap in the packet timestamps when video is muxed in the same command (ffmpeg 8.1, ~42 ms); renumbering from the sample count removes it.
const MASTER_TAIL = "aresample=48000,aformat=channel_layouts=stereo,asetpts=N/SR/TB";

// Every input of a mix is made stereo before amix. amix takes its channel
// layout from its first input, so a mono voice first collapses the whole mix
// to mono and every stereo pan in the bed is lost. A mono input lands
// centred at full level in both channels (ffmpeg's own mono->stereo upmix is
// -3 dB); a stereo input passes unchanged.
export const TO_STEREO = "pan=stereo|FL=FL+FC|FR=FR+FC";

/**
 * The static gain (+ optional limiter) filter string for pass 2, from a
 * pass-1 loudness measurement of the premaster mix. Pure — reuses
 * line-level.mjs's gain/limiter math (a whole-mix master and a single line
 * are the same problem: one measured loudness -> one static gain -> a
 * ceiling-safe limiter only when that gain would cross it).
 * @param {{integratedLufs:number|null, truePeakDb:number|null}} measured
 * @returns {string} e.g. "volume=3.2000dB,alimiter=...,aresample=48000,..."
 */
export function masterGainFilter(measured) {
  const gainDb = computeLineGainDb(measured, { targetLufs: MASTER_TARGET_LUFS });
  const limit = lineNeedsLimiter(measured, gainDb, { maxTruePeakDb: MASTER_MAX_TRUE_PEAK_DB });
  return `${lineLevelFilter(gainDb, limit, { maxTruePeakDb: MASTER_MAX_TRUE_PEAK_DB })},${MASTER_TAIL}`;
}

/** Measures `premasterWavPath` (pass 1's rendered mix) and returns both the
 * measurement (for logging/reporting) and the pass-2 filter string. */
export async function measureMasterGain(premasterWavPath) {
  const measured = await measureLoudness(premasterWavPath);
  return { measured, filter: masterGainFilter(measured) };
}

/**
 * @param {{narrationIndex?:number, hasSfx:boolean, cues:{trimSec:number, peakDb:number, gainDb?:number, atSec:number, leadSec?:number}[], includeNarration?:boolean, narrationWindows?:{start:number,end:number}[], duckDb?:number, rampSec?:number}} args
 *   `narrationIndex` is narration's `-i` position in the ffmpeg command
 *   (default 1: video is always input 0). Sfx (if `hasSfx`) is assumed to
 *   be the next input, then one input per cue, in `cues` order.
 *   `includeNarration` (default true) — false builds a bed-only mix (no
 *   narration channel at all, e.g. render.mjs --no-captions' picture bed);
 *   `narrationIndex` is then just the first sfx/cue input's index instead
 *   of narration's own.
 *   `narrationWindows`/`duckDb`/`rampSec` (scripts/lib/duck.mjs) duck every
 *   cue — not `hasSfx`'s page-rendered sound, which keeps the mix it
 *   already ducked itself (the music bed's own -10dB duck) — while
 *   narration speaks; omit `narrationWindows` or pass `duckDb: 0` for no
 *   ducking (byte-identical output to before ducking existed).
 * @returns {{filterComplex:string, inputCount:number}} `inputCount` is how
 *   many audio `-i` inputs (narration [+ sfx] + cues) the caller must pass,
 *   starting at `narrationIndex`.
 */
export function buildCueMixFilter({
  narrationIndex = 1,
  hasSfx,
  cues,
  includeNarration = true,
  narrationWindows = [],
  duckDb = 0,
  rampSec,
}) {
  const parts = [];
  const sumLabels = [];
  let nextInput = narrationIndex;
  if (includeNarration) {
    parts.push(`[${narrationIndex}:a]${TO_STEREO}[voice]`);
    sumLabels.push("[voice]");
    nextInput = narrationIndex + 1;
  }
  if (hasSfx) {
    parts.push(`[${nextInput}:a]${TO_STEREO}[sfx]`);
    sumLabels.push("[sfx]");
    nextInput++;
  }

  const duckFilter = buildDuckVolumeExpr(narrationWindows, { duckDb, rampSec });

  cues.forEach((cue, i) => {
    const inIdx = nextInput + i;
    const label = `cue${i}`;
    const trimSec = cue.trimSec;
    const fadeStart = Math.max(0, trimSec - FADE_OUT_SEC);
    const gainDb = (TARGET_PEAK_DB - cue.peakDb) + (cue.gainDb || 0);
    const delayMs = Math.max(0, Math.round(cue.atSec * 1000));
    const leadSec = cue.leadSec || 0;
    const trim = leadSec > 0 ? `atrim=${leadSec}:${leadSec + trimSec},asetpts=PTS-STARTPTS` : `atrim=0:${trimSec}`;
    // adelay shifts this cue's samples onto the absolute narration
    // timeline, so a duck filter chained right after it reads `t` as the
    // film's own absolute seconds — the same seconds narrationWindows uses.
    const duckStage = duckFilter ? `,${duckFilter}` : "";
    parts.push(
      `[${inIdx}:a]${trim},${TO_STEREO},afade=t=out:st=${fadeStart}:d=${FADE_OUT_SEC},` +
        `volume=${gainDb}dB,adelay=${delayMs}:all=1${duckStage}[${label}]`
    );
    sumLabels.push(`[${label}]`);
  });

  const mixedLabel = sumLabels.length > 1 ? "[amixed]" : sumLabels[0];
  if (sumLabels.length > 1) {
    // normalize=0: each cue is already leveled (peak-normalized to -6dBFS
    // then gainDb) and narration to -16 LUFS, so no further auto-scaling is
    // wanted here. ffmpeg's default normalize=1 divides the mix by however
    // many inputs haven't yet reached EOF — since each cue is a short clip
    // that ends soon after its adelay position, that count falls as cues
    // finish, silently boosting whatever plays later even though nothing
    // about its own level changed (the actual source of a loud/quiet drift
    // this shape of graph can produce, independent of any final loudness
    // stage — measured directly: this file's own narrStage-equivalent
    // pattern in dub.mjs ranged over 20dB before dropping normalize=0, and
    // ~3dB after, even though every line was already leveled to -16 LUFS).
    // duration=longest: the mix runs until its last sound ends; the caller
    // pads and cuts it to the picture (apad + -t). duration=first would end
    // a bed at its first cue's end when the page has no renderSfx.
    parts.push(`${sumLabels.join("")}amix=inputs=${sumLabels.length}:duration=longest:dropout_transition=0:normalize=0[amixed]`);
  }
  // No loudness stage here: the caller two-pass masters [premaster] itself
  // (measureMasterGain + masterGainFilter above) and adds apad in pass 2.
  parts.push(`${mixedLabel}anull[premaster]`);

  const inputCount = (includeNarration ? 1 : 0) + (hasSfx ? 1 : 0) + cues.length;
  return { filterComplex: parts.join(";"), inputCount };
}

/**
 * A 16-bit PCM WAV written chunk by chunk, so a long bed never sits in
 * memory as one buffer. The header is written up front from `frames`; each
 * `write(channels)` appends one chunk (one array per channel, same length;
 * a missing or short channel is silence). `close()` checks that exactly
 * `frames` frames were written.
 * @param {string} outPath
 * @param {{channels:number, sampleRate:number, frames:number}} format
 */
export function createWavPcm16Writer(outPath, { channels, sampleRate, frames }) {
  const blockAlign = channels * 2;
  const dataSize = frames * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  const fd = fs.openSync(outPath, "w");
  fs.writeSync(fd, header);
  let written = 0;
  return {
    write(chunk) {
      const n = chunk.reduce((m, c) => Math.max(m, c ? c.length : 0), 0);
      const buf = Buffer.alloc(n * blockAlign);
      for (let i = 0, off = 0; i < n; i++) {
        for (let c = 0; c < channels; c++, off += 2) {
          const s = chunk[c] && i < chunk[c].length ? chunk[c][i] : 0;
          buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s || 0)) * 32767), off);
        }
      }
      fs.writeSync(fd, buf);
      written += n;
    },
    close() {
      fs.closeSync(fd);
      if (written !== frames) throw new Error(`${outPath}: wrote ${written} frames, header says ${frames}`);
    },
  };
}
