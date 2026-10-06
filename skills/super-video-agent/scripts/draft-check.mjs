#!/usr/bin/env node
// Reports which drafts in out/drafts/ no longer match the page they were rendered from.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, readJson, writeJson } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame } from "./lib/browser.mjs";
import { draftsDir, reelStamp, slotProbeFrames, compareDraft } from "./lib/drafts.mjs";

const HELP = `usage: draft-check.mjs <reel-dir> [--out <json>]

Compares every draft in <reel-dir>/out/drafts/ (render.mjs --only <ids> --handle <sec>) with the page now.
A draft records a stamp of the page code and inputs (every file of the reel dir outside out/) and the hashes of
its slot's first, middle and last frame. One line per draft:
  current         the stamp is the same: the page is as it was when the draft was rendered
  slot-unchanged  the stamp moved but the page still draws the slot's frames the same: the draft is usable
  stale           the page draws the slot differently now: render the draft again (--only <id> --handle <sec>)
  unstamped       the draft's json has no stamp: render it again to record one
The page is opened only when a stamp moved. Writes <reel-dir>/out/draft-check.json (or --out). Exit 0 whatever
it finds: the report is facts; whether to use a stale draft is your decision.
`;

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** The page's hashes of a draft's slot frames, read in the open session. */
async function slotProbes(session, sidecar) {
  const segment = { frameStart: sidecar.slotFrameStart, frameEnd: sidecar.slotFrameEnd };
  const out = [];
  for (const f of slotProbeFrames(segment)) out.push(sha256Hex(await captureFrame(session.page, f / sidecar.fps)));
  return out;
}

export async function checkDrafts({ paths }) {
  const dir = draftsDir(paths.outDir);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : [];
  const stamp = reelStamp(paths.root);
  const sidecars = names.map((n) => readJson(path.join(dir, n)));
  const moved = sidecars.some((s) => typeof s.stamp === "string" && s.stamp !== stamp);
  let session = null;
  let server = null;
  try {
    if (moved) {
      server = await serveDir(paths.root);
      session = await openReel(server.url, {});
    }
    const results = [];
    for (const sidecar of sidecars) {
      const probes = session && typeof sidecar.stamp === "string" && sidecar.stamp !== stamp ? await slotProbes(session, sidecar) : null;
      results.push({ id: sidecar.id, ...compareDraft({ sidecar, stamp, probes }) });
    }
    return results;
  } finally {
    if (session) await session.close();
    if (server) await server.close();
  }
}

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length === 0) return printHelpAndExit(HELP, 1);
  const paths = reelPaths(abs(positional[0]));
  let results;
  try {
    results = await checkDrafts({ paths });
  } catch (e) {
    return fail(e.message);
  }
  if (!results.length) process.stdout.write(`checked nothing: no draft in ${draftsDir(paths.outDir)}. Draft a shot with render.mjs --only <id> --handle <sec> to have one to check.\n`);
  for (const r of results) process.stdout.write(`${r.state.padEnd(14)} ${r.id}  ${r.detail}\n`);
  const outPath = typeof flags.out === "string" ? abs(flags.out) : path.join(paths.outDir, "draft-check.json");
  writeJson(outPath, { checkedNothing: results.length === 0, drafts: results });
  process.stdout.write(`wrote ${outPath}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
