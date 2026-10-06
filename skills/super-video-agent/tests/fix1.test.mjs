// FIX1: span + lang, engine facts in verify/review, setup disk limits, bundled
// libraries in the static scan, SVA_CHROME_ARGS as JSON, contact-sheet launch options.
// Pure logic and small file fixtures; the one browser call fails before it opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  render, frameHashes, assertBedPair, assertWholeFilmFlags, spanPictureReads, spliceSpanPieces, checkPicturePair,
  planCacheKey, skillStamp, widestKeyframeGap,
} from "../scripts/render.mjs";
import { ffmpeg, spawnImagePipeEncoder, keyframeInterval, probeGops, planFrameCut, cutFrames, probePacketCount, videoStreamMd5 } from "../scripts/lib/ffmpeg.mjs";
import { main as joinMain, copyBlocker } from "../scripts/join.mjs";
import { reelPaths } from "../scripts/lib/reeldir.mjs";
import { splitEngineFacts, engineFactLines, parseChromeArgs, chromeLaunchOptions } from "../scripts/lib/browser.mjs";
import { diskThresholds, diskLines, workStatus } from "../scripts/setup.mjs";
import { scanReelHtml } from "../scripts/lib/static-scan.mjs";
import { staticScanLine } from "../scripts/verify.mjs";
import { buildContactSheet } from "../scripts/lib/contact-sheet.mjs";

// ---- 1 --span with --lang -------------------------------------------------

test("--span combines with --lang; the other whole-film flags still refuse", () => {
  assert.doesNotThrow(() => assertWholeFilmFlags("span", { span: "3-4", lang: "en", "no-captions": true }));
  for (const f of ["only", "insert", "use-draft", "handle", "probe-all", "assemble", "bed-only"]) {
    assert.throws(() => assertWholeFilmFlags("span", { [f]: "x" }), new RegExp(`--${f}`), f);
  }
  assert.throws(() => assertWholeFilmFlags("assemble", { lang: "en" }), /--lang/);
});

test("spanPictureReads: whole-new segment takes the session reads; cut frames keep their record and add to it", () => {
  const session = { keys: ["scene.title"], lang: false, all: false };
  const stored = { picture: { keys: ["brand"], lang: false, all: false } };
  const whole = [{ kind: "new", from: 0, to: 30 }];
  const mixed = [{ kind: "old", from: 0, to: 10 }, { kind: "new", from: 10, to: 30 }];
  assert.deepEqual(spanPictureReads({ stored, sessionReads: session, pieces: whole }), session);
  assert.deepEqual(spanPictureReads({ stored, sessionReads: session, pieces: mixed }), { keys: ["brand", "scene.title"], lang: false, all: false });
  assert.equal(spanPictureReads({ stored: { frameStart: 0 }, sessionReads: session, pieces: mixed }), null, "no record for the cached frames: none is claimed");
  assert.equal(spanPictureReads({ stored: null, sessionReads: session, pieces: mixed }), null);
  assert.equal(spanPictureReads({ stored, sessionReads: null, pieces: whole }), null);
});

// ---- 2 engine facts --------------------------------------------------------

test("splitEngineFacts: note-*, picture-string-missing and overlay-text-missing are facts; layout issues stay", () => {
  const issues = [
    { type: "text-outside-safe-area", text: "x" },
    { type: "note-word-not-found", lineId: "l1", at: "word:Hi" },
    { type: "note-missing-in-language", lineId: "l2" },
    { type: "picture-string-missing", key: "brand", lang: "en" },
    { type: "overlay-text-missing", key: "cta", lang: "en" },
    { type: "cue-word-not-found", asset: "a" },
  ];
  const { layout, facts } = splitEngineFacts(issues);
  assert.deepEqual(layout.map((i) => i.type), ["text-outside-safe-area", "cue-word-not-found"]);
  assert.equal(facts.length, 4);
  assert.deepEqual(splitEngineFacts(undefined), { layout: [], facts: [] });
});

