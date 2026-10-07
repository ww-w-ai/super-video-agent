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
  if (stored.assembledCopy?.pageMismatch) return { reuse: false, reason: "assembled copy differs from the page; retained for explicit span edits only" };
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
 * Reuse decision for a language picture (render.mjs --no-captions --lang):
 * the language's own stored segment first; else the base language's stored
 * segment when its range, fps, size and probe hashes equal the current ones
 * (the shot draws no string that changes per language), which is copied
 * instead of rendered; else render.
 * @param {{storedLang: object|null, storedBase: object|null, current: object, langMp4Exists: boolean, baseMp4Exists: boolean}} args
 * @returns {{action: "REUSE"|"COPY"|"RENDER", reason: string}}
 */
export function decideLangSegment({ storedLang, storedBase, current, langMp4Exists, baseMp4Exists }) {
  const own = decideSegmentReuse({ stored: storedLang, current, mp4Exists: langMp4Exists });
  if (own.reuse) return { action: "REUSE", reason: own.reason };
  const base = decideSegmentReuse({ stored: storedBase, current, mp4Exists: baseMp4Exists });
  if (base.reuse) return { action: "COPY", reason: "probe hashes equal the base language's segment (copied, not rendered)" };
  return { action: "RENDER", reason: own.reason };
}

/**
 * A language picture's segment that needs no probe: the base segment's
 * stored meta records which picture strings its frames read (render.mjs
 * writes `picture` = {keys, lang, all} for every segment it renders). When
 * those frames read no key this language sets, never read Reel.lang and
 * never listed the keys, the language's frames are the base frames — take
 * the base segment as is. Returns null when the segment must be probed:
 * no record, a read that this language changes, or a base segment that does
 * not match the current frame range, fps or size, or has no mp4.
 * @param {{storedBase: object|null, storedLang: object|null, current: {frameStart:number,frameEnd:number,fps:number,width:number,height:number}, strings: Record<string,string>, baseMp4Exists: boolean, langMp4Exists: boolean}} args
 * @returns {{action: "REUSE"|"COPY", reason: string}|null}
 */
export function decideLangUnprobed({ storedBase, storedLang, current, strings, baseMp4Exists, langMp4Exists }) {
  if (!storedBase || storedBase.assembledCopy?.pageMismatch || storedLang?.assembledCopy?.pageMismatch || !baseMp4Exists || !sameShape(storedBase, current)) return null;
  const reads = storedBase.picture;
  if (!reads || !Array.isArray(reads.keys) || reads.lang || reads.all) return null;
  const set = strings && typeof strings === "object" ? strings : {};
  const changed = reads.keys.filter((k) => Object.prototype.hasOwnProperty.call(set, k) && typeof set[k] === "string" && set[k] !== "");
  if (changed.length) return null;
  if (storedLang && langMp4Exists && sameShape(storedLang, current) && sameProbes(storedLang, storedBase)) {
    return { action: "REUSE", reason: "the base segment draws no string this language changes; the language's copy of it is current (not probed)" };
  }
  return { action: "COPY", reason: "the base segment draws no string this language changes (copied, not probed)" };
}

function sameShape(stored, current) {
  return (
    stored.frameStart === current.frameStart &&
    stored.frameEnd === current.frameEnd &&
    stored.fps === current.fps &&
    stored.width === current.width &&
    stored.height === current.height
  );
}

function sameProbes(a, b) {
  return Array.isArray(a.probes) && Array.isArray(b.probes) && a.probes.length === b.probes.length && a.probes.every((h, i) => h === b.probes[i]);
}

/**
 * With `--only`: the segments outside --only that have never been rendered
 * (no stored metadata or no .mp4). A first render by parts skips them
 * instead of refusing; the film is joined once none is left.
 * @param {{segments: {id:string}[], onlyIds: string[], storedById: Map<string, object|null>, mp4ExistsById: Map<string, boolean>}} args
 * @returns {string[]} in timeline order
 */
