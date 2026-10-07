// `dub.mjs <reel-dir> --lang <code> --init-plan [--copy]`: dub/<code>/plan.json from the base plan.
// The scaffold keeps what is the film's timing and structure (ids, pauses, lead) and leaves what
// belongs to the language (text, say, voice id, pronounce, overlay strings) empty, or copied
// as is with --copy. It writes a starting point; translating and choosing the voice stay with the user.
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./reeldir.mjs";

const LANG_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
// Per-line fields that are the film's timing and structure, the same in every language.
const LINE_KEEP = ["pauseBeforeMs", "pauseAfterMs", "lead", "rate", "speaker"];
// meta.voice fields that name one speaker; they differ per language, so they are left for the user.
const VOICE_SPEAKER = ["voiceId", "refAudio", "refText", "refTokens"];

/** The same object with every string leaf emptied: the shape of a block of copy still to be translated. */
function blankStrings(value) {
  if (typeof value === "string") return "";
  if (Array.isArray(value)) return value.map(blankStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blankStrings(v)]));
  return value;
}

/**
 * @param {{meta:object, lines:object[]}} base the base plan
 * @param {string} code the language code (BCP 47)
 * @param {{copy?:boolean}} [opts] copy: keep the base text, say, pronounce, overlay and the whole voice
 */
export function buildDubPlan(base, code, opts = {}) {
  const meta = { ...(base.meta || {}), lang: code };
  if (!opts.copy) {
    if (meta.voice) meta.voice = Object.fromEntries(Object.entries(meta.voice).filter(([k]) => !VOICE_SPEAKER.includes(k)));
    delete meta.pronounce;
    if (meta.overlay) meta.overlay = blankStrings(meta.overlay);
  }
  const lines = (base.lines || []).map((l) => {
    const out = { id: l.id, text: opts.copy ? l.text : "" };
    if (opts.copy && l.say != null) out.say = l.say;
    for (const k of LINE_KEEP) if (l[k] != null) out[k] = l[k];
    if (opts.copy) for (const k of ["notes", "pronounce", "sayWhy", "emotion", "lang", "voice", "cues"]) if (l[k] != null) out[k] = l[k];
    return out;
  });
  return { meta, lines };
}

/**
 * Writes `<dir>/dub/<code>/plan.json`. Stops (throws) when the language code is not a BCP 47 tag,
 * the base plan is missing, or the dub plan already exists (never overwritten).
 * @returns {{planPath:string, lineCount:number, copy:boolean, voiceDropped:boolean}}
 */
export function initDubPlan(dir, code, opts = {}) {
  if (!LANG_TAG.test(code)) throw new Error(`--lang "${code}" is not a BCP 47 language tag (e.g. en, ja, pt-BR)`);
  const target = path.join(dir, "dub", code, "plan.json");
  if (fs.existsSync(target)) throw new Error(`${target} already exists; edit it, or delete it to scaffold again`);
  const base = readJson(path.join(dir, "plan.json"));
  const plan = buildDubPlan(base, code, opts);
  if (plan.meta.cast) plan.meta.cast = path.relative(path.dirname(target), path.resolve(dir, plan.meta.cast));
  writeJson(target, plan);
  const voiceDropped = !opts.copy && !!(base.meta && base.meta.voice && VOICE_SPEAKER.some((k) => base.meta.voice[k] != null));
  return { planPath: target, lineCount: plan.lines.length, copy: !!opts.copy, voiceDropped };
}

/** The console lines after a scaffold: what was written and what is left to fill. */
export function formatInitReport(r) {
  const todo = r.copy
    ? "text, say and meta are copies of the base plan: translate them, or keep them for a dub in the base language"
    : `each line's text is empty (plan.json needs a non-empty text per line: write the translation)${r.voiceDropped ? "; meta.voice.voiceId and any reference clip were left out, set the voice for this language" : ""}; meta.overlay strings are empty`;
  return `wrote ${r.planPath} (${r.lineCount} lines)\nleft to fill: ${todo}\n`;
}
