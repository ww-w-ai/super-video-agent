// new-reel.mjs scaffold: creates the reel dir structure, inlines the
// engine, copies fonts (if present on this machine), generates a
// placeholder image, and writes a plan.json that validates against
// plan.schema.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../scripts/new-reel.mjs";
import { reelPaths, readJson } from "../scripts/lib/reeldir.mjs";
import { validate } from "../scripts/lib/schema-check.mjs";
import { scanReelHtml } from "../scripts/lib/static-scan.mjs";

test("scaffold: creates the full directory structure and a schema-valid plan.json", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-new-"));
  const paths = reelPaths(dir);

  await scaffold({ dir, width: 1080, height: 1920, fps: 30, title: "Test Reel", ratio: "9:16" });

  for (const p of [
    paths.reelHtml,
    paths.planJson,
    path.join(paths.root, "source"),
    paths.voiceDir,
    paths.outDir,
    path.join(paths.assetsDir, "images", "placeholder.png"),
  ]) {
    assert.ok(fs.existsSync(p), `expected ${p} to exist`);
  }

  const plan = readJson(paths.planJson);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = readJson(path.join(here, "..", "scripts", "plan.schema.json"));
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, true, errors.join("; "));

  const html = fs.readFileSync(paths.reelHtml, "utf8");
  assert.ok(html.includes("window.__reel"), "reel.html should define window.__reel");
  assert.ok(html.includes("Reel.boil") || html.includes("Reel."), "reel.html should use engine helpers");

  const scan = scanReelHtml(paths.reelHtml);
  assert.equal(scan.sceneFound, true);
  assert.equal(scan.ok, true, JSON.stringify(scan.violations));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("scaffold: is idempotent-safe on reel.html (re-scaffolding overwrites, doesn't duplicate placeholders)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-new2-"));
  await scaffold({ dir, width: 1080, height: 1080, fps: 24, title: "A", ratio: "1:1" });
  await scaffold({ dir, width: 1080, height: 1080, fps: 24, title: "A", ratio: "1:1" });
  const paths = reelPaths(dir);
  const html = fs.readFileSync(paths.reelHtml, "utf8");
  assert.ok(!html.includes("{{"), "no unresolved template placeholders should remain");
  fs.rmSync(dir, { recursive: true, force: true });
});
