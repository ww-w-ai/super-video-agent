// Pure segment math for partial re-rendering (references/pipeline.md
// "Re-rendering part of a film"): turning window.__reel.shots into frame
// ranges that tile the film, deciding whether a stored segment can be
// reused, and validating --only against the current timeline. No I/O.

/**
 * Convert shots [{id, start, end}] into contiguous frame-range segments.
 * The first segment always starts at frame 0 and the last always ends at
 * round(duration*fps), regardless of what the outer shots report (design
 * point 1). Interior boundaries must tile exactly (this shot's end frame
 * equals the next shot's start frame); when they don't (silence gaps,
 * overlaps, rounding drift), the non-tiling shots are merged into one
 * segment and a warning is returned instead of failing.
 * @param {{shots: {id:string,start:number,end:number}[], fps:number, duration:number}} args
 * @returns {{segments: {id:string, frameStart:number, frameEnd:number, shotIds:string[]}[], warnings:string[]}}
 */
export function computeSegments({ shots, fps, duration }) {
  const lastFrame = Math.round(duration * fps);
  if (!shots || shots.length === 0) {
    return {
      segments: [{ id: "full", frameStart: 0, frameEnd: lastFrame, shotIds: [] }],
      warnings: ["no shots reported by the page; using a single full-range segment"],
    };
  }

  const raw = shots.map((s) => ({
    id: s.id,
    frameStart: Math.round(s.start * fps),
    frameEnd: Math.round(s.end * fps),
  }));
  raw[0] = { ...raw[0], frameStart: 0 };
  raw[raw.length - 1] = { ...raw[raw.length - 1], frameEnd: lastFrame };

  const warnings = [];
  const segments = [];
  let cur = { ids: [raw[0].id], frameStart: raw[0].frameStart, frameEnd: raw[0].frameEnd };

  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    if (r.frameStart === cur.frameEnd) {
      segments.push(finalizeSegment(cur));
      cur = { ids: [r.id], frameStart: r.frameStart, frameEnd: r.frameEnd };
    } else {
      warnings.push(
        `shots do not tile: "${cur.ids[cur.ids.length - 1]}" ends at frame ${cur.frameEnd} but "${r.id}" ` +
          `starts at frame ${r.frameStart} — merged into one segment`
      );
      cur.ids.push(r.id);
      cur.frameEnd = Math.max(cur.frameEnd, r.frameEnd);
    }
  }
  segments.push(finalizeSegment(cur));

  return { segments, warnings };
}

function finalizeSegment(cur) {
  return { id: cur.ids.join("+"), frameStart: cur.frameStart, frameEnd: cur.frameEnd, shotIds: cur.ids.slice() };
}

/**
 * The three probe frame indices (first, middle, last) for a segment's
 * reuse test (design point 3).
 * @param {number} frameStart
 * @param {number} frameEnd exclusive
 * @returns {[number, number, number]}
 */
export function probeFrameIndices(frameStart, frameEnd) {
  const last = frameEnd - 1;
  const mid = frameStart + Math.floor((last - frameStart) / 2);
  return [frameStart, mid, last];
}

/**
 * Decide whether a segment can be reused: its stored metadata must match
 * the current frame range, fps and size, and all three probe hashes, and
 * its .mp4 must exist on disk (design point 3).
 * @param {{stored: object|null, current: {frameStart:number,frameEnd:number,fps:number,width:number,height:number,probes:string[]}, mp4Exists: boolean}} args
 * @returns {{reuse: boolean, reason: string}}
 */
export function decideSegmentReuse({ stored, current, mp4Exists }) {
  if (!mp4Exists) return { reuse: false, reason: "segment .mp4 missing" };
  if (!stored) return { reuse: false, reason: "no stored segment metadata" };
  if (stored.frameStart !== current.frameStart || stored.frameEnd !== current.frameEnd) {
    return {
      reuse: false,
      reason: `frame range changed (stored [${stored.frameStart},${stored.frameEnd}) vs current [${current.frameStart},${current.frameEnd}))`,
    };
  }
  if (stored.fps !== current.fps) {
    return { reuse: false, reason: `fps changed (${stored.fps} -> ${current.fps})` };
  }
  if (stored.width !== current.width || stored.height !== current.height) {
    return {
      reuse: false,
      reason: `size changed (${stored.width}x${stored.height} -> ${current.width}x${current.height})`,
    };
  }
  if (!Array.isArray(stored.probes) || stored.probes.length !== current.probes.length) {
    return { reuse: false, reason: "probe count mismatch" };
  }
  for (let i = 0; i < stored.probes.length; i++) {
    if (stored.probes[i] !== current.probes[i]) {
      return { reuse: false, reason: `probe hash mismatch at frame index ${i}` };
    }
  }
  return { reuse: true, reason: "frame range, size, fps and probe hashes match" };
}

/**
 * `--only` ids that don't correspond to any current segment (design point 4).
 * @param {{segments: {id:string}[], onlyIds: string[]}} args
 * @returns {string[]}
 */
export function unknownOnlyIds({ segments, onlyIds }) {
  const known = new Set(segments.map((s) => s.id));
  return onlyIds.filter((id) => !known.has(id));
}

/**
 * Validate that every segment NOT named in `--only` still matches its
 * stored frame range, so it's safe to reuse without probing. Returns the
 * ids of segments that must be added to --only when it isn't safe (design
 * point 4: "refuse ... and say which shots must be included").
 * @param {{segments: {id:string,frameStart:number,frameEnd:number}[], onlyIds: string[], storedById: Map<string, {frameStart:number,frameEnd:number}|null>}} args
 * @returns {{ok: boolean, mustInclude: string[]}}
 */
export function validateOnly({ segments, onlyIds, storedById }) {
  const onlySet = new Set(onlyIds);
  const mustInclude = [];
  for (const seg of segments) {
    if (onlySet.has(seg.id)) continue;
    const stored = storedById.get(seg.id);
    if (!stored || stored.frameStart !== seg.frameStart || stored.frameEnd !== seg.frameEnd) {
      mustInclude.push(seg.id);
    }
  }
  return { ok: mustInclude.length === 0, mustInclude };
}
