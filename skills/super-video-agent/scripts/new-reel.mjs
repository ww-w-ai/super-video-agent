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

const HELP = `usage: new-reel.mjs <dir> [--ratio 9:16|1:1|16:9|4:5] [--title "..."] [--fps 30] [--3d | --testbed]
       new-reel.mjs <dir> --vendor

Scaffolds <dir>/ with:
  reel.html          template scene + engine inlined
  plan.json          starter 3-line plan
  assets/fonts/       Pretendard (+ handwriting font if installed)
  assets/images/      generated placeholder.png
  source/ voice/ out/  empty working directories

--3d scaffolds from the WebGL/three.js template instead (references/3d.md):
  reel.html           <script type="module"> scene with a live import map
                       ("three", "three/addons/"), a detached WebGL canvas
                       copied into the 2D stage, one lit sample object
  assets/vendor/       three.module.js, three.core.js and addons/ (the whole
                       examples/jsm tree), copied from an installed three
                       package when one is found; otherwise empty and the
                       install steps are printed
  plan.json meta.look  "3d"

three.js is never bundled. A package is looked for in this order:
  $SVA_THREE_DIR, <dir>/node_modules/three, <skill>/node_modules/three

--vendor copies three.js and its addons into an existing reel's
  assets/vendor/ and touches nothing else (run it after npm install three).

--testbed scaffolds a GLB testbed instead (references/3d.md): a standalone
  window.__reel page (no engine, no plan.json) that loads every GLB listed in
  assets/models/models.json and shows one view per second — lineup front,
  lineup 3/4, then per model a turntable (0/90/180/270°) and one view per
  face_* node. Helpers in the page: actor, setFace (face toggle), hold,
  holdLevel, gradientSky, fitCamera. Render it with still.mjs --at 0,1,...
  reel.html             the testbed page
  assets/models/        put .glb files here; models.json lists them
  assets/vendor/        empty — install three.js and its addons (printed)
  Re-running --testbed on the folder keeps an existing reel.html and
  rewrites models.json from the .glb files present.
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
  const threeD = !!flags["3d"];

  if (flags.vendor) {
    const vendor = installThreeVendor(dir);
    if (!vendor) {
      fail(`no three package found.${threeInstallSteps(dir)}`);
      return;
    }
    process.stdout.write(vendorReport(vendor));
    return;
  }

  if (flags.testbed) {
    try {
      const result = scaffoldTestbed({ dir, width, height, fps, title });
      process.stdout.write(
        `${result.keptHtml ? "kept existing" : "wrote"} ${path.join(dir, "reel.html")}\n` +
          `models.json lists ${result.models.length} GLB file(s)${result.models.length ? ": " + result.models.join(", ") : ""}\n`
      );
      const vendor = installThreeVendor(dir);
      process.stdout.write(vendor ? vendorReport(vendor) : testbedInstallSteps(dir));
    } catch (e) {
      fail(e.message);
    }
    return;
  }

  let result;
  try {
    result = await scaffold({ dir, width, height, fps, title, ratio, threeD });
  } catch (e) {
    fail(e.message);
    return;
  }
  process.stdout.write(`scaffolded ${dir}\n`);
  if (threeD) {
    process.stdout.write(result.vendor ? vendorReport(result.vendor) : threeInstallSteps(dir));
  }
}

// Quotes a path for a copy-paste shell line only when it needs it.
function q(p) {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `"${p.replaceAll('"', '\\"')}"`;
}

/** The first installed three package: $SVA_THREE_DIR, <dir>/node_modules/three, <skill>/node_modules/three. */
export function findThree(dir, env = process.env) {
  const candidates = [
    env.SVA_THREE_DIR,
    path.join(dir, "node_modules", "three"),
    path.join(REPO_ROOT, "node_modules", "three"),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(path.join(c, "build", "three.module.js"))) || null;
}

/**
 * Copies three.module.js, three.core.js (three r170+) and the whole
 * examples/jsm tree (as addons/, keeping loaders/ and utils/ side by side for
 * their relative imports) into <dir>/assets/vendor/.
 * @returns {{from: string, version: string|null}|null} null when no three package is found
 */
export function installThreeVendor(dir, env = process.env) {
  const three = findThree(dir, env);
  if (!three) return null;
  const vendor = path.join(dir, "assets", "vendor");
  ensureDir(vendor);
  for (const f of ["three.module.js", "three.core.js"]) {
    const src = path.join(three, "build", f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(vendor, f));
  }
  const jsm = path.join(three, "examples", "jsm");
  if (fs.existsSync(jsm)) fs.cpSync(jsm, path.join(vendor, "addons"), { recursive: true });
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(three, "package.json"), "utf8")).version || null;
  } catch {
    version = null;
  }
  return { from: three, version };
}

function vendorReport(vendor) {
  return `copied three.js ${vendor.version || "(version unknown)"} and its addons from ${vendor.from} into assets/vendor/
