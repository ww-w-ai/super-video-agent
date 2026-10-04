// Source review: reads the reel's own code for the two defects frames cannot show reliably, and
// reports file:line, the window or value, and why. Like the boil check it judges the source, not
// pixels. Patterns are heuristics for a reviewer to read; a hit is a candidate, not a verdict, and
// nothing here fails a reel.
//   visibilitySourceReview: show/hide windows that last under 2 frames, one-frame gaps or overlaps
//     between neighbouring windows, conditions on two clocks, boundaries rounded in the test, and
//     fade windows of 0 or 1 frame.
//   blinkSourceReview: blink intervals, durations, rates and keyframes in the code that are
//     faster or more frequent than a human blink.
import fs from "node:fs";
import path from "node:path";
import { analyzeBlinks, MIN_BLINK_SEC, MIN_INTERVAL_SEC } from "./blink.mjs";

const NUM = String.raw`-?\d*\.?\d+`;
const TIMEISH = /^(t|tt|ts|lt|now|time|sec|secs|local\w*|\w*(?:Time|Sec|T))$/;
const EPS = 1e-9;
const SKIP_DIRS = new Set(["node_modules", "out", ".git", "voice", "takes", "stage"]);

/** Reads reel.html's scene block, the scripts it loads, and src/**.js under the reel dir. */
export function gatherSources(dir, { maxFiles = 200 } = {}) {
  const files = new Map();
  const add = (p) => {
    const full = path.resolve(p);
    if (files.has(full) || files.size >= maxFiles || !fs.existsSync(full) || !fs.statSync(full).isFile()) return;
    files.set(full, fs.readFileSync(full, "utf8"));
  };
  const html = path.join(dir, "reel.html");
  add(html);
  const text = files.get(path.resolve(html)) || "";
  for (const m of text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    if (!/^[a-z]+:|^\/\//i.test(m[1])) add(path.join(dir, m[1].split("?")[0]));
  }
  const queue = [...files.keys()];
  while (queue.length) {
    const f = queue.pop();
    for (const m of files.get(f).matchAll(/(?:import|export)[^'"]*from\s*["'](\.[^"']+)["']|import\s*["'](\.[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(f), m[1] || m[2]);
      if (!files.has(target) && fs.existsSync(target)) { add(target); queue.push(target); }
    }
  }
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js)$/.test(e.name)) add(p);
    }
  };
  walk(path.join(dir, "src"));
  return [...files].map(([full, src]) => {
    const rel = path.relative(dir, full);
    const b = src.indexOf("/* SCENE:BEGIN */"), e = src.indexOf("/* SCENE:END */");
    if (rel === "reel.html" && b !== -1 && e > b) {
      const before = src.slice(0, b).split("\n").length - 1;
      return { file: rel, text: src.slice(b, e), lineOffset: before };
    }
    return { file: rel, text: src, lineOffset: 0 };
  });
}

