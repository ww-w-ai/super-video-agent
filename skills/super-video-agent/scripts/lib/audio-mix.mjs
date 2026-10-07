// Builds the ffmpeg filter_complex that mixes library sound cues
// (design.md §2.5 "Sound") into a film's audio: each cue is trimmed to
// maxSec (or its own length), peak-normalized to -6 dBFS then `gainDb`, faded
// (30 ms out by default; `fadeInSec`, `fadeOutSec`, `endsAtCut`, `crossfadeSec` per cue), delayed to its cue time, ducked under narration
// (references/sound.md "Mix" — meta.sound.sfxDuckDb, else the duck.mjs defaults:
// -2.5 dB, 0.8 s ramps, gaps under 1.5 s held; no ducking when duckDb is 0 or no
// narrationWindows are given), and summed with narration
// (+ optional page SFX) into `[premaster]` — the mix before mastering. A
// pure function of its inputs so the graph shape can be unit-tested
// without ffmpeg: render.mjs supplies each cue's measured peak dB and trim
// length, then two-pass masters `[premaster]` itself (see masterGainFilter
// below).
import fs from "node:fs";
import { buildDuckVolumeExpr } from "./duck.mjs";
import { measureLoudness } from "./audio-analysis.mjs";
import { computeLineGainDb, lineNeedsLimiter, lineLevelFilter, LINE_MAX_BOOST_DB } from "./line-level.mjs";

const FADE_OUT_SEC = 0.03;
/** Default fade-out of a cue that ends at a picture cut (`endsAtCut`). */
export const CUT_FADE_OUT_SEC = 0.6;
const MIN_CUE_SEC = 0.05;
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

/**
 * What the master gain did, as facts: the gain it applied, whether the boost cap (LINE_MAX_BOOST_DB, +12 dB) held it
 * under what MASTER_TARGET_LUFS needs, and by how many dB the film then sits under the target. Pure.
 * @param {{integratedLufs:number|null}} measured
 * @returns {{gainDb:number, wantedDb:number, capped:boolean, shortDb:number}|null} null when the mix has no loudness
 */
export function masterGainReport(measured) {
  const lufs = measured && measured.integratedLufs;
  if (lufs == null || !Number.isFinite(lufs)) return null;
  const wantedDb = MASTER_TARGET_LUFS - lufs;
  const gainDb = computeLineGainDb(measured, { targetLufs: MASTER_TARGET_LUFS });
  return { gainDb, wantedDb, capped: wantedDb > LINE_MAX_BOOST_DB + 0.05, shortDb: Math.max(0, wantedDb - gainDb) };
}

/**
 * review.mjs's loudness fact: how far a finished file sits under the master target. Null when it is within
 * 0.5 dB or has no loudness. The cap is named because it is the usual cause in a sparse mix. Pure.
 * @param {number|null} integratedLufs
 * @returns {{targetLufs:number, underDb:number, text:string}|null}
 */
export function loudnessUnderTarget(integratedLufs) {
  if (integratedLufs == null || !Number.isFinite(integratedLufs)) return null;
  const underDb = MASTER_TARGET_LUFS - integratedLufs;
  if (underDb <= 0.5) return null;
  return {
    targetLufs: MASTER_TARGET_LUFS,
    underDb,
    text: `loudness: I=${integratedLufs.toFixed(1)} LUFS sits ${underDb.toFixed(1)} dB under the ${MASTER_TARGET_LUFS} LUFS master target; the master gain is capped at +${LINE_MAX_BOOST_DB} dB and peaks are held at ${MASTER_MAX_TRUE_PEAK_DB} dBTP, so a sparse mix stays under it (raise the page's own sound level, references/sound.md "Mix")`,
  };
}

/** The line render.mjs prints when the cap held the master gain; "" when it did not. */
export function formatMasterCap(report, measured) {
  if (!report || !report.capped) return "";
  return `master gain capped at +${LINE_MAX_BOOST_DB} dB: the mix measured ${measured.integratedLufs.toFixed(1)} LUFS, so the film sits ${report.shortDb.toFixed(1)} dB under ${MASTER_TARGET_LUFS} LUFS (raise the page's own sound level; references/sound.md "Mix")\n`;
}

/** Measures `premasterWavPath` (pass 1's rendered mix) and returns both the
 * measurement (for logging/reporting), the pass-2 filter string and the gain report. */
export async function measureMasterGain(premasterWavPath) {
  const measured = await measureLoudness(premasterWavPath);
  return { measured, filter: masterGainFilter(measured), report: masterGainReport(measured) };
}

/** A sound's final decrease at the picture boundary. Zero explicitly chooses a hard cut. */
export function endFadeFilter(durationSec, fadeOutSec = FADE_OUT_SEC) {
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("fade duration must be positive seconds");
  if (!Number.isFinite(fadeOutSec) || fadeOutSec < 0) throw new Error("fadeOutSec must be nonnegative seconds");
  if (fadeOutSec === 0) return "anull";
  const fade = Math.min(fadeOutSec, duration);
  return `afade=t=out:st=${Math.max(0, duration - fade)}:d=${fade}`;
}