test("engineFactLines: the safe-area note first, each distinct fact once with its count", () => {
  const facts = [
    { type: "picture-string-missing", key: "brand", lang: "en" },
    { type: "picture-string-missing", key: "brand", lang: "en" },
    { type: "note-text-missing", lineId: "l1", index: 0 },
  ];
  const lines = engineFactLines({ note: 'checked nothing: the safe area is "none"', facts });
  assert.equal(lines[0], 'note: checked nothing: the safe area is "none"');
  assert.equal(lines[1], 'fact: picture-string-missing key="brand" lang="en" (x2)');
  assert.equal(lines[2], 'fact: note-text-missing lineId="l1" index=0');
  assert.deepEqual(engineFactLines({ note: null, facts: [] }), []);
});

// ---- 3 setup disk limits ---------------------------------------------------

test("diskThresholds: defaults 0.8 GB and 5 GB; env overrides; bad values name the variable", () => {
  const gb = 1024 ** 3;
  const d = diskThresholds({});
  assert.equal(d.workBytes, 5 * gb);
  assert.equal(d.cacheBytes, 800 * 1024 ** 2);
  assert.deepEqual(diskThresholds({ SVA_MIN_CACHE_GB: "2", SVA_MIN_WORK_GB: "0" }), { cacheBytes: 2 * gb, workBytes: 0 });
  assert.throws(() => diskThresholds({ SVA_MIN_WORK_GB: "lots" }), /SVA_MIN_WORK_GB takes a number of GB/);
  assert.throws(() => diskThresholds({ SVA_MIN_CACHE_GB: "-1" }), /SVA_MIN_CACHE_GB/);
});

test("workStatus: --dir measures <reel>/out; without it the current folder is measured and said", () => {
  const gb = 1024 ** 3;
  const reel = path.join(os.tmpdir(), "sva-fix1-no-such-reel");
  const withDir = workStatus(reel, 1 * gb);
  assert.equal(withDir.dir, path.join(reel, "out"));
  assert.equal(withDir.measured, "reel");
  const cwd = workStatus(undefined, 1 * gb);
  assert.equal(cwd.dir, process.cwd());
  assert.equal(cwd.measured, "cwd");
  const cache = { dir: "/c", exists: true, free: 50 * gb, low: false };
  assert.match(diskLines(cache, { ...cwd, free: 80 * gb, low: false }).join("\n"), /measured the current folder.*--dir <reel>/);
  const reelLines = diskLines(cache, { ...withDir, free: 80 * gb, low: false }).join("\n");
  assert.match(reelLines, /render folder .*out/);
  assert.doesNotMatch(reelLines, /measured the current folder/);
  const low = diskLines({ ...cache, free: 1 * gb, needBytes: 2 * gb, low: true }, { ...withDir, free: 3 * gb, warnBytes: 4 * gb, low: true }).join("\n");
  assert.match(low, /under 2\.0 GB free there/);
  assert.match(low, /under 4\.0 GB free/);
});

// ---- 4 static scan and bundled libraries -----------------------------------

function reelWithSrc(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-fix1-scan-"));
  fs.writeFileSync(path.join(dir, "reel.html"), `<!doctype html><canvas id="c"></canvas><script>/* SCENE:BEGIN */\nvar a = 1;\n/* SCENE:END */</script>`);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, "src", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return path.join(dir, "reel.html");
}

