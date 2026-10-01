// Pure filter-graph and timing math (scripts/lib/join-ffmpeg.mjs) — string
// building only, no ffmpeg call needed for this part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJoinFilter, audioFitFilter, joinOffsets, joinTimes } from "../scripts/lib/join-ffmpeg.mjs";

test("joinOffsets: cumulative start time of each part", () => {
  assert.deepEqual(joinOffsets([8, 40, 12]), [0, 8, 48]);
  assert.deepEqual(joinOffsets([5]), [0]);
});

test("joinTimes: one cut time per join, between consecutive parts", () => {
  assert.deepEqual(joinTimes([8, 40, 12]), [8, 48]);
  assert.deepEqual(joinTimes([5, 5]), [5]);
  assert.deepEqual(joinTimes([5]), []);
});

test("buildJoinFilter: scales every input to the target size/fps and fades each part's audio edges", () => {
  const filter = buildJoinFilter({ count: 2, width: 1080, height: 1920, fps: 30, durationsSec: [2, 3] });
  assert.match(filter, /\[0:v\]scale=1080:1920,fps=30,format=yuv420p,setsar=1\[v0\]/);
  assert.match(filter, /\[1:v\]scale=1080:1920,fps=30,format=yuv420p,setsar=1\[v1\]/);
  assert.match(filter, /\[0:a\].*afade=t=in:d=0\.01.*afade=t=out:st=1\.990:d=0\.01\[a0\]/);
  assert.match(filter, /\[1:a\].*afade=t=out:st=2\.990:d=0\.01\[a1\]/);
  assert.match(filter, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[v\]\[a\]/);
});

test("buildJoinFilter: cuts each part's audio to its own video length, re-stamps it, pads it, then fades — before concat", () => {
  const filter = buildJoinFilter({ count: 3, width: 1080, height: 1920, fps: 30, durationsSec: [2, 36.5, 1.25] });
  const chains = filter.split(";");
  const expected = ["2.000000", "36.500000", "1.250000"];
  for (let i = 0; i < 3; i++) {
    const chain = chains.find((c) => c.startsWith(`[${i}:a]`));
    assert.ok(chain, `audio chain for part ${i}`);
    const fit = `atrim=end=${expected[i]},asetpts=N/SR/TB,apad=whole_dur=${expected[i]}`;
    assert.ok(chain.includes(fit), `part ${i} chain should carry ${fit}: ${chain}`);
    assert.ok(chain.indexOf("atrim=") < chain.indexOf("afade=t=in"), "trim comes before the edge fades");
    assert.ok(chain.endsWith(`[a${i}]`));
  }
  assert.equal((filter.match(/atrim=end=/g) || []).length, 3, "one atrim per part");
  assert.ok(filter.lastIndexOf("atrim=") < filter.indexOf("concat="), "every trim is applied before concat");
});

test("audioFitFilter: the per-part audio chain on its own", () => {
  assert.equal(audioFitFilter(8.033333), "atrim=end=8.033333,asetpts=N/SR/TB,apad=whole_dur=8.033333");
});

test("buildJoinFilter: joins any count of parts, not just three", () => {
  const filter = buildJoinFilter({ count: 4, width: 100, height: 100, fps: 24, durationsSec: [1, 1, 1, 1] });
  assert.match(filter, /concat=n=4:v=1:a=1/);
  for (let i = 0; i < 4; i++) {
    assert.match(filter, new RegExp(`\\[${i}:v\\]`));
  }
});
