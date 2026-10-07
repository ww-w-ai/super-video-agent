// FIX3: caption-layer language match (ko = ko-KR, zh-Hans != zh-Hant), sfxStems renders only `card`
// cues, voice clip facts in the review report, and the shared oversize-line refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../scripts/new-reel.mjs";
import { serveDir } from "../scripts/lib/server.mjs";
import { openReel } from "../scripts/lib/browser.mjs";
import { writeJson } from "../scripts/lib/reeldir.mjs";
import { captionLayerAliases } from "../scripts/lib/layout-scan-serve.mjs";
import { refuseOversize } from "../scripts/lib/line-split.mjs";
import { reviewLayers, voiceClipFacts } from "../scripts/review.mjs";
import { reelPaths } from "../scripts/lib/reeldir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const hasBrowser = fs.existsSync(path.join(here, "..", "node_modules", "playwright-core", "index.mjs"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fix3-"));

test("L7: --dub ko is the base language ko-KR; zh-Hans and zh-Hant stay apart", () => {
  const dir = tmp();
  const ko = captionLayerAliases(dir, { code: "ko", baseCode: "ko-KR" });
  assert.deepEqual(Object.keys(ko).sort(), ["/dub/ko/plan.json", "/dub/ko/timings.placed.json"]);
  assert.equal(Object.keys(captionLayerAliases(dir, { code: "ko-KR", baseCode: "ko" })).length, 2);
  assert.deepEqual(captionLayerAliases(dir, { code: "zh-Hant", baseCode: "zh-Hans" }), {});
  assert.deepEqual(captionLayerAliases(dir, { code: "en", baseCode: "ko-KR" }), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("L7: review --copy --lang ko finds the base layer ko-KR; a dub folder of that name still wins", () => {
  const dir = tmp();
  writeJson(path.join(dir, "plan.json"), { meta: { lang: "ko-KR" }, lines: [] });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "final.mp4"), "x");
  writeJson(path.join(dir, "voice", "timings.json"), { duration: 1, lines: [] });
  const paths = reelPaths(dir);
  const r = reviewLayers(dir, paths, "ko");
  assert.equal(r[0].code, "ko-KR");
  assert.equal(r[0].skip, undefined);
  assert.match(reviewLayers(dir, paths, "zh-Hans")[0].skip, /no such language layer/);
  fs.rmSync(dir, { recursive: true, force: true });
});

const sfxPage = (cues) => async (dir) => {
  await scaffold({ dir, width: 216, height: 384, fps: 10, title: "T", ratio: "9:16", threeD: false });
  fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify({ duration: 3, lines: [{ id: "l1", text: "a b", start: 0.4, end: 1.4 }] }));
  const html = path.join(dir, "reel.html");
  const src = fs.readFileSync(html, "utf8");
  const edited = src.replace(/function buildSfxCues\(\) \{\n    SFX_CUES = \[\];\n  \}/, `function buildSfxCues() {\n    SFX_CUES = ${JSON.stringify(cues)};\n  }`);
  assert.notEqual(edited, src, "buildSfxCues stub found");
  fs.writeFileSync(html, edited);
};

async function stemIds(cues) {
  const dir = tmp();
  await sfxPage(cues)(dir);
  const server = await serveDir(dir);
  const s = await openReel(server.url.replace(/\/$/, "") + "/reel.html", { width: 216, height: 384 });
  try {
    const stems = await s.page.evaluate(() => window.__reel.sfxStems(8000));
    return stems.map((x) => x.id);
  } finally {
    await s.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("L4: sfxStems renders only cues flagged card; every cue when none is flagged", { skip: !hasBrowser && "playwright-core not installed" }, async () => {
  const cues = [{ id: "a", at: 0.4, kind: "pop" }, { id: "b", at: 0.8, kind: "pop", card: true }, { id: "c", at: 1.2, kind: "pop", card: false }];
  assert.deepEqual(await stemIds(cues), ["b"]);
  assert.deepEqual(await stemIds(cues.map(({ card, ...c }) => c)), ["a", "b", "c"]);
});

test("L4: the 3D template filters the same way", () => {
  const html = fs.readFileSync(path.join(here, "..", "assets", "template", "reel-3d.html"), "utf8");
  assert.match(html, /flagged = SFX_CUES\.filter\(function \(cue\) \{ return cue\.card === true; \}\)/);
  assert.match(html, /\(flagged\.length \? flagged : SFX_CUES\)\.map/);
});

test("voice clip facts: stored HEAD/DIP/PAUSE are ignored when current clips are unavailable", async () => {
  const result = await voiceClipFacts({lines:[{id:"a",clipFacts:{head:{abrupt:true},dips:[{atSec:1,sec:0.2}],pauses:[]}}]}, "/unused", {
    decode: async () => { throw new Error("missing current clip"); }
  });
  assert.equal(result.measured, 0);
  assert.equal(result.unmeasured, 1);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.unavailable, [{id:"a",reason:"missing current clip"}]);
});

test("refuseOversize: one shared refusal names the provider, the line and the limit; at the limit passes", () => {
  assert.throws(() => refuseOversize([{ id: "big", text: "x".repeat(50) }], { limit: 40, provider: "acme" }), /acme: line "big" is 51 characters as sent; one request takes at most 40/);
  assert.doesNotThrow(() => refuseOversize([{ id: "ok", text: "x".repeat(39) + "." }], { limit: 40, provider: "acme" }));
});
