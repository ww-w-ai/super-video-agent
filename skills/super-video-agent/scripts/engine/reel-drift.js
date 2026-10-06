// Super Video Agent drift guard — browser-side, no imports, no network, no wall-clock.
// For films with many stages: checks timeline.json ({steps|stages: [{id, start, end, line?}], duration})
// against the page's duration and the measured voice timings. Optional: the AI decides whether a film
// needs it. Attaches globalThis.ReelDrift. Not inlined by new-reel.mjs: copy this file into <reel>/src/.
//   definite  a stage outside the film, overlapping stages, order broken, a repeated id, end beyond the
//             duration, a stage bound to a line that is missing or starts more than toleranceSec away:
//             guard() throws, so a page that calls it in ready stops the render.
//   graded    a stage shorter than minStepSec, an offset from its line inside the tolerance:
//             reported through ReelDrift.report() for the model to judge, never thrown.
(function () {
  "use strict";

  const stagesOf = (timeline) => (timeline && (timeline.steps || timeline.stages)) || [];

  /**
   * @param {object} timeline
   * @param {{duration:number, fps?:number, timings?:{lines:{id:string,start:number}[]}, pageStepIds?:string[],
   *          toleranceSec?:number, minStepSec?:number}} facts what the page and the voice say
   * @returns {{errors:string[], notes:string[]}}
   */
  function check(timeline, facts) {
    const f = facts || {};
    const frame = 1 / (f.fps || 30);
    const tol = f.toleranceSec === undefined ? 0.5 : f.toleranceSec;
    const minStep = f.minStepSec === undefined ? 0.5 : f.minStepSec;
    const errors = [], notes = [];
    const stages = stagesOf(timeline);
    const lineStart = {};
    for (const l of (f.timings && f.timings.lines) || []) lineStart[l.id] = l.start;

    if (!stages.length) errors.push("timeline has no steps");
    if (typeof timeline.duration === "number" && Math.abs(timeline.duration - f.duration) > frame) {
      errors.push("timeline duration " + timeline.duration + " s differs from the page's " + f.duration + " s by more than one frame");
    }
    if (f.pageStepIds) {
      const ids = new Set(stages.map((s) => s.id));
      if (f.pageStepIds.length !== stages.length) errors.push("the page has " + f.pageStepIds.length + " steps, the timeline " + stages.length);
      for (const id of f.pageStepIds) if (!ids.has(id)) errors.push("page step " + id + " is not in the timeline");
    }
    const seen = new Set();
    stages.forEach((s, i) => {
      const where = "step " + s.id;
      if (seen.has(s.id)) errors.push(where + " appears twice");
      seen.add(s.id);
      if (!(s.start >= 0) || !(s.end > s.start)) errors.push(where + " has start " + s.start + " and end " + s.end + " (needs 0 <= start < end)");
      else if (s.end > f.duration + frame) errors.push(where + " ends at " + s.end + " s, beyond the film's " + f.duration + " s");
      else if (s.end - s.start < minStep) notes.push(where + " lasts " + (s.end - s.start).toFixed(2) + " s, under " + minStep + " s a viewer needs to read a change");
      const prev = stages[i - 1];
      if (prev && s.start < prev.start) errors.push(where + " starts at " + s.start + " s, before the step ahead of it (" + prev.id + " at " + prev.start + " s): order is broken");
      else if (prev && s.start < prev.end - 1e-9) errors.push(where + " starts at " + s.start + " s, inside " + prev.id + " (which runs to " + prev.end + " s)");
      if (s.line !== undefined) bindToLine(s, lineStart, { tol, frame, errors, notes });
    });
    return { errors, notes };
  }

  function bindToLine(s, lineStart, { tol, frame, errors, notes }) {
    if (!(s.line in lineStart)) {
      errors.push("step " + s.id + " names line " + s.line + ", which is not in the voice timings");
      return;
    }
    const off = s.start - lineStart[s.line];
    if (Math.abs(off) > tol) errors.push("step " + s.id + " starts " + off.toFixed(2) + " s from line " + s.line + ", more than the " + tol + " s tolerance");
    else if (Math.abs(off) > frame) notes.push("step " + s.id + " starts " + off.toFixed(2) + " s from line " + s.line);
  }

  let last = null;

  /** Runs check, keeps the report for report(), and throws when something is definitely wrong. */
  function guard(timeline, facts) {
    const r = check(timeline, facts);
    last = { errors: r.errors, notes: r.notes, steps: stagesOf(timeline).length };
    if (r.errors.length) throw new Error("timeline drift: " + r.errors.join("; "));
    return last;
  }

  /** The last guard result as plain JSON (null before guard ran): window.__reel.driftReport = ReelDrift.report. */
  function report() {
    return last;
  }

  globalThis.ReelDrift = { check, guard, report };
})();
