// The picture-text advisory resolves identifiers and helper functions that carry a Reel.pictureText result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pictureTextCalls } from "../scripts/lib/static-scan.mjs";

const unresolved = (source) => pictureTextCalls(source).map((c) => [c.line, c.kind]);

test("a variable assigned from Reel.pictureText is not flagged", () => {
  assert.deepEqual(unresolved('var s = Reel.pictureText(k, t);\nctx.fillText(s, x, y);'), []);
});

test("a helper that returns Reel.pictureText is not flagged, as declaration, function expression and arrow", () => {
  const declared = 'function label(k, t){ return Reel.pictureText(k, t); }\nctx.fillText(label("a","b"), x, y);';
  const expression = 'const label = function(k, t){ return Reel.pictureText(k, t); };\nctx.fillText(label("a","b"), x, y);';
  const arrow = 'const label = (k, t) => Reel.pictureText(k, t);\nctx.fillText(label("a","b"), x, y);';
  const blockArrow = 'const label = (k, t) => { return Reel.pictureText(k, t); };\nctx.fillText(label("a","b"), x, y);';
  for (const source of [declared, expression, arrow, blockArrow]) assert.deepEqual(unresolved(source), [], source);
});

test("a scoped assignment resolves inside its function only", () => {
  const source = 'function a(){ var s = Reel.pictureText(k, t); ctx.fillText(s, 0, 0); }\nfunction b(){ ctx.fillText(s, 0, 0); }';
  assert.deepEqual(unresolved(source), [[2, "unresolved"]]);
});

test("raw literals and unknown variables are still reported", () => {
  assert.deepEqual(unresolved('ctx.fillText("Hello", 1, 2);\nctx.fillText(name, 1, 2);\nctx.fillText(helper("a"), 1, 2);'), [[1, "unregistered"], [2, "unresolved"], [3, "unresolved"]]);
});

test("a variable with any other assignment in its scope is still reported", () => {
  assert.deepEqual(unresolved('var s = Reel.pictureText(k, t);\ns = "plain";\nctx.fillText(s, 0, 0);'), [[3, "unresolved"]]);
  assert.deepEqual(unresolved('var s = Reel.pictureText(k, t);\ns += "x";\nctx.fillText(s, 0, 0);'), [[3, "unresolved"]]);
  assert.deepEqual(unresolved('var s = Reel.pictureText(k, t) + " more";\nctx.fillText(s, 0, 0);'), [[2, "unresolved"]]);
});

test("a parameter named like a pictureText variable is not resolved", () => {
  const source = 'var s = Reel.pictureText(k, t);\nfunction draw(s){ ctx.fillText(s, 0, 0); }';
  assert.deepEqual(unresolved(source), [[2, "unresolved"]]);
});

test("a helper with any other return is still reported", () => {
  const source = 'function label(k){ if (!k) return "none"; return Reel.pictureText(k, "x"); }\nctx.fillText(label("a"), 0, 0);';
  assert.deepEqual(unresolved(source), [[2, "unresolved"]]);
  assert.deepEqual(unresolved('function label(k){ k = 1; }\nctx.fillText(label("a"), 0, 0);'), [[2, "unresolved"]]);
});

test("a helper called with an extra expression around it is still reported", () => {
  const source = 'function label(k){ return Reel.pictureText(k, "x"); }\nctx.fillText(label("a") + "!", 0, 0);';
  assert.deepEqual(unresolved(source), [[2, "unresolved"]]);
});
