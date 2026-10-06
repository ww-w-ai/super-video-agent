// A11: review copy (--copy), "checked nothing" reports, page-declared regions, per-language glyph
// pre-check, and intended holds. Pure logic on plain data plus two tiny ffmpeg fixtures (64x64, 2 s).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ffmpeg, ffprobe } from "../scripts/lib/ffmpeg.mjs";
import { splitIntendedHolds } from "../scripts/lib/dead-air.mjs";
import { analyzeMotion } from "../scripts/lib/frame-diff.mjs";
import { regionCovers, checkedNothingReasons, fontForLang, captionChars, langGlyphPairs, langGlyphReport, formatStateChecks } from "../scripts/lib/state-checks.mjs";
import { formatCueWarnings } from "../scripts/lib/cue-check.mjs";
import { parseHolds, reviewCueText, buildReviewSrt, reviewCopy, reviewLayers, reviewFile } from "../scripts/review.mjs";
import { reelPaths } from "../scripts/lib/reeldir.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "a11-"));

test("splitIntendedHolds: the part inside a declared hold moves out; the rest stays flagged only if still long enough", () => {
  const r = splitIntendedHolds([{ startSec: 2, durationSec: 4 }], [{ from: 3, to: 5 }], 0.8);
  assert.deepEqual(r.intendedHolds, [{ startSec: 3, durationSec: 2 }]);
  assert.deepEqual(r.runs, [{ startSec: 2, durationSec: 1 }, { startSec: 5, durationSec: 1 }]);
  const short = splitIntendedHolds([{ startSec: 2, durationSec: 1 }], [{ from: 2.3, to: 3 }], 0.8);
  assert.deepEqual(short.runs, []);
  assert.equal(splitIntendedHolds([{ startSec: 0, durationSec: 2 }], [], 0.8).runs.length, 1);
});

test("analyzeMotion: a frozen run flagged without holds, listed as intended inside a declared hold", () => {
  const frames = Array.from({ length: 31 }, () => Buffer.alloc(16, 7));
  assert.equal(analyzeMotion(frames, 30).deadAirRuns.length, 1);
  const r = analyzeMotion(frames, 30, { holds: [{ from: 0, to: 2 }] });
  assert.equal(r.deadAirRuns.length, 0);
  assert.equal(r.intendedHoldRuns.length, 1);
});

test("regionCovers: label over key counts only while both are on screen; outline grows the label; no key = nothing", () => {
  const regions = [
    { id: "chart", kind: "key", box: [100, 100, 300, 300] },
    { id: "tag", kind: "label", box: [280, 100, 400, 140], from: 1, to: 2 },
    { id: "late", kind: "label", box: [100, 100, 150, 150], from: 5, to: 6, },
    { id: "logo", kind: "overlay", box: [0, 0, 120, 120] },
    { id: "edge", kind: "label", box: [305, 100, 400, 140], outline: 12 },
  ];
  const r = regionCovers(regions, { duration: 4 });
  const by = Object.fromEntries(r.map((x) => [x.label, x]));
  assert.equal(by.tag.sharePx, 20 * 40);
  assert.equal(by.tag.from, 1);
  assert.equal(by.late, undefined); // the key is on screen 0-4 s, this label 5-6 s
  assert.equal(by.logo.alwaysOn, true);
  assert.equal(by.tag.alwaysOn, false);
  assert.equal(by.edge.sharePx, 1 * 46); // box starts at x=305; grown by half the 12 px outline it reaches x=299, 1 px into the key, over 46 px of height
  assert.deepEqual(regionCovers([{ id: "t", kind: "label", box: [0, 0, 10, 10] }], { duration: 4 }), []);
});

