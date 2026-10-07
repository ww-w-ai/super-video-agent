// Pure-logic tests for markOnsetOffset (scripts/lib/sync-marks.mjs): a
// synthetic effects-only stem plus a full-mix voice that starts 100ms
// earlier than the mark — measuring the mix directly finds the voice's
// onset instead of the effect's; measuring the isolated stem does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markOnsetOffset, nearestStemByAt, pictureSampleTimes, pictureBeat, syncVerdict } from "../scripts/lib/sync-marks.mjs";
import { syncMarksLine } from "../scripts/review.mjs";

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

// ---- the picture side (defect: the stem-only check read 0 ms for every cue,
// so a cue drawn off its picture beat could never fail) -------------------


const W = 64 * 36;
const blank = () => new Uint8Array(W);
const lit = () => {
  const f = new Uint8Array(W);
  for (let i = 0; i < W / 4; i++) f[i] = 255;
  return f;
};

test("pictureSampleTimes: frame-aligned, clamped to 0 and to the duration", () => {
  const t = pictureSampleTimes(0.1, 30, { windowSec: 0.3 });
  assert.equal(t[0], 0);
  assert.ok(t.every((x) => Math.abs(x * 30 - Math.round(x * 30)) < 1e-9));
  const end = pictureSampleTimes(9.9, 30, { windowSec: 0.3, duration: 10 });
  assert.equal(end[end.length - 1], 10);
});

test("pictureBeat: the step between two frames is the beat (midpoint); steady motion or no change is not measured", () => {
  const fps = 30;
  const times = pictureSampleTimes(1.0, fps);
  const frames = times.map((t) => (t >= 1.0 - 1e-9 ? lit() : blank()));
  const { beat } = pictureBeat(times, frames);
  assert.ok(Math.abs(beat.atSec - (1.0 - 0.5 / fps)) < 1e-9, `beat at ${beat.atSec}`);

  const still = pictureBeat(times, times.map(() => blank()));
  assert.equal(still.beat, null);
  assert.match(still.reason, /does not change/);

  // every frame differs from the last by the same amount: a pan, not a hit
  const pan = pictureBeat(times, times.map((_, k) => (k % 2 ? lit() : blank())));
  assert.equal(pan.beat, null);
  assert.match(pan.reason, /stands out/);
});

test("pictureBeat: a hit that sets off a growing reaction is timed where the burst starts, not at its peak", () => {
  const fps = 30;
  const times = Array.from({ length: 19 }, (_, k) => 3.9 + k / fps);
  const level = (k) => [5, 5, 5, 5, 5, 5, 5, 5, 5, 11, 13, 14, 13, 11, 11, 12, 11, 12][k]; // % of pixels changed between frame k and k+1
  let prev = blank();
  const frames = [prev];
  for (let k = 0; k < times.length - 1; k++) {
    const next = Uint8Array.from(prev);
    const n = Math.round((level(k) / 100) * W);
    for (let i = 0; i < n; i++) next[(k * 97 + i) % W] = next[(k * 97 + i) % W] ? 0 : 255;
    frames.push(next);
    prev = next;
  }
  const { beat } = pictureBeat(times, frames);
  assert.ok(Math.abs(beat.atSec - (times[9] + times[10]) / 2) < 1e-9, `beat at ${beat.atSec}, burst starts between ${times[9]} and ${times[10]}`);
});

test("syncVerdict: a cue 200 ms after its picture beat fails even though its own stem reads 0 ms", () => {
  const beat = { atSec: 1.0 - 0.5 / 30 };
  const onBeat = syncVerdict({ at: 1.0, sync: true }, { soundOnsetMs: 0, beat, minMs: -20, maxMs: 40 });
  assert.equal(onBeat.measured, true);
  assert.equal(onBeat.pass, true);
  const late = syncVerdict({ at: 1.2, sync: true }, { soundOnsetMs: 0, beat, minMs: -20, maxMs: 40 });
  assert.equal(late.offsetMs, 217);
  assert.equal(late.pass, false);
  const unknown = syncVerdict({ at: 1.2, sync: true }, { soundOnsetMs: 0, beat: null, reason: "x", minMs: -20, maxMs: 40 });
  assert.equal(unknown.measured, false);
  assert.equal(unknown.pass, null, "not measured is neither a pass nor a fail");
  assert.equal(unknown.offsetMs, null, "never a passing 0 ms");
});

test("syncMarksLine: says NOT MEASURED when no sync mark could be compared with the picture", () => {
  const line = syncMarksLine([{ at: 4.2, kind: "drop", sync: true, measured: false, notMeasured: "the picture does not change near the mark", pass: null, source: "stems" }]);
  assert.match(line, /\[NOT MEASURED\]/);
  assert.match(line, /drop@4\.20s not measured/);
  const fail = syncMarksLine([{ at: 1.2, kind: "thud", sync: true, measured: true, offsetMs: 217, pictureAt: 0.983, pass: false, source: "stems" }]);
  assert.match(fail, /thud@1\.20s \+217ms vs picture 0\.983s.*\[FAIL\]/);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const hasBrowser = fs.existsSync(path.join(here, "..", "node_modules", "playwright-core", "index.mjs"));

test("grayFramesBySeek + pictureBeat on a real page: finds the frame a square appears on", { skip: !hasBrowser && "playwright-core not installed" }, async () => {
  const { serveDir } = await import("../scripts/lib/server.mjs");
  const { openReel, grayFramesBySeek } = await import("../scripts/lib/browser.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-beat-"));
  fs.writeFileSync(
    path.join(dir, "reel.html"),
    `<!doctype html><html><body><canvas width="320" height="180"></canvas><script>
var ctx = document.querySelector("canvas").getContext("2d");
window.Reel = { clearIssues: function () {} };
window.__reel = { width: 320, height: 180, fps: 30, duration: 3, shots: [], ready: Promise.resolve(),
  issues: function () { return []; },
  seek: function (t) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 320, 180);
    if (t >= 1.0) { ctx.fillStyle = "#fff"; ctx.fillRect(100, 40, 120, 100); } } };
</script></body></html>`
  );
  const server = await serveDir(dir);
  let session;
  try {
    session = await openReel(server.url, {});
    for (const [at, expectPass] of [[1.0, true], [1.2, false]]) {
      const times = pictureSampleTimes(at, 30, { duration: 3 });
      const frames = await grayFramesBySeek(session.page, times, { width: 256 });
      const { beat } = pictureBeat(times, frames);
      assert.ok(beat && Math.abs(beat.atSec - (1.0 - 0.5 / 30)) < 1e-6, `beat for mark ${at}: ${beat && beat.atSec}`);
      const v = syncVerdict({ at, sync: true }, { soundOnsetMs: 0, beat, minMs: -20, maxMs: 40 });
      assert.equal(v.pass, expectPass, `mark at ${at}: offset ${v.offsetMs}ms`);
    }
  } finally {
    if (session) await session.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
