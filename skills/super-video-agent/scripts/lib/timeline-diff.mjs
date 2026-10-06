// Finds which spans of a film changed between two timelines, so only those are rendered
// (render.mjs --span) and the rest is copied from the old film (render.mjs --assemble).
// Pure: no files, no browser.
//
// A timeline is voice/timings.json ({duration, fps?, lines:[{id, start, end, text, words?}]}) or a dump of
// the page's shots ({duration, fps?, shots:[{id, start, end, hash?}]}). Each item owns the frames from its
// start to the next item's start (the first from 0, the last to the end), so a changed gap moves the item
// before it. An item is kept when the other timeline has the same id with the same text, hash, word times
// and owned length; where it sits may differ (that is a shift, and the old frames are copied there).

const frameOf = (sec, fps) => Math.round(sec * fps);

/** The items of a timeline document, sorted by start: `shots` when present, else `lines`. */
export function timelineItems(doc) {
  const list = doc && Array.isArray(doc.shots) ? doc.shots : doc && Array.isArray(doc.lines) ? doc.lines : null;
  if (!list) throw new Error('a timeline is {"duration": s, "lines": [{id, start, end, text}]} (voice/timings.json) or {"duration": s, "shots": [{id, start, end}]}');
  for (const it of list) {
    if (typeof it.id !== "string" || !Number.isFinite(it.start)) throw new Error(`timeline item ${JSON.stringify(it.id)} needs a string "id" and a numeric "start"`);
  }
  return list.slice().sort((a, b) => a.start - b.start);
}

/** The frames each item owns, with a key that is equal when what the item draws is equal. */
export function ownedRanges(doc, fps) {
  const items = timelineItems(doc);
  const duration = Number.isFinite(doc.duration) ? doc.duration : Math.max(...items.map((i) => i.end ?? i.start));
  const last = frameOf(duration, fps);
  return items.map((it, i) => {
    const from = i === 0 ? 0 : frameOf(it.start, fps);
    const to = i === items.length - 1 ? last : frameOf(items[i + 1].start, fps);
    const words = Array.isArray(it.words) ? it.words.map((w) => frameOf(w.start - it.start, fps)) : [];
    return { id: it.id, from, to, key: JSON.stringify([it.text ?? "", it.hash ?? "", to - from, words]) };
  });
}

/**
 * @param {object} oldDoc the timeline the old film was made from
 * @param {object} newDoc the timeline the new film must follow
 * @param {number} fps
 * @returns {{runs: ({kind:"keep", newFrom:number, newTo:number, oldFrom:number, oldTo:number, ids:string[]} | {kind:"new", newFrom:number, newTo:number, ids:string[], reason:string})[], removed:string[], frames:{kept:number, new:number, shifted:number}}}
 *   runs tile the new film's frames in order
 */
export function diffTimelines(oldDoc, newDoc, fps) {
  const oldById = new Map(ownedRanges(oldDoc, fps).map((r) => [r.id, r]));
  const next = ownedRanges(newDoc, fps);
  const newIds = new Set(next.map((r) => r.id));
  const runs = [];
  for (const r of next) {
    const was = oldById.get(r.id);
    const run = was && was.key === r.key
      ? { kind: "keep", newFrom: r.from, newTo: r.to, oldFrom: was.from, oldTo: was.to, ids: [r.id] }
      : { kind: "new", newFrom: r.from, newTo: r.to, ids: [r.id], reason: was ? "changed" : "added" };
    const prev = runs[runs.length - 1];
    if (prev && prev.kind === run.kind && (run.kind === "new" || prev.oldTo === run.oldFrom)) {
      prev.newTo = run.newTo;
      prev.ids.push(...run.ids);
      if (run.kind === "keep") prev.oldTo = run.oldTo;
      else if (prev.reason !== run.reason) prev.reason = "changed";
    } else runs.push(run);
  }
  const keeps = runs.filter((r) => r.kind === "keep");
  return {
    runs,
    removed: [...oldById.keys()].filter((id) => !newIds.has(id)),
    frames: {
      kept: keeps.reduce((n, r) => n + r.newTo - r.newFrom, 0),
      new: runs.filter((r) => r.kind === "new").reduce((n, r) => n + r.newTo - r.newFrom, 0),
      shifted: keeps.filter((r) => r.newFrom !== r.oldFrom).reduce((n, r) => n + r.newTo - r.newFrom, 0),
    },
  };
}

/** `--span` value for the changed runs, in seconds on the new timeline; "" when nothing changed. */
export function spanFlag(runs, fps) {
  return runs.filter((r) => r.kind === "new").map((r) => `${+(r.newFrom / fps).toFixed(3)}-${+(r.newTo / fps).toFixed(3)}`).join(",");
}

/**
 * An `--assemble` EDL: kept runs come from the old film at their old frames, new runs from `newFilm`, a clip
 * whose frame n is the new film's frame n (so a changed run takes the same frames from it), or from `newClips`
 * (clips that start at a known frame of the new film, such as drafts).
 * @returns {{entries: object[]}}
 */
export function edlFromRuns(runs, { oldFilm, newFilm, newClips }) {
  const entries = runs.flatMap((r) => {
    if (r.kind === "keep") return [{ src: oldFilm, from: r.oldFrom, to: r.oldTo }];
    return newClips ? entriesFromClips(r, newClips) : [{ src: newFilm, from: r.newFrom, to: r.newTo, new: true }];
  });
  return { entries };
}

/**
 * A changed run cut out of the clips that hold its frames. A clip is {src, frameStart, frameEnd}: its first frame
 * is the new film's frame `frameStart` (a draft under out/drafts/ records that in its sidecar), so the film frame f
 * is the clip's frame f - frameStart. A run that no clip holds stops the step: the EDL would not fit.
 */
function entriesFromClips(run, clips) {
  const out = [];
  let at = run.newFrom;
  while (at < run.newTo) {
    const clip = clips.filter((c) => c.frameStart <= at && at < c.frameEnd).sort((a, b) => b.frameEnd - a.frameEnd)[0];
    if (!clip) throw new Error(`no new clip holds the film's frames [${at},${run.newTo}) (${run.ids.join(",")}); clips hold ${clips.map((c) => `[${c.frameStart},${c.frameEnd})`).join(" ")}`);
    const to = Math.min(run.newTo, clip.frameEnd);
    out.push({ src: clip.src, from: at - clip.frameStart, to: to - clip.frameStart, new: true });
    at = to;
  }
  return out;
}