test("checkedNothingReasons: empty pages say so; a page with texts does not", () => {
  const empty = checkedNothingReasons({ frames: [{ texts: [] }, { texts: [] }, { texts: [] }], checks: ["overlap", "glyphs", "flicker"], hasLayerHook: false });
  assert.deepEqual(empty.map((n) => n.check).sort(), ["glyph fallback", "one-frame flicker", "text overlap"]);
  const t = (text, box) => ({ text, box, alpha: 1, font: "20px X" });
  const ok = checkedNothingReasons({ frames: Array(3).fill({ texts: [t("a", [0, 0, 5, 5]), t("b", [9, 9, 12, 12])] }), checks: ["overlap", "glyphs", "flicker"], hasLayerHook: false });
  assert.deepEqual(ok, []);
  const out = formatStateChecks({ overlaps: {}, glyphs: { fallbacks: [], missingFamilies: [], uncheckedFonts: [] }, flicker: [], sampledFrames: 3, hooks: false, nothing: empty });
  assert.match(out, /text overlap: checked nothing/);
  assert.doesNotMatch(out, /text overlap: none/);
});

test("language glyphs: fonts resolve per language; a character the font lacks is reported for that language only", () => {
  assert.equal(fontForLang("ko", { ko: "Pretendard", "*": "Inter" }, null), "Pretendard");
  assert.equal(fontForLang("vi", { ko: "Pretendard", "*": "Inter" }, null), "Inter");
  assert.equal(fontForLang("vi", null, { caption: "Roboto" }), "Roboto");
  assert.equal(fontForLang("vi", null, null), null);
  assert.deepEqual(captionChars("a b|c\nd"), ["a", "b", "c", "d"]);
  const langs = [
    { lang: "en", lines: [{ id: "l1", text: "Hi" }] },
    { lang: "vi", lines: [{ id: "l1", text: "Ơ|ế" }, { id: "l2", text: "Ơ" }] },
    { lang: "th", lines: [{ id: "l1", text: "ก" }] },
  ];
  const plan = langGlyphPairs(langs, (l) => (l === "th" ? null : "Inter"));
  assert.deepEqual(plan.noFont, ["th"]);
  assert.equal(plan.pairs.length, 4); // H i Ơ ế
  const covered = plan.entries.map((e) => e.char !== "ế");
  const rep = langGlyphReport(plan, covered, langs);
  assert.equal(rep.definitelyWrong, true);
  const vi = rep.languages.find((l) => l.lang === "vi");
  assert.deepEqual(vi.missing.map((m) => [m.char, m.codepoint, m.lineIds]), [["ế", "U+1EBF", ["l1"]]]);
  assert.equal(rep.languages.find((l) => l.lang === "en").missing.length, 0);
  assert.equal(rep.languages.find((l) => l.lang === "th").noFont, true);
});

test("cue-check: zero word cues is 'checked nothing', not a clean pass", () => {
  assert.match(formatCueWarnings([], 0), /^checked nothing:/);
  assert.match(formatCueWarnings([], 2), /2 word cues checked, no warnings/);
});

test("parseHolds / reviewCueText / buildReviewSrt", () => {
  assert.deepEqual(parseHolds("12.5-15, 40-44"), [{ from: 12.5, to: 15 }, { from: 40, to: 44 }]);
  assert.throws(() => parseHolds("5-3"), /from-to/);
  assert.equal(reviewCueText("l3", "Hello | world\nagain"), "l3 Hello world again");
  const srt = buildReviewSrt([{ id: "a", start: 0, end: 1.5, text: "old" }, { id: "b", start: 1.5, end: 3661.25, text: "x" }], new Map([["a", "new text"]]));
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\na new text\n\n2\n00:00:01,500 --> 01:01:01,250\nb x\n$/);
});

async function mp4(out, { audio = true } = {}) {
  const args = ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=2:r=10"];
  if (audio) args.push("-f", "lavfi", "-i", "sine=f=440:d=2");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac");
  args.push(out);
  await ffmpeg(args);
}

async function streams(file) {
  const { stdout } = await ffprobe(["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", file]);
  return stdout.toString().trim().split("\n").sort();
}

