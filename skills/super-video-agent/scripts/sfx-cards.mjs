#!/usr/bin/env node
// Sound cards: one card per designed effect, filled with measured audio
// features and a fit judgment (references/sound.md "Sound cards"). Built
// because films kept sounding alike (measured: one library pop sat in 27
// cues across recent films) and because a library/kit sound that ignores
// this film's own world (a kitchen promo that sounds like a gym) reads as
// cheap even when the sound itself is fine in isolation.
//
// This tool reports; it never blocks a render.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { readJson, writeJson } from "./lib/reeldir.mjs";
import { validateCards } from "./lib/sfx-cards-schema.mjs";
import { measureFeatures } from "./lib/sfx-features.mjs";
import { measureLoudness, decodeMonoPcm } from "./lib/audio-analysis.mjs";
import { writeWavPCM16 } from "./lib/wav.mjs";
import { openLibrary, getById, assetFilePath } from "./lib/library.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, stubSeconds } from "./lib/browser.mjs";
import { buildJudgeSheet, buildScoresTemplate } from "./lib/sfx-judge-sheet.mjs";
import { buildDecideRequest, parseDecideResponse } from "./lib/jev-client.mjs";
import { buildChatRequest, parseChatResponse } from "./lib/openrouter-jev-client.mjs";
import { FIT_THRESHOLD, describeSpan } from "./lib/sfx-judge-rubric.mjs";

const SAMPLE_RATE = 48000;
// A judge's score for one sound moves a few tenths between runs; within this
// band of the pass mark one run cannot tell pass from fail.
const NEAR_LINE_BAND = 0.5;
const DEFAULT_EXTRA_RUNS = 2;
const LUFS_MIN_DURATION_SEC = 0.4; // review.mjs's own loudness-gate floor

const HELP = `usage: sfx-cards.mjs measure <reel-dir> [--stub <sec>]
       sfx-cards.mjs judge <reel-dir> [--repeat <n>]
       sfx-cards.mjs report <reel-dir>

measure  Fills sound-cards.json's "measured" field for every card: a "kit"
         or "custom" recipe is measured from window.__reel.sfxStems() (the
         page's own cue, rendered alone) when reel.html and voice/timings.json
         exist and the page defines it; an "asset" recipe is measured from
         its library file, over the part the film plays: 0 s to the card's
         recipe.maxSec, else to the maxSec its plan.json cues share, else
         the whole file. Prints the span per asset card and reports which
         cards it could not measure.
         --stub <sec>  for a reel with no voice/timings.json (a teaser): the
         page is served one silent line of <sec> seconds, as in render.mjs.
judge    Scores each card's fit (1-10: does the sound match the event's
         size/material/speed and this film's world/topic). Uses Jev
         (TYPESAFE_API_KEY) or OpenRouter's typesafe/jev-1.13
         (OPENROUTER_API_KEY) when a key is set; otherwise writes
         sound-judge.md, a scoring sheet for the current model to fill by
         hand, plus a sound-scores.json template.
         The same sound can score either side of ${FIT_THRESHOLD} across runs.
         --repeat <n> judges every card n times. Without it, a card whose
         first score is within ${NEAR_LINE_BAND} of ${FIT_THRESHOLD} gets ${DEFAULT_EXTRA_RUNS} extra runs.
         A card judged more than once stores the mean as "fit", plus "runs"
         and "spread"; runs on both sides of ${FIT_THRESHOLD} mark it "near the line".
report  Prints a fit table and a WARN list (fit < ${FIT_THRESHOLD}) with a redesign hint.
`;

function paths(dir) {
  const root = path.resolve(dir);
  return {
    root,
    cardsPath: path.join(root, "sound-cards.json"),
    scoresPath: path.join(root, "sound-scores.json"),
    sheetPath: path.join(root, "sound-judge.md"),
    planJson: path.join(root, "plan.json"),
    reelHtml: path.join(root, "reel.html"),
    timingsJson: path.join(root, "voice", "timings.json"),
    assetsLibDir: path.join(root, "assets", "lib"),
  };
}

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length < 2) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const [cmd, dirArg] = positional;
  const dir = abs(dirArg);
  try {
    if (cmd === "measure") {
      await runMeasure(dir, { stubSec: stubSeconds(flags.stub, paths(dir).timingsJson, fs.existsSync) });
    }
    else if (cmd === "judge") await runJudge(dir, { repeat: parseRepeat(flags.repeat) });
    else if (cmd === "report") await runReport(dir);
    else fail(`unknown command "${cmd}", expected "measure", "judge" or "report"`);
  } catch (e) {
    fail(e.message);
  }
}

