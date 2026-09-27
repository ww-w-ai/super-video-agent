#!/usr/bin/env node
// Render one frame at full resolution (design.md §2.3).
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame } from "./lib/browser.mjs";

const HELP = `usage: still.mjs <reel-dir> --at <t|shotId>[,<t|shotId>...] [--out <png>]

Renders frames of <reel-dir>/reel.html at time \`t\` (seconds) or at a
shot's readAt (pass the shot id) and writes each as a PNG. Several --at
values share one browser session.
Default output is <reel-dir>/out/still-<at>.png per value. --out applies
only when a single --at value is given.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0 || flags.at == null) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  if (!fs.existsSync(paths.reelHtml)) {
    fail(`no reel.html in ${dir} — run new-reel.mjs first`);
    return;
  }

  const ats = String(flags.at).split(",").map((s) => s.trim()).filter(Boolean);
  if (flags.out && ats.length > 1) {
    fail("--out takes a single --at value; drop --out to write still-<at>.png per value");
    return;
  }

  const server = await serveDir(dir);
  let session;
  try {
    session = await openReel(server.url, {});
    for (const at of ats) {
      const t = resolveAt(at, session.meta.shots);
      const png = await captureFrame(session.page, t);
      const outPath = flags.out ? abs(flags.out) : path.join(paths.outDir, `still-${sanitize(at)}.png`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, png);
      process.stdout.write(`wrote ${outPath} (t=${t.toFixed(3)}s)\n`);
    }
  } catch (e) {
    fail(e.message);
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

function resolveAt(at, shots) {
  const asNumber = Number(at);
  if (Number.isFinite(asNumber)) return asNumber;
  const shot = shots.find((s) => s.id === at);
  if (!shot) throw new Error(`no shot with id "${at}" and not a valid number`);
  return shot.readAt;
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
