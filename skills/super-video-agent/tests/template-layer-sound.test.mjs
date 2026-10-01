// Scaffolded templates in a real browser: the caption layer (?layer=captions,
// with and without a dub code) draws only the overlay, falls back to the
// film's own files for the base language, and the 3D template carries the
// 2D template's sound wiring (library sound cues, kit SFX_CUES, stems, marks).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../scripts/new-reel.mjs";
import { serveDir } from "../scripts/lib/server.mjs";
import { openReel } from "../scripts/lib/browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const hasBrowser = fs.existsSync(path.join(here, "..", "node_modules", "playwright-core", "index.mjs"));
const skip = !hasBrowser && "playwright-core not installed";

// three.js is never bundled with the skill: set SVA_THREE_BUILD to an
// installed three/build folder, or install three next to this skill.
const THREE_DIRS = [process.env.SVA_THREE_BUILD, path.join(here, "..", "node_modules", "three", "build")].filter(Boolean);
const threeDir = THREE_DIRS.find((d) => fs.existsSync(path.join(d, "three.module.js")));

const TIMINGS = {
  duration: 3,
  lines: [
    { id: "l1", text: "안녕 하세요", start: 0.4, end: 1.4 },
    { id: "l2", text: "두 번째 줄", start: 1.8, end: 2.6 },
  ],
};

async function makeReel(threeD) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-tpl-"));
  await scaffold({ dir, width: 216, height: 384, fps: 10, title: "T", ratio: "9:16", threeD });
  fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify(TIMINGS));
  return dir;
}

async function open(dir, query) {
  const server = await serveDir(dir);
  try {
    const s = await openReel(server.url.replace(/\/$/, "") + "/reel.html" + query, { width: 216, height: 384 });
    return { s, server };
  } catch (e) {
    await server.close();
    throw e;
  }
}

async function alphaStats(page, t) {
  return page.evaluate(async (x) => {
    const r = window.__reel.seek(x);
    if (r && r.then) await r;
    const c = document.getElementById("stage");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    return { corner: d[3], painted, total: d.length / 4 };
  }, t);
}

test("2D caption layer, no dub: base files, transparent picture, caption drawn", { skip }, async () => {
  const dir = await makeReel(false);
  const { s, server } = await open(dir, "?layer=captions");
  try {
    const a = await alphaStats(s.page, 1.0);
    assert.equal(a.corner, 0, "picture skipped: canvas cleared to transparent");
    assert.ok(a.painted > 0 && a.painted < a.total / 2, "only the caption is painted");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("2D caption layer, dub = base language with no dub run: falls back to voice/timings.json", { skip }, async () => {
  const dir = await makeReel(false);
  const { s, server } = await open(dir, "?layer=captions&dub=ko");
  try {
    assert.equal(s.meta.duration, 3);
  } finally {
    await s.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("2D caption layer, another language with no dub run: ready fails naming the dub file", { skip }, async () => {
  const dir = await makeReel(false);
  const server = await serveDir(dir);
  try {
    await assert.rejects(
      openReel(server.url.replace(/\/$/, "") + "/reel.html?layer=captions&dub=en", { width: 216, height: 384 }),
      /dub\/en\/timings\.placed\.json/
    );
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("3D caption layer: the scene is skipped — ready works with no three.js installed", { skip }, async () => {
  const dir = await makeReel(true);
  const { s, server } = await open(dir, "?layer=captions");
  try {
    const a = await alphaStats(s.page, 1.0);
    assert.equal(a.corner, 0);
    assert.ok(a.painted > 0);
  } finally {
    await s.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("3D template: one library sound cue and one kit SFX reach soundCues, renderSfx, sfxStems and marks", { skip: skip || (!threeDir && "three.js not installed") }, async () => {
  const dir = await makeReel(true);
  for (const f of ["three.module.js", "three.core.js"]) {
    fs.copyFileSync(path.join(threeDir, f), path.join(dir, "assets", "vendor", f));
  }
  fs.mkdirSync(path.join(dir, "assets", "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "assets", "lib", "manifest.json"),
    JSON.stringify({ assets: { ding1: { kind: "audio", file: "assets/lib/ding1.wav" } } })
  );
  fs.writeFileSync(
    path.join(dir, "assets", "lib", "cues.json"),
    JSON.stringify({ cues: [{ asset: "ding1", lineId: "l2", at: "start", play: "sound" }] })
  );
  const html = path.join(dir, "reel.html");
  const src = fs.readFileSync(html, "utf8");
  const edited = src.replace(
    /function buildSfxCues\(\) \{\n    SFX_CUES = \[\];\n  \}/,
    'function buildSfxCues() {\n    SFX_CUES = [{ id: "pop1", at: tl.line(0).start, kind: "pop" }];\n  }'
  );
  assert.notEqual(edited, src, "buildSfxCues stub found in the 3D scaffold");
  fs.writeFileSync(html, edited);

  const { s, server } = await open(dir, "");
  try {
    const out = await s.page.evaluate(async () => {
      const r = window.__reel;
      const [L] = r.audio.renderSfx(8000);
      const at = Math.round(0.4 * 8000);
      let peak = 0;
      for (let i = at; i < at + 800; i++) peak = Math.max(peak, Math.abs(L[i]));
      const stems = await r.sfxStems(8000);
      return { cues: r.soundCues(), marks: r.marks, len: L.length, peak, stems: stems.map((x) => x.id) };
    });
    assert.equal(out.cues.length, 1);
    assert.equal(out.cues[0].file, "assets/lib/ding1.wav");
    assert.equal(out.cues[0].at, 1.8);
    assert.equal(out.len, 3 * 8000);
    assert.ok(out.peak > 0.1, "the kit sound is in the bed at its cue");
    assert.deepEqual(out.stems, ["pop1"]);
    assert.equal(out.marks.length, 1);
  } finally {
    await s.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
