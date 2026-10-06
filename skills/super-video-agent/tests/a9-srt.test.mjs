// SRT tool (scripts/lib/srt.mjs): cues from placed timings, break rules, cross-language check,
// and the script-vs-heard-words alignment used by `srt.mjs align`. No real STT.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  srtTime, formatSrt, parseSrt, buildCues, checkCues, formatChecks, compareTracks, formatComparison,
  parseScript, alignScript, defaultLineChars, sttExtractArgs,
} from "../scripts/lib/srt.mjs";
import { alignCaptionWords, matchLetters } from "../scripts/voice/word-align.mjs";

await import("../scripts/engine/reel-engine.js");
const Reel = globalThis.Reel;

/** A line whose words are 0.4 s each from `start`, text split on spaces ("|" markers are not words). */
function line(id, text, start = 0, step = 0.4) {
  const tokens = text.split(/\s+/).filter((t) => t && t !== "|");
  const words = tokens.map((w, i) => ({ w, start: start + i * step, end: start + (i + 1) * step }));
  return { id, text, start, end: start + tokens.length * step, words };
}

const rowsOf = (built) => built.cues.map((c) => c.lines);

test("srtTime and formatSrt/parseSrt round-trip", () => {
  assert.equal(srtTime(83.4567), "00:01:23,457");
  assert.equal(srtTime(3661.5), "01:01:01,500");
  const cues = [{ start: 0.5, end: 2, lines: ["Hello", "world"] }, { start: 2.25, end: 3, lines: ["Bye"] }];
  const back = parseSrt(formatSrt(cues));
  assert.deepEqual(back, cues);
  assert.throws(() => parseSrt("1\nnot a time\ntext"), /no "-->"/);
});

test("a writer's | and newline set the cue breaks", () => {
  const b = buildCues(Reel, [line("a", "We cannot | do it any other way."), line("b", "one two\nthree four", 10)], { lang: "en" });
  assert.deepEqual(rowsOf(b), [["We cannot"], ["do it any other way."], ["one two"], ["three four"]]);
  assert.equal(b.cues[1].start, 0.8);
  assert.ok(Math.abs(b.cues[1].end - 2.8) < 1e-9);
});

test("a long line breaks at the engine's phrase rules, never more than 2 rows", () => {
  const text = "The quick brown fox jumps over the lazy dog, and then the dog wakes up and chases the fox across the whole green field today.";
  const b = buildCues(Reel, [line("a", text)], { lang: "en", lineChars: 30 });
  assert.ok(b.cues.length >= 2);
  for (const c of b.cues) assert.ok(c.lines.length <= 2);
  assert.equal(b.cues.map((c) => c.lines.join(" ")).join(" "), text);
  assert.deepEqual(checkCues(b).filter((f) => f.type === "glued-break" || f.type === "too-many-rows"), []);
});

test("a number stays with its unit and no row ends on an article", () => {
  const text = "We moved 10 kg of the stone to the top of a hill near the river bank before noon.";
  for (const lineChars of [14, 16, 18, 20, 22, 26]) {
    const b = buildCues(Reel, [line("a", text)], { lang: "en", lineChars });
    for (const c of b.cues) {
      for (const r of c.lines) assert.ok(!/(^| )(the|a|of|to)$/i.test(r), `row ends on a function word: "${r}" at ${lineChars}`);
    }
    const joined = b.cues.flatMap((c) => c.lines);
    assert.ok(joined.some((r) => r.includes("10 kg")), `10 kg split at ${lineChars}: ${JSON.stringify(joined)}`);
  }
});

test("two rows when a chunk is longer than one row", () => {
  const b = buildCues(Reel, [line("a", "first half of it second half of it")], { lang: "en", lineChars: 20 });
  assert.equal(b.cues.length, 1);
  assert.equal(b.cues[0].lines.length, 2);
});

test("Japanese (no spaces) splits by character units with proportional times", () => {
  const text = "今日は十五分だけ早く家を出て駅まで歩きました";
  const l = { id: "j", text, start: 0, end: 4, words: [{ w: text, start: 0, end: 4 }] };
  const b = buildCues(Reel, [l], { lang: "ja", lineChars: 8 });
  assert.ok(b.cues.length > 1);
  assert.equal(b.cues.map((c) => c.lines.join("")).join(""), text);
  assert.equal(b.cues[0].start, 0);
  assert.ok(Math.abs(b.cues.at(-1).end - 4) < 1e-6);
  for (const f of checkCues(b)) assert.notEqual(f.type, "too-many-rows");
});

