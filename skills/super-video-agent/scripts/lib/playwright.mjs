// Loads playwright-core's chromium from the skill's own node_modules. An
// installed copy of the skill ships without node_modules, so a missing
// package ends the run with one line naming the setup command instead of a
// module-resolution stack trace.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./cli.mjs";

const SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PW_ENTRY = path.join(SKILL_DIR, "node_modules", "playwright-core", "index.mjs");

/** The line printed when playwright-core is not installed in `skillDir`. */
export function playwrightMissingMessage(skillDir = SKILL_DIR) {
  return `playwright-core is not installed in this copy of the skill — run: node ${path.join(skillDir, "scripts", "setup.mjs")}`;
}

/**
 * Import playwright-core from `entry`.
 * @returns {Promise<object>} the module
 * @throws {Error} with playwrightMissingMessage() when the package is absent
 */
export async function importPlaywright(entry = PW_ENTRY, skillDir = SKILL_DIR) {
  try {
    return await import(entry);
  } catch (e) {
    if (!e || e.code !== "ERR_MODULE_NOT_FOUND") throw e;
    const missing = new Error(playwrightMissingMessage(skillDir));
    missing.setupMissing = true;
    throw missing;
  }
}

let chromiumMod = null;

/** playwright-core's chromium; a missing install ends the process with one line. */
export async function getChromium() {
  if (!chromiumMod) {
    try {
      chromiumMod = (await importPlaywright()).chromium;
    } catch (e) {
      if (!e.setupMissing) throw e;
      fail(e.message);
    }
  }
  return chromiumMod;
}
