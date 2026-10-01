// The one fit rubric shared by every judge backend (Jev's `criteria` array,
// the OpenRouter fallback prompt, and the human-readable scoring sheet) and
// by `report`'s threshold — references/sound.md "Sound cards".

/** Ten levels, low to high, for a "score" question (Jev: 0..9 -> fit 1..10). */
export const FIT_CRITERIA = [
  "no relation to the on-screen event or this film's world",
  "wrong size, material and speed, and the wrong world (e.g. a gym sound in a kitchen film)",
  "wrong material or clearly the wrong world, right rough category of sound",
  "right category, several mismatches in size, speed or mood, or ignores the film's world",
  "plausible sound but generic — could sit in any film, does not read as this film's world",
  "fits the event loosely; whether it belongs to this film's world is unclear",
  "fits the event; mostly reads as belonging to this film's world",
  "fits the event's size, material and speed; reads as belonging to this film's world",
  "fits the event tightly and clearly belongs to this film's world and topic",
  "exact match: size, material, speed, mood and this film's world all fit",
];

/** report warns below this fit score (owner: 8). One named constant — sfx-cards.mjs and the sheet both read it. */
export const FIT_THRESHOLD = 8;

export const FIT_INSTRUCTIONS =
  "Score how well this sound fits the on-screen event's size, material and speed, this film's " +
  "mood, and this film's world/topic (e.g. a kitchen promo must not sound like a gym or a " +
  "basketball court). A library or kit sound scores low if it would work just as well in an " +
  "unrelated film.";

/** Jev's own two-level "score" question (0..1, stable — Jev drifts on finer-grained criteria
 *  lists). fit = score * 10 keeps it on the same 1..10 scale as the rubric above, so
 *  FIT_THRESHOLD (8) applies unchanged: JEV_PASS (0.8) * 10 = 8. */
export const JEV_FIT_INSTRUCTIONS =
  "Does this sound fit the on-screen event (size, material, speed), this film's mood, and this " +
  "film's world/topic well enough to use as is? A generic sound that would fit any film, or one " +
  "from another world (e.g. a gym sound in a kitchen film), does not fit.";

export const JEV_FIT_CRITERIA = [
  "does not fit: make a new sound for this film instead",
  "fits tightly and clearly belongs to this film's world: use it as is",
];

/** report warns below fit = JEV_PASS * 10 (0.8 * 10 = 8, same line as FIT_THRESHOLD). */
export const JEV_PASS = 0.8;

/**
 * Which span of the sound the measurements cover: "0.00-3.00s of a 10.25s file"
 * for a trimmed library asset, "the whole 0.94s file" for an untrimmed one,
 * "the whole 0.35s sound" when there is no fileSec (a kit/custom stem, or
 * an asset measured before fileSec existed — then the whole file).
 */
export function describeSpan(measured) {
  if (!measured) return "(not measured)";
  const d = measured.durationSec.toFixed(2);
  if (measured.fileSec == null) return `the whole ${d}s sound`;
  if (measured.fileSec - measured.durationSec < 0.005) return `the whole ${d}s file`;
  return `0.00-${d}s of a ${measured.fileSec.toFixed(2)}s file`;
}

/** One line per measured feature, or "(not measured)" — shared by the Jev prompt and the sheet. */
export function describeMeasured(measured) {
  if (!measured) return "(not measured)";
  const lufs = measured.lufs == null ? "n/a" : `${measured.lufs.toFixed(1)} LUFS`;
  return (
    `over ${describeSpan(measured)}: ` +
    `duration ${measured.durationSec.toFixed(2)}s, peak ${measured.peakDb.toFixed(1)}dB, ` +
    `${lufs}, attack ${measured.attackMs.toFixed(1)}ms, brightness ${Math.round(measured.brightnessHz)}Hz, ` +
    `pitch ${measured.pitchTrend}, noisiness ${measured.noisiness.toFixed(2)}`
  );
}
