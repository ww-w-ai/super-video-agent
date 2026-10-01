#!/usr/bin/env node
// Validate a reel's plan.json against scripts/plan.schema.json.
// Exit non-zero with the failing path(s) if invalid.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { readJson, reelPaths } from "./lib/reeldir.mjs";
import { validate } from "./lib/schema-check.mjs";
import { stripCaptionBreaks, spokenText } from "./lib/pronounce.mjs";
import { stripTags } from "./lib/tags.mjs";
import { HEAD_SILENCE_SEC, TAIL_SILENCE_SEC } from "./lib/timing.mjs";
import { withShortsRate } from "./voice.mjs";

const HELP = `usage: validate-plan.mjs <reel-dir> [--estimate [--rate <units/s>] [--rate-from <timings.json>]] [--listener]

Validates <reel-dir>/plan.json against scripts/plan.schema.json.
Exits 0 and prints "ok" if valid; exits 1 and prints each failing
JSON path if not. <reel-dir> may be a dub folder (dub/<code>/).

--estimate   Length before any voice exists: spoken units per line (a
             syllable; one Hangul, kana or CJK character; one digit), the
             pauses, head and tail, and the estimated length. The rate is
             units per second as heard at the film's speed (meta.voice.rate,
             1.1 on an unset 9:16 film); a line's own rate scales its line.
             --rate <units/s> sets it. --rate-from <timings.json> measures it
             from a voice already made (this plan's own lines matched by id,
             else the timings' text). Otherwise a per-language starting
             value is used.
--listener   What a listener hears line after line: each line's ending (the
             last syllable, or the last word in a spaced script), the ending
             counts, adjacent lines with the same ending, and "!" and comma
             counts per line.
Both reports never change the exit code.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  // "--estimate <dir>" parses the dir as the flag's value; take it back.
  for (const name of ["estimate", "listener"]) {
    if (typeof flags[name] === "string") {
      positional.push(flags[name]);
      flags[name] = true;
    }
  }
  if (flags.help || flags.h || positional.length === 0) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = readJson(path.join(here, "plan.schema.json"));

  let plan;
  try {
    plan = readJson(paths.planJson);
  } catch (e) {
    fail(e.message);
    return;
  }

  const { valid, errors } = validate(plan, schema);
  if (valid) errors.push(...cueWordErrors(plan), ...captionBreakErrors(plan));
  if (errors.length) {
    process.stderr.write("plan.json is invalid:\n");
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("ok\n");
  }
  if (!Array.isArray(plan.lines)) return;
  if (flags.estimate) {
    const rateFrom = typeof flags["rate-from"] === "string" ? readJson(abs(flags["rate-from"])) : null;
    const rate = flags.rate != null ? Number(flags.rate) : null;
    if (rate != null && !(rate > 0)) {
      fail(`--rate must be a number > 0, got "${flags.rate}"`);
      return;
    }
    process.stdout.write(formatEstimate(estimateLength(plan, { rate, rateFrom })));
  }
  if (flags.listener) process.stdout.write(formatListener(listenerReport(plan)));
}

// ---------------------------------------------------------------------
// --estimate
// ---------------------------------------------------------------------

// Units per second at speed 1.0, by primary language subtag. Starting values
// only: voices differ, so a measured --rate-from wins.
const DEFAULT_UNITS_PER_SEC = { ko: 6.0, ja: 7.0, zh: 4.5, en: 3.8 };
const FALLBACK_UNITS_PER_SEC = 4.0;
const DEFAULT_GAP_MS = 700;

// One unit each: Hangul (syllables and jamo), kana, CJK ideographs.
const SYLLABIC_CHAR = /[ᄀ-ᇿ㄰-㆏가-힣぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿]/u;
const VOWEL_GROUP = /[aeiouyаеёиоуыэюяαεηιουω]+/g;

/** The words a listener hears for `line`: say ?? text, pronounce applied, marks and tags removed. */
function heardText(line, meta) {
  return stripTags(spokenText(line, meta.pronounce, {}, meta.lang));
}

/**
 * Spoken units in `text`: one per Hangul/kana/CJK character, one per digit,
 * and vowel-group syllables for each run of other letters (at least one).
 * @param {string} text
 */
export function spokenUnits(text) {
  let units = 0;
  let run = "";
  const flush = () => {
    if (run) units += letterRunSyllables(run);
    run = "";
  };
  for (const ch of String(text || "")) {
    if (SYLLABIC_CHAR.test(ch)) {
      flush();
      units += 1;
    } else if (/\p{Nd}/u.test(ch)) {
      flush();
      units += 1;
    } else if (/\p{L}/u.test(ch)) {
      run += ch;
    } else if (!/\p{M}/u.test(ch)) {
      flush();
    }
  }
  flush();
  return units;
}

function letterRunSyllables(run) {
  const w = run.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const groups = (w.match(VOWEL_GROUP) || []).length;
  if (!groups) return Math.max(1, Math.ceil(w.length / 3));
  const silentE = groups > 1 && /[^aeiouyl]e$/.test(w) ? 1 : 0;
  return Math.max(1, groups - silentE);
}

/**
 * Estimated film length before synthesis.
 * @param {{meta:object, lines:object[]}} plan
 * @param {{rate?: number|null, rateFrom?: {lines:{id:string, text:string, start:number, end:number}[]}|null}} [opts]
 *   rate: units/s as heard at the film's speed. rateFrom: a timings.json to measure it from.
 */
export function estimateLength(plan, opts = {}) {
  const meta = plan.meta || {};
  const lang = meta.lang || "ko-KR";
  const filmSpeed = withShortsRate(meta).rate || 1;
  const gapMs = meta.gapMs == null ? DEFAULT_GAP_MS : meta.gapMs;
  const lines = plan.lines.map((l) => ({ id: l.id, units: spokenUnits(heardText(l, meta)), speed: l.rate || filmSpeed }));

  let baseRate;
  let rateSource;
  if (opts.rateFrom) {
    baseRate = measuredBaseRate(plan, opts.rateFrom, filmSpeed);
    rateSource = "measured";
  } else if (opts.rate) {
    baseRate = opts.rate / filmSpeed;
    rateSource = "given";
  } else {
    const primary = lang.split("-")[0].toLowerCase();
    baseRate = DEFAULT_UNITS_PER_SEC[primary] || FALLBACK_UNITS_PER_SEC;
    rateSource = `default for "${primary}"`;
  }

  const perLine = lines.map((l) => ({ ...l, sec: l.units / (baseRate * l.speed) }));
  const speechSec = perLine.reduce((a, l) => a + l.sec, 0);
  const pauseSec = plan.lines.slice(0, -1).reduce((a, l) => a + (l.pauseAfterMs == null ? gapMs : l.pauseAfterMs) / 1000, 0);
  const headSec = HEAD_SILENCE_SEC;
  const tailSec = meta.tailSec == null ? TAIL_SILENCE_SEC : meta.tailSec;
  return {
    lang,
    filmSpeed,
    baseRate,
    heardRate: baseRate * filmSpeed,
    rateSource,
    units: perLine.reduce((a, l) => a + l.units, 0),
    speechSec,
    pauseSec,
    gaps: Math.max(0, plan.lines.length - 1),
    headSec,
    tailSec,
    totalSec: headSec + speechSec + pauseSec + tailSec,
    lines: perLine,
  };
}

// Units per second at speed 1.0 from measured line windows: each line's
// duration is scaled back by the speed it was spoken at.
function measuredBaseRate(plan, timings, filmSpeed) {
  const meta = plan.meta || {};
  const planById = new Map(plan.lines.map((l) => [l.id, l]));
  let units = 0;
  let sec = 0;
  for (const t of timings.lines || []) {
    const dur = t.end - t.start;
    if (!(dur > 0)) continue;
    const planLine = planById.get(t.id);
    units += spokenUnits(planLine ? heardText(planLine, meta) : stripTags(stripCaptionBreaks(t.text || "")));
    sec += dur * ((planLine && planLine.rate) || filmSpeed);
  }
  if (!(units > 0 && sec > 0)) throw new Error("--rate-from: no measured lines with text in that timings file");
  return units / sec;
}

export function formatEstimate(e) {
  const out = ["estimate (report only):"];
  const note = e.rateSource.startsWith("default") ? `${e.rateSource} — a starting value; --rate-from <timings.json> measures this voice` : e.rateSource;
  out.push(`  lang ${e.lang}, speed ${e.filmSpeed}, rate ${e.heardRate.toFixed(2)} units/s heard (${e.baseRate.toFixed(2)} at 1.0; ${note})`);
  out.push(`  spoken units ${e.units} -> speech ${e.speechSec.toFixed(1)} s`);
  out.push(`  pauses ${e.pauseSec.toFixed(1)} s (${e.gaps} gaps), head ${e.headSec.toFixed(1)} s, tail ${e.tailSec.toFixed(1)} s`);
  out.push(`  estimated length ${e.totalSec.toFixed(1)} s`);
  out.push("  per line (id  units  sec):");
  for (const l of e.lines) out.push(`    ${l.id}  ${l.units}  ${l.sec.toFixed(1)}`);
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------
// --listener
// ---------------------------------------------------------------------

const TRAILING_NON_LETTERS = /[^\p{L}\p{Nd}]+$/u;

/** The ending a listener hears at the close of `text`: last syllable, or last word in a spaced script. */
export function lineEnding(text) {
  const words = String(text || "").trim().split(/\s+/).map((w) => w.replace(TRAILING_NON_LETTERS, "")).filter(Boolean);
  if (!words.length) return "";
  const last = words[words.length - 1];
  const chars = [...last];
  const lastChar = chars[chars.length - 1];
  return SYLLABIC_CHAR.test(lastChar) ? lastChar : last.toLowerCase();
}

/**
 * Listener-pass facts per line and across adjacent lines. Report only.
 * @param {{meta:object, lines:object[]}} plan
 */
export function listenerReport(plan) {
  const meta = plan.meta || {};
  const lines = plan.lines.map((l) => {
    const heard = heardText(l, meta);
    return {
      id: l.id,
      ending: lineEnding(heard),
      exclamations: (heard.match(/[!！]/g) || []).length,
      commas: (heard.match(/[,，、]/g) || []).length,
    };
  });
  const counts = new Map();
  for (const l of lines) counts.set(l.ending, (counts.get(l.ending) || 0) + 1);
  const endings = [...counts].map(([ending, count]) => ({ ending, count })).sort((a, b) => b.count - a.count);
  const adjacent = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].ending && lines[i].ending === lines[i - 1].ending) {
      adjacent.push({ ending: lines[i].ending, ids: [lines[i - 1].id, lines[i].id] });
    }
  }
  return {
    lines,
    endings,
    adjacent,
    exclamations: lines.reduce((a, l) => a + l.exclamations, 0),
    commas: lines.reduce((a, l) => a + l.commas, 0),
  };
}

export function formatListener(r) {
  const out = ["listener (report only):"];
  out.push("  endings: " + r.endings.map((e) => `"${e.ending}" ${e.count}`).join(", "));
  out.push(
    "  adjacent same endings: " +
      (r.adjacent.length ? r.adjacent.map((a) => `${a.ids.join("-")} "${a.ending}"`).join(", ") : "none")
  );
  out.push(`  "!" ${r.exclamations} in ${r.lines.filter((l) => l.exclamations).length} of ${r.lines.length} lines, commas ${r.commas}`);
  out.push("  per line (id  ending  !  ,):");
  for (const l of r.lines) out.push(`    ${l.id}  ${l.ending}  ${l.exclamations}  ${l.commas}`);
  return out.join("\n") + "\n";
}

/**
 * A cue at "word:<w>" lands on the first word of the line's `text` that
 * contains <w> (reel-engine.js cueTime). One that matches no word falls back
 * to the line start at render time; catch it here, before the voice is made.
 */
export function cueWordErrors(plan) {
  const errors = [];
  (plan.lines || []).forEach((line, i) => {
    const words = stripCaptionBreaks(line.text || "").split(/\s+/);
    (line.cues || []).forEach((cue, j) => {
      if (typeof cue.at !== "string" || !cue.at.startsWith("word:")) return;
      const w = cue.at.slice(5);
      if (!words.some((x) => x.includes(w))) {
        errors.push(`lines[${i}].cues[${j}].at: "${cue.at}" matches no word in line "${line.id}" text`);
      }
    });
  });
  return errors;
}

/**
 * A "|" in a line's `text` forces a caption-chunk break there
 * (reel-engine.js captionChunks' `opts.breaks`, references/pipeline.md
 * "Forced caption breaks") and must appear as its own whitespace-separated
 * token. Rejects "||" (two markers with nothing between) and a "|" that
 * leads or trails the line — either would force a break before or after
 * every word, or between two markers with no word between them.
 */
export function captionBreakErrors(plan) {
  const errors = [];
  (plan.lines || []).forEach((line, i) => {
    const tokens = String(line.text || "").split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    if (tokens[0] === "|" || tokens[tokens.length - 1] === "|") {
      errors.push(`lines[${i}].text: "|" must not lead or trail the line in "${line.id}"`);
    }
    for (let j = 1; j < tokens.length; j++) {
      if (tokens[j] === "|" && tokens[j - 1] === "|") {
        errors.push(`lines[${i}].text: "||" (two "|" markers with no word between them) in "${line.id}"`);
        break;
      }
    }
  });
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
