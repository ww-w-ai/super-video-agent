// Pure-function tests for scripts/engine/reel-engine.js. The engine is a
// side-effect-only script (no import/export) that attaches globalThis.Reel;
// importing it here executes it exactly as the browser would.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const enginePath = path.join(here, "..", "scripts", "engine", "reel-engine.js");
await import(enginePath);
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

test("safeArea: 'none' frees the whole frame; an object sets the film's own margins", () => {
  Reel.setSafeArea("none");
  assert.deepEqual(Reel.safeArea(1080, 1920), { x: 0, y: 0, w: 1080, h: 1920 });
  assert.deepEqual(Reel.safeArea(1920, 1080), { x: 0, y: 0, w: 1920, h: 1080 });
  Reel.setSafeArea({ top: 60, bottom: 100, left: 40, right: 40 });
  assert.deepEqual(Reel.safeArea(1080, 1920), { x: 40, y: 60, w: 1000, h: 1760 });
  assert.throws(() => Reel.setSafeArea({ top: -1 }));
  assert.throws(() => Reel.setSafeArea("unknown-preset"));
  Reel.setSafeArea("shorts");
  assert.deepEqual(Reel.safeArea(1080, 1920), { x: 80, y: 200, w: 808, h: 1270 });
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

// --- balanced wrap: a greedy fill packs each row to the limit and can
// leave one short word alone on the last row (the owner's report — a
// caption wrapped "... 답을 만들어" / "가!"). wrapLines/textBlock now
// balance the row widths instead, keeping the same row count. fakeCtx
// measures 10px/char, so widths below are exact.

test("balanceRows: an uneven greedy wrap becomes two even rows at the same row count", () => {
  const ctx = fakeCtx();
  const words = ["aaaa", "bbbb", "cccc", "dd"]; // 40,40,40,20px; space=10px
  const widths = words.map((w) => ctx.measureText(w).width);
  const spaceW = ctx.measureText(" ").width;
  // greedy at 140: "aaaa bbbb cccc" (140) / "dd" (20) -- an orphan.
  const greedy = ["aaaa bbbb cccc", "dd"];
  assert.equal(greedy.length, 2);
  const balanced = Reel.balanceRows(widths, spaceW, 140);
  assert.equal(balanced.rows.length, 2); // same row count as the greedy fill
  const rowsAsWords = balanced.rows.map((row) => row.map((i) => words[i]));
  assert.deepEqual(rowsAsWords, [
    ["aaaa", "bbbb"],
    ["cccc", "dd"],
  ]);
});

test("balanceRows: a single-row fit is returned unchanged", () => {
  const ctx = fakeCtx();
  const widths = ["hi", "there"].map((w) => ctx.measureText(w).width);
  const spaceW = ctx.measureText(" ").width;
  const balanced = Reel.balanceRows(widths, spaceW, 1000);
  assert.equal(balanced.rows.length, 1);
  assert.deepEqual(balanced.rows[0], [0, 1]);
});

test("wrapLines (via textBlock): the same greedy-orphan text wraps evenly, not packed-then-orphaned", () => {
  Reel.clearIssues();
  const ctx = fakeCtx();
  // box width 140 at 10px/char: greedy would pack "aaaa bbbb cccc" (140)
  // then strand "dd" alone.
  const result = Reel.textBlock(ctx, "aaaa bbbb cccc dd", 0, 0, 140, 1000, { lineHeight: 40 });
  assert.equal(result.lines, 2);
  assert.deepEqual(ctx.calls.fillText.map((c) => c.text), ["aaaa bbbb", "cccc dd"]);
});

test("caption-orphan: not recorded for the balanced (even) wrap above", () => {
  Reel.clearIssues();
  const ctx = fakeCtx();
  Reel.textBlock(ctx, "aaaa bbbb cccc dd", 0, 0, 140, 1000, { lineHeight: 40 });
  assert.equal(Reel.issues().some((i) => i.type === "caption-orphan"), false);
});

test("caption-orphan: recorded when one word is too wide to ever share a row, even after balancing", () => {
  Reel.clearIssues();
  const ctx = fakeCtx();
  // "verylongwordddddddd" (19 chars = 190px) can never fit alongside any
  // other word even at the narrowest balanced width (its own), so "a b c"
  // (3 words) / "verylongwordddddddd" (1 word) survives balancing.
  const result = Reel.textBlock(ctx, "a b c verylongwordddddddd", 0, 0, 200, 1000, { lineHeight: 40 });
  assert.equal(result.lines, 2);
  const issue = Reel.issues().find((i) => i.type === "caption-orphan");
  assert.ok(issue, "expected a caption-orphan issue");
  assert.equal(issue.lastRow, "verylongwordddddddd");
});

// --- captionChunks: word-by-word caption chunking (pipeline.md "Picture
// first" — a film that reveals a line chunk by chunk rather than a
// wrapped box). Chunks at phrase punctuation first, then splits a long
// phrase evenly by word count (never packs-then-strands like a running
// char count would), then merges a lone <=3-char chunk into its neighbour.

function fakeWords(text) {
  return text.split(/\s+/).filter(Boolean).map((w, i) => ({ w, start: i, end: i + 1 }));
}

test("captionChunks: ko — the owner's report line does not leave '가!' alone", () => {
  const words = fakeWords("다음 토큰은 뭘까? 하나씩 척척 맞혀서 답을 만들어 가!");
  const chunks = Reel.captionChunks(words, 11);
  const asText = chunks.map((c) => c.map((i) => words[i].w).join(" "));
  assert.ok(!asText.includes("가!"), `got: ${JSON.stringify(asText)}`);
});

test("captionChunks: en — a long trailing word does not end up alone after an even split", () => {
  const words = fakeWords("Your words get chopped up into little numbered tokens.");
  const chunks = Reel.captionChunks(words, 16);
  const asText = chunks.map((c) => c.map((i) => words[i].w).join(" "));
  assert.ok(!asText.includes("tokens."), `got: ${JSON.stringify(asText)}`);
});

test("captionChunks: a lone <=3-char phrase (a connector like '자,') merges into its neighbour", () => {
  const words = fakeWords("자, 보이지? 답이 쓰이는 중인데 벌써 화면에 떠!");
  const chunks = Reel.captionChunks(words, 11);
  const asText = chunks.map((c) => c.map((i) => words[i].w).join(" "));
  assert.ok(!asText.includes("자,"), `got: ${JSON.stringify(asText)}`);
  assert.ok(asText.some((c) => c.startsWith("자, ")), `expected "자," merged forward, got: ${JSON.stringify(asText)}`);
});

test("captionChunks: records a caption-orphan issue when a one-word chunk survives merging (line has 3+ words)", () => {
  Reel.clearIssues();
  // "ab"+"cd" (<=3 chars each) merge into one chunk; the 22-char word is
  // too long to merge and has no other neighbour, so it stays alone.
  const words = fakeWords("ab cd superlongwordxxxxxxxxxx");
  const chunks = Reel.captionChunks(words, 9);
  const asText = chunks.map((c) => c.map((i) => words[i].w).join(" "));
  assert.ok(asText.includes("superlongwordxxxxxxxxxx"), `got: ${JSON.stringify(asText)}`);
  assert.ok(Reel.issues().some((i) => i.type === "caption-orphan"));
});

test("captionChunks: no split needed when the whole line fits under maxChars", () => {
  const words = fakeWords("short line here");
  const chunks = Reel.captionChunks(words, 100);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], [0, 1, 2]);
});