function makeReel(dir) {
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.mkdirSync(path.join(dir, "voice"), { recursive: true });
  fs.mkdirSync(path.join(dir, "dub", "ko"), { recursive: true });
  const lines = [{ id: "l1", text: "Hello there" }];
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: { lang: "en" }, lines }));
  fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify({ duration: 2, lines: [{ id: "l1", start: 0, end: 1, text: "Hello there" }] }));
  fs.writeFileSync(path.join(dir, "dub", "ko", "plan.json"), JSON.stringify({ meta: { lang: "ko" }, lines: [{ id: "l1", text: "안녕 하세요" }] }));
  fs.writeFileSync(path.join(dir, "dub", "ko", "timings.placed.json"), JSON.stringify({ duration: 2, lines: [{ id: "l1", start: 0.2, end: 1.4, text: "안녕 하세요" }] }));
}

test("reviewCopy: stream-copies picture and audio per language and adds an id+text subtitle track; missing encode is skipped with the reason", async () => {
  const dir = tmp();
  makeReel(dir);
  await mp4(path.join(dir, "out", "final.mp4"));
  const paths = reelPaths(dir);
  const results = await reviewCopy({ dir, paths, outDir: path.join(dir, "out") });
  const en = results.find((r) => r.code === "en");
  const ko = results.find((r) => r.code === "ko");
  assert.ok(en.out && fs.existsSync(en.out));
  assert.match(ko.skip, /no existing encode/);
  assert.deepEqual(await streams(en.out), ["aac,audio", "h264,video", "mov_text,subtitle"]);
  const { stdout } = await ffmpeg(["-v", "error", "-i", en.out, "-map", "0:s:0", "-f", "srt", "-"]);
  assert.match(stdout.toString(), /l1 Hello there/);
  assert.deepEqual(fs.readdirSync(path.join(dir, "out")).filter((f) => f.startsWith(".")), []);

  await mp4(path.join(dir, "out", "final-ko.mp4"));
  const both = await reviewCopy({ dir, paths, outDir: path.join(dir, "copy") });
  assert.deepEqual(both.map((r) => !!r.out), [true, true]);
  const k = await ffmpeg(["-v", "error", "-i", both[1].out, "-map", "0:s:0", "-f", "srt", "-"]);
  assert.match(k.stdout.toString(), /00:00:00,200 --> 00:00:01,400\nl1 안녕 하세요/);
  assert.equal(reviewLayers(dir, paths, "zz")[0].skip.includes("no such language layer"), true);
});

test("reviewFile: a file with no audio says the silence check checked nothing", async () => {
  const dir = tmp();
  const f = path.join(dir, "silent.mp4");
  await mp4(f, { audio: false });
  const r = await reviewFile({ file: f, cuts: [] });
  assert.deepEqual(r.checkedNothing.map((c) => c.check), ["silence"]);
  assert.match(r.checkedNothing[0].reason, /no audio stream/);
  assert.deepEqual(r.deadAir.intendedHolds, []);
});

test("state-checks.mjs in a browser: declared regions are checked, a missing language glyph exits 1, an empty page says checked nothing", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "reel.html"), `<!doctype html><canvas id="c" width="300" height="200"></canvas><script>
window.__reel = { width: 300, height: 200, fps: 10, duration: 1, ready: Promise.resolve(), shots: [], seek: function () {},
  regions: [{ id: "chart", kind: "key", box: [0, 0, 100, 100] }, { id: "badge", kind: "label", box: [90, 0, 150, 20] }],
  captionFonts: { ko: '"SvaMissingFont"', en: "sans-serif" } };
</script>`);
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: { lang: "en" }, lines: [{ id: "l1", text: "Hi" }] }));
  fs.mkdirSync(path.join(dir, "dub", "ko"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dub", "ko", "plan.json"), JSON.stringify({ meta: { lang: "ko" }, lines: [{ id: "l1", text: "안녕" }] }));
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts", "state-checks.mjs");
  const r = spawnSync(process.execPath, [script, dir, "--no-source"], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /label or overlay over key content: 1\n  badge over chart: 0\.000–1\.000 s, 200 px²/);
  assert.match(r.stdout, /glyphs ko: 2 of 2 characters are not in the font — definitely wrong for ko/);
  assert.match(r.stdout, /glyphs en: checked nothing \(no named font/);
  assert.match(r.stdout, /text overlap: checked nothing/);
  assert.match(r.stdout, /glyph fallback: checked nothing/);
});
