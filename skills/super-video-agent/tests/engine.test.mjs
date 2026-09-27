// Pure-function tests for scripts/engine/reel-engine.js. The engine is a
// side-effect-only script (no import/export) that attaches globalThis.Reel;
// importing it here executes it exactly as the browser would.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "..", "scripts", "engine", "reel-engine.js"));
const Reel = globalThis.Reel;

test("hash: deterministic for the same string", () => {
  assert.equal(Reel.hash("abc"), Reel.hash("abc"));
  assert.notEqual(Reel.hash("abc"), Reel.hash("abd"));
});

test("rng: same key produces the same sequence", () => {
  const a = Reel.rng("key-1");
  const b = Reel.rng("key-1");
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1);
  }
});

test("rng: different keys diverge", () => {
  const a = Reel.rng("key-a")();
  const b = Reel.rng("key-b")();
  assert.notEqual(a, b);
});

test("boil: identical output within the same floor(t*hz) bucket", () => {
  const hz = 8;
  const t1 = 0.101; // bucket floor(0.101*8)=0
  const t2 = 0.124; // bucket floor(0.124*8)=0
  const p1 = Reel.boil("scene:thing", t1, { hz });
  const p2 = Reel.boil("scene:thing", t2, { hz });
  assert.deepEqual(p1, p2);
});

test("boil: different output across bucket boundaries", () => {
  const hz = 8;
  const inBucket0 = Reel.boil("scene:thing", 0.05, { hz }); // bucket 0
  const inBucket1 = Reel.boil("scene:thing", 0.2, { hz }); // bucket 1
  assert.notDeepEqual(inBucket0, inBucket1);
});

test("boil: pure function of (key, t) — repeated calls at same t match, out of seek order", () => {
  const order = [0.3, 0.05, 0.2, 0.05, 0.3];
  const results = order.map((t) => Reel.boil("k", t, { hz: 8 }));
  assert.deepEqual(results[1], results[3]); // both t=0.05
  assert.deepEqual(results[0], results[4]); // both t=0.3
});

test("hold: quantises time to a step grid (on-twos: step = 2/fps)", () => {
  const step = 2 / 30; // ~0.0667
  assert.equal(Reel.hold(0.03, step), 0); // below first step -> bucket 0
  assert.ok(Math.abs(Reel.hold(0.09, step) - step) < 1e-9); // bucket 1
  assert.equal(Reel.hold(1, 0), 1); // step=0 -> passthrough
});

test("easing: easeOutCubic and easeOutBack are 0 at u=0 and ~1 at u=1", () => {
  assert.equal(Reel.easeOutCubic(0), 0);
  assert.ok(Math.abs(Reel.easeOutCubic(1) - 1) < 1e-9);
  assert.ok(Math.abs(Reel.easeOutBack(0) - 0) < 1e-9);
  assert.ok(Math.abs(Reel.easeOutBack(1) - 1) < 1e-9);
});

test("wobblePath: densifies and displaces, same t -> same points", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  const a = Reel.wobblePath(pts, "path1", 0.05, { step: 20, hz: 8, amp: 2 });
  const b = Reel.wobblePath(pts, "path1", 0.05, { step: 20, hz: 8, amp: 2 });
  assert.deepEqual(a, b);
  assert.ok(a.length > pts.length); // densified
});

// --- textBlock / caption: need a fake CanvasRenderingContext2D since
// node:test has no DOM. measureText approximates width as 10px/char so
// overflow is easy to force deterministically.
function fakeCtx() {
  const calls = { fillText: [] };
  let fontSeen = null;
  return {
    calls,
    get fontSeen() {
      return fontSeen;
    },
    save() {},
    restore() {},
    measureText(s) {
      return { width: s.length * 10 };
    },
    fillText(text, x, y) {
      calls.fillText.push({ text, x, y });
    },
    set font(v) {
      fontSeen = v;
    },
    set fillStyle(v) {},
    set textBaseline(v) {},
  };
}