test("a line whose words do not match its text is timed by letters and reported", () => {
  const l = { id: "p", text: "alpha beta gamma", start: 1, end: 4, words: [{ w: "alpha beta", start: 1, end: 3 }] };
  const b = buildCues(Reel, [l], { lang: "en" });
  assert.equal(b.cues[0].start, 1);
  assert.ok(Math.abs(b.cues[0].end - 4) < 1e-6);
  assert.ok(checkCues(b).some((f) => f.type === "proportional-times" && f.id === "p"));
});

test("cue ends never pass the next cue's start; a cue has at least a minimum length", () => {
  const l = { id: "x", text: "aa | bb", start: 0, end: 1, words: [{ w: "aa", start: 0, end: 0.1 }, { w: "bb", start: 0.2, end: 1 }] };
  const b = buildCues(Reel, [l], { lang: "en" });
  assert.equal(b.cues[0].end, 0.2);
  assert.ok(b.cues[1].end > b.cues[1].start);
  assert.deepEqual(checkCues(b).filter((f) => f.type === "overlap"), []);
});

test("checkCues names a break that cuts a glued pair and a row over the limit", () => {
  const built = buildCues(Reel, [line("a", "we saw 10 kg today")], { lang: "en", lineChars: 42 });
  const cue = built.cues[0];
  cue.rows = [[0, 1, 2], [3, 4]];
  cue.lines = ["we saw 10", "kg today and a long tail of words past the limit"];
  const kinds = checkCues(built).map((f) => f.type);
  assert.ok(kinds.includes("glued-break"));
  assert.ok(kinds.includes("row-too-long"));
  assert.match(formatChecks(checkCues(built)), /glued-break/);
  assert.match(formatChecks([]), /no findings/);
});

test("compareTracks: same cue count and times across languages is equal", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: "l1", start: i, end: i + 0.9 }));
  const cmp = compareTracks({ ko: mk(3), en: mk(3).map((c) => ({ ...c, start: c.start + 0.02 })) });
  assert.equal(cmp.equal, true);
  assert.match(formatComparison(cmp), /same cue count, same times/);
});

test("compareTracks: differing counts, shifted times and a missing line are listed per line", () => {
  const ko = [{ id: "a", start: 0, end: 1 }, { id: "a", start: 1, end: 2 }, { id: "b", start: 3, end: 4 }, { id: "c", start: 5, end: 6 }];
  const en = [{ id: "a", start: 0, end: 2 }, { id: "b", start: 3.5, end: 4.5 }];
  const cmp = compareTracks({ ko, en });
  assert.equal(cmp.equal, false);
  const by = Object.fromEntries(cmp.rows.map((r) => [r.id, r]));
  assert.equal(by.a.countsEqual, false);
  assert.equal(by.a.timesEqual, true);
  assert.equal(by.b.countsEqual, true);
  assert.equal(by.b.timesEqual, false);
  assert.equal(by.c.timesEqual, false);
  const text = formatComparison(cmp);
  assert.match(text, /a: ko=2 en=1 — cue counts differ/);
  assert.match(text, /c: ko=1 en=0/);
});

test("compareTracks reads parsed SRT files (no line ids)", () => {
  const a = parseSrt("1\n00:00:00,000 --> 00:00:01,000\nx\n\n2\n00:00:01,000 --> 00:00:02,000\ny\n");
  const b = parseSrt("1\n00:00:00,000 --> 00:00:01,000\nx\n");
  assert.equal(compareTracks({ a, b }).rows[0].countsEqual, false);
});

test("parseScript: plain text rows or JSON lines with ids", () => {
  assert.deepEqual(parseScript("one two\n\n three | four \n"), [{ id: "l1", text: "one two" }, { id: "l2", text: "three | four" }]);
  assert.deepEqual(parseScript('{"lines":[{"id":"s1","text":"hi there"},{"id":"s2","text":" "}]}'), [{ id: "s1", text: "hi there" }]);
  assert.throws(() => parseScript('{"x":1}'), /no "lines"/);
});

test("defaultLineChars by language", () => {
  assert.equal(defaultLineChars("en-US"), 42);
  assert.equal(defaultLineChars("ko"), 22);
  assert.equal(defaultLineChars("zh-Hant"), 16);
});

/** Whole-recording heard words for a script, spelled a little differently from the text. */
function heardFor(texts, step = 0.3, gapEvery = 0.5) {
  const heard = [];
  let t = 1;
  for (const text of texts) {
    for (const w of text.toLowerCase().replace(/[.,|]/g, "").split(/\s+/).filter(Boolean)) {
      heard.push({ w, start: t, end: t + step });
      t += step;
    }
    t += gapEvery;
  }
  return heard;
}

