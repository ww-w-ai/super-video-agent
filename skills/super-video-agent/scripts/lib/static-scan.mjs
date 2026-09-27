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
  const start = html.indexOf("/* SCENE:BEGIN */");
  const end = html.indexOf("/* SCENE:END */");
  const sceneFound = start !== -1 && end !== -1 && end > start;
  const scene = sceneFound ? html.slice(start, end) : html;

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
