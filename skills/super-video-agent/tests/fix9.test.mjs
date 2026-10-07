// Chess reproduction findings (W1-W5, D1-D4, G-items): STT install route, page sound in the lead,
// voice list, dub plan scaffold, stem gain, leveling cap warning, dub overlay keys, planned pauses.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sttReport } from "../scripts/setup.mjs";
import { leadErrors, leadSound, formatLeadReport } from "../scripts/lib/lead.mjs";
import { validate } from "../scripts/lib/schema-check.mjs";
import { readJson } from "../scripts/lib/reeldir.mjs";
import { shapeVoices, formatVoiceList, listVoicesReport } from "../scripts/lib/voice-list.mjs";
import * as typecast from "../scripts/voice/typecast.mjs";
import { main as voiceMain } from "../scripts/voice.mjs";
import { buildDubPlan, initDubPlan, formatInitReport } from "../scripts/lib/dub-scaffold.mjs";
import { fitAllLines, plannedGapMap } from "../scripts/lib/dub-timing.mjs";
import { reportLineFill, formatFillWarnings } from "../scripts/lib/dub-fill.mjs";
import { pictureGapPlan } from "../scripts/lib/silence-gate.mjs";
import { formatLevelReport, levelLineWav, LINE_MAX_BOOST_DB } from "../scripts/lib/line-level.mjs";
import { ffmpeg } from "../scripts/lib/ffmpeg.mjs";
import { main as validateMain, plannedPauseFacts } from "../scripts/validate-plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(here, "..");
const schema = readJson(path.join(SKILL, "scripts", "plan.schema.json"));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function capture(fn) {
  const write = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

// ---- W1/G1: the install route for the local STT engine -----------------------------------

test("setup: sttReport gives the install route while mlx-whisper is not ready, and not once it is", () => {
  const notReady = sttReport({ SVA_STT_PYTHON: "/x" }, () => false).join("\n");
  assert.match(notReady, /install route: .*venv.*pip install mlx-whisper/);
  assert.match(notReady, /SVA_STT_PYTHON=<dir>\/bin\/python/);
  assert.match(sttReport({}, () => false).join("\n"), /pip install mlx-whisper/);
  assert.doesNotMatch(sttReport({ SVA_STT_PYTHON: "/x" }, () => true).join("\n"), /install route/);
});

// ---- W2/D1: sound the page makes counts as the lead's sound ------------------------------

const leadPlan = (sound) => ({ meta: { title: "t", lang: "en", lead: 3, ...(sound ? { sound } : {}) }, lines: [{ id: "a", text: "x" }, { id: "b", text: "y" }] });

test("lead: meta.sound.page declares sound the page makes inside the lead", () => {
  assert.equal(leadErrors(leadPlan()).length, 1);
  assert.deepEqual(leadErrors(leadPlan({ page: true })), []);
  assert.equal(leadSound(leadPlan({ page: true })).page, true);
  assert.equal(validate(leadPlan({ page: true }), schema).valid, true);
  assert.equal(validate(leadPlan({ page: "yes" }), schema).valid, false);
  assert.match(formatLeadReport(leadPlan({ page: true })), /with sound \(page sound\)/);
  assert.match(leadErrors(leadPlan())[0], /meta\.sound\.page: true/);
});

// ---- W3/G2: voice list ---------------------------------------------------------------------

const TYPECAST_LIST = [
  { voice_id: "tc_1", voice_name: "Ann", gender: "female", age: "young_adult", use_cases: ["Audiobook"] },
  { voice_id: "tc_2", voice_name: "Bo", gender: "male", age: "middle_age", use_cases: ["Game", "Ads"] },
];
const ELEVEN_LIST = [
  { voice_id: "el_1", name: "Cy", labels: { gender: "male", accent: "american" }, verified_languages: [{ language: "en" }, { language: "ko" }] },
  { voice_id: "el_2", name: "Di", labels: { gender: "female" }, verified_languages: [{ language: "ja" }] },
];

test("voice list: no language field shows every voice with a note; a language field filters", () => {
  const all = shapeVoices(TYPECAST_LIST, { lang: "en-US" });
  assert.equal(all.voices.length, 2);
  assert.equal(all.filtered, false);
  assert.match(all.note, /no language field/);
  const ko = shapeVoices(ELEVEN_LIST, { lang: "ko-KR" });
  assert.deepEqual(ko.voices.map((v) => v.id), ["el_1"]);
  assert.equal(ko.filtered, true);
  assert.match(formatVoiceList("elevenlabs", ko, { lang: "ko-KR" }), /^voices \(elevenlabs, lang ko-KR\): 1 of 2\nid\tname/);
  assert.equal(shapeVoices(ELEVEN_LIST, { lang: "fr" }).voices.length, 0);
});

test("voice list: a provider's own language code (typecast ISO 639-3) matches a list that uses it", () => {
  const raw = [{ voice_id: "x", voice_name: "X", languages: ["eng", "kor"] }, { voice_id: "y", voice_name: "Y", languages: ["jpn"] }];
  const shaped = shapeVoices(raw, { lang: "ko", aliases: [typecast.languageCode("ko")] });
  assert.deepEqual(shaped.voices.map((v) => v.id), ["x"]);
});

test("voice list: a provider with no list stops that step with a message", async () => {
  await assert.rejects(() => listVoicesReport("none", {}), /no voice list/);
});

test("voice.mjs --list-voices: typecast list through a stubbed fetch; the key is sent, never printed", async () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.TYPECAST_API_KEY;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init && init.headers });
    return { ok: true, json: async () => TYPECAST_LIST };
  };
  process.env.TYPECAST_API_KEY = "secret-key-123";
  try {
    const out = await capture(() => voiceMain(["--list-voices", "--provider", "typecast", "--lang", "en"]));
    assert.match(out, /voices \(typecast, lang en\): 2/);
    assert.match(out, /tc_1\tAnn\tfemale\tyoung_adult\tAudiobook/);
    assert.match(out, /no language field/);
    assert.doesNotMatch(out, /secret-key-123/);
    assert.match(seen[0].url, /^https:\/\/api\.typecast\.ai\/v2\/voices\?model=ssfm-v30$/);
    assert.equal(seen[0].headers["X-API-KEY"], "secret-key-123");
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.TYPECAST_API_KEY;
    else process.env.TYPECAST_API_KEY = realKey;
  }
});

