// Shared helpers for a plan.json's line-level asset cues (design.md §2.5),
// used by both assets.mjs (fetch) and verify.mjs (drift warning).

/** Every {lineId, ...cue} across plan.lines[].cues, in plan order. */
export function collectPlanCues(plan) {
  const out = [];
  for (const line of (plan && plan.lines) || []) {
    for (const cue of line.cues || []) {
      out.push({ lineId: line.id, ...cue });
    }
  }
  return out;
}

/** Default `play` for a cue whose asset has the given library role. */
export function defaultPlay(role) {
  return role === "reaction" ? "both" : "sound";
}

/** The per-cue fade fields (audio-mix.mjs resolveCueFades), in the order the page template copies them. */
export const CUE_FADE_KEYS = ["fadeInSec", "fadeOutSec", "crossfadeSec", "endsAtCut", "track"];

/** The fade fields `cue` sets; those it leaves out stay out. */
export function cueFadeFields(cue) {
  const out = {};
  for (const key of CUE_FADE_KEYS) if (cue[key] != null) out[key] = cue[key];
  return out;
}

/** A stable string key identifying "the same cue" across plan.json and cues.json. */
export function cueKey(cue) {
  return `${cue.lineId}\u0000${cue.asset}\u0000${cue.at}\u0000${cue.offsetMs || 0}`;
}
