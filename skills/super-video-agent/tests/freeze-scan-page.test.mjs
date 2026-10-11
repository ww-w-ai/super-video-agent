// The page freeze check (scripts/lib/browser.mjs scanDeadAirBySeek) in a real
// browser: it seeks, scales the canvas to grey in the page and runs the shared
// method, so a still span is found with the same start and length the frame
// sequence gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveDir } from "../scripts/lib/server.mjs";
import { openReel, scanDeadAirBySeek } from "../scripts/lib/browser.mjs";

// 3 s at 10 fps: a bar moves every frame except from frame 10 to frame 21 (1.1 s of one picture).
const PAGE = `<!doctype html><canvas id="c" width="640" height="360"></canvas><script>
var ctx = document.getElementById("c").getContext("2d");
function draw(t) {
  var f = Math.round(t * 10);
  var x = f >= 10 && f <= 21 ? 10 : f;
  ctx.fillStyle = "#222"; ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = "#fff"; ctx.fillRect(x * 20, 100, 60, 160);
}
window.__reel = { width: 640, height: 360, fps: 10, duration: 3, ready: Promise.resolve(), shots: [], seek: draw, issues: function () { return []; } };
window.Reel = { clearIssues: function () {} };
draw(0);
</script>`;

test("scanDeadAirBySeek: a 1.1 s still span on the page is one freeze from 1.0 s, motion elsewhere is not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-freeze-page-"));
  fs.writeFileSync(path.join(dir, "reel.html"), PAGE);
  const server = await serveDir(dir);
  let session;
  try {
    session = await openReel(`${server.url}reel.html`, {});
    const scan = await scanDeadAirBySeek(session.page, { duration: 3, fps: 10 });
    assert.equal(scan.frameCount, 30);
    assert.equal(scan.runs.length, 1, JSON.stringify(scan.runs));
    assert.ok(Math.abs(scan.runs[0].startSec - 1) < 1e-9 && Math.abs(scan.runs[0].durationSec - 1.1) < 1e-9, JSON.stringify(scan.runs));
    assert.equal(scan.recheckSpans.length, 1);
  } finally {
    if (session) await session.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
