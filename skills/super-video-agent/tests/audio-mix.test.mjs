// Pure unit tests for scripts/lib/audio-mix.mjs's ffmpeg filter_complex
// builder (design.md §2.5 "Sound") — no ffmpeg involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCueMixFilter, masterGainFilter, MASTER_TARGET_LUFS, MASTER_MAX_TRUE_PEAK_DB, TO_STEREO } from "../scripts/lib/audio-mix.mjs";

// narrationIndex:0 in these tests keeps the label indices readable
// (narration=0, sfx=1, cues after); render.mjs uses the real default
// (narrationIndex:1, since the video is always ffmpeg input 0) — see the
// dedicated default-index test below.

test("buildCueMixFilter: no cues -> mixes narration alone (sanity; render.mjs skips this path entirely when cues is empty)", () => {
  const { filterComplex, inputCount } = buildCueMixFilter({ narrationIndex: 0, hasSfx: false, cues: [] });
  assert.equal(inputCount, 1); // narration only
  assert.equal(filterComplex, `[0:a]${TO_STEREO}[voice];[voice]anull[premaster]`);
  assert.doesNotMatch(filterComplex, /amix/);
});

test("buildCueMixFilter: one cue, no sfx — trims, fades, normalizes to -6dBFS, delays, mixes with narration", () => {
  const { filterComplex, inputCount } = buildCueMixFilter({
    narrationIndex: 0,
    hasSfx: false,
    cues: [{ trimSec: 0.8, peakDb: -12, gainDb: 2, atSec: 1.5 }],
  });
  assert.equal(inputCount, 2); // narration(0) + cue(1)
  assert.match(filterComplex, /\[1:a\]atrim=0:0\.8/);
  assert.match(filterComplex, /afade=t=out:st=0\.77:d=0\.03/); // trimSec - 30ms fade
  assert.match(filterComplex, /volume=8dB/); // (-6 - -12) + 2 = 8
  assert.match(filterComplex, /adelay=1500:all=1/);
  assert.match(filterComplex, /amix=inputs=2:duration=longest/);
  assert.match(filterComplex, /\[premaster\]$/);
});

test("buildCueMixFilter: sfx + two cues — input indices follow narration(0), sfx(1), cue0(2), cue1(3)", () => {
  const { filterComplex, inputCount } = buildCueMixFilter({
    narrationIndex: 0,
    hasSfx: true,
    cues: [
      { trimSec: 0.5, peakDb: -6, gainDb: 0, atSec: 0 },
      { trimSec: 1, peakDb: -20, gainDb: -3, atSec: 2 },
    ],
  });
  assert.equal(inputCount, 4);
  assert.match(filterComplex, /\[2:a\]atrim=0:0\.5.*\[cue0\]/);
  assert.match(filterComplex, /\[3:a\]atrim=0:1.*\[cue1\]/);
  assert.match(filterComplex, /\[0:a\]pan=stereo[^;]*\[voice\];\[1:a\]pan=stereo[^;]*\[sfx\]/);
  assert.match(filterComplex, /\[voice\]\[sfx\]\[cue0\]\[cue1\]amix=inputs=4/);
});

test("buildCueMixFilter: gainDb defaults to 0 when omitted", () => {
  const { filterComplex } = buildCueMixFilter({
    narrationIndex: 0,
    hasSfx: false,
    cues: [{ trimSec: 1, peakDb: -6, atSec: 0 }],
  });
  assert.match(filterComplex, /volume=0dB/); // (-6 - -6) + 0
});

test("buildCueMixFilter: negative delay clamps to 0ms", () => {
  const { filterComplex } = buildCueMixFilter({
    narrationIndex: 0,
    hasSfx: false,
    cues: [{ trimSec: 1, peakDb: -6, atSec: -0.2 }],
  });
  assert.match(filterComplex, /adelay=0:all=1/);
});

test("buildCueMixFilter: default narrationIndex is 1 (video is always ffmpeg input 0)", () => {
  const { filterComplex, inputCount } = buildCueMixFilter({
    hasSfx: true,
    cues: [{ trimSec: 0.5, peakDb: -6, atSec: 0 }],
  });
  assert.equal(inputCount, 3); // narration + sfx + 1 cue
  assert.match(filterComplex, /\[3:a\]atrim=0:0\.5.*\[cue0\]/); // narration(1), sfx(2), cue0(3)
  assert.match(filterComplex, /\[1:a\]pan=stereo[^;]*\[voice\];\[2:a\]pan=stereo[^;]*\[sfx\]/); // narration at 1, not 0 (0 is the video input)
  assert.match(filterComplex, /\[voice\]\[sfx\]\[cue0\]amix=inputs=3/);
});

test("buildCueMixFilter: leadSec skips a sound file's head silence before the delay", () => {
  const { filterComplex } = buildCueMixFilter({ hasSfx: false, cues: [{ trimSec: 1, peakDb: -6, atSec: 2, leadSec: 0.08 }] });
  assert.match(filterComplex, /atrim=0\.08:1\.08,asetpts=PTS-STARTPTS/);
  assert.match(filterComplex, /adelay=2000:all=1/);
});