// --- "|" forced caption breaks (references/pipeline.md "Forced caption
// breaks"): a plan line's own "|" marker splits into exactly the pieces the
// author asked for, instead of automatic chunking cutting mid noun-phrase
// ("a radio / wave", found in production, only fixed by a hand table).

test("captionBreaksFromText: found-in-production line breaks into exactly three pieces", () => {
  const text = "It rides a radio wave | to that cell tower | up there,";
  const breaks = Reel.captionBreaksFromText(text);
  const words = fakeWords(text.replace(/\s*\|\s*/g, " "));
  const chunks = Reel.captionChunks(words, 1000, { breaks });
  assert.equal(chunks.length, 3);
  const asText = chunks.map((c) => c.map((i) => words[i].w).join(" "));
  assert.deepEqual(asText, ["It rides a radio wave", "to that cell tower", "up there,"]);
});

test("captionBreaksFromText: the marker itself never appears in a rendered chunk", () => {
  const text = "It rides a radio wave | to that cell tower | up there,";
  const breaks = Reel.captionBreaksFromText(text);
  const words = fakeWords(text.replace(/\s*\|\s*/g, " "));
  const chunks = Reel.captionChunks(words, 1000, { breaks });
  for (const c of chunks) {
    for (const i of c) assert.notEqual(words[i].w, "|");
  }
});