export function pendingIds({ segments, onlyIds, storedById, mp4ExistsById }) {
  const named = new Set(onlyIds);
  return segments.filter((s) => !named.has(s.id) && (!storedById.get(s.id) || !mp4ExistsById.get(s.id))).map((s) => s.id);
}

/**
 * With `--only`, the segments immediately before and after each named one
 * that are not named themselves (and not in `skipIds`, e.g. covered by an
 * --insert clip): their frames can depend on the changed state, so render.mjs
 * probes them. In timeline order, no duplicates.
 * @param {{segments: {id:string}[], onlyIds: string[], skipIds?: string[]}} args
 * @returns {string[]}
 */
export function neighbourIds({ segments, onlyIds, skipIds = [] }) {
  const named = new Set(onlyIds);
  const skip = new Set(skipIds);
  const out = new Set();
  segments.forEach((seg, i) => {
    if (!named.has(seg.id)) return;
    for (const n of [segments[i - 1], segments[i + 1]]) {
      if (n && !named.has(n.id) && !skip.has(n.id)) out.add(n.id);
    }
  });
  return segments.map((s) => s.id).filter((id) => out.has(id));
}

/**
 * Reads the edit decision list of `render.mjs --assemble`: {"entries": [...]},
 * each entry one run of frames of an existing clip, in film order. An entry
 * names `src` (a clip path, relative to the reel dir) or `segment` (a cached
 * segment id); `from`/`to` are frames of that clip (default: all of it);
 * `new: true` marks frames that did not exist before (an inserted draft), which
 * the frame gate checks in full — it defaults to true for a clip under drafts/.
 * @returns {{src?:string, segment?:string, from:number, to:number|null, fresh:boolean}[]}
 */
export function parseEdl(doc) {
  const entries = doc && Array.isArray(doc.entries) ? doc.entries : null;
  if (!entries || !entries.length) throw new Error('the EDL must be {"entries": [{"segment": "<id>"}, {"src": "out/drafts/<id>.mp4", "new": true}, ...]} with at least one entry');
  return entries.map((e, i) => {
    const label = `EDL entry ${i + 1}`;
    if (!e || typeof e !== "object") throw new Error(`${label} is not an object`);
    const hasSrc = typeof e.src === "string" && e.src !== "";
    const hasSegment = typeof e.segment === "string" && e.segment !== "";
    if (hasSrc === hasSegment) throw new Error(`${label} names exactly one of "src" (a clip path) or "segment" (a cached segment id)`);
    const from = e.from === undefined ? 0 : e.from;
    const to = e.to === undefined ? null : e.to;
    if (!Number.isInteger(from) || from < 0 || (to !== null && (!Number.isInteger(to) || to <= from))) {
      throw new Error(`${label}: "from"/"to" are whole frame numbers of the clip with 0 <= from < to (got ${JSON.stringify(e.from)}, ${JSON.stringify(e.to)})`);
    }
    const fresh = e.new === undefined ? hasSrc && /(^|[\\/])drafts[\\/]/.test(e.src) : e.new === true;
    return hasSrc ? { src: e.src, from, to, fresh } : { segment: e.segment, from, to, fresh };
  });
}

/**
 * Entry-relative frame ranges the --assemble frame gate hashes: a new entry in
 * full; otherwise every re-encoded piece in full and the first and last `edge`
 * frames of every copied piece (the seams). Frames inside a packet-copied piece
 * are not hashed: they are the source's packets. Ascending, merged.
 * @param {{frames:number, pieces:{kind:string,from:number,to:number}[], fresh:boolean, edge?:number}} args
 */
export function entryCheckRanges({ frames, pieces, fresh, edge = 2 }) {
  if (fresh) return [{ from: 0, to: frames }];
  const raw = [];
  for (const p of pieces) {
    if (p.kind === "encode") raw.push({ from: p.from, to: p.to });
    else raw.push({ from: p.from, to: Math.min(p.to, p.from + edge) }, { from: Math.max(p.from, p.to - edge), to: p.to });
  }
  raw.sort((a, b) => a.from - b.from);
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
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
