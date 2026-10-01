// scripts/lib/playwright.mjs: an installed copy without node_modules gets one
// line naming the setup command, not a module-resolution stack trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { importPlaywright, playwrightMissingMessage } from "../scripts/lib/playwright.mjs";

test("playwrightMissingMessage: names setup.mjs under the given skill folder", () => {
  const skillDir = path.join(os.tmpdir(), "sva-installed-skill");
  assert.equal(
    playwrightMissingMessage(skillDir),
    `playwright-core is not installed in this copy of the skill — run: node ${path.join(skillDir, "scripts", "setup.mjs")}`
  );
});

test("importPlaywright: a missing package rejects with that one line", async () => {
  const skillDir = path.join(os.tmpdir(), "sva-installed-skill-" + Date.now());
  const entry = path.join(skillDir, "node_modules", "playwright-core", "index.mjs");
  await assert.rejects(importPlaywright(entry, skillDir), (e) => {
    assert.equal(e.message, playwrightMissingMessage(skillDir));
    assert.equal(e.setupMissing, true);
    return true;
  });
});
