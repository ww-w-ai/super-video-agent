// Pure text-comparison helpers for the voice step's speech-to-text
// round-trip check (references/voice.md "Did the voice say the line?"):
// normalize text for comparison, measure character error rate, compare a
// transcribed line against its intended `text`/`say`, and check whether a
// synthesized clip's tail (a TAIL voiceFlag candidate) actually finished
// the last syllable. No I/O, no network — fully unit-testable.

/**
 * Lowercase and strip whitespace/punctuation, keeping letters and digits of
 * any script (Korean included) so character error rate isn't inflated by
 * spacing/punctuation differences between the intended text and what the
 * STT model transcribed.
 * @param {string} s
 */
export function normalize(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Levenshtein (edit) distance between two strings, character by character. */
function levenshtein(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost));
    }
    prev = cur;
  }
  return prev[m];
}

/**
 * Character error rate: normalized edit distance between `a` (the intended
 * target) and `b` (what was heard), divided by the normalized target's
 * length (floored at 1 so an empty target never divides by zero).
 * @param {string} a target text
 * @param {string} b heard text
 * @returns {number}
 */
export function cer(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  return levenshtein(na, nb) / Math.max(1, na.length);
}

function tokenize(s) {
  return String(s ?? "")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Token-level diff between `target` and `heard`: aligns whitespace-split
 * tokens (normalized for comparison, original spelling reported) and
 * returns only the spans that differ, each as one {want, heard} entry
 * (consecutive differing tokens are joined into a single span).
 * @param {string} target
 * @param {string} heard
 * @returns {{want:string, heard:string}[]}
 */
function tokenDiffs(target, heard) {
  const a = tokenize(target);
  const b = tokenize(heard);
  const an = a.map(normalize);
  const bn = b.map(normalize);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (an[i - 1] === bn[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && an[i - 1] === bn[j - 1]) {
      ops.push({ type: "match" });
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.push({ type: "sub", want: a[i - 1], heard: b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ type: "del", want: a[i - 1] });
      i--;
    } else {
      ops.push({ type: "ins", heard: b[j - 1] });
      j--;
    }
  }
  ops.reverse();

  const diffs = [];
  let cur = null;
  for (const op of ops) {
    if (op.type === "match") {
      if (cur) {
        diffs.push(cur);
        cur = null;
      }
      continue;
    }
    if (!cur) cur = { want: [], heard: [] };
    if (op.want != null) cur.want.push(op.want);
    if (op.heard != null) cur.heard.push(op.heard);
  }
  if (cur) diffs.push(cur);

  return diffs.map((d) => ({ want: d.want.join(" "), heard: d.heard.join(" ") }));
}

/**
 * Compare a transcribed line against its intended `text` (caption) and, if
 * present, `say` (what was actually spoken — pronunciation-rewritten for
 * names/numbers/English terms per references/voice.md). Character error
 * rate is the MIN over both targets, since a correct reading of `say` can
 * legitimately transcribe differently from `text` (e.g. "UTM" read as
 * "유티엠" vs spelled "UTM" — either is a correct read, only `text` should
 * be penalized, `say` should not).
 * @param {{text:string, say?:string, heard:string}} args
 * @returns {{cer:number, against:"text"|"say", diffs:{want:string,heard:string}[]}}
 */
export function compareLine({ text, say, heard }) {
  const candidates = [{ key: "text", value: text }];
  if (say != null) candidates.push({ key: "say", value: say });

  let best = null;
  for (const c of candidates) {
    const c_er = cer(c.value, heard);
    if (!best || c_er < best.cer) {
      best = { against: c.key, cer: c_er, target: c.value };
    }
  }

  const diffs = tokenDiffs(best.target, heard);
  return { cer: best.cer, against: best.against, diffs };
}

// STT has its own error, so only a gross mismatch is flagged: most of the
// line wrong, or a take clearly shorter (dropped words, cut off) or longer
// (babble, words that were never in the script) than the line.
const GROSS_CER = 0.5;
const MIN_LENGTH_RATIO = 0.7;
const MAX_LENGTH_RATIO = 1.4;

/**
 * Whether a take is wrong beyond STT's own noise. Near-homophones, names and
 * spacing differences never trip it.
 * @param {string} target the line as it should be heard (`say ?? text`)
 * @param {string} heard the STT transcript
 * @param {number} lineCer the error rate from compareLine
 */
export function isGrossMismatch(target, heard, lineCer) {
  if (lineCer > GROSS_CER) return true;
  const nt = normalize(target).length;
  if (nt === 0) return false;
  const ratio = normalize(heard).length / nt;
  return ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO;
}

/**
 * Whether `heard` ends with the same final two normalized characters as
 * `target` — a cheap proxy for "the last syllable was not cut off",
 * complementing the qwen3 provider's own tail-RMS gate (voiceFlag TAIL).
 * @param {string} target
 * @param {string} heard
 */
export function tailCleared(target, heard) {
  const nt = normalize(target);
  const nh = normalize(heard);
  if (nt.length === 0) return true;
  const tail = nt.slice(-2);
  return nh.endsWith(tail);
}