Record this version and its MIT license in FILM.md (references/3d.md).
`;
}

export function threeInstallSteps(dir) {
  return `
three.js is not bundled with this skill and no installed three package was
found. Install it, then copy it and its addons into this reel:
  npm install three --prefix ${q(dir)}
  node ${q(path.join(here, "new-reel.mjs"))} ${q(dir)} --vendor
reel.html's import map already points "three" and "three/addons/" at
assets/vendor/; until the files are there its ready promise rejects naming
these steps. Record the installed version and its MIT license in FILM.md
(references/3d.md).
`;
}

/**
 * Scaffolds a GLB testbed folder (see HELP --testbed). Keeps an existing
 * reel.html; always rewrites assets/models/models.json from *.glb present.
 * @returns {{keptHtml: boolean, models: string[]}}
 */
export function scaffoldTestbed({ dir, width, height, fps, title }) {
  const paths = reelPaths(dir);
  const modelsDir = path.join(paths.assetsDir, "models");
  ensureDir(modelsDir);
  ensureDir(path.join(paths.assetsDir, "vendor"));
  ensureDir(paths.outDir);
  const keptHtml = fs.existsSync(paths.reelHtml);
  if (!keptHtml) {
    const html = fs
      .readFileSync(path.join(REPO_ROOT, "assets", "template", "reel-testbed.html"), "utf8")
      .replaceAll("{{TITLE}}", escapeHtml(title))
      .replaceAll("{{WIDTH}}", String(width))
      .replaceAll("{{HEIGHT}}", String(height))
      .replaceAll("{{FPS}}", String(fps));
    fs.writeFileSync(paths.reelHtml, html, "utf8");
  }
  // Recursive: `assets.mjs model` puts each model in assets/models/<id>/.
  const models = fs
    .readdirSync(modelsDir, { recursive: true })
    .map((f) => String(f).split(path.sep).join("/"))
    .filter((f) => f.toLowerCase().endsWith(".glb"))
    .sort();
  writeJson(path.join(modelsDir, "models.json"), { files: models });
  return { keptHtml, models };
}

/** Install steps for three.js plus the addons the testbed imports (GLTFLoader, SkeletonUtils). */
export function testbedInstallSteps(dir) {
  const vendor = path.join(dir, "assets", "vendor");
  const three = path.join(dir, "node_modules", "three");
  return `
three.js is not bundled with this skill. Install it and its addons into this
folder before opening reel.html:
  npm install three --prefix ${q(dir)}
  node ${q(path.join(here, "new-reel.mjs"))} ${q(dir)} --vendor
or copy by hand:
  cp ${q(path.join(three, "build", "three.module.js"))} ${q(vendor)}/
  cp ${q(path.join(three, "build", "three.core.js"))} ${q(vendor)}/
  cp -R ${q(path.join(three, "examples", "jsm"))} ${q(path.join(vendor, "addons"))}
Put .glb files in ${q(path.join(dir, "assets", "models"))}/ and re-run
  new-reel.mjs ${q(dir)} --testbed
to list them in models.json, then render views with
  still.mjs ${q(dir)} --at 0,1
Record the installed three.js version and its MIT license in FILM.md (references/3d.md).
`;
}

export async function scaffold({ dir, width, height, fps, title, ratio, threeD }) {
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

  // ---- 3D: three.js + addons into assets/vendor/ when installed ------
  let vendor = null;
  if (threeD) {
    ensureDir(path.join(paths.assetsDir, "vendor"));
    vendor = installThreeVendor(dir);
  }

  // ---- reel.html -------------------------------------------------------
  const templateName = threeD ? "reel-3d.html" : "reel.html";
  const templatePath = path.join(REPO_ROOT, "assets", "template", templateName);
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
        gapMs: 700,
        ...(threeD ? { look: "3d" } : {}),
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

  return { fontStatus, vendor };
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
