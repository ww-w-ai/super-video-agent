// Pure-logic tests for render.mjs's picture-first support (--no-captions,
// references/pipeline.md "Picture first"): the URL captions are turned off
// on, the separate segment directory name, and --no-captions arg parsing.
// No ffmpeg, no browser — render() itself needs both and is not exercised
// here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../scripts/lib/cli.mjs";
import { pictureUrl, segmentDirName } from "../scripts/render.mjs";

test("pictureUrl: appends ?captions=0 only when noCaptions is true", () => {
  assert.equal(pictureUrl("http://127.0.0.1:1234/", true), "http://127.0.0.1:1234/?captions=0");
  assert.equal(pictureUrl("http://127.0.0.1:1234/", false), "http://127.0.0.1:1234/");
});

test("segmentDirName: -nocap suffix only for a picture-first render, for both quality levels", () => {
  assert.equal(segmentDirName("final", false), "final");
  assert.equal(segmentDirName("final", true), "final-nocap");
  assert.equal(segmentDirName("preview", false), "preview");
  assert.equal(segmentDirName("preview", true), "preview-nocap");
});

test("--no-captions parses as a boolean flag (no value follows it)", () => {
  const { positional, flags } = parseArgs(["reels/foo", "--no-captions"]);
  assert.deepEqual(positional, ["reels/foo"]);
  assert.equal(flags["no-captions"], true);
});

test("--no-captions combines with --preview and --workers", () => {
  const { flags } = parseArgs(["reels/foo", "--no-captions", "--preview", "--workers", "2"]);
  assert.equal(flags["no-captions"], true);
  assert.equal(flags.preview, true);
  assert.equal(flags.workers, "2");
});
