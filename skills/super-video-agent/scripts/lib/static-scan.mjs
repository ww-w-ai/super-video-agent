// Static contract scan (design.md §2.1): scene code must not use
// nondeterministic or network APIs. Extracts the SCENE block from
// reel.html (the ENGINE block is exempt — it never uses these anyway,
// but the point of the contract is to police what scene authors write)
// and checks it against the banned-token list.
import fs from "node:fs";
import path from "node:path";

const BANNED = [
  { name: "Math.random", re: /Math\.random\s*\(/g, hardLimit: 0 },
  { name: "Date", re: /\bnew\s+Date\s*\(|Date\.now\s*\(/g, hardLimit: 0 },
  { name: "performance.now", re: /performance\.now\s*\(/g, hardLimit: 0 },
  { name: "requestAnimationFrame", re: /requestAnimationFrame\s*\(/g, hardLimit: 0 },
  { name: "setTimeout", re: /setTimeout\s*\(/g, hardLimit: 0 },
  { name: "setInterval", re: /setInterval\s*\(/g, hardLimit: 0 },
  // fetch() is banned in scene draw code, with exactly one exception: the
  // engine's own allowed loader used while building `ready` (design.md
  // §2.1) to load voice/timings.json. We allow at most one occurrence.
  { name: "fetch", re: /\bfetch\s*\(/g, hardLimit: 1 },
];

const SRC_SKIP = new Set(["node_modules", "out", ".git"]);

/**
 * Bundled libraries are not scene code (they use timers and fetch for their
 * own sake): src/vendor/, three* under src/lib/, *.min.js, node_modules.
 * @param {string} rel path under src/, "/"-separated
 * @param {string} name entry name
 */
function isBundledLibrary(rel, name) {
  return rel.startsWith("vendor/") || name === "vendor" || /\.min\.m?js$/i.test(name) || (/^lib\//.test(rel) && /^three/i.test(name));
}

/** Every .js/.mjs file under <reel-dir>/src as [path, text], plus the bundled entries it left out (relative to src/, a folder ends in "/"). */
function readSrcFiles(reelDir) {
  const out = [];
  const skipped = [];
  const root = path.join(reelDir, "src");
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SRC_SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join("/");
      const isScript = /\.m?js$/.test(e.name);
      if ((e.isDirectory() || isScript) && isBundledLibrary(rel, e.name)) skipped.push(e.isDirectory() ? `${rel}/` : rel);
      else if (e.isDirectory()) walk(p);
      else if (isScript) out.push([p, fs.readFileSync(p, "utf8")]);
    }
  };
  walk(root);
  return { files: out, skipped };
}

/**
 * Scans the SCENE block of reel.html and every script under <reel-dir>/src
 * (a reel that keeps its scenes in src/*.js is scene code too). Token counts
 * are summed over all of them against the same limits.
 * @param {string} reelHtmlPath
 * Bundled libraries (src/vendor/, src/lib/three*, *.min.js) are left out and listed.
 * @returns {{ok: boolean, violations: {name:string,count:number,limit:number}[], sceneFound: boolean, srcFiles: number, scannedChars: number, skippedLibraries: string[]}}
 *   scannedChars = scene-block characters + src characters; 0 means nothing was checked.
 */
export function scanReelHtml(reelHtmlPath) {
  const html = fs.readFileSync(reelHtmlPath, "utf8");
  const { scene, sceneFound } = extractScene(html);
  const { files: src, skipped } = readSrcFiles(path.dirname(reelHtmlPath));
  const code = [scene, ...src.map(([, text]) => text)].join("\n");
  const scannedChars = (sceneFound ? scene.replace(/\/\*\s*SCENE:(?:BEGIN|END)\s*\*\//g, "").trim().length : 0) + src.reduce((n, [, t]) => n + t.trim().length, 0);

  const violations = [];
  for (const rule of BANNED) {
    const matches = code.match(rule.re) || [];
    if (matches.length > rule.hardLimit) {
      violations.push({ name: rule.name, count: matches.length, limit: rule.hardLimit });
    }
  }

  // Also require exactly one <canvas> and no CSS transition/animation rules.
  const canvasCount = (html.match(/<canvas[\s>]/g) || []).length;
  if (canvasCount !== 1) {
    violations.push({ name: "canvas-count", count: canvasCount, limit: 1 });
  }
  const cssAnim = html.match(/(transition\s*:|animation\s*:)/gi) || [];
  if (cssAnim.length > 0) {
    violations.push({ name: "css-animation", count: cssAnim.length, limit: 0 });
  }

  return { ok: violations.length === 0, violations, sceneFound, srcFiles: src.length, scannedChars, skippedLibraries: skipped };
}

/** Isolates the SCENE:BEGIN..SCENE:END block from a reel.html string. */
function extractScene(html) {
  const start = html.indexOf("/* SCENE:BEGIN */");
  const end = html.indexOf("/* SCENE:END */");
  const sceneFound = start !== -1 && end !== -1 && end > start;
  return { scene: sceneFound ? html.slice(start, end) : html, sceneFound };
}

/**
 * Counts `boil(` call sites in the scene code and how many pass a `moving`
 * option (owner: shaking-while-moving reads as a glitch; boil should fade
 * out via Reel.moving() while an element travels — this is a fact report,
 * not a gate, since whether a given element *should* pass `moving` is a
 * craft judgment, not something a script can verify).
 * @param {string} reelHtmlPath
 * @returns {{sceneFound: boolean, callSites: number, withMoving: number}}
 */
export function boilCallSiteReport(reelHtmlPath) {
  const html = fs.readFileSync(reelHtmlPath, "utf8");
  const { scene, sceneFound } = extractScene(html);
  let callSites = 0;
  let withMoving = 0;
  const re = /\bboil\s*\(/g;
  let m;
  while ((m = re.exec(scene))) {
    const argsEnd = findMatchingParen(scene, re.lastIndex - 1);
    if (argsEnd === -1) continue;
    callSites++;
    const args = scene.slice(re.lastIndex, argsEnd);
    if (/\bmoving\s*:/.test(args)) withMoving++;
    re.lastIndex = argsEnd + 1;
  }
  return { sceneFound, callSites, withMoving };
}

/** Given the index of an opening `(`, returns the index of its matching `)`. */
function findMatchingParen(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === "(") depth++;
    else if (str[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}


/** Advisory fillText inventory. Dynamic expressions stay unresolved rather than claiming coverage. */
export function pictureTextReport(reelHtmlPath) {
  const html = fs.readFileSync(reelHtmlPath, "utf8");
  const { scene } = extractScene(html);
  const { files } = readSrcFiles(path.dirname(reelHtmlPath));
  const offset = html.slice(0, html.indexOf(scene)).split("\n").length - 1;
  return [[reelHtmlPath, scene, offset], ...files].flatMap(([file, code, lineOffset = 0]) =>
    pictureTextCalls(code).map(call => ({ file, ...call, line: call.line + lineOffset })));
}

/** Tokenize only enough to inventory call sites; comments and quoted code cannot create calls. */
function pictureTokens(code) {
  const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[\p{L}_$][\p{L}\p{N}_$]*|\d+(?:\.\d+)?|[^\s]/gu;
  const tokens = [];
  let line = 1;
  let end = 0;
  for (const match of code.matchAll(pattern)) {
    line += (code.slice(end, match.index).match(/\n/g) || []).length;
    const value = match[0];
    if (!value.startsWith("//") && !value.startsWith("/*")) tokens.push({ value, line });
    line += (value.match(/\n/g) || []).length;
    end = match.index + value.length;
  }
  return markArgumentBounds(tokens);
}

// Index each call boundary once so nested expressions do not cause repeated scans.
function markArgumentBounds(tokens) {
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (["(", "[", "{"].includes(value)) stack.push(i);
    else if ([")", "]", "}"].includes(value)) {
      const open = tokens[stack.pop()];
      if (open) { open.close = i; open.argEnd ??= i; }
    } else if (value === "," && stack.length) tokens[stack.at(-1)].argEnd ??= i;
  }
  return tokens;
}

/** Direct linguistic literals warn. Direct pictureText calls are registered; other expressions need review. */
export function pictureTextCalls(code) {
  const tokens = pictureTokens(code);
  const calls = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== "fillText" || tokens[i + 1]?.value !== "(") continue;
    const arg = tokens[i + 2]?.value || "";
    const end = tokens[i + 1].argEnd;
    if (arg === "Reel" && tokens[i + 3]?.value === "." && tokens[i + 4]?.value === "pictureText" && tokens[i + 5]?.value === "(" && tokens[i + 5].close === end - 1) continue;
    const quoted = /^["'`]/.test(arg);
    const dynamic = !quoted || end !== i + 3 || (arg.startsWith("`") && arg.includes("${"));
    if (!dynamic && !/\p{L}/u.test(arg)) continue;
    calls.push({ line: tokens[i].line, kind: dynamic ? "unresolved" : "unregistered", expression: arg });
  }
  return calls;
}
