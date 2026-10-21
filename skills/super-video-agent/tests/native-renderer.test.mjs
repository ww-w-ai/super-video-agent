// SVA_RENDERER=native: backend selection, the one frame-count rule, and the
// native page's contract (evaluate / seek / capture, query flags, routes,
// init scripts, session isolation, unsupported calls, load refusals).
// 3D reels: tests/native-3d.test.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filmFrameCount, lastFilmFrame } from "../scripts/lib/frame-count.mjs";
import { computeSegments } from "../scripts/lib/segments.mjs";
import { collectFrameStates, installTextProbe, glyphCoverage } from "../scripts/lib/page-probe.mjs";
import { planCaptionSpans } from "../scripts/lib/dub-timing.mjs";
import { nativeRaster } from "../scripts/native/raster.mjs";
import { rendererBackend, rendererLine, openReel, captureFrame, captureRgbaFrame, seekTo, pixelDiff, scanDeadAirBySeek } from "../scripts/lib/browser.mjs";
import { serveDir, serveOverrides, servedSite } from "../scripts/lib/server.mjs";
import { cssFontFamilies, stageSize, bodyElementsBesideCanvas } from "../scripts/native/reel-host.mjs";

process.env.SVA_RENDERER = "native";

const tmpRoots = [];
after(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

// A 2D reel: the frame's colour is a function of t, the page reads ?lang= and
// its clock from voice/timings.json (2.5 s when the file is absent).
const REEL = `<!doctype html><html><body>
<canvas id="stage" width="64" height="32"></canvas>
<script>
(function () {
  var canvas = document.getElementById("stage");
  var ctx = canvas.getContext("2d");
  var params = new URLSearchParams(location.search);
  var r = {
    width: 64, height: 32, fps: 30, duration: 2.5, shots: [], layers: [],
    lang: params.get("lang"), captions: params.get("captions"),
    picture: typeof globalThis.__svaPicture === "object" ? globalThis.__svaPicture.lang : null,
    seek: function (t) {
      ctx.fillStyle = "rgb(" + Math.round(t * 100) % 256 + ",20,40)";
      ctx.fillRect(0, 0, 64, 32);
    },
  };
  r.ready = fetch("voice/timings.json").then(function (res) { return res.ok ? res.json() : null; }).then(function (tm) {
    if (tm) r.duration = tm.duration;
    r.shots = [{ id: "a", start: 0, end: r.duration, readAt: r.duration / 2 }];
  });
  window.__reel = r;
})();
</script></body></html>`;

function reelDir(html = REEL, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-native-"));
  tmpRoots.push(dir);
  fs.writeFileSync(path.join(dir, "reel.html"), html);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

async function withReel(html, files, fn, query = "") {
  const server = await serveDir(reelDir(html, files));
  try {
    return await fn(server, `${server.url}${query}`);
  } finally {
    await server.close();
  }
}

const pngSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

// ---- frame count ------------------------------------------------------------

test("filmFrameCount: round(duration*fps); a partial last frame counts from half a frame", () => {
  assert.equal(filmFrameCount(73.102627, 30), 2193);
  assert.equal(filmFrameCount(250.3369, 30), 7510);
  assert.equal(filmFrameCount(2, 30), 60);
  assert.equal(filmFrameCount(2 + 0.5 / 30, 30), 61);
  assert.equal(filmFrameCount(2 + 0.49 / 30, 30), 60);
  assert.equal(lastFilmFrame(73.102627, 30), 2192);
  assert.equal(lastFilmFrame(0, 30), 0);
});

test("render segments, the state-check frame scan and dub caption spans use the same count", async () => {
  for (const duration of [73.102627, 250.33, 4.99, 1 / 60]) {
    const fps = 30;
    const want = filmFrameCount(duration, fps);
    const { segments } = computeSegments({ shots: [{ id: "a", start: 0, end: duration }], fps, duration });
    assert.equal(segments[segments.length - 1].frameEnd, want, `render frames for ${duration}`);
    const page = { evaluate: async (fn, arg) => (arg === undefined ? false : { texts: [], layers: null }) };
    const { frames } = await collectFrameStates(page, { fps, duration, step: 1 });
    assert.equal(frames.length, want, `state-check frames for ${duration}`);
    assert.equal(planCaptionSpans({ lines: [{ start: 0, end: duration }], duration, fps }).totalFrames, want);
  }
});

// ---- backend selection --------------------------------------------------------

test("rendererBackend: browser by default, native on request, anything else throws", () => {
  assert.equal(rendererBackend({}), "browser");
  assert.equal(rendererBackend({ SVA_RENDERER: "browser" }), "browser");
  assert.equal(rendererBackend({ SVA_RENDERER: "Native" }), "native");
  assert.throws(() => rendererBackend({ SVA_RENDERER: "skia" }), /SVA_RENDERER takes browser \| native \(got "skia"\)/);
  assert.match(rendererLine("native"), /^renderer: native \(SVA_RENDERER=native/);
  assert.match(rendererLine("browser"), /^renderer: browser \(SVA_RENDERER=browser/);
});

test("nativeRaster: cpu by default, gpu on request, anything else throws", () => {
  assert.equal(nativeRaster({}), "cpu");
  assert.equal(nativeRaster({ SVA_NATIVE_RASTER: "GPU" }), "gpu");
  assert.throws(() => nativeRaster({ SVA_NATIVE_RASTER: "metal" }), /SVA_NATIVE_RASTER takes cpu \| gpu \(got "metal"\)/);
  assert.match(rendererLine("native"), /CPU raster \(SVA_NATIVE_RASTER\)/);
});

test("native session: captureRgbaFrame gives the stage's raw RGBA, a pure function of t", async () => {
  await withReel(REEL, {}, async (server, url) => {
    const s = await openReel(url, { warm: false });
    try {
      assert.deepEqual(s.page.stageSize(), { width: 64, height: 32 });
      const a = await captureRgbaFrame(s.page, 0.5);
      assert.equal(a.length, 64 * 32 * 4);
      assert.notDeepEqual(await captureRgbaFrame(s.page, 1.5), a);
      assert.deepEqual(await captureRgbaFrame(s.page, 0.5), a);
    } finally {
      await s.close();
    }
  });
});

// ---- native page contract -----------------------------------------------------

test("native session: evaluate runs in the page, copies values both ways, compiles from source", async () => {
  await withReel(REEL, {}, async (server, url) => {
    const s = await openReel(url, { warm: false });
    try {
      assert.equal(s.renderer, "native");
      assert.equal(s.meta.duration, 2.5);
      assert.equal(await s.page.evaluate((x) => window.__reel.width + x, 6), 70);
      const arg = { list: [1, 2] };
      const back = await s.page.evaluate((a) => { a.list.push(3); return a; }, arg);
      assert.deepEqual(arg.list, [1, 2], "the argument is a copy");
      assert.deepEqual(back.list, [1, 2, 3]);
      const nodeOnly = 5;
      await assert.rejects(s.page.evaluate(() => nodeOnly), /nodeOnly is not defined/);
      await assert.rejects(s.page.evaluate(() => () => 1), /cannot cross back to Node/);
    } finally {
      await s.close();
    }
  });
});

test("native session: seek + capture give PNG bytes of the stage, a pure function of t", async () => {
  await withReel(REEL, {}, async (server, url) => {
    const s = await openReel(url, { warm: false });
    try {
      const a = await captureFrame(s.page, 0.5);
      assert.equal(a.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.deepEqual(pngSize(a), { width: 64, height: 32 });
      const b = await captureFrame(s.page, 1.5);
      assert.notDeepEqual(a, b);
      await seekTo(s.page, 2);
      assert.deepEqual(await captureFrame(s.page, 0.5), a);
      assert.deepEqual(await pixelDiff(s.page, a), { changed: 0, maxDelta: 0, box: null });
      const diff = await pixelDiff(s.page, b);
      assert.equal(diff.changed, 64 * 32);
      assert.equal(diff.maxDelta, 100);
      const scan = await scanDeadAirBySeek(s.page, { duration: s.meta.duration, fps: 30 });
      assert.equal(scan.frameCount, filmFrameCount(s.meta.duration, 30));
      assert.ok(scan.times.length >= 20, "the dead-air scan sampled the native frames");
      await seekTo(s.page, 0.5);
      const red = await s.page.evaluate(() => document.querySelector("canvas").getContext("2d").getImageData(1, 1, 1, 1).data[0]);
      assert.equal(red, 50);
    } finally {
      await s.close();
    }
  });
});

test("native session: the URL's query is location.search, as in the browser", async () => {
  await withReel(REEL, {}, async (server, url) => {
    const s = await openReel(url, { warm: false });
    try {
      assert.equal(await s.page.evaluate(() => location.search), "?captions=0&layer=captions&lang=fr");
      assert.deepEqual(await s.page.evaluate(() => [window.__reel.lang, window.__reel.captions]), ["fr", "0"]);
    } finally {
      await s.close();
    }
  }, "?captions=0&layer=captions&lang=fr");
});

test("native session: --stub and --timings routes, picture init script and served overrides reach the page", async () => {
  const timings = JSON.stringify({ duration: 3, lines: [] });
  await withReel(REEL, { "voice/timings.json": timings }, async (server, url) => {
    const stub = await openReel(url, { warm: false, stubSec: 1.25, picture: { lang: "de", strings: {} } });
    try {
      assert.equal(stub.meta.duration, 1.25);
      assert.equal(await stub.page.evaluate(() => window.__reel.picture), "de");
    } finally {
      await stub.close();
    }
    const own = await openReel(url, { warm: false });
    assert.equal(own.meta.duration, 3);
    await own.close();
    const fileTimings = path.join(reelDir(), "other-timings.json");
    fs.writeFileSync(fileTimings, JSON.stringify({ duration: 3.5, lines: [] }));
    const given = await openReel(url, { warm: false, timingsFile: fileTimings });
    assert.equal(given.meta.duration, 3.5);
    await given.close();
    const layer = await serveOverrides(server, { "/voice/timings.json": JSON.stringify({ duration: 4, lines: [] }) });
    try {
      const s = await openReel(layer.url, { warm: false });
      assert.equal(s.meta.duration, 4);
      await s.close();
    } finally {
      await layer.close();
    }
  });
});

test("native sessions are isolated: globals and the 2D context prototype are per session", async () => {
  await withReel(REEL, {}, async (server, url) => {
    const a = await openReel(url, { warm: false });
    const b = await openReel(url, { warm: false });
    try {
      await a.page.evaluate(() => {
        window.leak = 1;
        CanvasRenderingContext2D.prototype.fillRect = function () {};
      });
      assert.equal(await b.page.evaluate(() => typeof window.leak), "undefined");
      const before = await captureFrame(b.page, 1);
      assert.equal(before.length > 0, true);
      assert.equal(await b.page.evaluate(() => document.querySelector("canvas").getContext("2d").getImageData(1, 1, 1, 1).data[0]), 100);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test("native session: the state-check text probe records what each seek draws", async () => {
  const textReel = REEL.replace('ctx.fillRect(0, 0, 64, 32);', 'ctx.fillRect(0, 0, 64, 32); ctx.font = "12px sans-serif"; ctx.fillStyle = "#fff"; if (t < 1) ctx.fillText("hi", 4, 20);');
  await withReel(textReel, {}, async (server, url) => {
    const s = await openReel(url, { warm: false });
    try {
      await installTextProbe(s.page, { pixels: true });
      const { frames } = await collectFrameStates(s.page, { fps: 30, duration: s.meta.duration, step: 15 });
      assert.deepEqual(frames.map((f) => f.texts.map((x) => x.text).join()), ["hi", "hi", "", "", ""]);
      const rec = frames[0].texts[0];
      assert.match(rec.font, /12px sans-serif$/);
      assert.ok(rec.box[2] > rec.box[0] && rec.box[3] > rec.box[1], "the text box has an area");
      assert.deepEqual(rec.backing, { kind: "fill", color: "#001428", alpha: 1 });
      assert.deepEqual(await glyphCoverage(s.page, [["sans-serif", "A"]]), [false]);
    } finally {
      await s.close();
    }
  });
});

test("native page: every call it does not provide throws, never returns empty data", async () => {
  await withReel(REEL, {}, async (server, url) => {
    const s = await openReel(url, { warm: false });
    try {
      assert.throws(() => s.page.screenshot, /not supported on SVA_RENDERER=native: page\.screenshot/);
      assert.throws(() => s.page.on("dialog", () => {}), /not supported on SVA_RENDERER=native: page\.on\("dialog"\)/);
      await assert.rejects(s.page.route("**/x", () => {}), /not supported on SVA_RENDERER=native: page\.route with a glob/);
      await assert.rejects(s.page.addInitScript(() => {}), /not supported on SVA_RENDERER=native: page\.addInitScript after goto/);
      const handle = await s.page.waitForFunction(() => true, null, { timeout: 100 });
      assert.throws(() => handle.jsonValue, /not supported on SVA_RENDERER=native: the handle page\.waitForFunction returns\.jsonValue/);
    } finally {
      await s.close();
    }
  });
});

test("native: blocks the browser does not run are skipped; a WebGL context, a page beside the canvas and a script error fail on load", async () => {
  const dataBlocks = REEL.replace("<script>", '<script type="importmap">{}</script><script type="application/json">{"a":1}</script><script>');
  await withReel(dataBlocks, {}, async (server, url) => {
    const s = await openReel(url, { warm: false });
    assert.equal(s.meta.duration, 2.5);
    await s.close();
  });
  const glReel = REEL.replace('canvas.getContext("2d")', 'canvas.getContext("webgl2")');
  await withReel(glReel, {}, async (server, url) => {
    await assert.rejects(openReel(url, { warm: false }), /no WebGL canvas context: the scene asked for a "webgl2" canvas context\. It draws 2D canvas reels and three\.js reels.*SVA_RENDERER=browser/);
  });
  const domReel = REEL.replace("<canvas", '<div class="caption">hi</div><canvas');
  await withReel(domReel, {}, async (server, url) => {
    await assert.rejects(openReel(url, { warm: false }), /draws only the <canvas>; reel\.html's <body> also has <div>/);
  });
  const brokenReel = REEL.replace("(function () {", "(function () { notAFunction();");
  await withReel(brokenReel, {}, async (server, url) => {
    await assert.rejects(openReel(url, { warm: false, readyTimeoutMs: 2000 }), /step "load reel\.html": notAFunction is not defined/);
  });
});

test("native: page console errors and uncaught timer errors land in session.errors", async () => {
  const noisy = REEL.replace("window.__reel = r;", 'window.__reel = r; console.error("from the page"); setTimeout(function () { throw new Error("late throw"); }, 0);');
  await withReel(noisy, {}, async (server, url) => {
    const s = await openReel(url, { warm: false });
    try {
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(s.errors.includes("from the page"));
      assert.ok(s.errors.some((e) => /late throw/.test(e)));
    } finally {
      await s.close();
    }
  });
});

test("native: a URL no serveDir() owns is refused", async () => {
  await assert.rejects(openReel("http://127.0.0.1:9/reel.html", { warm: false }), /serveDir\(\) URL or a file: URL/);
});

// ---- small parsers ------------------------------------------------------------

test("serveDir records its root for the native page and forgets it on close", async () => {
  const dir = reelDir();
  const server = await serveDir(dir);
  assert.equal(servedSite(`${server.url}reel.html?x=1`).root, path.resolve(dir));
  await server.close();
  assert.equal(servedSite(server.url), null);
});

test("reel-host parsers: stage size, CSS font families, elements beside the canvas", () => {
  assert.deepEqual(stageSize('<canvas id="stage" width="1080" height="1920">'), { width: 1080, height: 1920 });
  assert.deepEqual(stageSize("<canvas>"), { width: 300, height: 150 });
  assert.deepEqual(cssFontFamilies("bold 64px 'Do Hyeon', \"Pretendard\", sans-serif"), ["do hyeon", "pretendard", "sans-serif"]);
  assert.deepEqual(cssFontFamilies("64px/1.2 Gaegu"), ["gaegu"]);
  assert.deepEqual(bodyElementsBesideCanvas("<body><canvas></canvas><script>var a='<div>'</script></body>"), []);
  assert.deepEqual(bodyElementsBesideCanvas("<body><canvas></canvas><p>x</p><img src=a></body>"), ["p", "img"]);
});
