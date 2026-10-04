// Sound-effect cue check: for each `word:<text>` cue, warns when the word it lands on is missing
// from the line, was not heard by the speech-to-text check, has an interpolated time, or sits where
// the waveform says the sound starts elsewhere. Pure; warnings only, nothing fails.

const letters = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Caption words of a line the way the engine splits them: whitespace, break marks dropped. */
export function captionWords(text) {
  return String(text || "").split(/\s+/).filter((w) => w && w !== "|");
}

/** Index of the first caption word containing `sub`, or -1 (the engine's firstWordIndexContaining). */
export function firstWordIndexContaining(text, sub) {
  return captionWords(text).findIndex((w) => w.includes(sub));
}

/**
 * @param {{lines?: {id:string, text?:string, cues?:{asset?:string, at?:string}[]}[]}} plan
 * @param {{lines?: {id:string, text?:string, words?:object[], wordsMeasured?:number, stt?:{heard?:string}}[]}} timings
 * @param {{words:{lineId:string,index:number,status:string,offsetSec:number|null,onset:number|null,recorded:number}[]}|null} onsets
 *   a word-onsets report, or null when no waveform was measured
 * @returns {{lineId:string, asset:string|undefined, word:string, type:string, detail:string}[]}
 */
export function checkWordCues(plan, timings, onsets) {
  const out = [];
  const byId = new Map((timings.lines || []).map((l) => [l.id, l]));
  const onsetOf = new Map((onsets ? onsets.words : []).map((w) => [`${w.lineId}#${w.index}`, w]));
  for (const line of plan.lines || []) {
    for (const cue of line.cues || []) {
      if (typeof cue.at !== "string" || !cue.at.startsWith("word:")) continue;
      const word = cue.at.slice(5);
      const warn = (type, detail) => out.push({ lineId: line.id, asset: cue.asset, word, type, detail });
      const tl = byId.get(line.id);
      if (!tl) { warn("cue-line-missing", "the line is not in timings.json"); continue; }
      const idx = firstWordIndexContaining(tl.text ?? line.text, word);
      if (idx === -1) { warn("cue-word-missing", `no word of the line contains "${word}"; the cue falls back to the line start`); continue; }
      const heard = tl.stt && typeof tl.stt.heard === "string" ? letters(tl.stt.heard) : null;
      if (heard !== null && !heard.includes(letters(word))) {
        warn("cue-word-not-heard", `the speech-to-text check heard "${tl.stt.heard}", which does not contain "${word}"`);
      }
      const count = (tl.words || []).length;
      if (typeof tl.wordsMeasured === "number" && tl.wordsMeasured < count) {
        warn("cue-word-uncertain", tl.wordsMeasured === 0
          ? `word times of the line are all interpolated (wordsMeasured 0 of ${count})`
          : `only ${tl.wordsMeasured} of ${count} word times in the line are measured; "${captionWords(tl.text)[idx]}" may be interpolated`);
      }
      const m = onsetOf.get(`${line.id}#${idx}`);
      if (m && m.status === "off") {
        warn("cue-word-moved", `recorded ${m.recorded.toFixed(3)} s, the sound starts ${m.onset.toFixed(3)} s (${m.offsetSec > 0 ? "+" : ""}${Math.round(m.offsetSec * 1000)} ms)`);
      } else if (m && m.status === "no-onset") {
        warn("cue-word-uncertain", `no clear sound onset near the recorded ${m.recorded.toFixed(3)} s`);
      }
    }
  }
  return out;
}

/** One line per warning, or a clean line. */
export function formatCueWarnings(warnings, cueCount) {
  if (!warnings.length) return `${cueCount} word cue${cueCount === 1 ? "" : "s"} checked, no warnings\n`;
  return `${cueCount} word cue${cueCount === 1 ? "" : "s"} checked, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}\n` +
    warnings.map((w) => `${w.lineId} ${w.asset ?? "?"} at word:${w.word}: ${w.type}: ${w.detail}\n`).join("");
}