test("static scan: bundled libraries under src/ are skipped and named; scene code under src/ still counts", () => {
  const lib = "setTimeout(function(){}, 1); setInterval(function(){}, 1);";
  const file = reelWithSrc({
    "vendor/gsap.js": lib,
    "lib/three.module.js": lib,
    "lib/three/examples/loader.js": lib,
    "lib/mine.js": "var b = 2;",
    "app.min.js": lib,
    "node_modules/x/index.js": lib,
    "scenes/a.js": "var c = 3;",
  });
  const r = scanReelHtml(file);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.equal(r.srcFiles, 2);
  assert.deepEqual([...r.skippedLibraries].sort(), ["app.min.js", "lib/three.module.js", "lib/three/", "vendor/"]);
  assert.match(staticScanLine(r), /skipped bundled libraries under src\/: .*vendor\//);
  const mine = reelWithSrc({ "scenes/bad.js": "setTimeout(function(){}, 5);" });
  assert.equal(scanReelHtml(mine).ok, false, "reel code in src/ is still scanned");
});

test("static scan: a reel with no bundled library prints no skipped line", () => {
  const r = scanReelHtml(reelWithSrc({ "scenes/a.js": "var c = 3;" }));
  assert.deepEqual(r.skippedLibraries, []);
  assert.doesNotMatch(staticScanLine(r), /skipped/);
});

// ---- 5 SVA_CHROME_ARGS -----------------------------------------------------

test("parseChromeArgs: whitespace split, or a JSON array when the value starts with [", () => {
  assert.deepEqual(parseChromeArgs(undefined), []);
  assert.deepEqual(parseChromeArgs("  --a   --b=1 "), ["--a", "--b=1"]);
  assert.deepEqual(parseChromeArgs('["--user-agent=My Agent 1.0", "--lang=en"]'), ["--user-agent=My Agent 1.0", "--lang=en"]);
  assert.throws(() => parseChromeArgs("[--a"), /JSON array of strings/);
  assert.throws(() => parseChromeArgs('["--a", 3]'), /array of strings/);
  assert.throws(() => parseChromeArgs('[{"a":1}]'), /array of strings/);
  assert.ok(chromeLaunchOptions({ SVA_CHROME_ARGS: '["--window-name=a b"]' }).args.includes("--window-name=a b"));
});

// ---- 6 contact sheet launch options ----------------------------------------

test("buildContactSheet launches with chromeLaunchOptions(process.env): a bad SVA_GPU stops it before Chromium opens", async () => {
  const before = process.env.SVA_GPU;
  process.env.SVA_GPU = "not-a-mode";
  try {
    await assert.rejects(buildContactSheet([{ png: Buffer.alloc(0), label: "x" }]), /SVA_GPU takes/);
  } finally {
    if (before === undefined) delete process.env.SVA_GPU;
    else process.env.SVA_GPU = before;
  }
});

// ---- A5 review 1: keyframes about every second in render encodes -----------

const FPS = 30;
const tmp = (p = "sva-fix1-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const same = (a, b) => a.length === b.length && a.every((h, i) => h === b[i]);

// A clip encoded by the encoder render.mjs uses for segments (default crf/preset), from a lavfi source.
async function renderEncode(source, frames, outPath, fps = FPS) {
  await ffmpeg(["-y", "-f", "lavfi", "-i", `${source}=size=160x120:rate=${fps}`, "-frames:v", String(frames), "-f", "image2pipe", "-c:v", "png", `${outPath}.pngs`]);
  const { proc, done } = spawnImagePipeEncoder({ fps, outPath });
  done.catch(() => {});
  proc.stdin.end(fs.readFileSync(`${outPath}.pngs`));
  await done;
  fs.rmSync(`${outPath}.pngs`);
}

test("keyframeInterval: one second of frames", () => {
  assert.equal(keyframeInterval(30), 30);
  assert.equal(keyframeInterval(24), 24);
  assert.equal(keyframeInterval(29.97), 30);
  assert.equal(keyframeInterval(0.2), 1);
});

test("render encodes (spawnImagePipeEncoder) keyframe every second: a short segment's untouched GOPs are copied in a splice", async () => {
  const dir = tmp();
  try {
    const old = path.join(dir, "old.mp4");
    await renderEncode("smptebars", 93, old); // 3.1 s: x264's default of 250 would give one keyframe
    assert.deepEqual((await probeGops(old)).keyFrames, [0, 30, 60, 90]);
    assert.deepEqual(planFrameCut({ from: 0, to: 30, keyFrames: [0, 30, 60, 90], total: 93 }), [{ kind: "copy", from: 0, to: 30 }]);
    const head = await cutFrames({ src: old, from: 0, to: 30, fps: FPS, crf: 18, preset: "medium", outPath: path.join(dir, "head.mp4") });
    const tail = await cutFrames({ src: old, from: 60, to: 93, fps: FPS, crf: 18, preset: "medium", outPath: path.join(dir, "tail.mp4") });
    assert.deepEqual(head.pieces.map((p) => p.kind), ["copy"]);
    assert.deepEqual(tail.pieces.map((p) => p.kind), ["copy"]);

    const fresh = path.join(dir, "fresh.mp4");
    await renderEncode("testsrc", 30, fresh);
    const workDir = path.join(dir, "work");
    fs.mkdirSync(workDir);
    const pieces = [{ kind: "old", from: 0, to: 30 }, { kind: "new", from: 30, to: 60 }, { kind: "old", from: 60, to: 93 }];
    const built = await spliceSpanPieces({ pieces, oldPath: old, renderNew: async (_p, out) => fs.copyFileSync(fresh, out), fps: FPS, crf: 18, preset: "medium", workDir });
    const [was, now] = [await frameHashes(old), await frameHashes(built)];
    assert.equal(now.length, 93);
    assert.ok(same(now.slice(0, 30), was.slice(0, 30)), "head frames keep their framemd5");
    assert.ok(same(now.slice(60), was.slice(60)), "tail frames keep their framemd5");
    assert.ok(same(now.slice(30, 60), await frameHashes(fresh)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the old default (one keyframe in a short clip) is why the splice used to re-encode: nothing to copy", async () => {
  const dir = tmp();
  try {
    const old = path.join(dir, "old.mp4");
    await ffmpeg(["-y", "-f", "lavfi", "-i", `smptebars=size=160x120:rate=${FPS}`, "-frames:v", "93", "-c:v", "libx264", "-pix_fmt", "yuv420p", old]);
    const gops = await probeGops(old);
    assert.deepEqual(gops.keyFrames, [0]);
    assert.deepEqual(planFrameCut({ from: 0, to: 30, keyFrames: gops.keyFrames, total: gops.total }), [{ kind: "encode", from: 0, to: 30 }]);
    assert.equal(widestKeyframeGap(gops), 93);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("widestKeyframeGap: the longest run between keyframes, the tail counted to the end", () => {
  assert.equal(widestKeyframeGap({ keyFrames: [0, 30, 60, 90], total: 93 }), 30);
  assert.equal(widestKeyframeGap({ keyFrames: [0, 10, 70], total: 100 }), 60);
  assert.equal(widestKeyframeGap({ keyFrames: [0], total: 93 }), 93);
});

// ---- A5 review 2: join falls back to the re-encode ---------------------------

async function joinNotes(argv) {
  const notes = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (s) => (notes.push(String(s)), true);
  process.stdout.write = silenceText(origOut);
  try {
    await joinMain(argv);
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }
  return notes.join("");
}

test("join.mjs: a variable-frame-rate part falls back to the re-encode, says why, and still writes the file", async () => {
  const dir = tmp();
  try {
    const a = path.join(dir, "a.mp4");
    await ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.7", "-frames:v", "20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "10", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", a]);
    const vfr = path.join(dir, "vfr.mp4");
    await ffmpeg(["-y", "-i", a, "-c", "copy", "-bsf:v", "setts=ts=TS+if(gte(N\\,10)\\,0.2/TB\\,0)", vfr]);
    assert.equal(await copyBlocker([a, vfr]), null, "same stream and rate: copy is attempted");
    const out = path.join(dir, "o.mp4");
    const notes = await joinNotes([out, a, vfr, "--json"]);
    assert.match(notes, /video: stream copy not possible \(video timestamps drift by half a frame/);
    assert.match(notes, /re-encoding every part/);
    assert.doesNotMatch(notes, /stream copy, no re-encode/);
    assert.ok((await probePacketCount(out)) >= 40, "the joined film has both parts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("copyBlocker: a part off the frame grid's rates or of another stream is named; matching parts give null", async () => {
  const dir = tmp();
  try {
    const mk = async (name, size, rate) => {
      const p = path.join(dir, `${name}.mp4`);
      await ffmpeg(["-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=${rate}`, "-frames:v", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", p]);
      return p;
    };
    const a = await mk("a", "160x120", "30");
    const b = await mk("b", "160x120", "30");
    const small = await mk("small", "96x64", "30");
    const odd = await mk("odd", "160x120", "7");
    assert.equal(await copyBlocker([a, b]), null);
    assert.match(await copyBlocker([a, small]), /small\.mp4 differs from the first part/);
    assert.match(await copyBlocker([a, odd]), /odd\.mp4 runs at 7 fps/);
    const ntsc = await mk("ntsc", "160x120", "30000/1001");
    assert.match(await copyBlocker([ntsc, a]), /a\.mp4 runs at 30 fps, the first part at 29\.97/, "an NTSC first part is a rate the grid holds; the other rate decides");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- A5 review 4: --bed-only compares against the hash taken before the link -

test("assertBedPair: a picture stream that is not the one hashed before the link stops the step", async () => {
  const dir = tmp();
  try {
    const video = path.join(dir, "picture-20260101-000000.mp4");
    await renderEncode("testsrc", 20, video, 10);
    const real = await videoStreamMd5(video);
    const args = { stampedVideo: video, stampedBed: path.join(dir, "no.wav"), stem: "picture", timingsPath: path.join(dir, "no.json"), durationSec: "2" };
    await assert.rejects(assertBedPair({ ...args, oldMd5: "0".repeat(32) }), /changed the picture stream \(md5 0+ -> [0-9a-f]{32}\); nothing published/);
    await assert.rejects(assertBedPair({ ...args, oldMd5: real }), /ENOENT|no\.json/, "with an equal stream the check goes on to the pair (which these fixtures lack)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- A5 review 5: the plan cache key carries the skill version ---------------

test("planCacheKey: includes the skill's package.json version and render.mjs's mtime", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "reel.html"), "<html></html>");
    const paths = reelPaths(dir);
    const key = JSON.parse(planCacheKey({ dir, paths, preview: false, noCaptions: true, lang: null, only: undefined, probeAll: false, stubSec: null, stubSegments: 1 }));
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"));
    const render_mjs = path.join(import.meta.dirname, "..", "scripts", "render.mjs");
    assert.equal(key.skill.version, pkg.version);
    assert.equal(key.skill.renderMtimeMs, fs.statSync(render_mjs).mtimeMs);
    assert.deepEqual(skillStamp(), key.skill);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- end to end in a real browser: --assemble cache order, --span with --lang ----

const FILM_FPS = 10;

// Shots draw by their own local time. `paint` repaints a stretch of the film (the changed frames);
// a language string `tint` (Reel.pictureText-style, read through the picture state) colours shot b.
function pageHtml({ lengths, paint = null }) {
  const shots = [];
  let t = 0;
  lengths.forEach((len, i) => {
    shots.push({ id: ["a", "b", "c"][i], start: t, end: t + len, readAt: t + 0.05, hue: 60 + i * 90 });
    t += len;
  });
  return `<!doctype html><body style="margin:0"><canvas id="c" width="64" height="48"></canvas><script>
const SHOTS = ${JSON.stringify(shots)}; const PAINT = ${JSON.stringify(paint)};
const ctx = document.getElementById("c").getContext("2d");
function draw(t) {
  const s = SHOTS.find((x) => t >= x.start && t < x.end) || SHOTS[SHOTS.length - 1];
  const local = t - s.start;
  const strings = (globalThis.__svaPicture && globalThis.__svaPicture.strings) || {};
  const tint = strings.tint;
  const changed = PAINT && t >= PAINT.from && t < PAINT.to;
  ctx.fillStyle = changed ? "#e02020" : (tint && s.id === "b" ? tint : "hsl(" + s.hue + ",60%,40%)"); ctx.fillRect(0, 0, 64, 48);
  ctx.fillStyle = "#fff"; ctx.fillRect(Math.round(local * 30) % 56, 8 + (s.hue % 7), 6, 6);
}
window.__reel = { width: 64, height: 48, fps: ${FILM_FPS}, duration: ${t}, ready: Promise.resolve(),
  shots: SHOTS.map((s) => ({ id: s.id, start: s.start, end: s.end, readAt: s.readAt })), seek(t) { draw(t); } };
</script></body>`;
}

function reelDir(lengths) {
  const dir = tmp("sva-fix1-reel-");
  fs.mkdirSync(path.join(dir, "voice"));
  fs.writeFileSync(path.join(dir, "reel.html"), pageHtml({ lengths }));
  fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify({ duration: lengths.reduce((a, b) => a + b, 0), lines: [] }));
  return dir;
}

// Silences the renders' text lines; the test runner's own event stream (binary chunks) still gets through.
const silenceText = (orig) => (chunk, ...rest) => (typeof chunk === "string" ? true : orig(chunk, ...rest));
const quiet = async (fn) => {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = silenceText(orig);
  try {
    return await fn();
  } finally {
    process.stdout.write = orig;
  }
};
const pictureRender = (dir, extra = {}) => render({ dir, paths: reelPaths(dir), preview: false, noCaptions: true, ...extra });
const real = (p) => fs.realpathSync(p);

test("--assemble: the segment cache is rewritten only after the film is published (a failed finish leaves it alone)", { timeout: 240000 }, async () => {
  const dir = reelDir([2, 2]); // a [0,20) b [20,40)
  const segDir = path.join(dir, "out", "segments", "final-nocap");
  try {
    await quiet(() => pictureRender(dir));
    const snapshot = () => ["a", "b"].flatMap((id) => [`${id}.json`, `${id}.mp4`]).map((n) => fs.readFileSync(path.join(segDir, n)).toString("base64"));
    const before = snapshot();
    const edl = path.join(dir, "edl.json");
    fs.writeFileSync(edl, JSON.stringify({ entries: [{ segment: "b" }, { segment: "a" }] }));
    // a voiced finish with no voice/narration.wav fails after the join and its gate
    await assert.rejects(quiet(() => render({ dir, paths: reelPaths(dir), preview: false, noCaptions: false, assemble: edl })));
    assert.deepEqual(snapshot(), before, "cache entries and mp4s are untouched by the failed assemble");
    assert.equal(fs.readdirSync(path.join(dir, "out")).filter((n) => /^_/.test(n)).length, 0, "no temp file is left");
    const bFrames = await frameHashes(path.join(segDir, "b.mp4"));
    await quiet(() => pictureRender(dir, { assemble: edl }));
    assert.ok(same(await frameHashes(path.join(segDir, "a.mp4")), bFrames), "a published assemble cuts the film's segments back into the cache: a's slot now holds b's frames");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--span with --lang: only the declared span of the language picture is drawn again; reads are kept; the base cache is untouched", { timeout: 240000 }, async () => {
  const dir = reelDir([2, 2, 2]);
  const out = path.join(dir, "out");
  const langSeg = path.join(out, "segments-en", "final-nocap");
  const baseSeg = path.join(out, "segments", "final-nocap");
  try {
    fs.mkdirSync(path.join(dir, "dub", "en"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dub", "en", "plan.json"), JSON.stringify({ meta: { lang: "en", overlay: { picture: { tint: "#20a040" } } }, lines: [] }));
    await quiet(() => pictureRender(dir));
    await quiet(() => pictureRender(dir, { lang: "en" }));
    const baseBefore = fs.readFileSync(path.join(baseSeg, "b.json"), "utf8");
    const filmBefore = await frameHashes(real(path.join(out, "picture-en.mp4")));
    assert.equal(filmBefore.length, 60);

    fs.writeFileSync(path.join(dir, "reel.html"), pageHtml({ lengths: [2, 2, 2], paint: { from: 2.5, to: 3.0 } }));
    const span = await quiet(() => pictureRender(dir, { lang: "en", spans: [{ fromSec: 2.5, toSec: 3.0 }] }));
    assert.equal(span.frames, 60);
    const film = await frameHashes(real(path.join(out, "picture-en.mp4")));
    assert.ok(same(film.slice(0, 20), filmBefore.slice(0, 20)) && same(film.slice(40), filmBefore.slice(40)), "frames outside the touched segment are the cached ones");
    assert.ok(!same(film.slice(20, 35), filmBefore.slice(20, 35)), "the span frames are drawn again");
    assert.deepEqual(await checkPicturePair({ outDir: out, lang: "en" }), { ok: true, problems: [] });
    const meta = JSON.parse(fs.readFileSync(path.join(langSeg, "b.json"), "utf8"));
    assert.ok(meta.picture && meta.picture.keys.includes("tint"), "the rebuilt segment records the strings it read");
    assert.equal(fs.readFileSync(path.join(baseSeg, "b.json"), "utf8"), baseBefore, "the base language's cache is not written by a language span");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
