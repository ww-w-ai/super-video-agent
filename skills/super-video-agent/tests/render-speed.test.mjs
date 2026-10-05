// Render speed (item 22): one page session per render (P4), first render by
// parts with --only and --stub --segments (P2), verify --range / --world (P5),
// and a language picture that skips probing segments whose base frames read
// no changed string (D2).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stubTimings, stubSegmentCount } from "../scripts/lib/browser.mjs";
import { createSessionPool } from "../scripts/lib/session-pool.mjs";
import { pendingIds, decideLangUnprobed } from "../scripts/lib/segments.mjs";
import { buildProbeTimes } from "../scripts/lib/determinism.mjs";
import { mergePictureReads, frameHashes } from "../scripts/render.mjs";
import { parseScopeFlags, worldWindows, shotsInWindows } from "../scripts/verify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");

// ---- --stub --segments --------------------------------------------------

test("stubTimings: one segment keeps the single 'stub' line; N splits the length evenly", () => {
  assert.deepEqual(stubTimings(3), stubTimings(3, 1));
  assert.deepEqual(stubTimings(3, 1).lines.map((l) => l.id), ["stub"]);
  const t = stubTimings(3, 3);
  assert.equal(t.duration, 3);
  assert.deepEqual(t.lines.map((l) => [l.id, l.start, l.end]), [["stub-1", 0, 1], ["stub-2", 1, 2], ["stub-3", 2, 3]]);
});

test("stubSegmentCount: absent → 1; needs a whole number and --stub", () => {
  assert.equal(stubSegmentCount(undefined, null), 1);
  assert.equal(stubSegmentCount("4", 2), 4);
  assert.throws(() => stubSegmentCount("0", 2), /whole number/);
  assert.throws(() => stubSegmentCount("2.5", 2), /whole number/);
  assert.throws(() => stubSegmentCount(true, 2), /whole number/);
  assert.throws(() => stubSegmentCount("3", null), /add --stub/);
});

// ---- session pool --------------------------------------------------------

function fakeOpen() {
  let n = 0;
  const warmed = [];
  const closed = [];
  const open = async () => {
    const s = { id: ++n, close: async () => closed.push(s.id) };
    return s;
  };
  const warm = async (s, ids) => warmed.push([s.id, [...ids]]);
  return { open, warm, warmed, closed };
}

test("session pool: sequential uses share one session; the open count stays 1", async () => {
  const f = fakeOpen();
  const pool = createSessionPool(f);
  const a = await pool.use(async (s) => s.id);
  const b = await pool.use(async (s) => s.id);
  const c = await pool.use(async (s) => s.id);
  assert.deepEqual([a, b, c], [1, 1, 1]);
  assert.equal(pool.opened, 1);
  await pool.closeAll();
  assert.deepEqual(f.closed, [1]);
});

test("session pool: two workers at once get two sessions, both kept for later", async () => {
  const f = fakeOpen();
  const pool = createSessionPool(f);
  const s1 = await pool.acquire();
  const s2 = await pool.acquire();
  assert.notEqual(s1.id, s2.id);
  pool.release(s1);
  pool.release(s2);
  await pool.use(async () => {});
  assert.equal(pool.opened, 2);
  await pool.closeAll();
  assert.deepEqual(f.closed.sort(), [1, 2]);
});

test("session pool: a discarded session is closed and never handed out again", async () => {
  const f = fakeOpen();
  const pool = createSessionPool(f);
  const s1 = await pool.acquire();
  await pool.discard(s1);
  assert.deepEqual(f.closed, [1]);
  const s2 = await pool.acquire();
  assert.equal(s2.id, 2);
  pool.release(s1); // a stale release of the discarded one is ignored
  pool.release(s2);
  assert.equal((await pool.acquire()).id, 2);
});

test("session pool: warmFor warms open sessions and later ones with the same shots", async () => {
  const f = fakeOpen();
  const pool = createSessionPool(f);
  const s1 = await pool.acquire();
  assert.deepEqual(f.warmed, [], "a session opened before warmFor is not warmed on open");
  pool.release(s1);
  await pool.warmFor(["a", "b"]);
  assert.deepEqual(f.warmed, [[1, ["a", "b"]]]);
  const busy = await pool.acquire();
  const s2 = await pool.acquire();
  assert.equal(s2.id, 2);
  assert.deepEqual(f.warmed[1], [2, ["a", "b"]]);
  pool.release(busy);
  pool.release(s2);
});

