// Pure boil() call-site fact report (scripts/lib/static-scan.mjs) against
// synthetic reel.html fixtures — no browser needed for this check.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boilCallSiteReport } from "../scripts/lib/static-scan.mjs";

function writeFixture(sceneBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-boil-"));
  const html = `<!doctype html><html><body><canvas id="stage"></canvas>
<script>/* SCENE:BEGIN */\n${sceneBody}\n/* SCENE:END */</script>
</body></html>`;
  const file = path.join(dir, "reel.html");
  fs.writeFileSync(file, html, "utf8");
  return file;
}

test("boilCallSiteReport: no boil() calls -> zero call sites", () => {
  const file = writeFixture(`function seek(t) {}`);
  const result = boilCallSiteReport(file);
  assert.equal(result.sceneFound, true);
  assert.equal(result.callSites, 0);
  assert.equal(result.withMoving, 0);
});

test("boilCallSiteReport: counts call sites and those passing a moving option", () => {
  const file = writeFixture(`
    function seek(t) {
      var a = Reel.boil("a", t, {amp: 1.2});
      var b = Reel.boil("b", t, {moving: Reel.moving(t, ivs)});
      var c = Reel.boil("c", t, {hz: 8, moving: 0});
    }
  `);
  const result = boilCallSiteReport(file);
  assert.equal(result.callSites, 3);
  assert.equal(result.withMoving, 2);
});

test("boilCallSiteReport: wobblePath's internal boil() call still counts (scene code, not engine)", () => {
  const file = writeFixture(`
    function seek(t) {
      var pts = Reel.wobblePath(points, "k", t, {});
      var d = Reel.boil("d", t, {});
    }
  `);
  const result = boilCallSiteReport(file);
  assert.equal(result.callSites, 1);
});

test("boilCallSiteReport: missing SCENE markers is reported as sceneFound:false", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-boil-"));
  const file = path.join(dir, "reel.html");
  fs.writeFileSync(file, "<html><body><canvas></canvas></body></html>", "utf8");
  const result = boilCallSiteReport(file);
  assert.equal(result.sceneFound, false);
});
