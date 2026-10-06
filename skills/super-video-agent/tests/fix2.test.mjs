// FIX2: language-tag scene-span check, per-region caption contrast, lock start-time liveness,
// group-kill guard, displaced-owner put-back, GPU idle hysteresis, TTS usage in the cost report.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { sceneSpanVerdict, sceneSpanNote, sameLanguageTag } from "../scripts/dub.mjs";
import { analyzeCaptionFrame, formatContrastReport } from "../scripts/lib/caption-contrast.mjs";
import {
  acquireSlot, readSlot, readTickets, releaseDeadSlot, pidAlive, procStartTime, stopLeftoverGroup,
} from "../scripts/runner/lock.mjs";
import { idleSamples } from "../scripts/runner/gpu-probe.mjs";
import { ttsUsageFor, reportFor, formatReport } from "../scripts/runner/cost-report.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fix2-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(15);
  }
  assert.fail("condition not reached");
}

// ---- 1 scene spans by full language tag ----------------------------------------------------------

const scene = [{ start: 1, end: 2, in: "scene" }];
const verdict = (lang, baseLang, extra = {}) => sceneSpanVerdict({ spans: scene, lang, baseLang, pictureSource: "base", dir: "/r", ...extra });

test("script subtags count: zh-Hans over a zh-Hant base stops, a region-only difference does not", () => {
  assert.match(verdict("zh-Hans", "zh-Hant"), /render\.mjs \/r --no-captions --lang zh-Hans/);
  assert.match(verdict("zh-Hant", "zh-Hans"), /still shows zh-Hans/);
  assert.match(verdict("zh-TW", "zh-Hans"), /langSpans/); // region TW reads as Hant
  assert.equal(verdict("zh-CN", "zh-Hans"), null);
  assert.equal(verdict("ko", "ko-KR"), null);
  assert.equal(verdict("en-GB", "en-US"), null);
  assert.match(verdict("en", "ko-KR"), /langSpans/);
  assert.equal(sameLanguageTag("sr-Latn", "sr-Cyrl"), false);
});

test("a script that cannot be told is not a stop but is said", () => {
  assert.equal(verdict("zh", "zh-Hant"), null);
  assert.match(sceneSpanNote({ spans: scene, lang: "zh", baseLang: "zh-Hant", pictureSource: "base" }), /may differ in script/);
  assert.equal(sceneSpanNote({ spans: scene, lang: "en", baseLang: "ko", pictureSource: "base" }), null);
});

test("an unreadable base language is reported, not passed silently", () => {
  for (const bad of [null, "", "not a tag!", 42]) {
    assert.equal(verdict("en", bad), null);
    assert.match(sceneSpanNote({ spans: scene, lang: "en", baseLang: bad, pictureSource: "base" }), /base language of the reel is not readable/);
  }
  assert.equal(sceneSpanNote({ spans: [{ start: 1, end: 2 }], lang: "en", baseLang: null, pictureSource: "base" }), null);
  assert.equal(sceneSpanNote({ spans: scene, lang: "en", baseLang: null, pictureSource: "lang" }), null);
});

test("spans that could not be read at all say so (page failed before langSpans)", () => {
  assert.match(sceneSpanNote({ spans: null, lang: "en", baseLang: "ko", pictureSource: "base" }), /could not be read/);
  assert.equal(sceneSpanNote({ spans: null, lang: "en", baseLang: "ko", pictureSource: "lang" }), null);
});

// ---- 2 caption and corner notes measured apart -----------------------------------------------------

function frame(width, height) {
  const caption = new Uint8Array(width * height * 4);
  const picture = new Uint8Array(width * height * 3).fill(230);
  const rect = (x0, y0, x1, y1, rgba) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) caption.set(rgba, (y * width + x) * 4);
  };
  return { caption, picture, rect, width, height };
}

test("a corner note and the caption are separate regions; the note is judged on its composited panel", () => {
  const f = frame(360, 640);
  f.rect(100, 540, 260, 570, [255, 255, 255, 255]); // caption text, white on a bright picture
  f.rect(10, 20, 150, 80, [0, 0, 0, 158]); // the note's semi-opaque panel
  f.rect(20, 30, 140, 50, [255, 255, 255, 255]); // the note's text
  const r = analyzeCaptionFrame(f);
  assert.equal(r.regions.length, 2);
  const cap = r.regions.find((x) => x.kind === "caption");
  const note = r.regions.find((x) => x.kind === "note");
  assert.ok(cap.box[1] >= 540 && cap.box[3] <= 570, "caption box does not reach the corner");
  assert.ok(note.box[3] <= 80, "note box does not reach the caption");
  assert.equal(cap.grade, "low");
  assert.ok(cap.ratio < 1.5);
  assert.equal(note.grade, "ok");
  assert.ok(note.bgMedianLum < 0.2, `panel composited over the picture, got ${note.bgMedianLum}`);
  assert.equal(r.grade, "low", "top-level fields carry the poorest region");
  assert.equal(r.kind, "caption");
});

