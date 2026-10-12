// K6: still.mjs, still.mjs --sheet, dub.mjs's own caption layer and --init-plan
// stop instead of writing wrong output.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pageErrorsOf } from "../scripts/still.mjs";
import { tryOwnCaptionLayer } from "../scripts/dub.mjs";
import { buildDubPlan, initDubPlan, formatInitReport } from "../scripts/lib/dub-scaffold.mjs";
import { ffmpeg } from "../scripts/lib/ffmpeg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");
const stillCli = path.join(scripts, "still.mjs");
const run = (args) => spawnSync(process.execPath, [stillCli, ...args], { encoding: "utf8", timeout: 60000 });

// A reel page on the --stub clock; `extra` is script run after __reel is set,
// `onSeek` runs inside seek(t) after the canvas is painted.
function reelPage({ extra = "", onSeek = "" } = {}) {
  return `<!doctype html><canvas width="8" height="8"></canvas><script>
var ready = fetch("voice/timings.json").then(function (r) { return r.json(); });
var tm = null;
ready.then(function (d) { tm = d; });
window.__reel = {
  width: 8, height: 8, fps: 30, ready: ready,
  get duration() { return tm.duration; },
  get shots() { return tm.lines.map(function (l) { return { id: l.id, start: l.start, end: l.end, readAt: (l.start + l.end) / 2 }; }); },
  seek: function (t) {
    var g = document.querySelector("canvas").getContext("2d"); g.fillStyle = "#00ff00"; g.fillRect(0, 0, 8, 8);
    ${onSeek}
  },
};
${extra}
</script>`;
}

function reelDir(page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-k6-"));
  fs.writeFileSync(path.join(dir, "reel.html"), page);
  return dir;
}

test("pageErrorsOf: a WebGL console line is matched by its normalized key; other errors stay", () => {
  const glText = "[.WebGL-0x12ab34cd]GL_INVALID_OPERATION: glDrawArrays: context 123456 lost";
  const key = glText.replace(/0x[0-9a-f]+/gi, "0x…").replace(/\d{3,}/g, "N");
  const session = { errors: [glText, "TypeError: x is null"], gl: new Map([[key, { text: glText, definite: true, count: 1 }]]) };
  assert.deepEqual(pageErrorsOf(session), ["TypeError: x is null"]);
});

