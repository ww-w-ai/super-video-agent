// Delivery marks in a line's spoken text. A plan writes our own marks in curly braces
// (`{pause}`, `{confident}`); each voice provider translates them into its model's own tags
// (`tagMap`), and a mark the model has no tag for is dropped. Square-bracket tags written in a
// model's own vocabulary (`[whispers sweetly]`) pass only to a model that reads tags.
// The speech-to-text check and caption word timings never see either kind.
// See references/voice.md "Delivery marks".

/** Our marks. Emotions are words both tag-reading engines take as they are. */
export const MARKS = {
  pause: "a short pause",
  "long-pause": "a longer pause",
  emphasis: "stress the next words",
  whisper: "whispered",
  soft: "soft, gentle tone",
  hurry: "hurried",
  shout: "shouted",
  laugh: "a laugh",
  chuckle: "a small laugh",
  sigh: "a sigh",
  gasp: "a gasp",
  "clear-throat": "clears the throat",
};
export const EMOTIONS = [
  "confident", "determined", "excited", "calm", "proud", "hopeful", "happy", "sad",
  "nervous", "curious", "surprised", "grateful", "serious", "warm", "sarcastic", "annoyed",
];

const MARK = /\{([a-z-]+)\}/g;
const NATIVE = /\[[^\]\n]*\]/g;

function tidy(s) {
  return s
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?…])/g, "$1")
    .trim();
}

/**
 * `s` without any marks or native tags — what a listener hears as words.
 * @param {string} s
 */
export function stripTags(s) {
  return tidy(String(s ?? "").replace(MARK, " ").replace(NATIVE, " "));
}

/**
 * Character spans [start, end) of every native `[tag]` in `s` (what an engine was sent).
 * @param {string} s
 */
export function tagSpans(s) {
  const spans = [];
  for (const m of String(s ?? "").matchAll(NATIVE)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/**
 * Marks in `s` that are neither in MARKS nor EMOTIONS.
 * @param {string} s
 */
export function unknownMarks(s) {
  const out = [];
  for (const m of String(s ?? "").matchAll(MARK)) {
    if (!(m[1] in MARKS) && !EMOTIONS.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * The text an engine receives. Each `{mark}` becomes the provider's tag for it, or nothing;
 * native `[tags]` stay only when the provider's model reads tags.
 * @param {string} spoken
 * @param {{tagMap?:(voiceCfg:object)=>Record<string,string>|null}} provider
 * @param {object} voiceCfg
 */
/**
 * `spoken` with `delivery`'s emotion mark prepended (meta.voice.delivery:
 * one film-wide delivery for every line), unless `spoken` already carries
 * its own emotion mark — a line's own `{confident}` etc. always wins.
 * `delivery` outside EMOTIONS is ignored (the schema already restricts it).
 * @param {string} spoken
 * @param {string} [delivery]
 */
export function applyDeliveryMark(spoken, delivery) {
  if (!delivery || !EMOTIONS.includes(delivery)) return spoken;
  const hasOwnEmotion = [...String(spoken ?? "").matchAll(MARK)].some((m) => EMOTIONS.includes(m[1]));
  if (hasOwnEmotion) return spoken;
  return `{${delivery}} ${spoken}`;
}

export function forEngine(spoken, provider, voiceCfg) {
  const map = typeof provider.tagMap === "function" ? provider.tagMap(voiceCfg || {}) : null;
  let out = String(spoken ?? "").replace(MARK, (_, name) => {
    const tag = map && (map[name] ?? (EMOTIONS.includes(name) ? `[${name}]` : null));
    return tag ? ` ${tag} ` : " ";
  });
  if (!map) out = out.replace(NATIVE, " ");
  return tidy(out);
}
