// measureMasterGain (scripts/lib/audio-mix.mjs): a static gain lands on the master target in one
// pass; when the limiter works it takes loudness away, so the gain before the same limiter is
// corrected from measurements until it lands within MASTER_TOLERANCE_LU, a bounded number of times.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  measureMasterGain,
  masterGainFilter,
  createWavPcm16Writer,
  MASTER_TARGET_LUFS,
  MASTER_TOLERANCE_LU,
  MASTER_MAX_CORRECTIONS,
} from "../scripts/lib/audio-mix.mjs";
import { measureLoudness } from "../scripts/lib/audio-analysis.mjs";

const roots = [];
after(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

// A fake meter: the premaster measures `lufs`/`peak`; through a filter it lands at
// lufs + gain * slope while a limiter is in the filter, lufs + gain without one.
function fakeMeter({ lufs, peak, slope }) {
  const calls = [];
  const measure = async (_file, opts = {}) => {
    calls.push(opts.filter || null);
    if (!opts.filter) return { integratedLufs: lufs, truePeakDb: peak };
    const gain = Number(/volume=(-?[\d.]+)dB/.exec(opts.filter)[1]);
    return { integratedLufs: lufs + gain * (/alimiter/.test(opts.filter) ? slope : 1), truePeakDb: -2 };
  };
  return { measure, calls };
}

test("measureMasterGain: no limiter needed -> one measurement, the static gain", async () => {
  const m = fakeMeter({ lufs: -22, peak: -10, slope: 1 });
  const r = await measureMasterGain("pre.wav", { measure: m.measure });
  assert.equal(m.calls.length, 1);
  assert.equal(r.filter, masterGainFilter({ integratedLufs: -22, truePeakDb: -10 }));
  assert.equal(r.report.passes, undefined);
});

test("measureMasterGain: the limiter takes loudness away -> corrected until within tolerance", async () => {
  // Each dB of gain buys about 0.8 LU through the limiter, so the one-pass gain lands about 0.8 LU short.
  const m = fakeMeter({ lufs: -20.1, peak: -1, slope: 0.8 });
  const r = await measureMasterGain("pre.wav", { measure: m.measure });
  const last = r.report.passes[r.report.passes.length - 1];
  assert.ok(Math.abs(last.landedLufs - MASTER_TARGET_LUFS) <= MASTER_TOLERANCE_LU, `landed ${last.landedLufs}`);
  assert.ok(r.report.passes[0].landedLufs < MASTER_TARGET_LUFS - MASTER_TOLERANCE_LU, "the uncorrected gain was short");
  assert.ok(m.calls.length <= MASTER_MAX_CORRECTIONS + 2, "bounded: first measurement + at most MAX+1 checks");
  assert.match(r.filter, new RegExp(`^volume=${last.gainDb.toFixed(4)}dB,alimiter=`), "the returned filter is the one last measured");
});

test("measureMasterGain: a correction never passes the +12 dB boost cap, and says it was capped", async () => {
  const m = fakeMeter({ lufs: -30, peak: -1, slope: 0.3 });
  const r = await measureMasterGain("pre.wav", { measure: m.measure });
  assert.equal(r.report.gainDb, 12);
  assert.equal(r.report.capped, true);
  assert.ok(r.report.shortDb > MASTER_TOLERANCE_LU);
});

// A real mix where peaks carry most of the loudness: the -2 dBFS limiter takes 1.3 LU from a
// +0.5 dB gain. 8 s stereo: a quiet 220 Hz tone and a 6 ms 1 kHz burst at 0.9 every 0.25 s.
test("measureMasterGain on a peaky mix (ffmpeg): the one-pass gain lands short, the corrected one on target", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-master-"));
  roots.push(dir);
  const file = path.join(dir, "premaster.wav");
  const sr = 48000;
  const x = new Float32Array(sr * 8);
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    x[i] = 0.06 * Math.sin(2 * Math.PI * 220 * t) + (t % 0.25 < 0.006 ? 0.9 * Math.sin(2 * Math.PI * 1000 * t) : 0);
  }
  const w = createWavPcm16Writer(file, { channels: 2, sampleRate: sr, frames: x.length });
  w.write([x, x]);
  w.close();
  const measured = await measureLoudness(file);
  const onePass = await measureLoudness(file, { filter: masterGainFilter(measured) });
  assert.ok(MASTER_TARGET_LUFS - onePass.integratedLufs > MASTER_TOLERANCE_LU, `one pass landed ${onePass.integratedLufs} LUFS: this mix shows the undershoot`);
  const r = await measureMasterGain(file);
  const landed = await measureLoudness(file, { filter: r.filter });
  assert.ok(Math.abs(landed.integratedLufs - MASTER_TARGET_LUFS) <= MASTER_TOLERANCE_LU, `corrected master landed ${landed.integratedLufs} LUFS`);
  assert.ok(landed.truePeakDb <= -1, `true peak ${landed.truePeakDb} dBFS stays under the ceiling`);
});
