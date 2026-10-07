#!/usr/bin/env node
// Validate a reel's plan.json against scripts/plan.schema.json.
// Exit non-zero with the failing path(s) if invalid.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { readJson, reelPaths } from "./lib/reeldir.mjs";
import { validate } from "./lib/schema-check.mjs";
import { stripCaptionBreaks, spokenText } from "./lib/pronounce.mjs";
import { stripTags } from "./lib/tags.mjs";
import { cer, pronounceFolds } from "./lib/stt-compare.mjs";
import { captionBreakReport } from "./lib/caption-breaks.mjs";
import { leadErrors, leadSec } from "./lib/lead.mjs";
import { HEAD_SILENCE_SEC, TAIL_SILENCE_SEC } from "./lib/timing.mjs";
import { withShortsRate, lineSpeed } from "./voice.mjs";
import { GAP_MAX_SHARE, GAP_MAX_FLOOR_SEC } from "./lib/dub-fill.mjs";

const HELP = `usage: validate-plan.mjs <reel-dir> [--estimate [--rate <units/s>] [--rate-from <timings.json>] [--lead <sec>] [--starts]] [--listener]

Validates <reel-dir>/plan.json against scripts/plan.schema.json.
Exits 0 and prints "ok" if valid; exits 1 and prints each failing
JSON path if not. <reel-dir> may be a dub folder (dub/<code>/).

--estimate   Length before any voice exists: spoken units per line (a
             syllable; one Hangul, kana or CJK character; one digit), the
             pauses, head and tail, and the estimated length. The rate is
             units per second as heard at the film's speed (meta.voice.rate,
             1.1 on an unset 9:16 film); a line's own rate scales its line.
             --rate <units/s> sets it. --rate-from <timings.json> measures it
             from a voice already made, using the lines of the plan.json
             beside that timings file (or one folder up), else the text
             stored in the timings; with neither it says it cannot measure.
             Otherwise a per-language starting value is used.
             --lead <sec> counts that much opening before the first line
             (instead of the plan's meta.lead; 0 = none). --starts adds
             each line's estimated start time to the per-line table.
--listener   What a listener hears line after line: each line's ending (the
             last syllable, or the last word in a spaced script), the ending
             counts, adjacent lines with the same ending, and "!" and comma
             counts per line.
--breaks     Every caption break of the whole film as "line id: …before | after…"
             (a "|" marker, a "\\n", phrase punctuation), so one read shows
             them all. --dub <code> reads dub/<code>/plan.json instead;
             --max-chars <n> also shows the engine's even split of a long
             phrase at that chunk size.
The reports never change the exit code.

A line whose say still differs from its text (after numbers, names from
pronounce, punctuation and marks are folded the same way) by a character
error rate over 0.3 prints a warning before any voice is made: a say left
over from an older text. A deliberate respelling stays under it. Write why in
the line's sayWhy to silence a say that differs on purpose.
A line note "word:<text>" that matches no word of the line's text prints a
warning (a dub's text may differ on purpose).

Facts printed after the result, never changing the exit code:
doc/schema mismatch: <field>   a field the plan carries that the schema
                               rejects but references/*.md or a template names, or a
                               meta.<field> the page (reel.html, src/) reads that the
                               schema does not have. Check which side is right before going on.
overlay keys (dub/<code>)      Reel.pictureText("key") and Reel.overlayText(overlay, "key")
                               keys found in reel.html and src/ that the dub's plan.json
                               meta.overlay (picture strings: meta.overlay.picture) lacks.
                               Run on a reel folder it lists every dub; run on dub/<code> it
                               reads the reel's page and lists that dub.
planned pause over the fit rule   a line whose pauseAfterMs is longer than the dub fit rule allows
                               as silence (the larger of 1.0 s and a quarter of its slot in
                               voice/timings.json). Listed once the voice exists. The pause stays
                               as planned: dub.mjs does not slow a line to shrink it.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  // "--estimate <dir>" parses the dir as the flag's value; take it back.
  for (const name of ["estimate", "listener", "breaks", "starts"]) {
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
  if (valid) errors.push(...cueWordErrors(plan), ...captionBreakErrors(plan), ...leadErrors(plan));
  if (errors.length) {
    process.stderr.write("plan.json is invalid:\n");
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("ok\n");
  }
  for (const fact of contractFacts(dir, schema, errors)) process.stdout.write(`${fact}\n`);
  if (!Array.isArray(plan.lines)) return;
  // The fit rule judges the picture's slots, which are the base voice's timings, not a dub's own.
  if (path.basename(path.dirname(dir)) !== "dub") for (const fact of plannedPauseFacts(plan, paths.timingsJson)) process.stdout.write(`${fact}\n`);
  const stale = staleSayWarnings(plan);
  if (stale.length) {
    process.stdout.write(`warning: ${stale.length} line(s) whose say differs from text (a say left from an older text?)\n`);
    for (const w of stale) process.stdout.write(`  - ${w}\n`);
  }
  const noteWarns = noteWordWarnings(plan);
  if (noteWarns.length) {
    process.stdout.write(`warning: ${noteWarns.length} line note(s) whose word matches no word of the line text\n`);
    for (const w of noteWarns) process.stdout.write(`  - ${w}\n`);
  }
  if (flags.estimate) {
    const rateFrom = typeof flags["rate-from"] === "string" ? loadRateSource(abs(flags["rate-from"])) : null;
    const rate = flags.rate != null ? Number(flags.rate) : null;
    if (rate != null && !(rate > 0)) {
      fail(`--rate must be a number > 0, got "${flags.rate}"`);
      return;
    }
    let lead;
    try {
      lead = parseLeadFlag(flags.lead);
    } catch (e) {
      fail(e.message);
      return;
    }
    process.stdout.write(formatEstimate(estimateLength(plan, { rate, rateFrom, leadSec: lead }), { starts: !!flags.starts }));
  }
  if (flags.listener) process.stdout.write(formatListener(listenerReport(plan)));
  if (flags.breaks) {
    const code = typeof flags.dub === "string" ? flags.dub : null;
    let source = plan;
    if (code) {
      try {
        source = readJson(reelPaths(path.join(dir, "dub", code)).planJson);
      } catch (e) {
        fail(e.message);
        return;
      }
    }
    const maxChars = flags["max-chars"] != null ? Number(flags["max-chars"]) : undefined;
    process.stdout.write(await captionBreakReport(source, { maxChars, label: code ? `caption breaks (${code})` : "caption breaks" }));
  }
}

// ---------------------------------------------------------------------
// --estimate
// ---------------------------------------------------------------------

// Units per second at speed 1.0, by primary language subtag. Starting values
// only: voices differ, so a measured --rate-from wins.
const DEFAULT_UNITS_PER_SEC = { ko: 6.0, ja: 7.0, zh: 4.5, en: 3.8 };
const FALLBACK_UNITS_PER_SEC = 4.0;
const DEFAULT_GAP_MS = 700;
// A say that differs from its text above this character error rate (after folding) is reported as stale.
const STALE_SAY_CER = 0.3;

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
 * @param {{rate?: number|null, rateFrom?: {timings: object, plan: object|null}|null}} [opts]
 *   rate: units/s as heard at the film's speed. rateFrom: a timings.json and the plan that
 *   made it (loadRateSource) to measure it from; when it cannot be measured the default is used.
 */
export function estimateLength(plan, opts = {}) {
  const meta = plan.meta || {};
  const lang = meta.lang || "ko-KR";
  const filmSpeed = withShortsRate(meta).rate || 1;
  const gapMs = meta.gapMs == null ? DEFAULT_GAP_MS : meta.gapMs;
  const lines = plan.lines.map((l) => ({ id: l.id, units: spokenUnits(heardText(l, meta)), speed: lineSpeed(meta, l) }));

  let baseRate = null;
  let rateSource;
  if (opts.rateFrom) {
    const measured = measuredBaseRate(opts.rateFrom, filmSpeed);
    if (measured.rate) {
      baseRate = measured.rate;
      rateSource = measured.source;
    } else {
      rateSource = `--rate-from: ${measured.reason}`;
    }
  } else if (opts.rate) {
    baseRate = opts.rate / filmSpeed;
    rateSource = "given";
  }
  if (baseRate == null) {
    const primary = lang.split("-")[0].toLowerCase();
    baseRate = DEFAULT_UNITS_PER_SEC[primary] || FALLBACK_UNITS_PER_SEC;
    rateSource = rateSource ? `${rateSource}; default for "${primary}"` : `default for "${primary}"`;
  }

  const lead = opts.leadSec != null ? opts.leadSec : leadSec(meta);
  const headSec = HEAD_SILENCE_SEC + lead;
  const pauses = plan.lines.map((l, i) => (i === plan.lines.length - 1 ? 0 : (l.pauseAfterMs == null ? gapMs : l.pauseAfterMs) / 1000));
  const befores = plan.lines.map((l) => (l.pauseBeforeMs || 0) / 1000);
  let at = headSec;
  const perLine = lines.map((l, i) => {
    const sec = l.units / (baseRate * l.speed);
    at += befores[i];
    const line = { ...l, sec, start: at };
    at += sec + pauses[i];
    return line;
  });
  const speechSec = perLine.reduce((a, l) => a + l.sec, 0);
  const pauseSec = pauses.reduce((a, p) => a + p, 0) + befores.reduce((a, p) => a + p, 0);
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
    leadSec: lead,
    headSec,
    tailSec,
    totalSec: headSec + speechSec + pauseSec + tailSec,
    lines: perLine,
  };
}

/**
 * What --rate-from measures from: the timings file and the plan that made it
 * (plan.json beside the timings file, or one folder up from voice/), or null
 * when there is none. The plan being estimated is never used — its lines may
 * share ids with another film's but not their text.
 * @param {string} timingsPath
 * @returns {{timings: object, plan: object|null}}
 */
export function loadRateSource(timingsPath) {
  const timings = readJson(timingsPath);
  const here = path.dirname(timingsPath);
  for (const candidate of [path.join(here, "plan.json"), path.join(here, "..", "plan.json")]) {
    if (fs.existsSync(candidate)) return { timings, plan: readJson(candidate) };
  }
  return { timings, plan: null };
}

// Units per second at speed 1.0 from measured line windows: each line's units
// come from the text that produced it, and its duration is scaled back by the
// speed it was spoken at.
function measuredBaseRate({ timings, plan: sourcePlan }, filmSpeed) {
  const meta = (sourcePlan && sourcePlan.meta) || {};
  const sourceById = new Map(((sourcePlan && sourcePlan.lines) || []).map((l) => [l.id, l]));
  const sourceSpeed = sourcePlan ? withShortsRate(meta).rate || 1 : filmSpeed;
  let units = 0;
  let sec = 0;
  for (const t of (timings && timings.lines) || []) {
    const dur = t.end - t.start;
    if (!(dur > 0)) continue;
    const sourceLine = sourceById.get(t.id);
    const text = sourceLine ? heardText(sourceLine, meta) : stripTags(stripCaptionBreaks(t.say ?? t.text ?? ""));
    const lineUnits = spokenUnits(text);
    if (!lineUnits) continue;
    units += lineUnits;
    sec += dur * (sourceLine ? lineSpeed(meta, sourceLine) : sourceSpeed);
  }
  if (!(units > 0 && sec > 0)) {
    return { rate: null, reason: "cannot measure — no plan.json beside that timings file and no line text in it" };
  }
  return { rate: units / sec, source: sourcePlan ? "measured from that film's plan.json" : "measured from the text in that timings file" };
}

/**
 * @param {object} e estimateLength() result
 * @param {{starts?: boolean}} [opts] starts: add each line's estimated start time
 */
export function formatEstimate(e, opts = {}) {
  const out = ["estimate (report only):"];
  const note = e.rateSource.startsWith("default") ? `${e.rateSource} — a starting value; --rate-from <timings.json> measures this voice` : e.rateSource;
  out.push(`  lang ${e.lang}, speed ${e.filmSpeed}, rate ${e.heardRate.toFixed(2)} units/s heard (${e.baseRate.toFixed(2)} at 1.0; ${note})`);
  out.push(`  spoken units ${e.units} -> speech ${e.speechSec.toFixed(1)} s`);
  const lead = e.leadSec ? ` (lead ${e.leadSec.toFixed(1)} s included)` : "";
  out.push(`  pauses ${e.pauseSec.toFixed(1)} s (${e.gaps} gaps), head ${e.headSec.toFixed(1)} s${lead}, tail ${e.tailSec.toFixed(1)} s`);
  out.push(`  estimated length ${e.totalSec.toFixed(1)} s`);
  if (opts.starts) {
    out.push("  per line (id  units  sec  start):");
    for (const l of e.lines) out.push(`    ${l.id}  ${l.units}  ${l.sec.toFixed(1)}  ${l.start.toFixed(1)}`);
  } else {
    out.push("  per line (id  units  sec):");
    for (const l of e.lines) out.push(`    ${l.id}  ${l.units}  ${l.sec.toFixed(1)}`);
  }
  return out.join("\n") + "\n";
}

/**
 * Reads `--lead <sec>` for --estimate: null when absent, else seconds >= 0.
 * @param {string|boolean|undefined} value
 */
export function parseLeadFlag(value) {
  if (value === undefined) return null;
  const n = Number(value);
  if (value === true || value === "" || !Number.isFinite(n) || n < 0) throw new Error(`--lead takes seconds >= 0, e.g. --lead 3 (got "${value}")`);
  return n;
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

/** A line note "word:<text>" that matches no word of the line's text (caption breaks removed). */
export function noteWordWarnings(plan) {
  const out = [];
  (plan.lines || []).forEach((line, i) => {
    const words = stripCaptionBreaks(line.text || "").split(/\s+/);
    (Array.isArray(line.notes) ? line.notes : []).forEach((note, j) => {
      if (!note || typeof note.at !== "string" || !note.at.startsWith("word:")) return;
      const w = note.at.slice(5);
      if (!words.some((x) => x.includes(w))) out.push(`lines[${i}].notes[${j}].at: "${note.at}" matches no word in line "${line.id}" text (the note starts with the line)`);
    });
  });
  return out;
}

// ---------------------------------------------------------------------
// contract facts: where the docs, the page and the plan disagree
// ---------------------------------------------------------------------

const SOURCE_EXT = /\.(?:html|js|mjs)$/;
const SOURCE_SKIP = new Set(["node_modules", "vendor", ".git", "out", "voice", "dub"]);
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_SOURCE_DEPTH = 4;

/** reel.html and the page's own sources under src/ (text, <= 2 MB each), as [relative path, text]. */
function pageSources(dir) {
  const out = [];
  const read = (file) => {
    try {
      if (fs.statSync(file).size <= MAX_SOURCE_BYTES) out.push([path.relative(dir, file), fs.readFileSync(file, "utf8")]);
    } catch {
      /* an unreadable file is not a source */
    }
  };
  const walk = (folder, depth) => {
    if (depth > MAX_SOURCE_DEPTH || !fs.existsSync(folder)) return;
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      if (SOURCE_SKIP.has(e.name)) continue;
      if (e.isDirectory()) walk(path.join(folder, e.name), depth + 1);
      else if (SOURCE_EXT.test(e.name)) read(path.join(folder, e.name));
    }
  };
  read(path.join(dir, "reel.html"));
  walk(path.join(dir, "src"), 0);
  return out;
}

/** The skill's own docs and templates, as [path relative to the skill, text]. */
function skillDocs(skillDir) {
  const out = [];
  for (const [sub, ext] of [["references", ".md"], [path.join("assets", "template"), ".html"]]) {
    const folder = path.join(skillDir, sub);
    if (!fs.existsSync(folder)) continue;
    for (const name of fs.readdirSync(folder)) {
      if (name.endsWith(ext)) out.push([path.join(sub, name), fs.readFileSync(path.join(folder, name), "utf8")]);
    }
  }
  return out;
}

// Which doc spellings name a field under an error path: "$.meta" -> meta.<k>, "$.lines[2]" -> line.<k> or lines[].<k>.
function ownerNames(errPath) {
  const last = errPath.replace(/\[\d+\]/g, "[]").split(".").pop();
  if (last === "lines[]") return ["line", "lines\\[\\]"];
  if (last === "cues[]") return ["cue"];
  return [last.replace(/\[\]$/, "")];
}

/**
 * The plan.meta fields a page's code reads: `<x>.meta.<field>`, and `<name>.<field>` for a variable
 * assigned from `<x>.meta` (read within the next 25 lines, so another `meta` variable elsewhere in the
 * file is not mistaken for the plan's).
 */
function planMetaReads(text) {
  const keys = new Set();
  for (const m of text.matchAll(/\.meta\.([A-Za-z_]\w*)/g)) keys.add(m[1]);
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const assigned = /\b(?:var|let|const)\s+(\w+)\s*=\s*[^;]*\.meta\b/.exec(line);
    if (!assigned) return;
    const read = new RegExp(`\\b${assigned[1]}\\.([A-Za-z_]\\w*)`, "g");
    for (const m of lines.slice(i + 1, i + 26).join("\n").matchAll(read)) keys.add(m[1]);
  });
  return keys;
}

/**
 * "doc/schema mismatch: <field>" facts. (1) A property the plan carries that the schema rejects and a
 * reference or template names. (2) A meta.<field> the page's own sources read that the schema lacks.
 * Facts only: the docs or the schema may be the side that is wrong, so each line says to check.
 */
export function docSchemaMismatches({ errors, schema, sources, docs }) {
  const out = [];
  for (const e of errors) {
    const m = /^(\$[^:]*): unexpected property "([^"]+)"$/.exec(e);
    if (!m) continue;
    const [, at, key] = m;
    const re = new RegExp(`\\b(?:${ownerNames(at).join("|")})\\.${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const hit = docs.find(([, text]) => re.test(text));
    if (hit) out.push(`doc/schema mismatch: ${at}.${key} — named in ${hit[0]} but rejected by plan.schema.json; check which is right before going on`);
  }
  const metaKeys = new Set(Object.keys(((schema.properties || {}).meta || {}).properties || {}));
  const reads = new Map();
  for (const [file, text] of sources) {
    for (const key of planMetaReads(text)) if (!metaKeys.has(key) && !reads.has(key)) reads.set(key, file);
  }
  for (const [key, file] of reads) out.push(`doc/schema mismatch: meta.${key} — read by ${file} but plan.schema.json has no meta.${key}; check which is right before going on`);
  return out;
}