/**
 * A cue's fade-in, fade-out and length, from its own fields and the cue that follows it on its track.
 * Fade-out: `fadeOutSec`, else CUT_FADE_OUT_SEC (at most half the cue) when `endsAtCut`, else the
 * short default. Fade-in: `fadeInSec`, else none. A cue with `crossfadeSec` and a `track` crossfades
 * with the next cue on that track: it runs `crossfadeSec` past that cue's start and fades out over
 * it while the next cue fades in over the same span.
 * @param {{trimSec:number, atSec:number, fadeInSec?:number, fadeOutSec?:number, endsAtCut?:boolean, crossfadeSec?:number, track?:string}[]} cues
 * @returns {{trimSec:number, fadeInSec:number, fadeOutSec:number}[]}
 */
export function resolveCueFades(cues) {
  const out = cues.map((c) => ({ trimSec: c.trimSec, fadeInSec: c.fadeInSec || 0, fadeOutSec: ownFadeOutSec(c) }));
  cues.forEach((cue, i) => {
    const j = crossfadePartner(cues, i);
    if (j < 0) return;
    const over = cue.crossfadeSec;
    out[i].trimSec = Math.max(MIN_CUE_SEC, cues[j].atSec + over - cue.atSec);
    out[i].fadeOutSec = over;
    out[j].fadeInSec = Math.max(out[j].fadeInSec, over);
  });
  return out.map((o) => ({ trimSec: o.trimSec, fadeInSec: Math.min(o.fadeInSec, o.trimSec), fadeOutSec: Math.min(o.fadeOutSec, o.trimSec) }));
}

function ownFadeOutSec(cue) {
  if (cue.fadeOutSec != null) return cue.fadeOutSec;
  return cue.endsAtCut ? Math.min(CUT_FADE_OUT_SEC, cue.trimSec / 2) : FADE_OUT_SEC;
}

/** Index of the next cue on cue `i`'s track that starts by the time `i` ends plus its crossfade, else -1. */
function crossfadePartner(cues, i) {
  const cue = cues[i];
  if (!(cue.crossfadeSec > 0) || cue.track == null) return -1;
  let best = -1;
  cues.forEach((other, j) => {
    if (j === i || other.track !== cue.track || other.atSec < cue.atSec) return;
    if (other.atSec === cue.atSec && j < i) return;
    if (best < 0 || other.atSec < cues[best].atSec) best = j;
  });
  return best >= 0 && cues[best].atSec <= cue.atSec + cue.trimSec + cue.crossfadeSec ? best : -1;
}

/**
 * @param {{narrationIndex?:number, hasSfx:boolean, cues:{trimSec:number, peakDb:number, gainDb?:number, atSec:number, leadSec?:number, fadeInSec?:number, fadeOutSec?:number, endsAtCut?:boolean, crossfadeSec?:number, track?:string}[], includeNarration?:boolean, narrationWindows?:{start:number,end:number}[], duckDb?:number, rampSec?:number, durationSec?:number, fadeOutSec?:number}} args
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
 *   narration speaks; `duckDb`/`rampSec` left out use the duck.mjs defaults;
 *   omit `narrationWindows` or pass `duckDb: 0` for no ducking.
 *   `durationSec` fades sounds at the picture boundary; `fadeOutSec: 0` deliberately cuts them.
 *   Narration retains its own clip edges.
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
  duckDb,
  rampSec,
  durationSec,
  fadeOutSec,
}) {
  const endFade = durationSec == null ? "" : `,${endFadeFilter(durationSec, fadeOutSec)}`;
  const parts = [];
  const sumLabels = [];
  let nextInput = narrationIndex;
  if (includeNarration) {
    parts.push(`[${narrationIndex}:a]${TO_STEREO}[voice]`);
    sumLabels.push("[voice]");
    nextInput = narrationIndex + 1;
  }
  if (hasSfx) {
    parts.push(`[${nextInput}:a]${TO_STEREO}${endFade}[sfx]`);
    sumLabels.push("[sfx]");
    nextInput++;
  }

  const duckFilter = buildDuckVolumeExpr(narrationWindows, { duckDb, rampSec });

  const fades = resolveCueFades(cues);
  cues.forEach((cue, i) => {
    const inIdx = nextInput + i;
    const label = `cue${i}`;
    const { trimSec, fadeInSec, fadeOutSec } = fades[i];
    const fadeStart = Math.max(0, trimSec - fadeOutSec);
    const gainDb = (TARGET_PEAK_DB - cue.peakDb) + (cue.gainDb || 0);
    const delayMs = Math.max(0, Math.round(cue.atSec * 1000));
    const leadSec = cue.leadSec || 0;
    const trim = leadSec > 0 ? `atrim=${leadSec}:${leadSec + trimSec},asetpts=PTS-STARTPTS` : `atrim=0:${trimSec}`;
    // The source is leveled first (volume), then faded: a fade is never undone by the level.
    const fadeIn = fadeInSec > 0 ? `afade=t=in:st=0:d=${fadeInSec},` : "";
    const fadeOut = fadeOutSec > 0 ? `afade=t=out:st=${fadeStart}:d=${fadeOutSec},` : "";
    // adelay shifts this cue's samples onto the absolute narration
    // timeline, so a duck filter chained right after it reads `t` as the
    // film's own absolute seconds — the same seconds narrationWindows uses.
    const duckStage = duckFilter ? `,${duckFilter}` : "";
    parts.push(
      `[${inIdx}:a]${trim},${TO_STEREO},volume=${gainDb}dB,${fadeIn}` +
        `${fadeOut}adelay=${delayMs}:all=1${duckStage}${endFade}[${label}]`
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
