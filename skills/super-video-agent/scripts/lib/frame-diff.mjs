// Greyscale frames of a finished file for the picture checks: one ffmpeg
// decode streamed frame by frame (never the whole film in memory), and the
// in-memory front end of the shared freeze method (scripts/lib/freeze-scan.mjs).
import { spawn } from "node:child_process";
import { splitIntendedHolds } from "./dead-air.mjs";
import {
  changedFraction,
  createFreezeStream,
  scanSize,
  FREEZE_SCAN_WIDTH,
  FREEZE_MIN_SEC,
} from "./freeze-scan.mjs";

export { changedFraction, FREEZE_SCAN_WIDTH };

/**
 * ffmpeg arguments that decode every frame of `file` (no rate conversion, so
 * dropped and repeated frames stay visible) to w x h greyscale raw video.
 */
export function grayDecodeArgs(file, w, h) {
  return [
    "-hide_banner", "-loglevel", "error", "-i", file, "-an", "-sn", "-dn",
    "-fps_mode", "passthrough", "-vf", `scale=${w}:${h}:flags=neighbor,format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ];
}

/** Cuts a byte stream into whole frames of `frameSize`, each a fresh buffer handed to `onFrame` in order. */
function frameSplitter(frameSize, onFrame) {
  let frame = Buffer.allocUnsafe(frameSize);
  let filled = 0;
  let count = 0;
  return {
    write(chunk) {
      let at = 0;
      while (at < chunk.length) {
        const n = chunk.copy(frame, filled, at, Math.min(chunk.length, at + frameSize - filled));
        filled += n;
        at += n;
        if (filled < frameSize) continue;
        onFrame(frame, count++);
        frame = Buffer.allocUnsafe(frameSize);
        filled = 0;
      }
    },
    count: () => count,
  };
}

/**
 * Decode `file` once to greyscale frames at most `maxWidth` wide and hand each
 * to `onFrame(frame, index)` as it arrives.
 * @param {string} file
 * @param {{width:number, height:number, maxWidth?:number, onFrame:(frame:Buffer, index:number)=>void, spawnFn?:typeof spawn}} opts
 *   width/height = the video's own size; spawnFn is injectable so a test can count decodes
 * @returns {Promise<{frames:number, w:number, h:number}>}
 */
export function streamGrayFrames(file, { width, height, maxWidth = FREEZE_SCAN_WIDTH, onFrame, spawnFn = spawn }) {
  const { w, h } = scanSize(width, height, maxWidth);
  return new Promise((resolve, reject) => {
    const child = spawnFn("ffmpeg", grayDecodeArgs(file, w, h), { stdio: ["ignore", "pipe", "pipe"] });
    const split = frameSplitter(w * h, onFrame);
    let stderr = "";
    let failed = null;
    child.stdout.on("data", (chunk) => {
      if (failed) return;
      try {
        split.write(chunk);
      } catch (e) {
        failed = e;
        child.kill();
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
    child.on("close", (code) => {
      if (failed) reject(failed);
      else if (code === 0) resolve({ frames: split.count(), w, h });
      else reject(new Error(`ffmpeg grey decode exited ${code}\n${stderr}`));
    });
  });
}

/**
 * Freeze runs over greyscale frames already in memory (one per fps tick),
 * by the shared method: the same code the file check streams through.
 * @param {Uint8Array[]} frames
 * @param {number} fps
 * @param {{holds?: {from:number, to:number}[]}} [opts] holds = intended slow-motion / hold spans (seconds)
 * @returns {{deadAirRuns:{startSec:number,durationSec:number}[], intendedHoldRuns:{startSec:number,durationSec:number}[], frameCount:number}}
 */
export function analyzeMotion(frames, fps, { holds } = {}) {
  const stream = createFreezeStream({ fps });
  for (const f of frames) stream.push(f);
  // Spans the page declared as intended slow motion / hold are reported apart, never flagged.
  const split = splitIntendedHolds(stream.finish().runs, holds, FREEZE_MIN_SEC);
  return { deadAirRuns: split.runs, intendedHoldRuns: split.intendedHolds, frameCount: frames.length };
}
