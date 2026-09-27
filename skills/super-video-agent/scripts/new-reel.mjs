#!/usr/bin/env node
// Scaffold a reel folder: template reel.html with the engine inlined,
// fonts copied, a generated placeholder image, and a starter plan.json
// (design.md §2, §2.3).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, ensureDir, writeJson } from "./lib/reeldir.mjs";
import { findPretendard, findHandwritingFont } from "./lib/fonts.mjs";
import { ffmpeg } from "./lib/ffmpeg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, "..");

const HELP = `usage: new-reel.mjs <dir> [--ratio 9:16|1:1|16:9|4:5] [--title "..."] [--fps 30]

Scaffolds <dir>/ with:
  reel.html          template scene + engine inlined
  plan.json          starter 3-line plan
  assets/fonts/       Pretendard (+ handwriting font if installed)
  assets/images/      generated placeholder.png
  source/ voice/ out/  empty working directories
`;

const RATIOS = {
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "16:9": [1920, 1080],
  "4:5": [1080, 1350],
};

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const dir = abs(positional[0]);
  const ratio = flags.ratio || "9:16";
  if (!RATIOS[ratio]) {
    fail(`unknown --ratio "${ratio}", expected one of: ${Object.keys(RATIOS).join(", ")}`);
    return;
  }
  const [width, height] = RATIOS[ratio];
  const fps = flags.fps ? parseInt(flags.fps, 10) : 30;
  const title = flags.title || path.basename(dir);

  try {
    await scaffold({ dir, width, height, fps, title, ratio });
  } catch (e) {
    fail(e.message);
    return;
  }
  process.stdout.write(`scaffolded ${dir}\n`);
}

export async function scaffold({ dir, width, height, fps, title, ratio }) {
  const paths = reelPaths(dir);
  ensureDir(paths.root);
  ensureDir(path.join(paths.root, "source"));
  ensureDir(paths.voiceDir);
  ensureDir(paths.outDir);
  ensureDir(paths.assetsDir);
  const fontsDir = path.join(paths.assetsDir, "fonts");
  const imagesDir = path.join(paths.assetsDir, "images");
  ensureDir(fontsDir);
  ensureDir(imagesDir);

  // ---- fonts ---------------------------------------------------------
  const { regular, bold } = findPretendard();
  const fontStatus = { pretendard: false, handwriting: null };
  if (regular) {
    fs.copyFileSync(regular, path.join(fontsDir, "Pretendard-Regular.otf"));
    fontStatus.pretendard = true;
  }
  if (bold) {
    fs.copyFileSync(bold, path.join(fontsDir, "Pretendard-Bold.otf"));
    fontStatus.pretendard = fontStatus.pretendard && true;
  }
  if (!regular || !bold) {
    fontStatus.pretendard = false;
  }

  const handwriting = findHandwritingFont();
  let handwritingFontFace = "";
  let hasHandwriting = false;
  if (handwriting) {
    const ext = path.extname(handwriting);
    const destName = "handwriting" + ext;
    fs.copyFileSync(handwriting, path.join(fontsDir, destName));
    handwritingFontFace = `  @font-face {\n    font-family: 'Handwriting';\n    src: url('assets/fonts/${destName}');\n  }`;
    hasHandwriting = true;
    fontStatus.handwriting = handwriting;
  } else {
    fontStatus.handwriting = null;
  }

  // ---- placeholder image ---------------------------------------------
  const placeholderPath = path.join(imagesDir, "placeholder.png");
  await ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0xE7E1D2:s=${Math.round(width * 0.8)}x${Math.round(width * 0.8 * 1.2)}`,
    "-frames:v",
    "1",
    placeholderPath,
  ]);

  // ---- reel.html -------------------------------------------------------
  const templatePath = path.join(REPO_ROOT, "assets", "template", "reel.html");
  const engineSrc = fs.readFileSync(
    path.join(REPO_ROOT, "scripts", "engine", "reel-engine.js"),
    "utf8"
  );
  const audioSrc = fs.readFileSync(
    path.join(REPO_ROOT, "scripts", "engine", "reel-audio.js"),
    "utf8"
  );
  let html = fs.readFileSync(templatePath, "utf8");
  html = html
    .replaceAll("{{TITLE}}", escapeHtml(title))
    .replaceAll("{{WIDTH}}", String(width))
    .replaceAll("{{HEIGHT}}", String(height))
    .replaceAll("{{FPS}}", String(fps))
    .replaceAll("{{HAS_HANDWRITING}}", String(hasHandwriting))
    .replace("{{HANDWRITING_FONT_FACE}}", handwritingFontFace)
    .replace("{{ENGINE_SOURCE}}", () => engineSrc)
    .replace("{{AUDIO_SOURCE}}", () => audioSrc);
  fs.writeFileSync(paths.reelHtml, html, "utf8");

  // ---- plan.json -------------------------------------------------------
  if (!fs.existsSync(paths.planJson)) {
    writeJson(paths.planJson, {
      meta: {
        title,
        lang: "ko-KR",
        ratio,
        fps,
        voice: { provider: "say" },
        gapMs: 250,
      },
      style: {
        palette: ["#f2efe6", "#111111", "#e0563e", "#fff3a0"],
        fonts: { body: "Pretendard", annotation: hasHandwriting ? "Handwriting" : "Pretendard" },
        boilHz: 8,
      },
      lines: [
        { id: "l1", text: "코드가 프레임을 그립니다.", say: "코드가 프레임을 그립니다", visual: "opening title" },
        { id: "l2", text: "seek는 순수 함수입니다.", visual: "supporting image" },
        { id: "l3", text: "결정론적으로, 끝까지.", visual: "closing caption" },
      ],
    });
  }

  return { fontStatus };
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
