// The sentence every "checked nothing" message ends with. A check with no targets is neither a pass nor a
// fail; the reader decides whether this film needs the check at all, and the fix is to make the targets
// and rerun that one check, not the whole run.

/**
 * @param {string} [targets] what the check reads, in words (e.g. "a word cue in plan.json"); omit for a generic line
 * @returns {string} one sentence, no trailing newline
 */
export function checkedNothingNext(targets) {
  const make = targets ? `make ${targets}` : "make its targets";
  return `Confirm this video needs this check; if it does, ${make} and rerun only this check.`;
}