test("session pool: use() gives the session back when the callback throws", async () => {
  const f = fakeOpen();
  const pool = createSessionPool(f);
  await assert.rejects(pool.use(async () => { throw new Error("x"); }), /x/);
  assert.equal(await pool.use(async (s) => s.id), 1);
  assert.equal(pool.opened, 1);
});

// ---- --only first render (pending) ----------------------------------------

const SEGS = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

test("pendingIds: segments outside --only with no stored meta or no mp4 are pending", () => {
  const storedById = new Map([["a", { frameStart: 0 }], ["b", null], ["c", { frameStart: 9 }], ["d", null]]);
  const mp4ExistsById = new Map([["a", true], ["b", false], ["c", false], ["d", false]]);
  assert.deepEqual(pendingIds({ segments: SEGS, onlyIds: ["d"], storedById, mp4ExistsById }), ["b", "c"]);
  assert.deepEqual(pendingIds({ segments: SEGS, onlyIds: ["b", "c", "d"], storedById, mp4ExistsById }), []);
});

// ---- language picture: unprobed copy -------------------------------------

const CUR = { frameStart: 0, frameEnd: 30, fps: 30, width: 8, height: 8 };
const base = (picture) => ({ ...CUR, probes: ["p1", "p2", "p3"], picture });

test("decideLangUnprobed: base frames that read no changed key are copied without a probe", () => {
  const d = decideLangUnprobed({ storedBase: base({ keys: ["title"], lang: false, all: false }), storedLang: null, current: CUR, strings: { brand: "B" }, baseMp4Exists: true, langMp4Exists: false });
  assert.equal(d.action, "COPY");
});

test("decideLangUnprobed: the language's own copy of the same base segment is reused", () => {
  const d = decideLangUnprobed({ storedBase: base({ keys: [], lang: false, all: false }), storedLang: base(undefined), current: CUR, strings: {}, baseMp4Exists: true, langMp4Exists: true });
  assert.equal(d.action, "REUSE");
});

test("decideLangUnprobed: a changed key, a Reel.lang read, a key listing or no record means probe", () => {
  const args = { storedLang: null, current: CUR, strings: { brand: "B" }, baseMp4Exists: true, langMp4Exists: false };
  assert.equal(decideLangUnprobed({ ...args, storedBase: base({ keys: ["brand"], lang: false, all: false }) }), null);
  assert.equal(decideLangUnprobed({ ...args, storedBase: base({ keys: [], lang: true, all: false }) }), null);
  assert.equal(decideLangUnprobed({ ...args, storedBase: base({ keys: [], lang: false, all: true }) }), null);
  assert.equal(decideLangUnprobed({ ...args, storedBase: base(undefined) }), null);
  assert.equal(decideLangUnprobed({ ...args, storedBase: base({ keys: [], lang: false, all: false }), baseMp4Exists: false }), null);
  assert.equal(decideLangUnprobed({ ...args, storedBase: { ...base({ keys: [], lang: false, all: false }), frameEnd: 31 } }), null);
  // an empty string in the language plan draws the fallback, so it changes nothing
  assert.equal(decideLangUnprobed({ ...args, strings: { brand: "" }, storedBase: base({ keys: ["brand"], lang: false, all: false }) }).action, "COPY");
});

test("mergePictureReads: union of keys, either flag wins, null when both are absent", () => {
  assert.equal(mergePictureReads(null, null), null);
  assert.deepEqual(mergePictureReads({ keys: ["b"], lang: false, all: false }, { keys: ["a", "b"], lang: true, all: false }), { keys: ["a", "b"], lang: true, all: false });
  assert.deepEqual(mergePictureReads(null, { keys: [], lang: false, all: true }), { keys: [], lang: false, all: true });
});

// ---- verify --range / --world ---------------------------------------------

test("parseScopeFlags: --range t0-t1, --world key, not both", () => {
  assert.equal(parseScopeFlags({}), null);
  assert.deepEqual(parseScopeFlags({ range: "4-9.5" }), { range: { from: 4, to: 9.5 } });
  assert.deepEqual(parseScopeFlags({ world: "park" }), { world: "park" });
  assert.throws(() => parseScopeFlags({ range: "9-4" }), /t1 > t0/);
  assert.throws(() => parseScopeFlags({ range: "abc" }), /--range takes/);
  assert.throws(() => parseScopeFlags({ range: "1-2", world: "x" }), /use one/);
  assert.throws(() => parseScopeFlags({ world: true }), /--world takes/);
});

