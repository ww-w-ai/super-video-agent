// review.mjs --scan --layer captions: loads reel.html?layer=captions&dub=<code>,
// scans every frame, and serves the base language from voice/timings.json
// and plan.json when dub/<base>/ files do not exist. The fixture page records
// a "scene-drawn" issue if it is ever opened outside the caption layer, and a
// planted off-safe sticker at 10.0-10.5 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reelPaths, writeJson } from "../scripts/lib/reeldir.mjs";
import { captionLayerAliases, placedDuration, serveDirWithAliases } from "../scripts/lib/layout-scan-serve.mjs";
import { scanCaptionLayer } from "../scripts/review.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const hasBrowser = fs.existsSync(path.join(here, "..", "node_modules", "playwright-core", "index.mjs"));

const PAGE = `<!doctype html><html><body><canvas width="108" height="192"></canvas><script>
var q = new URLSearchParams(location.search);
var layer = q.get("layer"), dub = q.get("dub");
var issues = [];
window.Reel = { clearIssues: function () { issues = []; } };
function need(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + " missing"); return r.json(); }); }
var timingsUrl = layer === "captions" ? "dub/" + dub + "/timings.placed.json" : "voice/timings.json";
window.__reel = {
  width: 108, height: 192, fps: 30, duration: 0, shots: [], layers: ["captions"],
  seek: function (t) {
    if (layer !== "captions") issues.push({ type: "scene-drawn" });
    if (t >= 10 && t < 10.5) issues.push({ type: "text-outside-safe-area", text: "STICKER" });
  },
  issues: function () { return issues.slice(); },
};
window.__reel.ready = Promise.all([need(timingsUrl), layer === "captions" ? need("dub/" + dub + "/plan.json") : null])
  .then(function (r) { window.__reel.duration = r[0].duration; });
</script></body></html>`;

function makeReel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-caplayer-"));
  fs.writeFileSync(path.join(dir, "reel.html"), PAGE);
  writeJson(path.join(dir, "plan.json"), { meta: { lang: "en" }, lines: [] });
  writeJson(path.join(dir, "voice", "timings.json"), { duration: 42.6, lines: [{ id: "l1", start: 0.5, end: 3, text: "hi" }] });
  return dir;
}

test("captionLayerAliases: base language without dub files is served from voice/timings.json and plan.json", () => {
  const dir = makeReel();
  assert.deepEqual(captionLayerAliases(dir, { code: "en", baseCode: "en" }), {
    "/dub/en/timings.placed.json": path.join(dir, "voice", "timings.json"),
    "/dub/en/plan.json": path.join(dir, "plan.json"),
  });
  writeJson(path.join(dir, "dub", "en", "timings.placed.json"), { duration: 1, lines: [] });
  assert.deepEqual(Object.keys(captionLayerAliases(dir, { code: "en", baseCode: "en" })), ["/dub/en/plan.json"], "an existing placed file is used as is");
  assert.deepEqual(captionLayerAliases(dir, { code: "ko", baseCode: "en" }), {}, "a non-base language is never aliased");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("serveDirWithAliases: answers aliased paths from their source and forwards the rest", async () => {
  const dir = makeReel();
  const server = await serveDirWithAliases(dir, captionLayerAliases(dir, { code: "en", baseCode: "en" }));
  try {
    const placed = await (await fetch(`${server.url}dub/en/timings.placed.json`)).json();
    assert.equal(placed.duration, 42.6);
    const html = await fetch(`${server.url}reel.html`);
    assert.equal(html.status, 200);
    assert.equal((await fetch(`${server.url}dub/ko/plan.json`)).status, 404);
  } finally {
    await server.close();
  }
  assert.equal(fs.existsSync(path.join(dir, "dub")), false, "nothing is written into the reel");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanCaptionLayer: base language, every frame, caption layer only, planted sticker reported", { skip: !hasBrowser && "playwright-core not installed" }, async () => {
  const dir = makeReel();
  const started = Date.now();
  const report = await scanCaptionLayer({ dir, paths: reelPaths(dir), stepSec: undefined, dub: undefined });
  const elapsedMs = Date.now() - started;

  assert.equal(report.dub, "en");
  assert.equal(report.layerDeclared, true);
  assert.ok(Math.abs(report.stepSec - 1 / 30) < 1e-9, "default step is one frame");
  assert.ok(report.sampleCount >= 1278, `every frame of 42.6 s at 30 fps, got ${report.sampleCount}`);
  assert.ok(elapsedMs < 60000, `scan took ${elapsedMs} ms`);
  assert.deepEqual(Object.keys(report.servedInPlace).sort(), ["/dub/en/plan.json", "/dub/en/timings.placed.json"]);

  const types = report.runs.flatMap((r) => r.types);
  assert.ok(!types.includes("scene-drawn"), "the page was opened in caption-layer mode");
  assert.equal(report.runs.length, 1, JSON.stringify(report.runs));
  assert.deepEqual(report.runs[0].texts, ["STICKER"]);
  assert.ok(Math.abs(report.runs[0].startSec - 10) < 0.04 && report.runs[0].endSec < 10.5);
  assert.equal(fs.existsSync(path.join(dir, "dub")), false, "nothing is written into the reel");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("placedDuration: reads dub/<code>/timings.placed.json, else the alias source, else null", () => {
  const dir = makeReel();
  const code = "en";
  assert.equal(placedDuration(dir, captionLayerAliases(dir, { code, baseCode: "en" }), code), 42.6, "base language from voice/timings.json");
  writeJson(path.join(dir, "dub", "ko", "timings.placed.json"), { duration: 43.4, lines: [] });
  assert.equal(placedDuration(dir, {}, "ko"), 43.4);
  assert.equal(placedDuration(dir, {}, "ja"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanCaptionLayer: a --min-gap dub scans to its own, longer length", { skip: !hasBrowser && "playwright-core not installed" }, async () => {
  const dir = makeReel();
  // The page reports the base picture's length (10 s), as a real reel does.
  fs.writeFileSync(path.join(dir, "reel.html"), PAGE.replace("window.__reel.duration = r[0].duration;", "window.__reel.duration = 10;"));
  writeJson(path.join(dir, "dub", "ko", "plan.json"), { meta: { lang: "ko" }, lines: [] });
  writeJson(path.join(dir, "dub", "ko", "timings.placed.json"), { duration: 10.78, lines: [] });
  const report = await scanCaptionLayer({ dir, paths: reelPaths(dir), stepSec: 0.1, dub: "ko" });
  assert.ok(Math.abs(report.duration - 10.78) < 1e-9, `scanned ${report.duration}`);
  assert.ok(report.sampleCount >= 108, `samples ${report.sampleCount}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanCaptionLayer: a non-base language with no dub run is refused with the command to run", async () => {
  const dir = makeReel();
  await assert.rejects(
    scanCaptionLayer({ dir, paths: reelPaths(dir), stepSec: 0.5, dub: "ko" }),
    /run dub\.mjs --lang ko first/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