test("textBlock: records an overflow issue when wrapped lines exceed the box height", () => {
  Reel.clearIssues();
  const ctx = fakeCtx();
  const longText = "word ".repeat(60).trim();
  const result = Reel.textBlock(ctx, longText, 0, 0, 100, 20, { lineHeight: 40 });
  assert.equal(result.overflow, true);
  const issues = Reel.issues();
  assert.ok(issues.some((i) => i.type === "text-overflow"));
});

test("textBlock: no issue when the box is tall enough", () => {
  Reel.clearIssues();
  const ctx = fakeCtx();
  const result = Reel.textBlock(ctx, "short", 100, 300, 700, 1000, { lineHeight: 40 });
  assert.equal(result.overflow, false);
  assert.equal(Reel.issues().length, 0);
});

test("caption: defaults to 800 56px Pretendard and a boxH that fits two lines but not three", () => {
  Reel.clearIssues();
  const ctxTwoLines = fakeCtx();
  // n=20 wraps to 2 lines at the 696px centred safe width under the 10px/char fake measurer.
  const twoLineText = "word ".repeat(20).trim();
  const twoLineResult = Reel.caption(ctxTwoLines, { text: twoLineText }, 0.1, {
    width: 1080,
    height: 1920,
  });
  assert.equal(ctxTwoLines.fontSeen, "800 56px 'Pretendard'");
  assert.equal(twoLineResult.lines, 2);
  assert.equal(twoLineResult.overflow, false);
  assert.equal(Reel.issues().length, 0);

  Reel.clearIssues();
  const ctxThreeLines = fakeCtx();
  // n=40 wraps to 3 lines under the same box — must overflow the 2-line boxH.
  const threeLineText = "word ".repeat(40).trim();
  const threeLineResult = Reel.caption(ctxThreeLines, { text: threeLineText }, 0.1, {
    width: 1080,
    height: 1920,
  });
  assert.equal(threeLineResult.lines, 3);
  assert.equal(threeLineResult.overflow, true);
  assert.ok(Reel.issues().some((i) => i.type === "text-overflow"));
});

test("caption: never boils — same line drawn at two different t lands at the same x,y", () => {
  const ctxA = fakeCtx();
  const ctxB = fakeCtx();
  const line = { text: "steady caption" };
  Reel.caption(ctxA, line, 0.1, { width: 1080, height: 1920 });
  Reel.caption(ctxB, line, 5.7, { width: 1080, height: 1920 });
  assert.deepEqual(ctxA.calls.fillText, ctxB.calls.fillText);
});

test("timeline: line(i).u(t) maps start->0, end->1, clamped outside", () => {
  const timings = {
    lines: [
      { id: "a", text: "hello world", start: 1, end: 3 },
      { id: "b", text: "second line", start: 3.25, end: 5 },
    ],
  };
  const tl = Reel.timeline(timings);
  const w0 = tl.line(0);
  assert.equal(w0.u(1), 0);
  assert.equal(w0.u(3), 1);
  assert.equal(w0.u(0), 0); // clamped
  assert.equal(w0.u(10), 1); // clamped
  assert.ok(Math.abs(w0.u(2) - 0.5) < 1e-9);
});

test("timeline: word(i,j) falls back to proportional split by character count", () => {
  const timings = {
    lines: [{ id: "a", text: "ab cd", start: 0, end: 1 }], // "ab"=2 chars, "cd"=2 chars -> even split
  };
  const tl = Reel.timeline(timings);
  const w0 = tl.word(0, 0);
  const w1 = tl.word(0, 1);
  assert.ok(Math.abs(w0.start - 0) < 1e-9);
  assert.ok(Math.abs(w0.end - 0.5) < 1e-9);
  assert.ok(Math.abs(w1.start - 0.5) < 1e-9);
  assert.ok(Math.abs(w1.end - 1) < 1e-9);
});