test("alignScript: each script line takes its own stretch of the heard words, in order", () => {
  const script = [
    { id: "s1", text: "Hello there, friends." },
    { id: "s2", text: "We start at 9:15 | sharp." },
    { id: "s3", text: "Thanks for watching." },
  ];
  const heard = heardFor(["hello there friends", "we start at nine fifteen sharp", "thanks for watching"]);
  const out = alignScript(script, heard, { align: alignCaptionWords, letters: matchLetters, lang: "en" });
  assert.deepEqual(out.lines.map((l) => l.id), ["s1", "s2", "s3"]);
  assert.deepEqual(out.lowMatch, []);
  assert.ok(Math.abs(out.lines[0].start - 1) < 1e-6);
  assert.ok(out.lines[1].start > out.lines[0].end);
  assert.ok(out.lines[2].start > out.lines[1].end);
  assert.equal(out.lines[1].words.length, 5);
  assert.ok(Math.abs(out.lines[2].end - heard.at(-1).end) < 1e-6);
});

test("alignScript: a script line the audio never says is listed as low match; the rest still align", () => {
  const script = [
    { id: "s1", text: "Hello there friends." },
    { id: "s2", text: "Zebra quantum xylophone." },
    { id: "s3", text: "Thanks for watching." },
  ];
  const heard = heardFor(["hello there friends", "thanks for watching"]);
  const out = alignScript(script, heard, { align: alignCaptionWords, letters: matchLetters, lang: "en" });
  assert.ok(out.lowMatch.some((l) => l.id === "s2"));
  assert.ok(!out.lines.some((l) => l.id === "s2"), "an unmatched line gets no invented times");
  const s3 = out.lines.find((l) => l.id === "s3");
  assert.ok(s3 && s3.wordsMeasured === 3, "s3 is still found after the unmatched line");
});

test("alignScript output feeds buildCues: SRT cue times come from the heard words", () => {
  const script = [{ id: "s1", text: "Hello there | friends." }];
  const heard = heardFor(["hello there friends"]);
  const out = alignScript(script, heard, { align: alignCaptionWords, letters: matchLetters, lang: "en" });
  const b = buildCues(Reel, out.lines, { lang: "en" });
  assert.deepEqual(rowsOf(b), [["Hello there"], ["friends."]]);
  assert.ok(Math.abs(b.cues[0].start - 1) < 1e-6);
});
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main as srtMain } from "../scripts/srt.mjs";

test("srt.mjs build: one SRT per language from base + placed timings, report written", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `a9-srt-${process.pid}-`));
  try {
    const base = { duration: 5, lang: "en", lines: [line("l1", "We start now.", 0), line("l2", "Then we stop.", 2)] };
    const ko = { duration: 5, lang: "ko", provider: "dub", lines: [line("l1", "지금 바로 시작해요.", 0), line("l2", "그리고 곧 멈춰요.", 2)] };
    fs.mkdirSync(path.join(dir, "voice"), { recursive: true });
    fs.mkdirSync(path.join(dir, "dub", "ko"), { recursive: true });
    fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify(base));
    fs.writeFileSync(path.join(dir, "dub", "ko", "timings.placed.json"), JSON.stringify(ko));
    await srtMain(["build", dir]);
    const en = parseSrt(fs.readFileSync(path.join(dir, "out", "srt", "en.srt"), "utf8"));
    const koCues = parseSrt(fs.readFileSync(path.join(dir, "out", "srt", "ko.srt"), "utf8"));
    assert.equal(en.length, 2);
    assert.equal(koCues.length, 2);
    const report = JSON.parse(fs.readFileSync(path.join(dir, "out", "srt", "srt-report.json"), "utf8"));
    assert.equal(report.comparison.codes.length, 2);
    assert.equal(report.comparison.equal, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sttExtractArgs: a video gets a mono 16 kHz wav extract, a wav is passed on as it is", () => {
  const args = sttExtractArgs("/in/film.mp4", "/tmp/w/audio-16k.wav");
  assert.deepEqual(args.slice(args.indexOf("-vn")), ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "/tmp/w/audio-16k.wav"]);
  assert.equal(args[args.indexOf("-i") + 1], "/in/film.mp4");
  assert.equal(sttExtractArgs("/in/voice.WAV", "/tmp/x.wav"), null);
});