/** Whole frames k (at `fps`) with a <= k/fps < b, or <= b when `inclusive`. */
export function framesIn(a, b, fps, inclusive = false) {
  const first = Math.ceil(a * fps - EPS);
  const last = inclusive ? Math.floor(b * fps + EPS) : Math.ceil(b * fps - EPS) - 1;
  return Math.max(0, last - first + 1);
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const lineText = (text, line) => (text.split("\n")[line - 1] || "").trim().slice(0, 140);

/** Time windows written as literals: {start, end, inclusive, line}. */
function literalWindows(text) {
  const out = [];
  const push = (index, a, b, inclusive, why) => out.push({ index, line: lineOf(text, index), start: Number(a), end: Number(b), inclusive, via: why });
  for (const m of text.matchAll(new RegExp(String.raw`([A-Za-z_$][\w$.]*)\s*(>=|>)\s*(${NUM})\s*&&\s*\1\s*(<=|<)\s*(${NUM})`, "g"))) {
    if (TIMEISH.test(m[1])) push(m.index, m[3], m[5], m[4] === "<=", "comparison");
  }
  for (const m of text.matchAll(new RegExp(String.raw`([A-Za-z_$][\w$.]*)\s*(<=|<)\s*(${NUM})\s*&&\s*\1\s*(>=|>)\s*(${NUM})`, "g"))) {
    if (TIMEISH.test(m[1])) push(m.index, m[5], m[3], m[2] === "<=", "comparison");
  }
  for (const m of text.matchAll(new RegExp(String.raw`(${NUM})\s*(<=|<)\s*([A-Za-z_$][\w$.]*)\s*&&\s*\3\s*(<=|<)\s*(${NUM})`, "g"))) {
    if (TIMEISH.test(m[3])) push(m.index, m[1], m[5], m[4] === "<=", "comparison");
  }
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:between|inRange|within|inWindow|isBetween)\s*\(\s*[\w$.]+\s*,\s*(${NUM})\s*,\s*(${NUM})\s*\)`, "g"))) {
    push(m.index, m[1], m[2], false, "between()");
  }
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:start|from|begin|in)\s*:\s*(${NUM})\s*,\s*(?:end|to|out|until|stop)\s*:\s*(${NUM})`, "g"))) {
    push(m.index, m[1], m[2], false, "start/end pair");
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * @param {{file:string, text:string, lineOffset:number}[]} sources
 * @param {number} fps
 * @returns {{file:string, line:number, kind:string, window:{start:number,end:number}|null, text:string, why:string}[]}
 */
export function visibilitySourceReview(sources, fps) {
  const found = [];
  const two = 2 / fps;
  for (const { file, text, lineOffset } of sources) {
    const add = (line, kind, window, why) => found.push({ file, line: line + lineOffset, kind, window, text: lineText(text, line), why });
    const wins = literalWindows(text);
    for (const w of wins) {
      if (w.end < w.start) continue;
      const n = framesIn(w.start, w.end, fps, w.inclusive);
      if (n < 2) {
        add(w.line, "short-window", { start: w.start, end: w.end },
          `${w.via} ${w.start}–${w.end} s shows for ${n} frame${n === 1 ? "" : "s"} at ${fps} fps; under ${FLICKER_FRAMES} frames reads as a flash or never shows`);
      }
    }
    for (let i = 1; i < wins.length; i++) {
      const prev = wins[i - 1], next = wins[i];
      if (next.line - prev.line > 8 || next.line === prev.line) continue;
      const gapFrames = framesIn(prev.end, next.start, fps, false);
      if (next.start > prev.end && gapFrames === 1) {
        add(next.line, "one-frame-gap", { start: prev.end, end: next.start },
          `windows at line ${prev.line + lineOffset} (to ${prev.end} s) and here (from ${next.start} s) leave exactly one frame in neither`);
      }
      const overFrames = framesIn(next.start, prev.end, fps, false);
      if (next.start < prev.end && overFrames === 1) {
        add(next.line, "one-frame-overlap", { start: next.start, end: prev.end },
          `windows at line ${prev.line + lineOffset} (to ${prev.end} s) and here (from ${next.start} s) both show for exactly one frame`);
      }
    }
    const lines = text.split("\n");
    const rounders = new Map();
    lines.forEach((ln, k) => {
      const line = k + 1;
      if (/^\s*(\/\/|\*)/.test(ln)) return;
      const compare = /[<>]=?/.test(ln.replace(/=>/g, ""));
      for (const m of ln.matchAll(new RegExp(String.raw`\(\s*[\w$.]+\s*-\s*[^()]*?\)\s*\/\s*(${NUM})(?![\w.*])`, "g"))) {
        const d = Number(m[1]);
        if (d >= 0 && d < two) {
          add(line, "short-fade", { start: 0, end: d },
            d === 0 ? "a fade divides by 0 s: it jumps (or becomes NaN)" : `a fade or ramp over ${d} s is ${Math.round(d * fps * 100) / 100} frame${d * fps === 1 ? "" : "s"} at ${fps} fps; under ${FLICKER_FRAMES} frames is a pop`);
        }
      }
      if (compare && /\b(base\w*|picture\w*|loadPictureClock)\b/i.test(ln) && /\b(dub\w*|layerClock|captionClock|captionTimings)\b/i.test(ln)) {
        add(line, "two-clocks", null, "one condition reads both the base (picture) clock and a dub clock; the two differ per language, so the element can show or hide a frame off");
      }
      if (compare && /\b(?:localT|tLocal|lt|shotT|tShot)\b/.test(ln) && /(?<![\w.])t(?![\w])/.test(ln.replace(/\blt\b/g, ""))) {
        add(line, "two-clocks", null, "one condition mixes shot-local time and global time; check both are on the same offset at shot edges");
      }
      const round = /Math\.(round|floor|ceil|trunc)\s*\(/.exec(ln);
      if (compare && round && /[A-Za-z_$][\w$.]*\s*[<>]=?|[<>]=?\s*[A-Za-z_$]/.test(ln) && /\b(t|tt|time|lt|localT)\b/.test(ln)) {
        add(line, "rounded-boundary", null, `the boundary is computed with Math.${round[1]} inside the visibility test; neighbours rounded differently leave a one-frame gap or overlap`);
        if (!rounders.has(round[1])) rounders.set(round[1], line);
      }
    });
    if (rounders.size > 1) {
      const [name, line] = [...rounders][0];
      add(line, "mixed-rounding", null, `visibility tests round boundaries with different functions (${[...rounders.keys()].map((n) => "Math." + n).join(", ")}); a boundary shared by two elements can land a frame apart`);
    }
  }
  return dedupe(found).sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

/** Matches the report's own wording: a window or fade under this many frames is flagged. */
const FLICKER_FRAMES = 2;

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => {
    const k = `${i.file}:${i.line}:${i.kind}:${i.why}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Text of the bracketed literal that opens at text[open] ("[" or "{"), or null. */
function balanced(text, open) {
  const pair = { "[": "]", "{": "}" }[text[open]];
  let depth = 0;
  for (let i = open; i < Math.min(text.length, open + 6000); i++) {
    if (text[i] === text[open]) depth++;
    else if (text[i] === pair && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

/** Keyframe tuples in an array literal: [t, v] pairs or {t|time|at, v|value|weight|closed} objects. */
function tuplesOf(body) {
  const tuples = [];
  for (const m of body.matchAll(new RegExp(String.raw`\[\s*(${NUM})\s*,\s*(${NUM})\s*\]`, "g"))) tuples.push({ i: m.index, t: Number(m[1]), v: Number(m[2]) });
  for (const m of body.matchAll(/\{[^{}]*\}/g)) {
    const t = new RegExp(String.raw`\b(?:t|time|at)\s*:\s*(${NUM})`).exec(m[0]);
    const v = new RegExp(String.raw`\b(?:v|value|weight|closed|amount|w)\s*:\s*(${NUM})`).exec(m[0]);
    if (t && v) tuples.push({ i: m.index, t: Number(t[1]), v: Number(v[1]) });
  }
  return tuples.sort((a, b) => a.i - b.i).map(({ t, v }) => ({ t, v }));
}

/**
 * @param {{file:string, text:string, lineOffset:number}[]} sources
 * @returns {{file:string, line:number, kind:string, text:string, why:string}[]}
 */
export function blinkSourceReview(sources) {
  const found = [];
  for (const { file, text, lineOffset } of sources) {
    const add = (line, kind, why) => found.push({ file, line: line + lineOffset, kind, text: lineText(text, line), why });
    const lines = text.split("\n");
    lines.forEach((ln, k) => {
      const line = k + 1;
      if (/^\s*(\/\/|\*)/.test(ln) || !/blink/i.test(ln)) return;
      const near = lines.slice(Math.max(0, k - 3), k + 4).join("\n");
      if (/Math\.random|setInterval|setTimeout/.test(near) && /Math\.random|setInterval|setTimeout/.test(ln)) {
        add(line, "random-blink", "a blink driven by a random draw or a timer is not a function of t, and can fire close to the last blink; read the blink times from a fixed list or a fixed period instead");
      }
      for (const m of ln.matchAll(new RegExp(String.raw`([A-Za-z_$][\w$.]*)\s*[:=]\s*(${NUM})(?![\w.])`, "g"))) {
        const name = m[1], value = Number(m[2]);
        if (!/blink/i.test(name) || value <= 0) continue;
        const isMs = /ms$/i.test(name) || /Ms\b/.test(name) || value >= 50;
        const sec = isMs ? value / 1000 : value;
        const unit = isMs ? `${value} ms` : `${value} s`;
        if (/perMin|bpm|perMinute/i.test(name)) {
          if (60 / value < MIN_INTERVAL_SEC) add(line, "close-blinks", `${name} = ${value} blinks a minute is one every ${(60 / value).toFixed(2)} s; people blink about every 2–10 s (under ${MIN_INTERVAL_SEC} s apart is frequent)`);
        } else if (/interval|every|period|gap|delay|wait|cycle|spacing/i.test(name)) {
          if (sec < MIN_INTERVAL_SEC) add(line, "close-blinks", `${name} = ${unit}: blinks start under ${MIN_INTERVAL_SEC} s apart; people blink about every 2–10 s`);
        } else if (/dur|time|len|speed|close|open|lid/i.test(name)) {
          const half = /close|open/i.test(name) && !/dur|total/i.test(name);
          const limit = half ? MIN_BLINK_SEC / 2 : MIN_BLINK_SEC;
          if (sec < limit) add(line, "fast-blink", `${name} = ${unit}: ${half ? "one half of a blink" : "a whole blink"} under ${Math.round(limit * 1000)} ms; a human blink is ~100–400 ms start to end`);
        }
      }
      const mod = new RegExp(String.raw`%\s*(${NUM})(?![\w.])`).exec(ln);
      if (mod) {
        const v = Number(mod[1]);
        const sec = v >= 50 ? v / 1000 : v;
        if (v > 1 && sec < MIN_INTERVAL_SEC) add(line, "close-blinks", `a blink repeats every ${sec} s (t % ${mod[1]}); people blink about every 2–10 s`);
      }
    });
    for (const m of text.matchAll(/blink\w*\s*[:=]\s*(?=[[{])/gi)) {
      const open = m.index + m[0].length;
      const body = balanced(text, open);
      if (!body) continue;
      const line = lineOf(text, m.index);
      const tuples = tuplesOf(body);
      if (tuples.length >= 3) {
        const r = analyzeBlinks(tuples);
        for (const f of r.flags) add(line, f.type, `keyframes at ${f.at} s: ${f.detail}`);
      } else if (/^\[\s*(?:-?\d*\.?\d+\s*,?\s*)+\]$/.test(body)) {
        const starts = body.match(/-?\d*\.?\d+/g).map(Number).sort((a, b) => a - b);
        starts.slice(1).forEach((t, i) => {
          if (t - starts[i] < MIN_INTERVAL_SEC) add(line, "close-blinks", `blink times ${starts[i]} s and ${t} s are ${(t - starts[i]).toFixed(2)} s apart; people blink about every 2–10 s`);
        });
      }
    }
  }
  return dedupe(found);
}

/** One line per finding: file:line, kind, why, and the code. */
export function formatSourceFindings(findings, title) {
  if (!findings.length) return `${title}: no candidates in the source\n`;
  return `${title}: ${findings.length} candidate${findings.length === 1 ? "" : "s"} in the source\n` +
    findings.map((f) => `  ${f.file}:${f.line} ${f.kind}: ${f.why}\n    ${f.text}\n`).join("");
}
