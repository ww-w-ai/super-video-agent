// Which untrimmed take an installed line clip came from. voice/raw/<id>.wav is the take a clip was
// trimmed, sped up and leveled from; timings.json lines record it as `rawTake` ({sha256, bytes,
// source}) so a later rebuild from the raw file can tell whether that file is still the clip's own.
// A take is staged beside the raw file and replaces it only once the clip made from it is installed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const RAW_DIR = "raw";

export function rawTakePath(voiceDir, id) {
  return path.join(voiceDir, RAW_DIR, `${id}.wav`);
}

/** sha256 and byte length of a file. */
export function fingerprintFile(file) {
  const bytes = fs.readFileSync(file);
  return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

/**
 * Copy the untrimmed take `wavPath` next to its raw slot as raw/<id>.staged.wav.
 * `source` names where the take came from ("synth", or the take file for --pick / --takes).
 * @returns {{stagedPath:string, finalPath:string, record:{sha256:string, bytes:number, source:string}}}
 */
export function stageRawTake(voiceDir, id, wavPath, source = "synth") {
  const finalPath = rawTakePath(voiceDir, id);
  const stagedPath = path.join(voiceDir, RAW_DIR, `${id}.staged.wav`);
  fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
  fs.copyFileSync(wavPath, stagedPath);
  return { stagedPath, finalPath, record: { ...fingerprintFile(stagedPath), source } };
}

/** The staged take becomes the line's raw take. */
export function commitRawTake(staged) {
  fs.renameSync(staged.stagedPath, staged.finalPath);
}

/** The staged take was not installed: the line keeps its earlier raw take. */
export function discardRawTake(staged) {
  fs.rmSync(staged.stagedPath, { force: true });
}

/**
 * Whether voice/raw/<id>.wav is the take `line`'s installed clip came from:
 * "current" (hash equals the recorded one), "stale" (differs), "missing" (no raw file),
 * "unrecorded" (the line has no rawTake record: made before it was stored, or not made from a raw take).
 * @param {string} voiceDir
 * @param {{id:string, rawTake?:{sha256:string}}} line a timings.json line
 */
export function rawTakeStatus(voiceDir, line) {
  const file = rawTakePath(voiceDir, line.id);
  if (!fs.existsSync(file)) return "missing";
  if (!line.rawTake || !line.rawTake.sha256) return "unrecorded";
  return fingerprintFile(file).sha256 === line.rawTake.sha256 ? "current" : "stale";
}

/**
 * The lines whose raw take must not be rebuilt from: every status but "current".
 * @returns {{id:string, status:string}[]}
 */
export function rawTakeProblems(voiceDir, lines) {
  return lines.map((l) => ({ id: l.id, status: rawTakeStatus(voiceDir, l) })).filter((r) => r.status !== "current");
}

/** One message naming the lines a rebuild from raw takes would get wrong, or null when all are current. */
export function rawTakeWarning(problems) {
  if (!problems.length) return null;
  const by = (s) => problems.filter((p) => p.status === s).map((p) => p.id);
  const parts = [["stale", "raw take is not the one the clip was made from"], ["missing", "no raw take"], ["unrecorded", "no record of which raw take the clip came from"]]
    .map(([status, why]) => (by(status).length ? `${why}: ${by(status).join(", ")}` : null))
    .filter(Boolean);
  return `do not rebuild these lines from voice/raw: ${parts.join("; ")}`;
}
