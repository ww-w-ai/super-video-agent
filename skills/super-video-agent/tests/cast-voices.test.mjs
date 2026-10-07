import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCastVoices } from "../scripts/lib/cast-voices.mjs";
import { buildLineVoices } from "../scripts/voice.mjs";
import { initDubPlan } from "../scripts/lib/dub-scaffold.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-cast-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cast = { speakers: { speaker1: { voices: { ko: { provider: "none", voiceId: "v-ko" }, en: { provider: "file", voiceId: "v-en", refAudio: "sample.wav" } } } } };
  const plan = { meta: { title: "Cast", lang: "ko-KR", cast: "cast.json", voice: { voiceId: "obsolete", refText: "obsolete" } }, lines: [{ id: "a", text: "A", speaker: "speaker1" }, { id: "b", text: "B", speaker: "speaker1", lang: "en-US" }] };
  fs.writeFileSync(path.join(dir, "cast.json"), JSON.stringify(cast));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  return { dir, cast, plan };
}

test("cast settings reach provider loading and resolved synthesis voices without plan copies", async (t) => {
  const { dir, plan } = fixture(t);
  const original = JSON.stringify(plan);
  const loaded = [];
  const voices = await buildLineVoices(plan, "say", async (name) => { loaded.push(name); return { name }; }, loadCastVoices(plan, dir));
  assert.deepEqual(loaded, ["none", "file"]);
  assert.equal(voices.get("a").voiceCfg.voiceId, "v-ko");
  assert.equal(voices.get("a").voiceCfg.refText, undefined);
  assert.equal(voices.get("b").voiceCfg.refAudio, path.join(dir, "sample.wav"));
  assert.equal(JSON.stringify(plan), original);
});

test("dub scaffold retains speaker and relocates cast path; fresh cast edits are consumed", (t) => {
  const { dir, cast } = fixture(t);
  const { planPath } = initDubPlan(dir, "en");
  const plan = JSON.parse(fs.readFileSync(planPath));
  assert.equal(plan.lines[0].speaker, "speaker1");
  assert.equal(plan.lines[0].voice, undefined);
  assert.equal(loadCastVoices(plan, path.dirname(planPath)).get("a").voiceId, "v-en");
  cast.speakers.speaker1.voices.en.voiceId = "updated";
  fs.writeFileSync(path.join(dir, "cast.json"), JSON.stringify(cast));
  assert.equal(loadCastVoices(plan, path.dirname(planPath)).get("a").voiceId, "updated");
  assert.throws(() => initDubPlan(dir, "../escape"), /BCP 47/);
});

test("missing, conflicting and ambiguous cast mappings fail before any provider loads", (t) => {
  const { dir, plan, cast } = fixture(t);
  plan.lines[0].voice = { voiceId: "copy" };
  assert.throws(() => loadCastVoices(plan, dir), /belongs in the cast/);
  delete plan.lines[0].voice;
  plan.lines[0].speaker = "missing";
  assert.throws(() => loadCastVoices(plan, dir), /unknown cast speaker/);
  plan.lines[0].speaker = "speaker1";
  plan.meta.lang = "zh-Hant";
  cast.speakers.speaker1.voices.zh = { provider: "none" };
  fs.writeFileSync(path.join(dir, "cast.json"), JSON.stringify(cast));
  assert.throws(() => loadCastVoices(plan, dir), /found 0/);
  plan.meta.lang = "en-AU";
  delete cast.speakers.speaker1.voices.en;
  cast.speakers.speaker1.voices["en-US"] = { provider: "none" };
  cast.speakers.speaker1.voices["en-GB"] = { provider: "none" };
  fs.writeFileSync(path.join(dir, "cast.json"), JSON.stringify(cast));
  assert.throws(() => loadCastVoices(plan, dir), /found 2/);
});