test("timeline: word(i,j) uses provider alignment when present", () => {
  const timings = {
    lines: [
      {
        id: "a",
        text: "ab cd",
        start: 0,
        end: 1,
        words: [
          { w: "ab", start: 0.1, end: 0.4 },
          { w: "cd", start: 0.4, end: 0.9 },
        ],
      },
    ],
  };
  const tl = Reel.timeline(timings);
  assert.deepEqual(tl.word(0, 0), { start: 0.1, end: 0.4 });
});

test("timeline: phrase(i, substring) spans the words containing that substring", () => {
  const timings = {
    lines: [{ id: "a", text: "seek는 순수 함수입니다", start: 0, end: 3 }],
  };
  const tl = Reel.timeline(timings);
  // "seek는 순수 함수입니다" -> 3 words of char lengths 4,2,6 = 12 total.
  // "순수" is word index 1 (proportional window).
  const win = tl.phrase(0, "순수");
  assert.ok(win);
  const w1 = tl.word(0, 1);
  assert.deepEqual(win, { start: w1.start, end: w1.end });
});

test("timeline: phrase(i, substring) spans multiple words when the substring crosses a word boundary", () => {
  const timings = { lines: [{ id: "a", text: "hello world today", start: 0, end: 3 }] };
  const tl = Reel.timeline(timings);
  const win = tl.phrase(0, "lo wor"); // straddles "hello" and "world"
  assert.ok(win);
  const w0 = tl.word(0, 0);
  const w1 = tl.word(0, 1);
  assert.deepEqual(win, { start: w0.start, end: w1.end });
});

test("timeline: phrase(i, substring) returns null when the substring isn't in the line", () => {
  const timings = { lines: [{ id: "a", text: "hello world", start: 0, end: 1 }] };
  const tl = Reel.timeline(timings);
  assert.equal(tl.phrase(0, "missing"), null);
  assert.equal(tl.phrase(5, "hello"), null); // no such line index
});

test("caption: 16:9 (1920x1080) fits a caption within ~70% width, font in [48,52]px, <=2 lines", () => {
  Reel.clearIssues();
  const ctx = fakeCtx();
  const line = { text: "word ".repeat(18).trim() }; // 18*5-1=89 chars @10px/char under fakeCtx measurer
  const result = Reel.caption(ctx, line, 0.1, { width: 1920, height: 1080 });
  const fontMatch = /800 (\d+)px/.exec(ctx.fontSeen);
  assert.ok(fontMatch, `unexpected font string: ${ctx.fontSeen}`);
  const px = Number(fontMatch[1]);
  assert.ok(px >= 48 && px <= 52, `caption font ${px}px outside [48,52] for 16:9`);
  assert.ok(result.lines <= 2, `expected <=2 lines, got ${result.lines}`);
  assert.equal(result.overflow, false);
  assert.equal(Reel.issues().length, 0);
});

test("safeArea: 9:16 shorts and ads boxes; other ratios keep 5% margins", () => {
  assert.deepEqual(Reel.safeArea(1080, 1920), { x: 80, y: 200, w: 808, h: 1270 });
  Reel.setSafeArea("ads");
  assert.deepEqual(Reel.safeArea(1080, 1920), { x: 80, y: 288, w: 808, h: 960 });
  Reel.setSafeArea("shorts");
  assert.deepEqual(Reel.safeArea(1920, 1080), { x: 96, y: 54, w: 1728, h: 972 });
});

test("centeredSafeArea: 9:16 box shares the frame's centre line; caption centres on x 540", () => {
  assert.deepEqual(Reel.centeredSafeArea(1080, 1920), { x: 192, y: 200, w: 696, h: 1270 });
  assert.deepEqual(Reel.centeredSafeArea(1920, 1080), Reel.safeArea(1920, 1080));
  const ctx = fakeCtx();
  Reel.caption(ctx, { text: "steady caption" }, 0.1, { width: 1080, height: 1920 });
  const { x } = ctx.calls.fillText[0];
  assert.equal(x + ("steady caption".length * 10) / 2, 540);
});