// ---- W4: dub plan scaffold -----------------------------------------------------------------

const basePlan = () => ({
  meta: { title: "T", lang: "ko-KR", gapMs: 500, voice: { provider: "typecast", voiceId: "tc_ko", rate: 1.1 }, pronounce: { a: { say: "b" } }, overlay: { title: "제목", picture: { place: "런던" } }, lead: 3, sound: { bed: true } },
  lines: [
    { id: "k1", text: "하나", say: "하나요", pauseAfterMs: 1600, pauseBeforeMs: 200, notes: [{ at: "start", text: "n" }] },
    { id: "k2", text: "둘", lead: false },
  ],
});

test("dub scaffold: ids and pauses kept, text and language copy left empty, speaker fields out", () => {
  const dub = buildDubPlan(basePlan(), "en");
  assert.equal(dub.meta.lang, "en");
  assert.equal(dub.meta.gapMs, 500);
  assert.equal(dub.meta.lead, 3);
  assert.deepEqual(dub.meta.voice, { provider: "typecast", rate: 1.1 });
  assert.equal(dub.meta.pronounce, undefined);
  assert.deepEqual(dub.meta.overlay, { title: "", picture: { place: "" } });
  assert.deepEqual(dub.lines[0], { id: "k1", text: "", pauseBeforeMs: 200, pauseAfterMs: 1600 });
  assert.equal(dub.lines[1].text, "");
});

test("dub scaffold --copy keeps the base copy and voice", () => {
  const dub = buildDubPlan(basePlan(), "ko", { copy: true });
  assert.equal(dub.meta.lang, "ko");
  assert.equal(dub.meta.voice.voiceId, "tc_ko");
  assert.equal(dub.meta.pronounce.a.say, "b");
  assert.equal(dub.lines[0].text, "하나");
  assert.equal(dub.lines[0].say, "하나요");
  assert.equal(dub.lines[0].notes.length, 1);
});