test("captionBreaksFromText: no marker -> no forced breaks", () => {
  assert.deepEqual(Reel.captionBreaksFromText("just a plain line"), []);
});

test("caption(): the '|' marker is never drawn", () => {
  Reel.clearIssues();
  const ctx = fakeCtx();
  Reel.caption(ctx, { text: "It rides a radio wave | to that cell tower | up there," }, 0, { width: 1080, height: 1920 });
  const drawn = ctx.calls.fillText.map((c) => c.text).join(" ");
  assert.ok(!drawn.includes("|"), `expected no "|" in drawn text, got: ${JSON.stringify(ctx.calls.fillText)}`);
});

test("captionBreaksFromText: a forced piece longer than maxChars still splits evenly instead of overflowing", () => {
  const text = "alpha bravo charlie delta echo foxtrot golf | hotel india";
  const breaks = Reel.captionBreaksFromText(text);
  const words = fakeWords(text.replace(/\s*\|\s*/g, " "));
  const chunks = Reel.captionChunks(words, 16, { breaks });
  for (const c of chunks) {
    const len = c.map((i) => words[i].w).join(" ").length;
    assert.ok(len <= 20, `chunk "${c.map((i) => words[i].w).join(" ")}" (${len} chars) did not balance under maxChars 16`);
  }
});

// --- captionsOn / caption() gating (render.mjs --no-captions,
// references/pipeline.md "Picture first"): ?captions=0 is read once from
// location.search at load, never inside seek(t). Node has no `location`
// global, so the top-level import above behaves exactly like a normal page
// load (captionsOn() true) — these two tests fake `location` and re-import
// the engine (cache-busted query so it is a fresh module load, exactly
// like a fresh page load) to exercise the off path without a browser.
test("captionsOn: true and caption() draws normally with no location.search (default, e.g. this test file's own import)", () => {
  assert.equal(Reel.captionsOn(), true);
  Reel.clearIssues();
  const ctx = fakeCtx();
  Reel.caption(ctx, { text: "hello" }, 0.1, { width: 1080, height: 1920 });
  assert.equal(ctx.calls.fillText.length, 1);
});

test("captionsOn: false when location.search is ?captions=0, and caption() then draws nothing", async () => {
  const previousLocation = globalThis.location;
  globalThis.location = { search: "?captions=0" };
  try {
    await import(`${pathToFileURL(enginePath).href}?variant=nocap`);
    const ReelNoCap = globalThis.Reel;
    assert.equal(ReelNoCap.captionsOn(), false);
    const ctx = fakeCtx();
    const result = ReelNoCap.caption(ctx, { text: "hello" }, 0.1, { width: 1080, height: 1920 });
    assert.equal(result, undefined);
    assert.equal(ctx.calls.fillText.length, 0);
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    globalThis.Reel = Reel; // restore the captions-on engine for any test that runs after this one
  }
});

// --- layer() / dubCode() (dub.mjs "let the reel draw its own captions",
// references/pipeline.md "Picture first"): ?layer=captions&dub=<code>,
// read once from location.search at load, same re-import approach as above.
test("layer/dubCode: both null with no location.search (default, this test file's own import)", () => {
  assert.equal(Reel.layer(), null);
  assert.equal(Reel.dubCode(), null);
});

test("layer/dubCode: parsed from ?layer=captions&dub=<code>", async () => {
  const previousLocation = globalThis.location;
  globalThis.location = { search: "?layer=captions&dub=en" };
  try {
    await import(`${pathToFileURL(enginePath).href}?variant=captionlayer`);
    const ReelLayer = globalThis.Reel;
    assert.equal(ReelLayer.layer(), "captions");
    assert.equal(ReelLayer.dubCode(), "en");
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    globalThis.Reel = Reel;
  }
});

test("layer/dubCode: only one of the two params set leaves the other null", async () => {
  const previousLocation = globalThis.location;
  globalThis.location = { search: "?layer=captions" };
  try {
    await import(`${pathToFileURL(enginePath).href}?variant=layeronly`);
    const ReelLayerOnly = globalThis.Reel;
    assert.equal(ReelLayerOnly.layer(), "captions");
    assert.equal(ReelLayerOnly.dubCode(), null);
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    globalThis.Reel = Reel;
  }
});

// --- boil: opts.moving scales jitter amplitude toward zero -----------------

