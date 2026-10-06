// The opening lead (plan.json meta.lead): schema, default length, the sound requirement,
// timings shifted by the lead, and a dub that keeps it. Local only (voice provider "none").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../scripts/lib/schema-check.mjs";
import { leadSec, leadErrors, leadSound, formatLeadReport, withLeadHandover, LEAD_DEFAULT_SEC } from "../scripts/lib/lead.mjs";
import { buildPlacedTimings } from "../scripts/lib/dub-timing.mjs";
import { classifyGaps } from "../scripts/lib/silence-gate.mjs";
import { main } from "../scripts/voice.mjs";
import { reelPaths, readJson } from "../scripts/lib/reeldir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = readJson(path.join(here, "..", "scripts", "plan.schema.json"));

function plan(meta = {}, lines) {
  return {
    meta: { title: "Lead", lang: "ko-KR", gapMs: 250, voice: { provider: "none" }, ...meta },
    lines: lines || [
      { id: "l1", text: "첫 번째 줄입니다" },
      { id: "l2", text: "두 번째 줄입니다" },
    ],
  };
}

function tmpReel(p) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-lead-"));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(p), "utf8");
  return dir;
}

async function quiet(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk, ...rest) => {
    out += String(chunk);
    return original(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

test("schema: meta.lead takes a number of seconds or true; a line takes lead: true", () => {
  assert.equal(validate(plan({ lead: 2.5 }), schema).valid, true);
  assert.equal(validate(plan({ lead: true }), schema).valid, true);
  assert.equal(validate(plan({}, [{ id: "a", text: "x", lead: true }, { id: "b", text: "y" }]), schema).valid, true);
  assert.equal(validate(plan({ lead: false }), schema).valid, false);
  assert.equal(validate(plan({ lead: 0 }), schema).valid, false);
  assert.equal(validate(plan({ lead: "3" }), schema).valid, false);
});

test("leadSec: true is 3 s, a number is itself, absent is no lead", () => {
  assert.equal(leadSec({ lead: true }), 3);
  assert.equal(LEAD_DEFAULT_SEC, 3);
  assert.equal(leadSec({ lead: 1.5 }), 1.5);
  assert.equal(leadSec({}), 0);
  assert.equal(leadSec(undefined), 0);
});

test("validation: no lead means no sound requirement", () => {
  assert.deepEqual(leadErrors(plan()), []);
});

test("validation: a lead with no bed, no cue and no lead line fails", () => {
  const errors = leadErrors(plan({ lead: true }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no sound/);
});

test("validation: a lead with a music bed passes", () => {
  assert.deepEqual(leadErrors(plan({ lead: true, sound: { bed: true } })), []);
});

test("validation: a lead with a sound cue before the first story line passes; a late cue does not count", () => {
  const early = plan({ lead: 3 }, [
    { id: "l1", text: "x", cues: [{ asset: "whoosh", at: "start", offsetMs: -1000 }] },
    { id: "l2", text: "y" },
  ]);
  assert.deepEqual(leadErrors(early), []);
  const late = plan({ lead: 3 }, [
    { id: "l1", text: "x", cues: [{ asset: "whoosh", at: "start", offsetMs: 500 }] },
    { id: "l2", text: "y" },
  ]);
  assert.equal(leadErrors(late).length, 1);
  const pictureOnly = plan({ lead: 3 }, [
    { id: "l1", text: "x", cues: [{ asset: "pop", at: "start", offsetMs: -1000, play: "picture" }] },
  ]);
  assert.equal(leadErrors(pictureOnly).length, 1);
});

test("validation: a lead with a lead line passes; lead lines must open the plan and not be the whole plan", () => {
  const ok = plan({ lead: 3 }, [{ id: "hi", text: "안녕", lead: true }, { id: "l1", text: "x" }]);
  assert.deepEqual(leadErrors(ok), []);
  assert.deepEqual(leadSound(ok), { bed: false, cue: false, line: true, page: false });
  const notFirst = plan({ lead: 3 }, [{ id: "l1", text: "x" }, { id: "hi", text: "안녕", lead: true }]);
  assert.ok(leadErrors(notFirst).some((e) => /first lines/.test(e)));
  const all = plan({ lead: 3 }, [{ id: "hi", text: "안녕", lead: true }]);
  assert.ok(leadErrors(all).some((e) => /story/.test(e)));
});

test("validation: a lead line without meta.lead fails", () => {
  const errors = leadErrors(plan({}, [{ id: "hi", text: "x", lead: true }, { id: "l1", text: "y" }]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /meta\.lead/);
});

test("lead report: a lead with sound is a planned span; one without is a WARN", () => {
  assert.match(formatLeadReport(plan({ lead: true, sound: { bed: true } })), /with sound \(music bed\)/);
  assert.match(formatLeadReport(plan({ lead: true })), /^WARN: lead 3 s has no sound/);
  assert.equal(formatLeadReport(plan()), "");
});

test("silence gate: the hand-over from a lead line to the story is planned, not dead air", () => {
  const planLines = [{ id: "hi", lead: true }, { id: "l1" }];
  const timingsLines = [
    { id: "hi", start: 0.4, end: 1.0 },
    { id: "l1", start: 3.4, end: 4.0 },
  ];
  const gaps = [{ startSec: 1.0, endSec: 3.4, durationSec: 2.4 }];
  assert.equal(classifyGaps(gaps, timingsLines, planLines, { gapMs: 250 }).unplanned.length, 1);
  const handed = classifyGaps(gaps, timingsLines, withLeadHandover(planLines, timingsLines), { gapMs: 250 });
  assert.equal(handed.unplanned.length, 0);
  assert.equal(handed.planned.length, 1);
});

test("voice.mjs: story lines start after the lead and timings.json records it", async () => {
  const base = tmpReel(plan());
  const led = tmpReel(plan({ lead: true, sound: { bed: true } }));
  await quiet(() => main([base, "--no-stt"]));
  await quiet(() => main([led, "--no-stt"]));
  const a = readJson(reelPaths(base).timingsJson);
  const b = readJson(reelPaths(led).timingsJson);
  assert.equal(a.lead, undefined);
  assert.equal(b.lead, 3);
  for (let i = 0; i < a.lines.length; i++) {
    assert.ok(Math.abs(b.lines[i].start - a.lines[i].start - 3) < 0.01, `line ${i}`);
    assert.ok(Math.abs(b.lines[i].end - a.lines[i].end - 3) < 0.01, `line ${i}`);
  }
  assert.ok(Math.abs(b.duration - a.duration - 3) < 0.01);
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(led, { recursive: true, force: true });
});

test("voice.mjs: a lead line sounds inside the lead and the story still starts at head + lead", async () => {
  const dir = tmpReel(plan({ lead: 3 }, [{ id: "hi", text: "안녕하세요", lead: true }, { id: "l1", text: "첫 줄" }]));
  await quiet(() => main([dir, "--no-stt"]));
  const t = readJson(reelPaths(dir).timingsJson);
  assert.equal(t.lead, 3);
  assert.equal(t.lines[0].lead, true);
  assert.ok(t.lines[0].start < 1 && t.lines[0].end <= 3.4, JSON.stringify(t.lines[0]));
  assert.ok(Math.abs(t.lines[1].start - 3.4) < 0.01, String(t.lines[1].start));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dub: the placed timings keep the picture's lead", () => {
  const placed = buildPlacedTimings([{ id: "l1", start: 3.4, end: 4 }], 6, "en-US", 3);
  assert.equal(placed.lead, 3);
  assert.equal(buildPlacedTimings([], 6, "en-US").lead, undefined);
});