test("dub scaffold: writes the file once, refuses to overwrite, refuses a bad code; the empty text is a to-do the validator names", () => {
  const dir = tmp("sva-scaffold-");
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(basePlan()));
  const r = initDubPlan(dir, "en");
  assert.equal(r.lineCount, 2);
  assert.equal(r.voiceDropped, true);
  assert.match(formatInitReport(r), /wrote .*dub\/en\/plan\.json \(2 lines\)\nleft to fill: each line's text is empty/);
  const written = readJson(path.join(dir, "dub", "en", "plan.json"));
  assert.equal(validate(written, schema).valid, false, "empty text is not a plan yet");
  written.lines.forEach((l) => (l.text = "x"));
  assert.equal(validate(written, schema).valid, true);
  assert.throws(() => initDubPlan(dir, "en"), /already exists/);
  assert.throws(() => initDubPlan(dir, "not a tag"), /BCP 47/);
  assert.throws(() => initDubPlan(path.join(dir, "missing"), "fr"), /missing file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- W5/G7: stems at the cue's gain --------------------------------------------------------

test("templates: sfxStems returns each stem at its cue's gain (2D and 3D)", async () => {
  for (const name of ["reel.html", "reel-3d.html"]) {
    const html = fs.readFileSync(path.join(SKILL, "assets", "template", name), "utf8");
    const from = html.indexOf("function sfxStems");
    const src = html.slice(from, html.indexOf("\n  }\n", from) + 4);
    const make = new Function("SFX_CUES", "ReelAudio", `${src}; return sfxStems;`);
    const cues = [
      { kind: "tick", at: 1, gain: 0.5, id: "quiet" },
      { kind: "tick", at: 2, id: "unit" },
    ];
    const sfxStems = make(cues, { sfx: { tick: () => [1, -1, 0.5] } });
    const stems = await sfxStems(8000);
    assert.deepEqual([...stems[0].L], [0.5, -0.5, 0.25], name);
    assert.deepEqual([...stems[1].L], [1, -1, 0.5], name);
    assert.equal(stems[0].id, "quiet");
  }
});

// ---- D2: the leveling cap is reported ------------------------------------------------------

test("leveling: a take that needs more than the cap is warned about; one inside the cap is not", () => {
  const capped = formatLevelReport("k3", { beforeLufs: -31.6, afterLufs: -19.6, capped: true, targetLufs: -16 });
  assert.match(capped, /line "k3" leveled: -31\.6 -> -19\.6 LUFS\n/);
  assert.match(capped, new RegExp(`WARN: line "k3" boost capped at \\+${LINE_MAX_BOOST_DB} dB; the line stays 3\\.6 dB under -16 LUFS`));
  assert.doesNotMatch(formatLevelReport("k1", { beforeLufs: -20, afterLufs: -16, capped: false }), /WARN/);
});

test("leveling: levelLineWav flags a quiet take as capped", async () => {
  const dir = tmp("sva-level-");
  const wav = path.join(dir, "quiet.wav");
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-af", "volume=-45dB", "-ar", "48000", "-ac", "1", wav]);
  const r = await levelLineWav(wav);
  assert.equal(r.capped, true);
  assert.ok(r.afterLufs < -16 - 1, `stays under the target: ${r.afterLufs}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- D3: overlay keys when run on a dub folder ---------------------------------------------

test("validate-plan on dub/<code> lists the overlay keys the reel's page reads that the dub lacks", async () => {
  const dir = tmp("sva-overlay-");
  const plan = (extra = {}) => ({ meta: { title: "T", lang: "en", ...extra }, lines: [{ id: "a", text: "x" }] });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan()));
  fs.writeFileSync(path.join(dir, "reel.html"), '<script>Reel.pictureText("place", "x");</script>');
  fs.mkdirSync(path.join(dir, "dub", "zz"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dub", "zz", "plan.json"), JSON.stringify(plan()));
  const onDub = await capture(() => validateMain([path.join(dir, "dub", "zz")]));
  assert.match(onDub, /overlay keys \(dub\/zz\): Reel\.pictureText "place"/);
  const onReel = await capture(() => validateMain([dir]));
  assert.match(onReel, /overlay keys \(dub\/zz\)/);
  fs.writeFileSync(path.join(dir, "dub", "zz", "plan.json"), JSON.stringify(plan({ overlay: { picture: { place: "Place" } } })));
  assert.doesNotMatch(await capture(() => validateMain([path.join(dir, "dub", "zz")])), /overlay keys/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- D4: planned pauses are planned silence ------------------------------------------------

const baseLines = [{ id: "a", start: 0.4, end: 3.0 }, { id: "b", start: 5.0, end: 7.0 }];

test("dub fit: a declared pause is not slowed away; an undeclared long gap still is", () => {
  const dubLines = [{ id: "a", text: "x", start: 0, end: 3, words: [] }, { id: "b", text: "y", start: 0, end: 2, words: [] }];
  const clips = new Map([["a", 3.0], ["b", 2.0]]);
  const plain = fitAllLines(baseLines, dubLines, clips, 8);
  assert.ok(plain.lines[0].atempoFactor < 1, "no declared pause: the gap after a is slowed");
  const planned = plannedGapMap([{ id: "a", pauseAfterMs: 1600 }, { id: "b", pauseAfterMs: 0 }]);
  const kept = fitAllLines(baseLines, dubLines, clips, 8, 1.1, { plannedGapSec: planned });
  assert.equal(kept.lines[0].atempoFactor, 1);
  assert.deepEqual(kept.longGaps, []);
  const shorter = fitAllLines(baseLines, dubLines, new Map([["a", 2.0], ["b", 2.0]]), 8, 1.1, { plannedGapSec: planned });
  assert.ok(shorter.lines[0].atempoFactor < 1, "silence beyond the declared pause is still slowed");
});

test("dub fit: the picture's own pause over the gate counts as declared, and the fill report does not call it sparse or ask for a rewrite", () => {
  const gapPlan = pictureGapPlan(baseLines, [{ id: "a", pauseAfterMs: 1600 }, { id: "b" }]);
  const planned = plannedGapMap(gapPlan);
  assert.ok(planned.get("a") >= 1.6);
  const dubLines = [{ id: "a", text: "x", start: 0, end: 3, words: [] }, { id: "b", text: "y", start: 0, end: 2, words: [] }];
  const fit = fitAllLines(baseLines, dubLines, new Map([["a", 3.0], ["b", 2.0]]), 8, 1.1, { plannedGapSec: planned });
  const slots = [{ id: "a", start: 0.4, end: 5.0 }, { id: "b", start: 5.0, end: 8 }];
  const withPlan = reportLineFill(fit.lines, slots, baseLines, planned);
  assert.equal(withPlan[0].gapState, "ok");
  assert.equal(formatFillWarnings(withPlan), "");
  assert.equal(reportLineFill(fit.lines, slots, baseLines)[0].gapState, "sparse");
});

test("validate-plan lists a planned pause over the fit rule as a fact once the voice exists", () => {
  const dir = tmp("sva-pause-");
  const timings = path.join(dir, "timings.json");
  fs.writeFileSync(timings, JSON.stringify({ lines: [{ id: "a", start: 0.4, end: 1.5 }, { id: "b", start: 3.1, end: 4 }] }));
  const plan = { lines: [{ id: "a", pauseAfterMs: 1600 }, { id: "b" }] };
  const facts = plannedPauseFacts(plan, timings);
  assert.equal(facts.length, 1);
  assert.match(facts[0], /planned pause over the fit rule: "a" pauseAfterMs 1600 is 1\.60 s; the dub fit rule allows 1\.00 s/);
  assert.deepEqual(plannedPauseFacts({ lines: [{ id: "a", pauseAfterMs: 900 }] }, timings), []);
  assert.deepEqual(plannedPauseFacts(plan, path.join(dir, "none.json")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
