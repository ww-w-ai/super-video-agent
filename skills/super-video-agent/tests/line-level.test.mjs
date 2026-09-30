// computeLineGainDb is pure (no ffmpeg); levelLineWav is exercised elsewhere
// through voice.mjs/dub.mjs's own real-ffmpeg test runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineGainDb, lineNeedsLimiter, lineLevelFilter, LINE_TARGET_LUFS, LINE_MAX_TRUE_PEAK_DB, LINE_MAX_BOOST_DB } from "../scripts/lib/line-level.mjs";

test("computeLineGainDb: quiet line gets boosted up to target LUFS", () => {
  const gain = computeLineGainDb({ integratedLufs: -20.7, truePeakDb: -10 });
  assert.ok(Math.abs(gain - (LINE_TARGET_LUFS - -20.7)) < 1e-9, `gain=${gain}`);
});

test("computeLineGainDb: loud line gets attenuated down to target LUFS", () => {
  const gain = computeLineGainDb({ integratedLufs: -14.1, truePeakDb: -6 });
  assert.ok(Math.abs(gain - (LINE_TARGET_LUFS - -14.1)) < 1e-9, `gain=${gain}`);
  assert.ok(gain < 0);
});

test("computeLineGainDb: the peak does not cap the gain; a limiter handles the peak", () => {
  // -20 LUFS wants +4dB although the peak is already -3dBTP: the quiet line
  // still reaches the target, and the limiter catches the +1dBTP peak.
  const measured = { integratedLufs: -20, truePeakDb: -3 };
  const gain = computeLineGainDb(measured, { targetLufs: -16 });
  assert.ok(Math.abs(gain - 4) < 1e-9, `gain=${gain}`);
  assert.equal(lineNeedsLimiter(measured, gain, { maxTruePeakDb: -1.5 }), true);
  assert.equal(lineNeedsLimiter({ truePeakDb: -9 }, gain, { maxTruePeakDb: -1.5 }), false);
  assert.match(lineLevelFilter(gain, true), /^volume=4\.0000dB,alimiter=limit=0\.7943:/);
  assert.equal(lineLevelFilter(gain, false), "volume=4.0000dB");
});

test("computeLineGainDb: a near-silent take is boosted at most LINE_MAX_BOOST_DB", () => {
  assert.equal(computeLineGainDb({ integratedLufs: -60 }, { targetLufs: -16 }), LINE_MAX_BOOST_DB);
});

test("computeLineGainDb: missing/invalid loudness measurement is a no-op", () => {
  assert.equal(computeLineGainDb({ integratedLufs: null, truePeakDb: -6 }), 0);
  assert.equal(computeLineGainDb({ integratedLufs: NaN, truePeakDb: -6 }), 0);
  assert.equal(computeLineGainDb({}), 0);
});

test("computeLineGainDb: no true peak measurement still levels loudness", () => {
  const gain = computeLineGainDb({ integratedLufs: -18, truePeakDb: null });
  assert.ok(Math.abs(gain - 2) < 1e-9, `gain=${gain}`);
});

test("LINE_MAX_TRUE_PEAK_DB is the documented ceiling", () => {
  assert.equal(LINE_MAX_TRUE_PEAK_DB, -1.5);
});
