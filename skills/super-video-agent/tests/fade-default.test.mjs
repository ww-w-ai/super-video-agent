import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fadeOutSecFor } from "../scripts/render.mjs";
import { spawnSync } from "node:child_process";
import { endFadeFilter, resolveCueFades, buildCueMixFilter } from "../scripts/lib/audio-mix.mjs";

test("sound decreases fade by default; only explicit zero chooses a hard cut", () => {
  assert.equal(resolveCueFades([{ atSec: 0, trimSec: 1 }])[0].fadeOutSec, 0.03);
  assert.equal(endFadeFilter(1), "afade=t=out:st=0.97:d=0.03");
  assert.equal(endFadeFilter(0.01), "afade=t=out:st=0:d=0.01");
  assert.equal(endFadeFilter(1, 0), "anull");
  assert.throws(() => endFadeFilter(1, -1), /nonnegative/);
  assert.throws(() => endFadeFilter(0), /positive/);
  const graph = buildCueMixFilter({ hasSfx: true, durationSec: 1,
    cues: [{ atSec: 0, trimSec: 2, peakDb: -6 }] }).filterComplex;
  assert.match(graph, /\[1:a\]pan=[^;]+\[voice\]/);
  assert.doesNotMatch(graph.split(";")[0], /afade/);
  assert.match(graph, /afade=t=out:st=0.97:d=0.03\[sfx\]/);
  assert.match(graph, /adelay=0:all=1,afade=t=out:st=0.97:d=0.03\[cue0\]/);
  const cut = buildCueMixFilter({ hasSfx: false,
    cues: [{ atSec: 0, trimSec: 1, peakDb: -6, fadeOutSec: 0 }] }).filterComplex;
  assert.doesNotMatch(cut, /afade/);
});

test("actual samples decay at the boundary and explicit cut retains the level", () => {
  const render = (filter) => {
    const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=0.25:s=48000:d=1", "-af", filter, "-f", "f32le", "-ac", "1", "pipe:1"]);
    assert.equal(result.status, 0, result.stderr.toString());
    const samples = new Float32Array(result.stdout.length / 4);
    for (let i = 0; i < samples.length; i++) samples[i] = result.stdout.readFloatLE(i * 4);
    return samples;
  };
  const faded = render(endFadeFilter(1));
  const cut = render(endFadeFilter(1, 0));
  assert.equal(faded.length, cut.length);
  assert.equal(faded[40000], cut[40000]);
  assert.ok(faded.at(-1) < 0.001, "default must reach silence before truncation");
  assert.ok(cut.at(-1) > 0.24, "explicit cut must preserve abrupt ending");
});

test("picture-only stub without plan retains default fade; invalid plans are not hidden", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-fade-plan-"));
  try {
    assert.equal(fadeOutSecFor(dir), undefined);
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({meta:{sound:{fadeOutSec:0}}}));
    assert.equal(fadeOutSecFor(dir), 0);
    fs.writeFileSync(path.join(dir, "plan.json"), "broken");
    assert.throws(() => fadeOutSecFor(dir), /invalid JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
