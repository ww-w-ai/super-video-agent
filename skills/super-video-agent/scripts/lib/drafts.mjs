// Draft shots with handles (render.mjs --only <ids> --handle <sec>): the span
// math, the sidecar a draft clip is stored with, and the cut that takes the
// slot span back out of a handled clip (render.mjs --use-draft <id>).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** out/drafts/ — one <id>.mp4 + <id>.json per drafted shot. */
export function draftsDir(outDir) {
  return path.join(outDir, "drafts");
}

/**
 * The frames a draft renders: the shot's slot widened by `handleSec` on each
 * side (rounded to whole frames), clamped to the film's frames. `handleBefore`
 * / `handleAfter` are the frames actually gained on each side, so a clamp at
 * the film's start or end shows up there.
 * @param {{segment: {id:string, frameStart:number, frameEnd:number}, fps:number, filmStart:number, filmEnd:number, handleSec:number}} args
 */
export function draftSpan({ segment, fps, filmStart, filmEnd, handleSec }) {
  if (!Number.isFinite(handleSec) || handleSec < 0) throw new Error(`--handle takes seconds >= 0 (got ${handleSec})`);
  const want = Math.round(handleSec * fps);
  const frameStart = Math.max(filmStart, segment.frameStart - want);
  const frameEnd = Math.min(filmEnd, segment.frameEnd + want);
  return {
    frameStart,
    frameEnd,
    handleBefore: segment.frameStart - frameStart,
    handleAfter: frameEnd - segment.frameEnd,
  };
}

const STAMP_SKIP = new Set(["node_modules", ".git", ".backup", ".worktree"]);
const STAMP_CONTENT_MAX = 8 * 1024 * 1024;

/**
 * A stamp of what the page was made from: a hash over every file of the reel
 * dir outside out/ (relative path, size and, up to 8 MB, content; mtime is not
 * used, so a touch or a checkout does not change it). Files over 8 MB count by
 * size only. Equal stamp = the page code and inputs are as they were.
 */
export function reelStamp(root) {
  const h = crypto.createHash("sha256");
  const files = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!STAMP_SKIP.has(e.name) && !(d === root && e.name === "out")) stack.push(p);
      } else if (e.isFile()) files.push(p);
    }
  }
  for (const p of files.sort()) {
    const size = fs.statSync(p).size;
    h.update(`${path.relative(root, p)}|${size}|`);
    if (size <= STAMP_CONTENT_MAX) h.update(fs.readFileSync(p));
  }
  return h.digest("hex");
}

/** The slot's three probe frame indices (first, middle, last), as the segment cache uses them. */
export function slotProbeFrames(segment) {
  const last = segment.frameEnd - 1;
  return [segment.frameStart, segment.frameStart + Math.floor((last - segment.frameStart) / 2), last];
}

/**
 * What a draft's state is against the page now. `stamp` is the page's current
 * stamp, `probes` the hashes of the page's slot frames now (null when not read).
 * "current": same stamp. "slot-unchanged": the stamp moved but the slot's frames draw the same.
 * "stale": the slot's frames draw differently. "stamp-moved": the stamp moved and the frames were not read.
 * "unstamped": the draft has no stamp (drawn before drafts recorded one).
 * @returns {{state: "current"|"slot-unchanged"|"stale"|"stamp-moved"|"unstamped", detail: string}}
 */
export function compareDraft({ sidecar, stamp, probes }) {
  if (typeof sidecar.stamp !== "string") return { state: "unstamped", detail: "the draft records no page stamp; render it again to record one" };
  if (sidecar.stamp === stamp) return { state: "current", detail: "the page code and inputs are the same as when the draft was rendered" };
  if (!probes || !Array.isArray(sidecar.probes)) return { state: "stamp-moved", detail: "the page code or inputs changed since the draft was rendered; its slot frames were not compared" };
  const bad = sidecar.probes.findIndex((p, i) => p !== probes[i]);
  if (bad === -1 && sidecar.probes.length === probes.length) return { state: "slot-unchanged", detail: "the page changed elsewhere; the slot's frames draw the same" };
  return { state: "stale", detail: `the page draws the slot differently now (probe frame ${bad === -1 ? "count" : bad} differs); render the draft again` };
}

/** What <id>.json records beside <id>.mp4: the slot, the handle, how the clip was encoded and the page stamp it was drawn from. */
export function draftSidecar({ segment, span, fps, handleSec, quality, width, height, stamp, probes }) {
  return {
    ...(stamp ? { stamp, probes } : {}),
    id: segment.id,
    fps,
    quality,
    width,
    height,
    handleSec,
    slotStart: segment.frameStart / fps,
    slotEnd: segment.frameEnd / fps,
    slotFrameStart: segment.frameStart,
    slotFrameEnd: segment.frameEnd,
    frameStart: span.frameStart,
    frameEnd: span.frameEnd,
    handleBefore: span.handleBefore,
    handleAfter: span.handleAfter,
  };
}

/**
 * Where the slot sits inside the handled clip: clip frames [from, to) are the
 * slot, and `startSec` is the film time the cut clip goes in at.
 */
export function slotCut(sidecar) {
  const from = sidecar.slotFrameStart - sidecar.frameStart;
  const to = sidecar.slotFrameEnd - sidecar.frameStart;
  if (!(from >= 0 && to > from && to <= sidecar.frameEnd - sidecar.frameStart)) {
    throw new Error(`draft ${sidecar.id}: sidecar slot [${sidecar.slotFrameStart},${sidecar.slotFrameEnd}) is not inside the clip's frames [${sidecar.frameStart},${sidecar.frameEnd})`);
  }
  return { from, to, frames: to - from, startSec: sidecar.slotFrameStart / sidecar.fps };
}