test("boil: moving=0 (default) matches passing no moving opt at all", () => {
  const withZero = Reel.boil("scene:thing", 0.37, { moving: 0 });
  const withoutOpt = Reel.boil("scene:thing", 0.37, {});
  assert.deepEqual(withZero, withoutOpt);
});

test("boil: moving=1 gives exactly {dx:0, dy:0, rot:0}", () => {
  const p = Reel.boil("scene:thing", 0.37, { moving: 1 });
  assert.deepEqual(p, { dx: 0, dy: 0, rot: 0 });
  assert.ok(Object.is(p.dx, 0) && Object.is(p.dy, 0) && Object.is(p.rot, 0));
});

test("boil: moving=0.5 halves the amplitude of the moving=0 sample", () => {
  const still = Reel.boil("scene:thing", 0.37, {});
  const half = Reel.boil("scene:thing", 0.37, { moving: 0.5 });
  assert.ok(Math.abs(half.dx - still.dx / 2) < 1e-9);
  assert.ok(Math.abs(half.dy - still.dy / 2) < 1e-9);
  assert.ok(Math.abs(half.rot - still.rot / 2) < 1e-9);
});

// --- moving(t, intervals, opts) --------------------------------------------

test("moving: 0 with no intervals", () => {
  assert.equal(Reel.moving(1.0, []), 0);
  assert.equal(Reel.moving(1.0, null), 0);
});

test("moving: 1 strictly inside an interval, 0 well outside", () => {
  const intervals = [{ start: 1.0, end: 2.0 }];
  assert.equal(Reel.moving(1.5, intervals), 1);
  assert.equal(Reel.moving(1.0, intervals), 1); // inclusive start
  assert.equal(Reel.moving(2.0, intervals), 1); // inclusive end
  assert.equal(Reel.moving(0.0, intervals, { settleSec: 0.15 }), 0);
  assert.equal(Reel.moving(3.0, intervals, { settleSec: 0.15 }), 0);
});

test("moving: ramps 0->1 before start and 1->0 after end over settleSec", () => {
  const intervals = [{ start: 1.0, end: 2.0 }];
  const settleSec = 0.15;
  const before = Reel.moving(1.0 - settleSec / 2, intervals, { settleSec });
  assert.ok(Math.abs(before - 0.5) < 1e-9);
  const farBefore = Reel.moving(1.0 - settleSec, intervals, { settleSec });
  assert.ok(Math.abs(farBefore - 0) < 1e-9);
  const after = Reel.moving(2.0 + settleSec / 2, intervals, { settleSec });
  assert.ok(Math.abs(after - 0.5) < 1e-9);
  const farAfter = Reel.moving(2.0 + settleSec, intervals, { settleSec });
  assert.ok(Math.abs(farAfter - 0) < 1e-9);
});

test("moving: default settleSec is 0.15s", () => {
  const intervals = [{ start: 1.0, end: 2.0 }];
  const explicit = Reel.moving(0.925, intervals, { settleSec: 0.15 });
  const implicit = Reel.moving(0.925, intervals, {});
  assert.equal(explicit, implicit);
});

test("moving: deterministic — same (t, intervals) always returns the same value", () => {
  const intervals = [{ start: 1.0, end: 2.0 }];
  const a = Reel.moving(1.05, intervals);
  const b = Reel.moving(1.05, intervals);
  assert.equal(a, b);
});

test("moving: feeding into boil gives zero jitter throughout the move and half amplitude at the ramp midpoint", () => {
  const intervals = [{ start: 1.0, end: 2.0 }];
  const settleSec = 0.15;
  const duringMoveAmp = Reel.boil("k", 1.5, { moving: Reel.moving(1.5, intervals, { settleSec }) });
  assert.deepEqual(duringMoveAmp, { dx: 0, dy: 0, rot: 0 });
  // at the ramp midpoint moving() is 0.5, so boil at that same t should
  // equal half the amplitude of boil at that same t with no moving opt.
  const t = 1.0 - settleSec / 2;
  const m = Reel.moving(t, intervals, { settleSec });
  assert.ok(Math.abs(m - 0.5) < 1e-9);
  const still = Reel.boil("k", t, {});
  const ramped = Reel.boil("k", t, { moving: m });
  assert.ok(Math.abs(ramped.dx - still.dx / 2) < 1e-9);
  assert.ok(Math.abs(ramped.dy - still.dy / 2) < 1e-9);
  assert.ok(Math.abs(ramped.rot - still.rot / 2) < 1e-9);
});
