// still.mjs --sheet (T27): tiles given PNG files into one contact sheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSheetArgs } from "../scripts/still.mjs";
import { ffmpeg, probeVideoInfo } from "../scripts/lib/ffmpeg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const stillCli = path.join(here, "..", "scripts", "still.mjs");

test("parseSheetArgs: output first, inputs after, optional --cols and --cell (default 540)", () => {
  const r = parseSheetArgs({ sheet: "/o/s.png", cols: "2", cell: "800" }, ["/a.png", "/b.png"]);
  assert.deepEqual(r, { outPath: "/o/s.png", inputs: ["/a.png", "/b.png"], cols: 2, cellWidth: 800 });
  const d = parseSheetArgs({ sheet: "/o/s.png" }, ["/a.png"]);
  assert.equal(d.cols, undefined);
  assert.equal(d.cellWidth, 540);
  assert.throws(() => parseSheetArgs({ sheet: true }, ["/a.png"]), /output PNG path first/);
  assert.throws(() => parseSheetArgs({ sheet: "/o/s.png" }, []), /at least one input PNG/);
  assert.throws(() => parseSheetArgs({ sheet: "/o/s.png", cols: "0" }, ["/a.png"]), /--cols takes a positive whole number/);
  assert.throws(() => parseSheetArgs({ sheet: "/o/s.png", cell: "wide" }, ["/a.png"]), /--cell takes a positive whole number/);
});

async function pngs(dir, n, size = "108x192") {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = path.join(dir, `s${i}.png`);
    await ffmpeg(["-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=1`, "-frames:v", "1", p]);
    out.push(p);
  }
  return out;
}

test("still.mjs --sheet: four PNGs give one 4×1 sheet of the expected size", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-sheet-"));
  try {
    const inputs = await pngs(dir, 4);
    const out = path.join(dir, "sheet.png");
    const r = spawnSync(process.execPath, [stillCli, "--sheet", out, ...inputs], { encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wrote .*sheet\.png \(4 PNGs\)/);
    // still.mjs default cell 540 px wide, height by the frames' aspect (192/108) + 28 px label
    const { width, height } = await probeVideoInfo(out).catch(() => ({}));
    assert.equal(width, 4 * 540);
    assert.equal(height, Math.round(540 * (192 / 108)) + 28);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("still.mjs --sheet --cols 2 --cell 300: four PNGs give a 2×2 sheet of 300 px cells; a missing input fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-sheet2-"));
  try {
    const inputs = await pngs(dir, 4);
    const out = path.join(dir, "sheet.png");
    const r = spawnSync(process.execPath, [stillCli, "--sheet", out, ...inputs, "--cols", "2", "--cell", "300"], { encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const { width, height } = await probeVideoInfo(out).catch(() => ({}));
    assert.equal(width, 2 * 300);
    assert.equal(height, 2 * (Math.round(300 * (192 / 108)) + 28));
    const bad = spawnSync(process.execPath, [stillCli, "--sheet", out, path.join(dir, "nope.png")], { encoding: "utf8", timeout: 60000 });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /input PNG not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