test("textBlock: text outside the safe area is an issue unless marked outsideSafeOk", () => {
  Reel.clearIssues();
  const ctx = fakeCtx();
  // Right edge at 1040 runs under the 9:16 right rail (safe box ends at 888).
  Reel.textBlock(ctx, "under the buttons", 900, 600, 140, 200, { lineHeight: 40, width: 1080, height: 1920 });
  const issue = Reel.issues().find((i) => i.type === "text-outside-safe-area");
  assert.ok(issue, "expected a text-outside-safe-area issue");

  Reel.clearIssues();
  Reel.textBlock(ctx, "decoration", 900, 600, 140, 200, { lineHeight: 40, width: 1080, height: 1920, outsideSafeOk: true });
  assert.equal(Reel.issues().length, 0);
});

test("caption: the default 9:16 caption sits inside the safe area, on its bottom edge", () => {
  Reel.clearIssues();
  const ctx = fakeCtx();
  Reel.caption(ctx, { text: "word ".repeat(20).trim() }, 0.1, { width: 1080, height: 1920 });
  assert.equal(Reel.issues().length, 0);
});

// --- cueTime / clipFrame (design.md §2.5 asset library) ----------------

function fakeTimings() {
  return {
    duration: 3,
    lines: [
      { id: "l1", text: "hello world today", start: 0, end: 1 },
      { id: "l2", text: "second line here", start: 1.25, end: 2 },
    ],
  };
}

test("cueTime: at:start / at:end resolve to the line's own start/end, plus offsetMs", () => {
  const timings = fakeTimings();
  const line = timings.lines[0];
  assert.equal(Reel.cueTime({ asset: "a", at: "start" }, line, timings), 0);
  assert.equal(Reel.cueTime({ asset: "a", at: "end" }, line, timings), 1);
  assert.ok(Math.abs(Reel.cueTime({ asset: "a", at: "end", offsetMs: -50 }, line, timings) - 0.95) < 1e-9);
});

test("cueTime: at:word:<text> resolves to the first matching word's start", () => {
  const timings = fakeTimings();
  const line = timings.lines[0]; // "hello world today", proportional split, 3 equal words over [0,1]
  const t = Reel.cueTime({ asset: "a", at: "word:world" }, line, timings);
  assert.ok(Math.abs(t - 1 / 3) < 1e-9);
});

test("cueTime: unresolvable word falls back to line.start and records an issue", () => {
  Reel.clearIssues();
  const timings = fakeTimings();
  const line = timings.lines[0];
  const t = Reel.cueTime({ asset: "a", at: "word:missing" }, line, timings);
  assert.equal(t, line.start);
  assert.ok(Reel.issues().some((i) => i.type === "cue-word-not-found"));
});

test("clipFrame: holds the last frame past the clip's own duration, deterministic", () => {
  const frames = ["f0", "f1", "f2"];
  Reel.registerClip("clip-a", frames, 2); // 2 fps -> frame i covers [i/2, (i+1)/2)
  assert.equal(Reel.clipFrame("clip-a", 0), "f0");
  assert.equal(Reel.clipFrame("clip-a", 0.6), "f1");
  assert.equal(Reel.clipFrame("clip-a", 100), "f2"); // well past the end: held
  assert.equal(Reel.clipFrame("clip-a", 100), Reel.clipFrame("clip-a", 100)); // pure
});

test("clipFrame: unknown clip id returns null", () => {
  assert.equal(Reel.clipFrame("no-such-clip", 0), null);
});

test("textBlock: a \\n in the text forces a line break even when the words would fit on one line", () => {
  Reel.clearIssues();
  const ctx = fakeCtx();
  const result = Reel.textBlock(ctx, "3점을 158개나\n넣었는데", 100, 300, 700, 1000, { lineHeight: 40 });
  assert.equal(result.lines, 2);
  assert.deepEqual(ctx.calls.fillText.map((c) => c.text), ["3점을 158개나", "넣었는데"]);
});
