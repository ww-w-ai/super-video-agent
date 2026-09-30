// Static contract scan (design.md §2.1): scene code must not use
// nondeterministic or network APIs. Extracts the SCENE block from
// reel.html (the ENGINE block is exempt — it never uses these anyway,
// but the point of the contract is to police what scene authors write)
// and checks it against the banned-token list.
import fs from "node:fs";

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

/**
 * @param {string} reelHtmlPath
 * @returns {{ok: boolean, violations: {name:string,count:number,limit:number}[], sceneFound: boolean}}
 */
export function scanReelHtml(reelHtmlPath) {
  const html = fs.readFileSync(reelHtmlPath, "utf8");
  const { scene, sceneFound } = extractScene(html);

  const violations = [];
  for (const rule of BANNED) {
    const matches = scene.match(rule.re) || [];
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

  return { ok: violations.length === 0, violations, sceneFound };
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
