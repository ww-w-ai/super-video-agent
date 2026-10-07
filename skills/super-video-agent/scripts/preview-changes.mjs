#!/usr/bin/env node
// Preview an existing mixed encode without rendering the page or synthesizing speech.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, abs, fail } from "./lib/cli.mjs";
import { ffmpeg, probeDuration } from "./lib/ffmpeg.mjs";

/** Changed lines with adjacent speech boundaries as listening context. */
export function previewWindows(timings, ids) {
  const wanted = new Set(ids);
  if (!wanted.size) throw new Error("choose at least one changed line");
  const lines = timings.lines || [];
  const duration = timings.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("timings need a positive duration");
  const windows = [];
  let previousEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!Number.isFinite(line.start) || !Number.isFinite(line.end) || line.start < previousEnd || line.end < line.start || line.end > duration) {
      throw new Error(`invalid or overlapping timing for ${line.id}`);
    }
    previousEnd = line.end;
    if (!wanted.delete(line.id)) continue;
    const from = i ? lines[i - 1].end : 0;
    const to = i + 1 < lines.length ? lines[i + 1].start : duration;
    const last = windows.at(-1);
    if (last && from <= last.to) { last.to = to; last.ids.push(line.id); }
    else windows.push({ from, to, ids: [line.id] });
  }
  if (wanted.size) throw new Error(`unknown changed lines: ${[...wanted].join(", ")}`);
  return windows;
}

/** Exact preview span with required picture and existing mixed audio. */
export function previewArgs(media, window, output) {
  return ["-y", "-i", media, "-ss", String(window.from), "-t", String(window.to - window.from),
    "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-movflags", "+faststart", output];
}

/** Overwrite this command's previews only. Keep unrelated preview files. */
export async function previewChanges({ dir, media, timings, ids }, run = ffmpeg) {
  const windows = previewWindows(timings, ids);
  const out = path.join(dir, "out", "preview");
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  for (const [i, window] of windows.entries()) {
    const file = path.join(out, `change-${i + 1}.mp4`);
    await run(previewArgs(media, window, file));
    files.push({ ...window, file });
  }
  for (const name of fs.readdirSync(out)) {
    const match = /^change-(\d+)\.mp4$/.exec(name);
    if (match && Number(match[1]) > windows.length) fs.rmSync(path.join(out, name));
  }
  fs.writeFileSync(path.join(out, "changes.json"), JSON.stringify({ media, windows: files }, null, 2) + "\n");
  return files;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || !positional.length) {
    process.stdout.write("usage: preview-changes.mjs <absolute-reel-dir> --lines <id,id> --media <mixed.mp4> [--timings <json>]\n");
    return;
  }
  if (typeof flags.lines !== "string" || typeof flags.media !== "string") throw new Error("--lines and --media are required");
  const dir = abs(positional[0]);
  const media = abs(flags.media);
  const file = flags.timings ? abs(flags.timings) : path.join(dir, "voice", "timings.json");
  const timings = JSON.parse(fs.readFileSync(file, "utf8"));
  const duration = await probeDuration(media);
  if (Math.abs(duration - timings.duration) > 0.1) throw new Error("media and timings use different clocks; select matching placed timings");
  const files = await previewChanges({ dir, media, timings, ids: flags.lines.split(",").filter(Boolean) });
  for (const item of files) process.stdout.write(`${item.file}: ${item.from}-${item.to} s (${item.ids.join(", ")})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => fail(e.message));
