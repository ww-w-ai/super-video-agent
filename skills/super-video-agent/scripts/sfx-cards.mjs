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
import { openReel } from "./lib/browser.mjs";
import { buildJudgeSheet, buildScoresTemplate } from "./lib/sfx-judge-sheet.mjs";
import { buildDecideRequest, parseDecideResponse } from "./lib/jev-client.mjs";
import { buildChatRequest, parseChatResponse } from "./lib/openrouter-jev-client.mjs";
import { FIT_THRESHOLD } from "./lib/sfx-judge-rubric.mjs";

const SAMPLE_RATE = 48000;
const LUFS_MIN_DURATION_SEC = 0.4; // review.mjs's own loudness-gate floor

const HELP = `usage: sfx-cards.mjs measure <reel-dir>
       sfx-cards.mjs judge <reel-dir>
       sfx-cards.mjs report <reel-dir>

measure  Fills sound-cards.json's "measured" field for every card: a "kit"
         or "custom" recipe is measured from window.__reel.sfxStems() (the
         page's own cue, rendered alone) when reel.html and voice/timings.json
         exist and the page defines it; an "asset" recipe is measured from
         its library file directly. Reports which cards it could not
         measure.
judge    Scores each card's fit (1-10: does the sound match the event's
         size/material/speed and this film's world/topic). Uses Jev
         (TYPESAFE_API_KEY) or OpenRouter's typesafe/jev-1.13
         (OPENROUTER_API_KEY) when a key is set; otherwise writes
         sound-judge.md, a scoring sheet for the current model to fill by
         hand, plus a sound-scores.json template.
report   Prints a fit table and a WARN list (fit < ${FIT_THRESHOLD}) with a redesign hint.
`;

function paths(dir) {
  const root = path.resolve(dir);
  return {
    root,
    cardsPath: path.join(root, "sound-cards.json"),
    scoresPath: path.join(root, "sound-scores.json"),
    sheetPath: path.join(root, "sound-judge.md"),
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
    if (cmd === "measure") await runMeasure(dir);
    else if (cmd === "judge") await runJudge(dir);
    else if (cmd === "report") await runReport(dir);
    else fail(`unknown command "${cmd}", expected "measure", "judge" or "report"`);
  } catch (e) {
    fail(e.message);
  }
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

export async function runMeasure(dir) {
  const p = paths(dir);
  const cards = loadCards(p);
  const assetLibManifest = readAssetLibManifest(p);

  const stemCards = cards.filter((c) => c.recipe.kind !== "asset");
  const stems = stemCards.length ? await fetchSfxStems(dir, p) : { byId: new Map(), list: [] };

  const unmeasured = [];
  for (const card of cards) {
    if (card.recipe.kind === "asset") {
      const measured = await measureAssetCard(p, card, assetLibManifest);
      if (measured) card.measured = measured;
      else unmeasured.push(card.id);
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
async function fetchSfxStems(dir, p) {
  if (!fs.existsSync(p.reelHtml) || !fs.existsSync(p.timingsJson)) {
    return { byId: new Map(), list: [] };
  }
  const server = await serveDir(dir);
  let session;
  try {
    session = await openReel(server.url, {});
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

async function measureAssetCard(p, card, assetLibManifest) {
  const assetId = card.recipe.assetId;
  const filePath = resolveAssetFile(p, assetId, assetLibManifest);
  if (!filePath || !fs.existsSync(filePath)) return null;
  const samples = await decodeMonoPcm(filePath, SAMPLE_RATE);
  const features = measureFeatures(samples, SAMPLE_RATE);
  const { integratedLufs } = features.durationSec >= LUFS_MIN_DURATION_SEC
    ? await measureLoudness(filePath)
    : { integratedLufs: null };
  return { ...features, lufs: integratedLufs };
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

export async function runJudge(dir) {
  const p = paths(dir);
  const cards = loadCards(p);

  const typesafeKey = process.env.TYPESAFE_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (!typesafeKey && !openrouterKey) {
    const sheet = buildJudgeSheet(cards);
    fs.writeFileSync(p.sheetPath, sheet, "utf8");
    writeJson(p.scoresPath, buildScoresTemplate(cards));
    process.stdout.write(
      `no TYPESAFE_API_KEY or OPENROUTER_API_KEY — wrote ${p.sheetPath} to score by hand, ` +
        `and a ${p.scoresPath} template to fill in\n`
    );
    return;
  }

  const scores = [];
  for (const card of cards) {
    const result = typesafeKey
      ? await judgeWithJev(card, typesafeKey)
      : await judgeWithOpenRouter(card, openrouterKey);
    scores.push(result);
  }
  writeJson(p.scoresPath, scores);
  process.stdout.write(`judged ${scores.length} card(s) with ${typesafeKey ? "jev" : "openrouter-jev"} -> ${p.scoresPath}\n`);
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
      fit: score ? score.fit : null,
      backend: score ? score.backend : null,
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
    const fitText = w.fit == null ? "unscored" : `fit ${w.fit}`;
    process.stdout.write(`  - ${w.id} (${fitText}): ${w.event}\n`);
  }
  process.stdout.write(
    "hint: redesign these sounds (new synth voice, different pitch/envelope/layers, " +
      "replace with a better library sound, or make a new one), re-measure, re-judge; up to 3 rounds\n"
  );
  return { rows, warnings };
}

function formatTable(rows) {
  const header = ["id", "event", "fit", "backend"];
  const cellRows = rows.map((r) => [r.id, r.event, r.fit == null ? "-" : String(r.fit), r.backend || "-"]);
  const widths = header.map((h, i) => Math.max(h.length, ...cellRows.map((c) => c[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  const lines = [line(header), line(widths.map((w) => "-".repeat(w)))];
  for (const c of cellRows) lines.push(line(c));
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
