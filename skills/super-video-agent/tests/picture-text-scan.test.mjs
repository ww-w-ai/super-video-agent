import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pictureTextCalls, pictureTextReport, scanReelHtml } from "../scripts/lib/static-scan.mjs";
test("picture strings distinguish registered, literal and unresolved draws", () => {
  const source = `ctx.fillText("Hello", 1, 2);
ctx.fillText(Reel.pictureText("greeting", "Hello"), 1, 2);
ctx.fillText(label, 1, 2);
ctx.fillText("123", 1, 2);
ctx.fillText('안녕', 1, 2);`;
  assert.deepEqual(pictureTextCalls(source).map(x => [x.line, x.kind]), [[1, "unregistered"], [3, "unresolved"], [5, "unregistered"]]);
  assert.equal(pictureTextCalls(`// ctx.fillText("no",0,0);\nconst example = 'ctx.fillText("no",0,0)';`).length, 0);
});
test("picture inventory scans authored sources and reports real source lines without failing the contract", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-text-scan-"));
  try {
    fs.mkdirSync(path.join(dir, "src", "vendor"), { recursive: true });
    const html = path.join(dir, "reel.html");
    fs.writeFileSync(html, '<canvas></canvas>\n/* ENGINE:BEGIN */ctx.fillText("engine",0,0);/* ENGINE:END */\n/* SCENE:BEGIN */\nctx.fillText("Visible",0,0);\n/* SCENE:END */');
    fs.writeFileSync(path.join(dir, "src", "scene.js"), 'ctx.fillText("Another",0,0);');
    fs.writeFileSync(path.join(dir, "src", "vendor", "lib.js"), 'ctx.fillText("vendor",0,0);');
    const calls = pictureTextReport(html);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].line, 4);
    assert.equal(scanReelHtml(html).ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("compound first arguments remain unresolved even after a registered or numeric prefix", () => {
  const source = 'ctx.fillText(Reel.pictureText("title", "Title") + " unregistered", 0, 0);ctx.fillText("123" + label, 0, 0);';
  assert.deepEqual(pictureTextCalls(source).map(x => x.kind), ["unresolved", "unresolved"]);
  assert.equal(pictureTextCalls('ctx.fillText(Reel.pictureText("title", helper("a", "b")), 0, 0);').length, 0);
});
