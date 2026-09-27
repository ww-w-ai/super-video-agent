// Determinism probe (design.md §2.1, §2.4): seek(t) must be independent of
// seek history. Build a list of probe times (shot boundaries + boil bucket
// edges + spread samples), capture pixel hashes in order and shuffled, and
// compare.
import crypto from "node:crypto";

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Build >=12 probe times covering shot boundaries and boil-bucket edges.
 * @param {{start:number,end:number,readAt:number}[]} shots
 * @param {number} duration
 * @param {number} boilHz
 */
export function buildProbeTimes(shots, duration, boilHz = 8) {
  const times = new Set();
  for (const s of shots) {
    times.add(round(s.start));
    times.add(round(s.readAt));
    times.add(round(Math.max(s.start, s.end - 1 / 60)));
  }
  // boil bucket edges: t just after n/hz for several n across the duration
  const step = 1 / boilHz;
  const bucketCount = Math.max(1, Math.floor(duration / step));
  const sampleEvery = Math.max(1, Math.floor(bucketCount / 8));
  for (let n = 0; n < bucketCount; n += sampleEvery) {
    times.add(round(n * step + step / 2));
  }
  // even spread fallback to guarantee >= 12
  for (let i = 0; i < 12 && times.size < 12; i++) {
    times.add(round((duration * i) / 12));
  }
  return Array.from(times)
    .filter((t) => t >= 0 && t <= duration)
    .sort((a, b) => a - b);
}

function round(t) {
  return Math.round(t * 1000) / 1000;
}

/** Fisher-Yates shuffle seeded by a fixed constant (deterministic test order). */
export function deterministicShuffle(arr, seedStr = "sva-verify") {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
