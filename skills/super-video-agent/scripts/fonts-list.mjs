#!/usr/bin/env node
// Lists the font families installed on this machine, read from each font
// file's own name table, so the scene can pick a face that fits the film.
// Same code on macOS, Linux and Windows: no fontconfig, CoreText or DirectWrite.
import { parseArgs, printHelpAndExit } from "./lib/cli.mjs";
import { fontDirs, listFontFamilies } from "./lib/fonts.mjs";
import { isMain } from "./lib/is-main.mjs";

const HELP = `usage: fonts-list.mjs [--text "<sample line>"] [--family "<name>"] [--json]

Prints one line per installed font family: its name and any localized names
(e.g. a Korean name). Searches $SVA_FONT_DIR first, then the OS font folders
(references/pipeline.md "Fonts").
--text "<sample line>" keeps only faces that have every character of the line
  (pass a line in the film's language).
--family "<name>" prints that family's style and file path per face, to copy
  the chosen files into the reel's assets/fonts/.
--json prints the families with every style and file path as JSON.
`;

export function main(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help || flags.h) {
    printHelpAndExit(HELP);
    return;
  }
  const dirs = fontDirs();
  const list = listFontFamilies({ dirs, text: typeof flags.text === "string" ? flags.text : "" });
  if (flags.json) {
    process.stdout.write(JSON.stringify({ searched: dirs, ...list }, null, 2) + "\n");
    return;
  }
  if (typeof flags.family === "string") {
    process.stdout.write(formatFamilyFiles(list.families, flags.family));
    return;
  }
  process.stdout.write(formatFamilies(list, dirs));
}

/** One line per family: "Name (local names)". */
export function formatFamilies({ families, unreadable }, dirs) {
  const lines = families.map((f) => (f.localNames.length ? `${f.family} (${f.localNames.join(", ")})` : f.family));
  lines.push(`${families.length} families in ${dirs.join(", ")}${unreadable ? `; ${unreadable} files unreadable` : ""}`);
  return lines.join("\n") + "\n";
}

/** "style  path" lines for one family, matched case-insensitively on any of its names. */
export function formatFamilyFiles(families, name) {
  const want = name.toLowerCase();
  const f = families.find((x) => [x.family, ...x.localNames].some((n) => n.toLowerCase() === want));
  if (!f) return `no installed family named "${name}"\n`;
  return f.faces.map((x) => `${x.style}  ${x.file}`).join("\n") + "\n";
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
