// Pure-logic tests for markOnsetOffset (scripts/lib/sync-marks.mjs): a
// synthetic effects-only stem plus a full-mix voice that starts 100ms
// earlier than the mark — measuring the mix directly finds the voice's
// onset instead of the effect's; measuring the isolated stem does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { markOnsetOffset, nearestStemByAt } from "../scripts/lib/sync-marks.mjs";

const SR = 48000;

/** A synthetic hard-onset step: 0 up to `onsetSec`, then `amp` for the rest of a `totalSec`-long buffer. */
function silenceThenStep(sampleRate, { totalSec, onsetSec, amp }) {
  const n = Math.round(totalSec * sampleRate);
  const buf = new Float32Array(n);
  const onsetIdx = Math.round(onsetSec * sampleRate);
  for (let i = onsetIdx; i < n; i++) buf[i] = amp;
  return buf;
}

function mixInto(target, source, startSec, sampleRate) {
  const startIdx = Math.round(startSec * sampleRate);
  for (let i = 0; i < source.length; i++) {
    const idx = startIdx + i;
    if (idx >= 0 && idx < target.length) target[idx] += source[i];
  }
}

test("markOnsetOffset: measuring the effects-only stem is not fooled by an earlier, louder voice onset in the mix", () => {
  const markAt = 1.0;

  // The effect's own isolated stem: onset 20ms into its own buffer (a small
  // rendering delay), amplitude 0.6.
  const effectStem = silenceThenStep(SR, { totalSec: 0.15, onsetSec: 0.02, amp: 0.6 });

  // The full mix: a much louder voice starts 100ms *before* the mark and
  // keeps going; the (ducked, quieter) effect lands near the mark.
  const mixPcm = new Float32Array(Math.round(2 * SR));
  const voice = silenceThenStep(SR, { totalSec: 0.4, onsetSec: 0, amp: 1.0 });
  mixInto(mixPcm, voice, markAt - 0.1, SR);
  const effectInMix = silenceThenStep(SR, { totalSec: 0.1, onsetSec: 0.02, amp: 0.2 });
  mixInto(mixPcm, effectInMix, markAt, SR);

  const mark = { at: markAt, kind: "click", sync: true };
  const stems = [{ id: "click@1", at: markAt, L: Array.from(effectStem) }];

  const stemsResult = markOnsetOffset(mark, { stems, mixPcm, sampleRate: SR, windowSec: 0.15 });
  assert.equal(stemsResult.source, "stems");
  assert.ok(
    stemsResult.offsetMs != null && Math.abs(stemsResult.offsetMs - 20) <= 10,
    `expected ~20ms offset from the isolated stem, got ${stemsResult.offsetMs}`
  );

  const mixResult = markOnsetOffset(mark, { stems: [], mixPcm, sampleRate: SR, windowSec: 0.15 });
  assert.equal(mixResult.source, "mix");
  assert.ok(
    mixResult.offsetMs != null && mixResult.offsetMs < -50,
    `expected the mix fallback to be fooled by the earlier, louder voice onset, got ${mixResult.offsetMs}`
  );
});

test("nearestStemByAt: matches within tolerance, null outside it", () => {
  const stems = [{ id: "a", at: 1.0 }, { id: "b", at: 5.0 }];
  assert.equal(nearestStemByAt(stems, 1.02, 0.1).id, "a");
  assert.equal(nearestStemByAt(stems, 1.5, 0.1), null);
});