test("the report names the region kind and lists only flagged regions", () => {
  const f = frame(360, 640);
  f.rect(100, 540, 260, 570, [255, 255, 255, 255]);
  f.rect(10, 20, 150, 80, [0, 0, 0, 158]);
  f.rect(20, 30, 140, 50, [255, 255, 255, 255]);
  const text = formatContrastReport([{ lineId: "l1", t: 1, ...analyzeCaptionFrame(f) }]);
  assert.match(text, /l1 t=1\.00s LOW .*\(caption, light on light/);
  assert.equal(text.split("\n").filter((l) => l.startsWith("  ")).length, 1);
});

test("a frame with only a caption is one region and keeps the old fields", () => {
  const f = frame(360, 640);
  f.rect(100, 540, 260, 570, [20, 20, 20, 255]);
  const r = analyzeCaptionFrame(f);
  assert.equal(r.regions.length, 1);
  assert.equal(r.grade, "ok");
  assert.equal(r.direction, "dark on light");
  assert.equal(analyzeCaptionFrame(frame(360, 640)), null);
});

// ---- 3 lock: start time, group kill guard, put-back, hysteresis ------------------------------------

function slotWith(dir, owner) {
  fs.mkdirSync(path.join(dir, "slot"), { recursive: true });
  fs.writeFileSync(path.join(dir, "slot", "owner.json"), JSON.stringify({ uid: process.getuid(), since: Date.now(), ...owner }));
}

test("a live pid with another start time is dead: owner, ticket and pidAlive agree", () => {
  const start = procStartTime(process.pid);
  assert.ok(start, "ps can read our own start time");
  assert.equal(pidAlive(process.pid, start), true);
  assert.equal(pidAlive(process.pid, "Thu Jan 1 00:00:00 1970"), false);
  assert.equal(pidAlive(process.pid), true, "no recorded start time: kill(0) decides");
  const dir = tmp();
  slotWith(dir, { pid: process.pid, startTime: "Thu Jan 1 00:00:00 1970" });
  assert.equal(readSlot(dir).ownerAlive, false);
  fs.mkdirSync(path.join(dir, "queue"));
  fs.writeFileSync(path.join(dir, "queue", "1-1.json"), JSON.stringify({ pid: process.pid, startTime: "Thu Jan 1 00:00:00 1970", createdUs: 1 }));
  fs.writeFileSync(path.join(dir, "queue", "2-2.json"), JSON.stringify({ pid: process.pid, startTime: start, createdUs: 2 }));
  assert.deepEqual(readTickets(dir).map((t) => [t.id, t.alive]).sort(), [["1-1", false], ["2-2", true]]);
});

test("acquireSlot records the owner's and the ticket's start time", async () => {
  const dir = tmp();
  const h = await acquireSlot({ dir, pollMs: 5, gpu: false });
  assert.equal(readSlot(dir).owner.startTime, procStartTime(process.pid));
  h.release();
});

function orphanGroup() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

test("the leftover group is killed only when its leader's start time matches the record", async () => {
  const child = orphanGroup();
  await until(() => procStartTime(child.pid));
  const events = [];
  const emit = (type, text) => events.push([type, text]);
  const wrong = { uid: process.getuid(), childPgid: child.pid, childStart: "Thu Jan 1 00:00:00 1970" };
  assert.equal(stopLeftoverGroup(wrong, emit), false);
  assert.equal(events[0][0], "skip-group-kill");
  assert.match(events[0][1], /reused/);
  assert.equal(stopLeftoverGroup({ uid: process.getuid(), childPgid: child.pid }, emit), false);
  assert.match(events[1][1], /no start time/);
  assert.equal(pidAlive(child.pid), true, "both refusals left the process alone");
  assert.equal(stopLeftoverGroup({ uid: process.getuid(), childPgid: child.pid, childStart: procStartTime(child.pid) }, emit), true);
  await until(() => !pidAlive(child.pid));
});

test("releaseDeadSlot says why it skipped the group kill and still frees the slot", async () => {
  const child = orphanGroup();
  await until(() => procStartTime(child.pid));
  const dir = tmp();
  slotWith(dir, { pid: process.pid, startTime: "Thu Jan 1 00:00:00 1970", childPgid: child.pid, childStart: "Thu Jan 1 00:00:00 1970" });
  const events = [];
  const dead = releaseDeadSlot(dir, (type, text) => events.push(type));
  assert.equal(dead.pid, process.pid);
  assert.deepEqual(events, ["skip-group-kill"]);
  assert.equal(readSlot(dir).held, false);
  assert.equal(pidAlive(child.pid), true);
  process.kill(-child.pid, "SIGKILL");
  await until(() => !pidAlive(child.pid));
});

test("a displaced fresh owner whose slot was taken meanwhile is dropped with an event, and the new holder keeps the slot", async () => {
  const dir = tmp();
  const bystander = orphanGroup(); // a live pid standing in for the fresh owner
  await until(() => procStartTime(bystander.pid));
  slotWith(dir, { pid: process.pid, startTime: "Thu Jan 1 00:00:00 1970" }); // what the releaser saw: a dead owner
  const events = [];
  const seam = {
    beforeRename: () => slotWith(dir, { pid: bystander.pid, startTime: procStartTime(bystander.pid) }), // a fresh owner took the slot
    afterRename: () => slotWith(dir, { pid: 424242, startTime: "x" }), // another waiter took the slot we just freed
  };
  assert.equal(releaseDeadSlot(dir, (type, text) => events.push([type, text]), seam), null);
  assert.equal(events[0][0], "displaced-owner");
  assert.match(events[0][1], new RegExp(`pid ${bystander.pid}`));
  assert.equal(readSlot(dir).owner.pid, 424242);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith("slot.dead")), []);
  process.kill(-bystander.pid, "SIGKILL");
});