const PICTURE_CALL = /Reel\.pictureText\(\s*(["'`])((?:(?!\1).)+)\1/g;
const OVERLAY_CALL = /Reel\.overlayText\(\s*(?:[^,()"'`]+,\s*)?(["'`])((?:(?!\1).)+)\1/g;
const ANY_CALL = /Reel\.(?:pictureText|overlayText)\(/g;

/**
 * The literal keys of Reel.pictureText("key"...) and Reel.overlayText(overlay, "key"...) calls, and how
 * many calls named a key that is not a string literal (not scanned).
 * @param {[string,string][]} sources
 */
export function scanLabelKeys(sources) {
  const picture = new Set();
  const overlay = new Set();
  let calls = 0;
  let literal = 0;
  for (const [, text] of sources) {
    calls += (text.match(ANY_CALL) || []).length;
    for (const [re, set] of [[PICTURE_CALL, picture], [OVERLAY_CALL, overlay]]) {
      for (const m of text.matchAll(re)) {
        if (m[2].includes("${")) continue;
        set.add(m[2]);
        literal++;
      }
    }
  }
  return { picture: [...picture], overlay: [...overlay], notScanned: Math.max(0, calls - literal) };
}

const hasString = (obj, key) => !!obj && typeof obj === "object" && typeof obj[key] === "string" && obj[key] !== "";

/**
 * Label keys the page uses that a dub's plan.json meta.overlay does not carry: picture strings live in
 * meta.overlay.picture, caption-layer labels in meta.overlay. Facts: the base text is drawn there, which
 * may be intended (a brand kept as is).
 * @param {{picture:string[], overlay:string[], notScanned:number}} keys
 * @param {{code:string, plan:object}[]} dubs
 */
export function missingOverlayKeys(keys, dubs) {
  const out = [];
  for (const { code, plan } of dubs) {
    const overlay = (plan.meta && plan.meta.overlay) || {};
    const picture = keys.picture.filter((k) => !hasString(overlay.picture, k));
    const label = keys.overlay.filter((k) => !hasString(overlay, k));
    if (!picture.length && !label.length) continue;
    const parts = [];
    if (picture.length) parts.push(`Reel.pictureText ${picture.map((k) => `"${k}"`).join(", ")} (meta.overlay.picture)`);
    if (label.length) parts.push(`Reel.overlayText ${label.map((k) => `"${k}"`).join(", ")} (meta.overlay)`);
    out.push(`overlay keys (dub/${code}): ${parts.join("; ")} missing in dub/${code}/plan.json — the base language's text is drawn there`);
  }
  return out;
}

function readDubPlans(dir) {
  const root = path.join(dir, "dub");
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const code of fs.readdirSync(root).sort()) {
    try {
      out.push({ code, plan: readJson(path.join(root, code, "plan.json")) });
    } catch {
      /* a folder without a readable plan is not a dub language */
    }
  }
  return out;
}

/**
 * Planned pauses longer than the dub fit rule allows as silence (the larger of 1.0 s and a
 * quarter of the line's slot), by line, measured on the slots in voice/timings.json. Facts only:
 * dub.mjs keeps a planned pause as planned silence and does not slow the line to shrink it.
 * Nothing is listed until the voice has been made.
 * @param {{lines:object[]}} plan
 * @param {string} timingsPath
 * @returns {string[]}
 */
export function plannedPauseFacts(plan, timingsPath) {
  let timings;
  try {
    timings = readJson(timingsPath);
  } catch {
    return [];
  }
  const lines = timings.lines || [];
  const pauseById = new Map((plan.lines || []).map((l) => [l.id, l.pauseAfterMs || 0]));
  const out = [];
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    const pause = (pauseById.get(l.id) || 0) / 1000;
    if (!next || !pause) return;
    const allowed = Math.max(GAP_MAX_FLOOR_SEC, GAP_MAX_SHARE * (next.start - l.start));
    if (pause > allowed + 1e-9) out.push(`planned pause over the fit rule: "${l.id}" pauseAfterMs ${Math.round(pause * 1000)} is ${pause.toFixed(2)} s; the dub fit rule allows ${allowed.toFixed(2)} s of silence in its slot; dub.mjs keeps the pause as planned`);
  });
  return out;
}

/**
 * The folder whose page is read and the dub plans to check. A dub folder (dub/<code>/ of a reel)
 * is checked against its reel's page and is the only dub listed; any other folder is its own reel
 * and every dub under it is listed.
 */
function pageAndDubs(dir) {
  const parent = path.dirname(dir);
  if (path.basename(parent) !== "dub") return { reelDir: dir, dubs: readDubPlans(dir) };
  const reelDir = path.dirname(parent);
  const code = path.basename(dir);
  return { reelDir, dubs: readDubPlans(reelDir).filter((d) => d.code === code) };
}

/** Every contract fact for a reel folder: doc/schema mismatches and missing overlay keys. */
function contractFacts(dir, schema, errors) {
  const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const { reelDir, dubs } = pageAndDubs(dir);
  const sources = pageSources(reelDir);
  const out = docSchemaMismatches({ errors, schema, sources, docs: skillDocs(skillDir) });
  if (dubs.length && sources.length) {
    const keys = scanLabelKeys(sources);
    out.push(...missingOverlayKeys(keys, dubs));
    if (keys.notScanned) out.push(`overlay keys: ${keys.notScanned} Reel.pictureText/overlayText call(s) use a key that is not a string literal and were not scanned`);
  }
  return out;
}

/**
 * Lines whose `say` no longer reads as their `text`: the text was edited and the say still holds
 * the old sentence. Both sides go through the STT gate's folding (numbers, scripts, pronounce
 * respellings, punctuation, marks), so a say that only spells numbers or names out is not a
 * difference. A difference is reported only above STALE_SAY_CER (a deliberate respelling stays
 * quiet), with its character error rate; a say that differs on purpose is left out of the report by
 * writing the reason in the line's `sayWhy`. A warning only: say may differ from text by design.
 * @returns {string[]}
 */
export function staleSayWarnings(plan) {
  const meta = plan.meta || {};
  const out = [];
  for (const line of plan.lines || []) {
    if (line.say == null || line.sayWhy) continue;
    const lang = line.lang || meta.lang || null;
    const names = pronounceFolds(lang, meta.pronounce, line.pronounce);
    const text = stripTags(stripCaptionBreaks(line.text || ""));
    const say = stripTags(stripCaptionBreaks(line.say));
    const c = cer(text, say, lang, names);
    if (c > STALE_SAY_CER) out.push(`"${line.id}" CER ${c.toFixed(2)}: text "${text}" / say "${say}"; if intended, write why in sayWhy`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