test("still.mjs: a page that throws at load → exit 1, error printed, no still written", () => {
  const dir = reelDir(reelPage({ extra: 'null.scenes.register("a");' }));
  try {
    const r = run([dir, "--at", "0", "--stub", "2"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /page reported error\(s\)/);
    assert.match(r.stderr, /TypeError/);
    assert.equal(fs.existsSync(path.join(dir, "out", "still-0.png")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("still.mjs: a page that throws while drawing t=2 only → still-1 written, still-2 not, exit 1", () => {
  const onSeek = 'if (t === 2) { setTimeout(function () { throw new TypeError("seek broke at 2"); }, 0); return new Promise(function (r) { setTimeout(r, 100); }); }';
  const dir = reelDir(reelPage({ onSeek }));
  try {
    const r = run([dir, "--at", "1,2", "--stub", "2"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /seek broke at 2/);
    assert.ok(fs.existsSync(path.join(dir, "out", "still-1.png")), "the frame before the error is kept");
    assert.equal(fs.existsSync(path.join(dir, "out", "still-2.png")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("still.mjs: a WebGL-only console error (hex id, long number) keeps today's behaviour — file written, exit 1 via the GL report", () => {
  const onSeek = 'console.error("[.WebGL-0x12ab34cd]GL_INVALID_OPERATION: glDrawArrays: context 123456 attempt to draw");';
  const dir = reelDir(reelPage({ onSeek }));
  try {
    const r = run([dir, "--at", "1", "--stub", "2", "--no-warm"]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, "out", "still-1.png")), r.stderr);
    assert.match(r.stderr, /GL error/);
    assert.doesNotMatch(r.stderr, /page reported error/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("still.mjs: an unknown --at shot id → exit 1, no shot with id", () => {
  const dir = reelDir(reelPage());
  try {
    const r = run([dir, "--at", "nosuch", "--stub", "2"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no shot with id "nosuch"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function frames(dir, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = path.join(dir, `s${i}.png`);
    await ffmpeg(["-y", "-f", "lavfi", "-i", `testsrc=size=108x192:rate=1`, "-frames:v", "1", p]);
    out.push(p);
  }
  return out;
}

test("--sheet: the output named again as an input → refused, file unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-k6-sheet-"));
  try {
    const [a, b] = await frames(dir, 2);
    const before = fs.readFileSync(a);
    const r = run(["--sheet", a, a, b, "--cell", "100"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is also an input; the first path after --sheet is the output/);
    assert.deepEqual(fs.readFileSync(a), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--sheet: an existing frame as the output (not a sheet of this layout) → refused, file unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-k6-sheet-"));
  try {
    const [s0, s1, s2] = await frames(dir, 3);
    const before = fs.readFileSync(s0);
    const r = run(["--sheet", s0, s1, s2, "--cell", "100"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists and is not a sheet of this layout \(108x192; this sheet is \d+x\d+\); nothing written/);
    assert.deepEqual(fs.readFileSync(s0), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--sheet: an existing output that is not an image → refused, file unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-k6-sheet-"));
  try {
    const [s0, s1] = await frames(dir, 2);
    const out = path.join(dir, "notes.png");
    fs.writeFileSync(out, "not an image");
    const r = run(["--sheet", out, s0, s1, "--cell", "100"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot be read as an image; nothing written/);
    assert.equal(fs.readFileSync(out, "utf8"), "not an image");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--sheet: the same sheet written twice to one path → the second run overwrites it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-k6-sheet-"));
  try {
    const inputs = await frames(dir, 2);
    const out = path.join(dir, "sheet.png");
    assert.equal(run(["--sheet", out, ...inputs, "--cell", "100"]).status, 0);
    const again = run(["--sheet", out, ...inputs, "--cell", "100"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /wrote .*sheet\.png \(2 PNGs\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Declares its own caption layer; every seek throws, so openReel's warm-up fails.
const LAYER_PAGE = `<!doctype html><canvas width="8" height="8"></canvas><script>
window.__reel = {
  width: 8, height: 8, fps: 30, duration: 1, layers: ["captions"], ready: Promise.resolve(),
  shots: [{ id: "a", start: 0, end: 1, readAt: 0.5 }],
  seek: function () { throw new TypeError("caption layer broke in warm-up"); },
};
</script>`;

// openReel leaves Chromium open when warm-up throws (lib/browser.mjs), so these run in a
// child process: an in-process call would keep the test runner alive.
function layerHarness(dir, body) {
  const dubUrl = pathToFileURL(path.join(scripts, "dub.mjs")).href;
  const cliUrl = pathToFileURL(path.join(scripts, "lib", "cli.mjs")).href;
  const code = [
    `import { tryOwnCaptionLayer } from ${JSON.stringify(dubUrl)};`,
    `import { fail } from ${JSON.stringify(cliUrl)};`,
    `const args = { reelDir: ${JSON.stringify(dir)}, lang: "en", baseLang: "ko", pictureSource: "base", fps: 30, framesDir: ${JSON.stringify(path.join(dir, "frames"))}, planFor: () => ({}), lines: [], keepBasePictureText: false, contrast: false };`,
    body,
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 60000 });
}

test("tryOwnCaptionLayer: the film's own caption layer throwing in warm-up is fatal, not a fallback", () => {
  assert.equal(typeof tryOwnCaptionLayer, "function");
  const dir = reelDir(LAYER_PAGE);
  try {
    const r = layerHarness(dir, `const r = await tryOwnCaptionLayer(args); process.stdout.write(JSON.stringify(r)); process.exit(0);`);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.match(out.fatal || "", /own caption layer failed .*caption layer broke in warm-up.* no final written/);
    assert.equal(out.note, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dub caption-layer failure: the process exits 1 through fail() even with the page's browser left open", () => {
  const dir = reelDir(LAYER_PAGE);
  try {
    // Same path as dub.mjs main: buildCaptionedVideo throws on fatal, main's catch calls fail().
    const r = layerHarness(dir, [
      `try {`,
      `  const r = await tryOwnCaptionLayer(args);`,
      `  if (r.fatal) throw new Error(r.fatal);`,
      `  process.stdout.write("no fatal: " + (r.note || "") + "\\n");`,
      `} catch (e) { fail(e.message); }`,
    ].join("\n"));
    assert.equal(r.status, 1, `status ${r.status} signal ${r.signal}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /no final written/);
    assert.equal(fs.readdirSync(dir).some((f) => /^final/.test(f)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildDubPlan: overlay strings are left out, numbers kept; an all-string overlay drops meta.overlay", () => {
  const base = (overlay) => ({ meta: { lang: "ko", overlay }, lines: [{ id: "a", text: "가" }] });
  const dub = buildDubPlan(base({ title: "제목", picture: { place: "런던" }, size: 2, list: ["a"] }), "en");
  assert.deepEqual(dub.meta.overlay, { size: 2 });
  assert.equal("overlay" in buildDubPlan(base({ title: "제목", picture: { place: "런던" } }), "en").meta, false);
  assert.deepEqual(buildDubPlan(base({ title: "제목" }), "ko", { copy: true }).meta.overlay, { title: "제목" });
});

test("initDubPlan + formatInitReport: the report names how many overlay strings were left out", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-k6-init-"));
  try {
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: { lang: "ko", overlay: { title: "제목", picture: { place: "런던" }, size: 2 } }, lines: [{ id: "a", text: "가" }] }));
    const r = initDubPlan(dir, "en");
    assert.equal(r.overlayOmitted, 2);
    const written = JSON.parse(fs.readFileSync(r.planPath, "utf8"));
    assert.deepEqual(written.meta.overlay, { size: 2 });
    assert.match(formatInitReport(r), /; 2 meta\.overlay string\(s\) left out — add each translation/);
    assert.doesNotMatch(formatInitReport({ ...r, overlayOmitted: 0 }), /meta\.overlay/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
