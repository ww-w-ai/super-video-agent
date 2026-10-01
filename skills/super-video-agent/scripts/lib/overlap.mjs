// Pure helpers for overlap.mjs: check the page hook's answer, merge per-frame counts into spans,
// and print them. No browser here, so the logic is unit-tested on plain data.

/**
 * Checks one answer of window.__reel.overlap(t). Returns the array; throws a message naming the
 * time when it is not [{pair: string, count: number}, ...].
 * @param {unknown} value
 * @param {number} t
 */
export function checkHookResult(value, t) {
  const where = `window.__reel.overlap(${t.toFixed(3)})`;
  if (!Array.isArray(value)) throw new Error(`${where} returned ${typeof value}, not an array of {pair, count}`);
  value.forEach((e, i) => {
    if (!e || typeof e.pair !== "string" || !e.pair) throw new Error(`${where}[${i}] has no "pair" string`);
    if (!Number.isFinite(e.count) || e.count < 0) throw new Error(`${where}[${i}] ("${e.pair}") has no count ≥ 0`);
  });
  return value;
}

/**
 * Merges sampled frames into spans per pair. A span is a run of sampled frames, each `step` frames
 * after the previous one, where the pair's count is above 0. Pairs that never overlap are kept
 * with no spans, so the report shows they were checked.
 * @param {{frame:number, pairs:{pair:string, count:number}[]}[]} samples  in frame order
 * @param {{fps:number, step:number}} opts
 * @returns {Record<string, {spans:{startFrame:number,endFrame:number,start:number,end:number,
 *   frames:number,maxCount:number,maxAt:number}[], framesWithOverlap:number, maxCount:number}>}
 */
export function overlapSpans(samples, { fps, step }) {
  const out = {};
  const open = {};
  const sec = (f) => Math.round((f / fps) * 1000) / 1000;
  for (const s of samples) {
    for (const { pair, count } of s.pairs) {
      const p = (out[pair] ||= { spans: [], framesWithOverlap: 0, maxCount: 0 });
      if (count <= 0) { open[pair] = null; continue; }
      p.framesWithOverlap++;
      p.maxCount = Math.max(p.maxCount, count);
      const cur = open[pair];
      if (cur && s.frame - cur.endFrame === step) {
        cur.endFrame = s.frame;
        cur.end = sec(s.frame);
        cur.frames++;
        if (count > cur.maxCount) { cur.maxCount = count; cur.maxAt = sec(s.frame); }
      } else {
        const span = { startFrame: s.frame, endFrame: s.frame, start: sec(s.frame), end: sec(s.frame),
          frames: 1, maxCount: count, maxAt: sec(s.frame) };
        p.spans.push(span);
        open[pair] = span;
      }
    }
    // a pair missing from this sample closes its open span
    for (const pair of Object.keys(open)) if (!s.pairs.some((e) => e.pair === pair)) open[pair] = null;
  }
  return out;
}

/** One line per pair: its spans, or "none". */
export function formatSpans(byPair) {
  const names = Object.keys(byPair).sort();
  if (!names.length) return "the hook reported no pairs at any sampled frame\n";
  return names.map((name) => {
    const { spans } = byPair[name];
    if (!spans.length) return `${name}: none\n`;
    const list = spans.map((s) =>
      `${s.start.toFixed(3)}–${s.end.toFixed(3)} s (frames ${s.startFrame}–${s.endFrame}, max ${s.maxCount} at ${s.maxAt.toFixed(3)} s)`);
    return `${name}: ${spans.length} span${spans.length > 1 ? "s" : ""} — ${list.join("; ")}\n`;
  }).join("");
}
