// Pure filter-graph and timing math (scripts/lib/join-ffmpeg.mjs) — string
// building only, no ffmpeg call needed for this part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJoinFilter, joinOffsets, joinTimes } from "../scripts/lib/join-ffmpeg.mjs";

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

test("buildJoinFilter: joins any count of parts, not just three", () => {
  const filter = buildJoinFilter({ count: 4, width: 100, height: 100, fps: 24, durationsSec: [1, 1, 1, 1] });
  assert.match(filter, /concat=n=4:v=1:a=1/);
  for (let i = 0; i < 4; i++) {
    assert.match(filter, new RegExp(`\\[${i}:v\\]`));
  }
});
