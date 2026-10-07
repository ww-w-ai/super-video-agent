import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembledSegmentMeta, assertSpanBase } from "../scripts/render.mjs";
import { decideSegmentReuse, decideLangUnprobed } from "../scripts/lib/segments.mjs";
const input = { segment: { frameStart: 0, frameEnd: 30 }, fps: 30, width: 100, height: 100,
  items: [{ image: Buffer.from("page") }], bad: [{ index: 0, fraction: 0.5 }] };
test("assembly mismatch stays uncached unless explicitly retained", () => {
  assert.equal(assembledSegmentMeta(input), null);
  const stored = assembledSegmentMeta({ ...input, keepAssembledCopies: true });
  assert.equal(stored.assembledCopy.pageMismatch, true);
  assert.deepEqual(stored.assembledCopy.probes, input.bad);
  assert.equal(decideSegmentReuse({ stored, current: stored, mp4Exists: true }).reuse, false);
  assert.equal(decideLangUnprobed({ storedBase: { ...stored, picture: { keys: [] } }, current: stored, strings: {}, baseMp4Exists: true }), null);
});
test("matching assembly keeps the original normal cache behavior", () => {
  const stored = assembledSegmentMeta({ ...input, bad: [] });
  assert.equal(stored.assembledCopy, undefined);
  assert.equal(decideSegmentReuse({ stored, current: stored, mp4Exists: true }).reuse, true);
});

test("an explicitly retained assembly is accepted as the next span base", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-retained-"));
  const segment = { ...input.segment, id: "shot" };
  const stored = assembledSegmentMeta({ ...input, segment, keepAssembledCopies: true });
  try {
    fs.writeFileSync(path.join(dir, "shot.mp4"), "fixture");
    const args = { segments: [segment], touched: [], segDir: dir, fps: 30, width: 100, height: 100 };
    assert.throws(() => assertSpanBase(args), /never rendered/);
    fs.writeFileSync(path.join(dir, "shot.json"), JSON.stringify(stored));
    assert.doesNotThrow(() => assertSpanBase(args));
    assert.throws(() => assertSpanBase({ ...args, fps: 24 }), /fps or size moved/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
