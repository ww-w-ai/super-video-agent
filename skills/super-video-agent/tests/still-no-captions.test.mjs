// still.mjs --no-captions: the page is loaded with ?captions=0 (as
// render.mjs --no-captions does), and the still gets its own file name.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stillFileName } from "../scripts/still.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const stillCli = path.join(here, "..", "scripts", "still.mjs");

test("stillFileName: -nocap suffix only for a picture-only still", () => {
  assert.equal(stillFileName("12.5", false), "still-12.5.png");
  assert.equal(stillFileName("12.5", true), "still-12.5-nocap.png");
  assert.equal(stillFileName("l 3", true), "still-l_3-nocap.png");
});

// Paints its whole canvas from location.search alone: red with
// ?captions=0, green without. The two stills can only differ if the query
// reached the page.
const PAGE = `<!doctype html><canvas width="8" height="8"></canvas><script>
var off = /(^|[?&])captions=0(&|$)/.test(location.search);
var ready = fetch("voice/timings.json").then(function (r) { return r.json(); });
var t = null;
ready.then(function (d) { t = d; });
window.__reel = {
  width: 8, height: 8, fps: 30, ready: ready,
  get duration() { return t.duration; },
  get shots() { return t.lines.map(function (l) { return { id: l.id, start: l.start, end: l.end, readAt: (l.start + l.end) / 2 }; }); },
  seek: function () { var g = document.querySelector("canvas").getContext("2d"); g.fillStyle = off ? "#ff0000" : "#00ff00"; g.fillRect(0, 0, 8, 8); },
};
</script>`;

test("still.mjs --no-captions: loads ?captions=0 and writes still-<at>-nocap.png beside the captioned still", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-still-nocap-"));
  try {
    fs.writeFileSync(path.join(dir, "reel.html"), PAGE);
    const opts = { encoding: "utf8", timeout: 60000 };
    const plain = spawnSync(process.execPath, [stillCli, dir, "--at", "1", "--stub", "2"], opts);
    assert.equal(plain.status, 0, plain.stderr);
    const nocap = spawnSync(process.execPath, [stillCli, dir, "--at", "1", "--stub", "2", "--no-captions"], opts);
    assert.equal(nocap.status, 0, nocap.stderr);
    const a = fs.readFileSync(path.join(dir, "out", "still-1.png"));
    const b = fs.readFileSync(path.join(dir, "out", "still-1-nocap.png"));
    assert.ok(a.length > 0 && b.length > 0);
    assert.notDeepEqual(a, b, "the --no-captions still should be drawn from a page that saw ?captions=0");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
