// How loud the page's own sound (bed + effects, no narration) sits against a narration line, and the dB
// to add to the page's level to reach a chosen gap. Pure arithmetic over measured loudness.

/** The median of the finite numbers in `values`, or null when there are none. */
export function medianLufs(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * @param {{integratedLufs:number|null, truePeakDb:number|null}} bed the page's sound measured alone
 * @param {number} voiceLufs the narration reference (a leveled line's integrated loudness)
 * @param {{underDb?: number, maxTruePeakDb?: number}} [opts] `underDb`: the gap wanted, in dB below the voice
 * @returns {{bedLufs:number, voiceLufs:number, gapDb:number, wantedGapDb:number|null, offsetDb:number|null, truePeakAfterDb:number|null, overPeakDb:number|null}}
 *   gapDb = voice minus page (positive: the page is quieter). offsetDb = what to add to the page's level
 *   (negative lowers it); truePeakAfterDb = the page's true peak once that offset is applied
 */
export function mixOffset(bed, voiceLufs, { underDb = null, maxTruePeakDb = -1 } = {}) {
  if (!Number.isFinite(bed.integratedLufs)) throw new Error("the page's sound has no measurable loudness (silent, or shorter than 400 ms)");
  const gapDb = voiceLufs - bed.integratedLufs;
  const offsetDb = underDb === null ? null : gapDb - underDb;
  const peak = Number.isFinite(bed.truePeakDb) ? bed.truePeakDb : null;
  const truePeakAfterDb = peak === null ? null : peak + (offsetDb ?? 0);
  const overPeakDb = truePeakAfterDb !== null && truePeakAfterDb > maxTruePeakDb ? truePeakAfterDb - maxTruePeakDb : null;
  return { bedLufs: bed.integratedLufs, voiceLufs, gapDb, wantedGapDb: underDb, offsetDb, truePeakAfterDb, overPeakDb };
}

/** The report lines: the facts first, then the offset when a gap was asked for. */
export function formatMixLevel(r, { reference }) {
  const lines = [
    `page sound ${r.bedLufs.toFixed(1)} LUFS integrated; ${reference} ${r.voiceLufs.toFixed(1)} LUFS: the page sits ${Math.abs(r.gapDb).toFixed(1)} dB ${r.gapDb >= 0 ? "under" : "over"} the voice`,
  ];
  if (r.offsetDb === null) lines.push("no --under <dB> given: no offset computed");
  else {
    const sign = r.offsetDb >= 0 ? "+" : "";
    lines.push(`for a gap of ${r.wantedGapDb} dB under the voice, add ${sign}${r.offsetDb.toFixed(1)} dB to the page's level, then render again`);
  }
  if (r.truePeakAfterDb !== null) lines.push(`page true peak ${r.truePeakAfterDb.toFixed(1)} dBTP${r.offsetDb === null ? "" : " with that offset"}${r.overPeakDb !== null ? `: ${r.overPeakDb.toFixed(1)} dB over the -1 dBTP limit` : ""}`);
  return lines.join("\n") + "\n";
}
