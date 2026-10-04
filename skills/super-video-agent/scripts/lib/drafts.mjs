// Draft shots with handles (render.mjs --only <ids> --handle <sec>): the span
// math, the sidecar a draft clip is stored with, and the cut that takes the
// slot span back out of a handled clip (render.mjs --use-draft <id>).
import path from "node:path";

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

/** What <id>.json records beside <id>.mp4: the slot, the handle and how the clip was encoded. */
export function draftSidecar({ segment, span, fps, handleSec, quality, width, height }) {
  return {
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
