// Tempo: the speed factor that fits a timeline of stages to a target length (references/assembly.md
// "Fit to a target length"). tempo = natural / target (above 1 = faster). With a floor (the shortest a
// stage may run) the stages that hit the floor stay there and the others take the rest, so the applied
// factor differs from the plain one. Pure functions; facts for the model, which decides whether to apply.

export const TEMPO_RANGE = [0.7, 1.5];
const round = (v) => Math.round(v * 1000) / 1000;

/** The stages of a timeline object ({steps|stages}) or of a timings object ({lines}). */
export function stagesOfTimeline(obj) {
  return obj.steps || obj.stages || obj.lines || [];
}

/** Lead before the first stage, the gaps between stages and the tail, as scalable pauses. */
function pausesOf(stages, natural) {
  const pauses = [stages.length ? Math.max(0, stages[0].start) : natural];
  for (let i = 1; i < stages.length; i++) pauses.push(Math.max(0, stages[i].start - stages[i - 1].end));
  if (stages.length) pauses.push(Math.max(0, natural - stages[stages.length - 1].end));
  return pauses;
}

/** Total length when stages run at tempo s: each stage max(floor, d/s), pauses p/s. */
function totalAt(durations, floors, pauses, s) {
  let sum = 0;
  for (let i = 0; i < durations.length; i++) sum += Math.max(floors[i], durations[i] / s);
  for (const p of pauses) sum += p / s;
  return sum;
}

/**
 * @param {{stages:{id:string,start:number,end:number}[], natural:number, target:number, floorSec?:number}} args
 * @returns {{target, natural, tempo, appliedTempo, feasible, minTotalSec, outOfRange, segments:object[]}}
 * feasible is false when even every stage at its floor is longer than the target; then the stages are
 * placed at their floors and minTotalSec says how short the film can get.
 */
export function fitTempo({ stages, natural, target, floorSec = 0 }) {
  const durations = stages.map((s) => s.end - s.start);
  const floors = durations.map((d) => Math.min(floorSec, d));
  const pauses = pausesOf(stages, natural);
  const minTotalSec = floors.reduce((a, b) => a + b, 0);
  const feasible = target >= minTotalSec - 1e-9;
  let s;
  if (!feasible) s = Infinity;
  else {
    let lo = 0.01, hi = 1000;
    for (let i = 0; i < 80; i++) {
      const mid = Math.sqrt(lo * hi);
      if (totalAt(durations, floors, pauses, mid) > target) lo = mid; else hi = mid;
    }
    s = hi;
  }
  const tempo = natural / target;
  return { target, natural, tempo: round(tempo), appliedTempo: feasible ? round(s) : null, feasible, minTotalSec: round(minTotalSec),
    outOfRange: tempo < TEMPO_RANGE[0] || tempo > TEMPO_RANGE[1], segments: layout(stages, durations, floors, pauses, s) };
}

/** Start, end and factor of each stage at tempo s (s = Infinity puts every stage at its floor with no pauses). */
function layout(stages, durations, floors, pauses, s) {
  let t = pauses[0] / s;
  return stages.map((st, i) => {
    const d = Math.max(floors[i], durations[i] / s);
    const seg = { id: st.id, naturalStart: st.start, naturalEnd: st.end, start: round(t), end: round(t + d),
      factor: round(durations[i] / d), atFloor: floors[i] > 0 && durations[i] / s <= floors[i] + 1e-9 };
    t += d + (pauses[i + 1] || 0) / s;
    return seg;
  });
}

/** Report lines: the factors, the range note, floors reached. */
export function tempoLines(r) {
  const lines = [`natural ${r.natural.toFixed(2)} s -> target ${r.target.toFixed(2)} s: tempo ${r.tempo} (above 1 = faster)`];
  if (!r.feasible) lines.push(`target not reachable: with every stage at its floor the film is ${r.minTotalSec} s; stages placed at their floors`);
  else if (r.appliedTempo !== r.tempo) lines.push(`with the floors the applied tempo is ${r.appliedTempo}`);
  if (r.outOfRange) lines.push(`tempo is outside ${TEMPO_RANGE[0]}-${TEMPO_RANGE[1]}: the stages may be too many or too long for the target (cut or merge stages, or ask whether the target should change)`);
  const floored = r.segments.filter((s) => s.atFloor).map((s) => s.id);
  if (floored.length) lines.push(`at the floor: ${floored.join(", ")}`);
  for (const s of r.segments) lines.push(`${s.id}: ${s.naturalStart}-${s.naturalEnd} -> ${s.start}-${s.end} (factor ${s.factor})`);
  return lines;
}

/** The timeline object with fitted stage times, duration = target and the applied tempo recorded. */
export function fittedTimeline(timeline, r) {
  const key = timeline.steps ? "steps" : "stages";
  return { ...timeline, [key]: timeline[key].map((st, i) => ({ ...st, start: r.segments[i].start, end: r.segments[i].end })),
    duration: r.feasible ? r.target : round(r.segments.length ? r.segments[r.segments.length - 1].end : 0), tempo: r.appliedTempo };
}