function parseRepeat(value) {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--repeat must be a whole number >= 1, got "${value}"`);
  return n;
}

function loadCards(p) {
  const cards = readJson(p.cardsPath);
  const { valid, errors } = validateCards(cards);
  if (!valid) {
    throw new Error(`sound-cards.json is invalid:\n  - ${errors.join("\n  - ")}`);
  }
  return cards;
}

// ---------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------

export async function runMeasure(dir, { stubSec = null } = {}) {
  const p = paths(dir);
  const cards = loadCards(p);
  const assetLibManifest = readAssetLibManifest(p);
  const plan = fs.existsSync(p.planJson) ? readJson(p.planJson) : null;

  const stemCards = cards.filter((c) => c.recipe.kind !== "asset");
  const stems = stemCards.length ? await fetchSfxStems(dir, p, stubSec) :{ byId: new Map(), list: [] };

  const unmeasured = [];
  for (const card of cards) {
    if (card.recipe.kind === "asset") {
      const trim = assetTrim(card, plan);
      const measured = await measureAssetCard(p, card, assetLibManifest, trim.maxSec);
      if (!measured) {
        unmeasured.push(card.id);
        continue;
      }
      card.measured = measured;
      process.stdout.write(`${card.id}: measured ${describeSpan(measured)}${trimNote(trim)}\n`);
      continue;
    }
    const stem = stems.byId.get(card.id) || nearestStemByTime(stems.list, card.at);
    if (!stem) {
      unmeasured.push(card.id);
      continue;
    }
    card.measured = await measureStem(stem);
  }

  writeJson(p.cardsPath, cards);
  process.stdout.write(`measured ${cards.length - unmeasured.length}/${cards.length} card(s)\n`);
  if (unmeasured.length) {
    process.stdout.write(`unmeasured: ${unmeasured.join(", ")}\n`);
  }
}

function readAssetLibManifest(p) {
  const manifestPath = path.join(p.assetsLibDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  return readJson(manifestPath);
}

/**
 * window.__reel.sfxStems(sampleRate) if the page defines it (optional —
 * references/pipeline.md); [] with no error otherwise, so a reel with no
 * reel.html/timings yet, or an older page that predates sfxStems, falls
 * straight through to the per-card "unmeasured" report instead of failing
 * the whole command.
 */
async function fetchSfxStems(dir, p, stubSec = null) {
  if (!fs.existsSync(p.reelHtml) || (!stubSec && !fs.existsSync(p.timingsJson))) {
    return { byId: new Map(), list: [] };
  }
  const server = await serveDir(dir);
  let session;
  try {
    session = await openReel(server.url, { stubSec });
    const hasFn = await session.page.evaluate(() => typeof window.__reel.sfxStems === "function");
    if (!hasFn) return { byId: new Map(), list: [] };
    const list = await session.page.evaluate((sr) => window.__reel.sfxStems(sr), SAMPLE_RATE);
    const byId = new Map(list.map((s) => [s.id, s]));
    return { byId, list };
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

/** A stem whose cue time lands within 150ms of the card's `at` — for a card whose id doesn't match a SFX_CUES id exactly. */
function nearestStemByTime(list, at, toleranceSec = 0.15) {
  let best = null;
  let bestDelta = Infinity;
  for (const stem of list) {
    const delta = Math.abs(stem.at - at);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = stem;
    }
  }
  return bestDelta <= toleranceSec ? best : null;
}

async function measureStem(stem) {
  const samples = Float32Array.from(stem.L);
  const features = measureFeatures(samples, SAMPLE_RATE);
  const lufs = await measureLufsIfLongEnough(samples, features.durationSec);
  return { ...features, lufs };
}

/**
 * Measures the part of the library file the film plays: from 0 s to
 * `maxSec` (render.mjs trims a cue the same way), or the whole file when no
 * trim is given. `fileSec` keeps the file's own length beside it.
 */
async function measureAssetCard(p, card, assetLibManifest, maxSec) {
  const filePath = resolveAssetFile(p, card.recipe.assetId, assetLibManifest);
  if (!filePath || !fs.existsSync(filePath)) return null;
  const samples = await decodeMonoPcm(filePath, SAMPLE_RATE);
  return measureAssetSpan(samples, SAMPLE_RATE, maxSec);
}

/**
 * Features of `samples` cut to its first `maxSec` seconds (all of it when
 * maxSec is null or longer than the file), plus `fileSec`.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number|null|undefined} maxSec
 */
export async function measureAssetSpan(samples, sampleRate, maxSec) {
  const end = maxSec ? Math.min(samples.length, Math.round(maxSec * sampleRate)) : samples.length;
  const span = samples.subarray(0, end);
  const features = measureFeatures(span, sampleRate);
  const lufs = await measureLufsIfLongEnough(span, features.durationSec);
  return { ...features, lufs, fileSec: samples.length / sampleRate };
}

/**
 * The trim the film applies to a library asset: the card's own
 * `recipe.maxSec`, else the `maxSec` every plan.json cue of that asset
 * shares. Null when the film plays the whole file; `conflict` when plan.json
 * cues of that asset disagree (the card then needs its own maxSec).
 * @param {object} card
 * @param {object|null} plan
 * @returns {{maxSec: number|null, from: "card"|"plan.json"|null, conflict: boolean}}
 */
export function assetTrim(card, plan) {
  if (card.recipe.maxSec) return { maxSec: card.recipe.maxSec, from: "card", conflict: false };
  const cues = ((plan && plan.lines) || []).flatMap((l) => l.cues || []).filter((c) => c.asset === card.recipe.assetId);
  const values = new Set(cues.map((c) => c.maxSec ?? null));
  if (values.size > 1) return { maxSec: null, from: null, conflict: true };
  const only = values.size === 1 ? [...values][0] : null;
  return only ? { maxSec: only, from: "plan.json", conflict: false } : { maxSec: null, from: null, conflict: false };
}

function trimNote(trim) {
  if (trim.conflict) return " (plan.json cues of this asset use different maxSec values; set recipe.maxSec on the card)";
  if (trim.from) return ` (maxSec ${trim.maxSec} from ${trim.from})`;
  return " (no maxSec on the card or in plan.json: the whole file)";
}

/** Prefer the reel's own fetched copy (assets/lib/<id>.<ext>, from `assets.mjs fetch`); fall back to the shared library. */
function resolveAssetFile(p, assetId, assetLibManifest) {
  if (assetLibManifest && assetLibManifest.assets && assetLibManifest.assets[assetId]) {
    const entry = assetLibManifest.assets[assetId];
    if (entry.file) return path.join(p.root, entry.file);
  }
  const library = openLibrary();
  if (!library) return null;
  const asset = getById(library, assetId);
  if (!asset || asset.kind !== "audio") return null;
  return assetFilePath(library, asset);
}

async function measureLufsIfLongEnough(samples, durationSec) {
  if (durationSec < LUFS_MIN_DURATION_SEC) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-sfx-"));
  const tmpPath = path.join(tmpDir, "stem.wav");
  writeWavPCM16(tmpPath, [samples, samples], SAMPLE_RATE);
  try {
    const { integratedLufs } = await measureLoudness(tmpPath);
    return integratedLufs;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------

/**
 * @param {string} dir
 * @param {{repeat?: number, judge?: (card) => Promise<{id:string, fit:number}>}} [opts]
 *   repeat: runs per card (default 1, plus DEFAULT_EXTRA_RUNS when the first
 *   run lands within NEAR_LINE_BAND of FIT_THRESHOLD). judge: replaces the
 *   network backend (tests).
 */
export async function runJudge(dir, opts = {}) {
  const p = paths(dir);
  const cards = loadCards(p);

  const typesafeKey = process.env.TYPESAFE_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (!opts.judge && !typesafeKey && !openrouterKey) {
    const sheet = buildJudgeSheet(cards);
    fs.writeFileSync(p.sheetPath, sheet, "utf8");
    writeJson(p.scoresPath, buildScoresTemplate(cards));
    process.stdout.write(
      `no TYPESAFE_API_KEY or OPENROUTER_API_KEY — wrote ${p.sheetPath} to score by hand, ` +
        `and a ${p.scoresPath} template to fill in\n`
    );
    return;
  }

  const judge =
    opts.judge ||
    (typesafeKey ? (card) => judgeWithJev(card, typesafeKey) : (card) => judgeWithOpenRouter(card, openrouterKey));
  const backend = opts.judge ? "custom" : typesafeKey ? "jev" : "openrouter-jev";
  const scores = [];
  for (const card of cards) {
    scores.push(await judgeCard(card, judge, opts.repeat));
  }
  writeJson(p.scoresPath, scores);
  process.stdout.write(`judged ${scores.length} card(s) with ${backend} -> ${p.scoresPath}\n`);
  const near = scores.filter((s) => s.nearLine);
  if (near.length) {
    process.stdout.write(`near the line (runs on both sides of ${FIT_THRESHOLD}): ${near.map((s) => s.id).join(", ")}\n`);
  }
  return scores;
}

async function judgeCard(card, judge, repeat) {
  const first = await judge(card);
  const results = [first];
  const nearMark = Math.abs(first.fit - FIT_THRESHOLD) <= NEAR_LINE_BAND;
  const total = repeat != null ? repeat : nearMark ? 1 + DEFAULT_EXTRA_RUNS : 1;
  while (results.length < total) results.push(await judge(card));
  if (results.length === 1) return first;
  return { ...results[results.length - 1], ...summarizeRuns(results.map((r) => r.fit)) };
}

/**
 * Mean, spread and near-the-line mark for several fit scores of one card.
 * @param {number[]} runs
 * @param {number} [threshold]
 * @returns {{fit:number, runs:number[], spread:number, nearLine:boolean}}
 */
export function summarizeRuns(runs, threshold = FIT_THRESHOLD) {
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
  const min = Math.min(...runs);
  const max = Math.max(...runs);
  return {
    fit: round2(mean),
    runs: runs.slice(),
    spread: round2(max - min),
    nearLine: min < threshold && max >= threshold,
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

async function judgeWithJev(card, apiKey) {
  const req = buildDecideRequest(card, { apiKey });
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
  if (!res.ok) throw new Error(`jev request failed for card "${card.id}": HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const { score, fit, confidence } = parseDecideResponse(json);
  return { id: card.id, score, fit, confidence, backend: "jev" };
}