test("worldWindows / shotsInWindows: a world's windows and the shots over them", () => {
  const segs = [{ from: 0, to: 4, key: "desk" }, { from: 4, to: 9, key: "park" }, { from: 9, to: 12, key: "desk" }];
  assert.deepEqual(worldWindows(segs, "desk"), [{ from: 0, to: 4 }, { from: 9, to: 12 }]);
  assert.throws(() => worldWindows(segs, "lab"), /keys: desk, park/);
  assert.throws(() => worldWindows(null, "desk"), /window\.__reel\.segments/);
  const shots = [{ id: "s1", start: 0, end: 3 }, { id: "s2", start: 3, end: 6 }, { id: "s3", start: 6, end: 12 }];
  assert.deepEqual(shotsInWindows(shots, [{ from: 7, to: 8 }]).map((s) => s.id), ["s3"]);
});

test("buildProbeTimes: unchanged without windows; inside the windows with them, still >= 12", () => {
  const shots = [{ start: 0, end: 5, readAt: 2.5 }, { start: 5, end: 10, readAt: 7.5 }];
  const all = buildProbeTimes(shots, 10, 8);
  assert.ok(all.length >= 12);
  assert.deepEqual(buildProbeTimes(shots, 10, 8, null), all);
  const scoped = buildProbeTimes(shots, 10, 8, [{ from: 6, to: 9 }]);
  assert.ok(scoped.length >= 12, `got ${scoped.length}`);
  assert.ok(scoped.every((t) => t >= 6 && t <= 9));
});

// ---- end to end on a tiny page ---------------------------------------------

// 8x8 page, 30 fps. The colour is a function of the frame number; during
// 1.0-2.0 s it also depends on the picture string "brand". The page reads
// globalThis.__svaPicture the way reel-engine.js pictureText() does.
const PAGE = `<!doctype html><canvas width="8" height="8"></canvas><script>
var timings = null;
var ready = fetch("voice/timings.json").then(function (r) { if (!r.ok) throw new Error("voice/timings.json not found"); return r.json(); }).then(function (d) { timings = d; });
function pictureText(key, fallback) {
  var p = globalThis.__svaPicture; var s = p && p.strings;
  if (s && typeof s === "object" && Object.prototype.hasOwnProperty.call(s, key) && s[key]) return s[key];
  return fallback;
}
window.__reel = {
  width: 8, height: 8, fps: 30, ready: ready,
  get duration() { return timings.duration; },
  get shots() { return timings.lines.map(function (l) { return { id: l.id, start: l.start, end: l.end, readAt: (l.start + l.end) / 2 }; }); },
  seek: function (t) {
    var g = document.querySelector("canvas").getContext("2d");
    var f = Math.round(t * 30);
    var extra = 0;
    if (t >= 1 && t < 2) extra = pictureText("brand", "base").length * 20;
    g.fillStyle = "rgb(" + ((f * 7) % 256) + "," + ((f * 13 + extra) % 256) + ",90)";
    g.fillRect(0, 0, 8, 8);
  },
};
</script>`;