// ---- includeNarration:false — render.mjs --no-captions' picture bed
// (no narration exists yet, only the page's own sound) -------------------

test("buildCueMixFilter: includeNarration:false with sfx + one cue mixes sfx and the cue, no narration channel", () => {
  const { filterComplex, inputCount } = buildCueMixFilter({
    narrationIndex: 0, // first input is sfx here, not narration
    hasSfx: true,
    cues: [{ trimSec: 0.5, peakDb: -6, atSec: 1, gainDb: 0 }],
    includeNarration: false,
  });
  assert.equal(inputCount, 2); // sfx + cue, no narration
  assert.match(filterComplex, /\[1:a\]atrim=0:0\.5.*\[cue0\]/); // cue is input 1 (sfx is input 0)
  assert.match(filterComplex, /\[0:a\]pan=stereo[^;]*\[sfx\]/);
  assert.match(filterComplex, /\[sfx\]\[cue0\]amix=inputs=2/);
  assert.doesNotMatch(filterComplex, /\[voice\]/);
  assert.doesNotMatch(filterComplex, /amix=inputs=3/);
});

// ---- ducking (scripts/lib/duck.mjs) — every cue dips under narration ----

test("buildCueMixFilter: duckDb 0 appends no duck stage; left out, the duck.mjs defaults duck the cue", () => {
  const args = { narrationIndex: 0, hasSfx: false, cues: [{ trimSec: 0.8, peakDb: -12, gainDb: 2, atSec: 1.5 }], narrationWindows: [{ start: 0, end: 1 }] };
  assert.doesNotMatch(buildCueMixFilter({ ...args, duckDb: 0 }).filterComplex, /volume=eval=frame/);
  assert.match(buildCueMixFilter(args).filterComplex, /volume=eval=frame/);
  assert.equal(buildCueMixFilter(args).filterComplex, buildCueMixFilter({ ...args, duckDb: -2.5, rampSec: 0.8 }).filterComplex);
});

test("buildCueMixFilter: a nonzero duckDb with narrationWindows chains the duck filter after adelay, before the label", () => {
  const { filterComplex } = buildCueMixFilter({
    narrationIndex: 0,
    hasSfx: false,
    cues: [{ trimSec: 0.8, peakDb: -12, gainDb: 2, atSec: 1.5 }],
    narrationWindows: [{ start: 0, end: 1 }],
    duckDb: -6,
  });
  assert.match(filterComplex, /adelay=1500:all=1,volume=eval=frame:volume='.*'\[cue0\]/);
});

test("buildCueMixFilter: includeNarration:false with only cues (no sfx) mixes cues alone", () => {
  const { filterComplex, inputCount } = buildCueMixFilter({
    narrationIndex: 0,
    hasSfx: false,
    cues: [
      { trimSec: 0.5, peakDb: -6, atSec: 0 },
      { trimSec: 1, peakDb: -6, atSec: 2 },
    ],
    includeNarration: false,
  });
  assert.equal(inputCount, 2); // two cues, no narration, no sfx
  assert.match(filterComplex, /\[0:a\]atrim=0:0\.5.*\[cue0\]/);
  assert.match(filterComplex, /\[1:a\]atrim=0:1.*\[cue1\]/);
  assert.match(filterComplex, /\[cue0\]\[cue1\]amix=inputs=2/);
});

// ---- masterGainFilter — two-pass mastering's pure gain/limiter builder ----
// (measureMasterGain wraps ffmpeg's ebur128 measurement, exercised for real
// via render.mjs/dub.mjs's own real-ffmpeg test runs).

test("masterGainFilter: targets MASTER_TARGET_LUFS as a single static gain, no limiter needed", () => {
  const filter = masterGainFilter({ integratedLufs: -22, truePeakDb: -10 });
  assert.equal(MASTER_TARGET_LUFS, -16);
  assert.match(filter, /^volume=6\.0000dB,aresample=48000,aformat=channel_layouts=stereo,asetpts=N\/SR\/TB$/); // -16 - -22 = 6dB, no alimiter stage
});

test("masterGainFilter: adds a limiter only when the gained peak would cross the true-peak ceiling", () => {
  const filter = masterGainFilter({ integratedLufs: -20, truePeakDb: -3 });
  assert.equal(MASTER_MAX_TRUE_PEAK_DB, -1.5);
  // gain = 4dB, peak -3 + 4 = 1 > -1.5dBTP -> limiter kicks in
  assert.match(filter, /^volume=4\.0000dB,alimiter=limit=0\.7943:attack=5:release=50:level=disabled,aresample=48000/);
});

test("masterGainFilter: attenuates a mix measured louder than target (no ramp — one static number)", () => {
  const filter = masterGainFilter({ integratedLufs: -12, truePeakDb: -6 });
  assert.match(filter, /^volume=-4\.0000dB,aresample=48000/);
});