async function judgeWithOpenRouter(card, apiKey) {
  const req = buildChatRequest(card, { apiKey });
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
  if (!res.ok) throw new Error(`openrouter request failed for card "${card.id}": HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const { fit, reason } = parseChatResponse(json);
  return { id: card.id, fit, backend: "openrouter-jev", reason };
}

// ---------------------------------------------------------------------
// report
// ---------------------------------------------------------------------

export async function runReport(dir) {
  const p = paths(dir);
  const cards = loadCards(p);
  const scores = fs.existsSync(p.scoresPath) ? readJson(p.scoresPath) : [];
  const scoreById = new Map(scores.map((s) => [s.id, s]));

  const rows = cards.map((card) => {
    const score = scoreById.get(card.id);
    return {
      id: card.id,
      event: card.event,
      span: describeSpan(card.measured),
      fit: score ? score.fit : null,
      backend: score ? score.backend : null,
      runs: score && score.runs ? score.runs : null,
      spread: score && score.spread != null ? score.spread : null,
      nearLine: !!(score && score.nearLine),
    };
  });

  process.stdout.write(formatTable(rows) + "\n");

  const warnings = rows.filter((r) => r.fit == null || r.fit < FIT_THRESHOLD);
  if (warnings.length === 0) {
    process.stdout.write(`every scored card meets fit >= ${FIT_THRESHOLD}\n`);
    return { rows, warnings: [] };
  }
  process.stdout.write(`\nWARN (fit < ${FIT_THRESHOLD} or unscored):\n`);
  for (const w of warnings) {
    const fitText = w.fit == null ? "unscored" : `fit ${w.fit}${w.nearLine ? ", near the line" : ""}`;
    process.stdout.write(`  - ${w.id} (${fitText}): ${w.event}\n`);
  }
  process.stdout.write(
    "hint: redesign these sounds (new synth voice, different pitch/envelope/layers, " +
      "replace with a better library sound, or make a new one), re-measure, re-judge; up to 3 rounds\n"
  );
  return { rows, warnings };
}

function formatTable(rows) {
  const header = ["id", "event", "measured over", "fit", "runs", "spread", "backend", "note"];
  const cellRows = rows.map((r) => [
    r.id,
    r.event,
    r.span,
    r.fit == null ? "-" : String(r.fit),
    r.runs ? r.runs.join("/") : "-",
    r.spread == null ? "-" : String(r.spread),
    r.backend || "-",
    r.nearLine ? "near the line" : "",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cellRows.map((c) => c[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  const lines = [line(header), line(widths.map((w) => "-".repeat(w)))];
  for (const c of cellRows) lines.push(line(c));
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