function renderRun(dir, args) {
  const r = spawnSync(process.execPath, [path.join(scripts, "render.mjs"), dir, "--no-captions", "--stub", "3", "--segments", "3", ...args], { encoding: "utf8", timeout: 180000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout;
}

function newReel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-speed-"));
  fs.writeFileSync(path.join(dir, "reel.html"), PAGE);
  return dir;
}

test("render: a first render by parts, then the join; one page open per run; frames equal a one-pass render", { timeout: 300000 }, async () => {
  const parts = newReel();
  const whole = newReel();
  try {
    const first = renderRun(parts, ["--only", "stub-1"]);
    assert.match(first, /PENDING {2}stub-2/);
    assert.match(first, /PENDING {2}stub-3/);
    assert.match(first, /not joined: 2 segment\(s\) not rendered yet: stub-2, stub-3/);
    assert.match(first, /page opens: 1\n/);
    assert.equal(fs.existsSync(path.join(parts, "out", "picture.mp4")), false);

    const second = renderRun(parts, ["--only", "stub-2,stub-3"]);
    assert.match(second, /REUSE {2}stub-1 .*probe hashes match/); // the neighbour of stub-2 is probed, not re-rendered
    assert.match(second, /wrote .*picture\.mp4\n/);
    assert.match(second, /page opens: 1\n/);

    const again = renderRun(parts, []);
    assert.equal((again.match(/^REUSE /gm) || []).length, 3);
    assert.match(again, /page opens: 1\n/);

    renderRun(whole, []);
    const a = await frameHashes(path.join(parts, "out", "picture.mp4"));
    const b = await frameHashes(path.join(whole, "out", "picture.mp4"));
    assert.equal(a.length, 90);
    assert.deepEqual(a, b);

    const stored = JSON.parse(fs.readFileSync(path.join(whole, "out", "segments", "final-nocap", "stub-2.json"), "utf8"));
    assert.deepEqual(stored.picture, { keys: ["brand"], lang: false, all: false });
    const opening = JSON.parse(fs.readFileSync(path.join(whole, "out", "segments", "final-nocap", "stub-1.json"), "utf8"));
    assert.deepEqual(opening.picture, { keys: ["brand"], lang: false, all: false }); // every read the page made in the session, warm-up included
  } finally {
    fs.rmSync(parts, { recursive: true, force: true });
    fs.rmSync(whole, { recursive: true, force: true });
  }
});

test("render --lang: a segment reading a changed string is rendered; strings no page read skip the probe", { timeout: 300000 }, async () => {
  const dir = newReel();
  try {
    renderRun(dir, []);
    fs.mkdirSync(path.join(dir, "dub", "en"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dub", "en", "plan.json"), JSON.stringify({ meta: { lang: "en", overlay: { picture: { brand: "Brand name" } } }, lines: [] }));
    const out = renderRun(dir, ["--lang", "en"]);
    assert.match(out, /COPY {2}stub-1 .*probe hashes equal/);
    assert.match(out, /RENDER {2}stub-2 /);
    assert.match(out, /COPY {2}stub-3 .*probe hashes equal/);
    const basePic = await frameHashes(path.join(dir, "out", "picture.mp4"));
    const enPic = await frameHashes(path.join(dir, "out", "picture-en.mp4"));
    assert.equal(enPic.length, 90);
    assert.deepEqual(enPic.slice(0, 30), basePic.slice(0, 30));
    assert.notDeepEqual(enPic.slice(30, 60), basePic.slice(30, 60));
    assert.deepEqual(enPic.slice(60), basePic.slice(60));

    const probed = renderRun(dir, ["--lang", "en", "--probe-all"]);
    assert.doesNotMatch(probed, /not probed/);
    assert.equal((probed.match(/^REUSE /gm) || []).length, 3);

    fs.mkdirSync(path.join(dir, "dub", "de"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dub", "de", "plan.json"), JSON.stringify({ meta: { lang: "de", overlay: { picture: { unused: "nie gelesen" } } }, lines: [] }));
    const unread = renderRun(dir, ["--lang", "de"]);
    assert.equal((unread.match(/^COPY {2}stub-\d .*not probed/gm) || []).length, 3);
    assert.deepEqual(await frameHashes(path.join(dir, "out", "picture-de.mp4")), basePic);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The same page, but it reads "brand" once and caches it: whichever seek
// reads first (warm-up, a probe, an earlier segment), later frames draw the
// cached string without reading it again.
const CACHING_PAGE = PAGE.replace("var timings = null;", "var timings = null; var cached = null;").replace(
  'if (t >= 1 && t < 2) extra = pictureText("brand", "base").length * 20;',
  'if (t >= 1 && t < 2) { if (cached === null) cached = pictureText("brand", "base"); extra = cached.length * 20; }'
);

test("render --lang on a page that caches its picture string: the segment that draws it is rendered, not copied", { timeout: 300000 }, async () => {
  assert.notEqual(CACHING_PAGE, PAGE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-speed-cache-"));
  fs.writeFileSync(path.join(dir, "reel.html"), CACHING_PAGE);
  try {
    renderRun(dir, []);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "out", "segments", "final-nocap", "stub-2.json"), "utf8"));
    assert.ok(stored.picture.keys.includes("brand"), `stub-2 recorded ${JSON.stringify(stored.picture)}`);
    fs.mkdirSync(path.join(dir, "dub", "en"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dub", "en", "plan.json"), JSON.stringify({ meta: { lang: "en", overlay: { picture: { brand: "Brand name" } } }, lines: [] }));
    const out = renderRun(dir, ["--lang", "en"]);
    assert.match(out, /RENDER {2}stub-2 /);
    const basePic = await frameHashes(path.join(dir, "out", "picture.mp4"));
    const enPic = await frameHashes(path.join(dir, "out", "picture-en.mp4"));
    assert.equal(enPic.length, 90);
    assert.notDeepEqual(enPic.slice(30, 60), basePic.slice(30, 60));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