test("a handle notices when the slot no longer names it, and does not write its group into someone else's slot", async () => {
  const dir = tmp();
  const h = await acquireSlot({ dir, pollMs: 5, gpu: false });
  assert.equal(h.holds(), true);
  assert.equal(h.setChildGroup(process.pid), true);
  assert.equal(readSlot(dir).owner.childStart, procStartTime(process.pid));
  slotWith(dir, { pid: 424242, startTime: "x" });
  assert.equal(h.holds(), false);
  assert.equal(h.setChildGroup(process.pid), false);
  assert.equal(readSlot(dir).owner.pid, 424242);
  h.release();
  assert.equal(readSlot(dir).held, true, "release leaves another process's slot alone");
});

test("the GPU gate needs N quiet samples in a row; one quiet reading between bursts does not open it", async () => {
  const dir = tmp();
  const seq = [10, 90, 10, 10, 10, 10];
  let calls = 0;
  const events = [];
  const gpu = { threshold: 50, idleSamples: 3, maxWaitMs: 60000, probe: () => ({ ok: true, source: "t", utilization: seq[calls++] }) };
  const h = await acquireSlot({ dir, pollMs: 2, gpu, onEvent: (t) => events.push(t) });
  assert.equal(calls, 5, "idle, busy, then three idle samples");
  assert.ok(events.includes("gpu-busy"));
  assert.equal(h.gpu.idleSamples, 3);
  h.release();
});

test("idleSamples reads SVA_GPU_IDLE_SAMPLES, default 3, never below 1", () => {
  assert.equal(idleSamples({}), 3);
  assert.equal(idleSamples({ SVA_GPU_IDLE_SAMPLES: "5" }), 5);
  assert.equal(idleSamples({ SVA_GPU_IDLE_SAMPLES: "0" }), 3);
  assert.equal(idleSamples({ SVA_GPU_IDLE_SAMPLES: "x" }), 3);
});

// ---- 4 TTS usage in the cost report ------------------------------------------------------------------

test("TTS usage is read from voice/ and dub/<code>/ tts-usage.jsonl", () => {
  const film = tmp();
  fs.mkdirSync(path.join(film, "voice"));
  fs.mkdirSync(path.join(film, "dub", "en"), { recursive: true });
  fs.writeFileSync(path.join(film, "voice", "tts-usage.jsonl"), [
    JSON.stringify({ provider: "a", chars: 100, seconds: 6.5, cost: 0.01 }),
    JSON.stringify({ provider: "a", chars: 50, seconds: 3 }),
    "not json",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(film, "dub", "en", "tts-usage.jsonl"), JSON.stringify({ provider: "b", chars: 80, seconds: 5, cost: 0.5 }) + "\n");
  const t = ttsUsageFor(film);
  assert.equal(t.logged, true);
  assert.equal(t.unreadable, 1);
  const a = t.rows.find((r) => r.scope === "voice");
  assert.deepEqual([a.provider, a.syntheses, a.chars, a.seconds, a.cost, a.noCost], ["a", 2, 150, 9.5, 0.01, 1]);
  assert.equal(t.rows.find((r) => r.scope === "dub/en").cost, 0.5);
  const text = formatReport(reportFor(film));
  assert.match(text, /TTS usage \(from tts-usage\.jsonl\)/);
  assert.match(text, /voice \| a \| 2 \| 150 \| 9\.5 \| 0\.0100 \(\+1 without cost\)/);
  assert.match(text, /dub\/en \| b \| 1 \| 80 \| 5\.0 \| 0\.5000/);
  assert.match(text, /1 line\(s\) were not JSON objects/);
});

test("without any tts-usage.jsonl the report says not logged", () => {
  const film = tmp();
  assert.equal(ttsUsageFor(film).logged, false);
  assert.match(formatReport(reportFor(film)), /TTS usage: not logged \(no tts-usage\.jsonl in voice\/ or dub\/<code>\/\)/);
});
