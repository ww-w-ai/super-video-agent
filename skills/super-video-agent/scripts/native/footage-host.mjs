// The footage frame source of a native 2D reel realm (SVA_RENDERER=native). The page asks
// `Reel.footageFrame(id, t)`; the engine forwards to globalThis.__svaFootage.frame, which this
// host implements: it finds the span in window.__reel.footage, maps film time to a source frame
// (scripts/lib/footage.mjs), and hands back a canvas holding that frame's pixels.
//
// One ffmpeg decoder per span streams raw RGBA into this process. A render reads each span's
// frames in order, so every frame is decoded once; a repeat (freeze, slow motion, a probe at the
// same time) comes from a small cache; a jump backwards or far ahead restarts the same fixed
// command from that frame, which gives the same pixels (lib/footage.mjs decoderArgs).
import { spawn } from "node:child_process";
import path from "node:path";
import { checkFootageSpans, spanFrameAt, sourceIndexAt, lastSourceIndex, sourceSecOf, decoderArgs, probeFootageSource, decodeSize } from "../lib/footage.mjs";

const CACHED_FRAMES = 4;
const READ_AHEAD_SEC = 3;

/**
 * @param {{reelDir:string, stage:{width:number, height:number}, makeCanvas:(w:number, h:number) => object,
 *   ImageData:Function, readReel:() => object, probe?:Function}} opts
 *   makeCanvas: a canvas of the realm's own class, so footage rasterizes like the rest of the page.
 *   readReel: the page's window.__reel (its fps and footage).
 * @returns {{frame:(id:string, t:number) => Promise<object>, dispose:() => void, stats:() => object}}
 */
export function createFootageHost({ reelDir, stage, makeCanvas, ImageData, readReel, probe = probeFootageSource }) {
  const sources = new Map();
  const decoders = new Map();
  const counts = { decoded: 0, starts: 0, cached: 0 };

  const sourceOf = (abs) => {
    if (!sources.has(abs)) sources.set(abs, probe(abs));
    return sources.get(abs);
  };

  async function frame(id, t) {
    const reel = readReel();
    const span = checkFootageSpans(reel && reel.footage !== undefined ? reel.footage : []).find((s) => s.id === id);
    if (!span) throw new Error(`footage "${id}" is not in window.__reel.footage`);
    const fps = reel.fps;
    const src = path.resolve(reelDir, span.src);
    const source = await sourceOf(src);
    const { width, height } = decodeSize(source, stage, span.size);
    const n = spanFrameAt(span, t, fps);
    const index = sourceIndexAt(span, n);
    const key = JSON.stringify([src, span.in, fps, width, height, span.filter || null]);
    if (!decoders.has(key)) decoders.set(key, createDecoder({ src, span, fps, width, height, counts }));
    const d = decoders.get(key);
    d.last = Math.max(d.last, lastSourceIndex(span));
    const canvas = await d.read(index, () => ranOut(span, index, n, source, fps));
    return { image: canvas, width, height, index, frame: n, sourceSec: sourceSecOf(span, index, fps) };
  }

  // Raw RGBA of one frame, as a canvas of the realm's class (the page draws it with drawImage).
  function toCanvas(buf, width, height) {
    const c = makeCanvas(width, height);
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), width, height), 0, 0);
    return c;
  }

  function createDecoder({ src, span, fps, width, height, counts: c }) {
    const bytes = width * height * 4;
    const cache = new Map();
    let live = null;
    let queue = Promise.resolve();
    const state = { last: lastSourceIndex(span), read, close };

    function start(from) {
      close();
      const count = Math.max(1, state.last - from + 1);
      const args = decoderArgs({ src, inSec: span.in, fps, width, height, filter: span.filter, from, count });
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("error", () => {});
      live = { proc, reader: frameReader(proc.stdout, bytes), next: from, until: from + count - 1, stderr: () => stderr };
      c.starts++;
    }

    async function decode(index, onEnd) {
      if (!live || index < live.next || index - live.next > READ_AHEAD_SEC * fps || index > live.until) start(index);
      let buf = null;
      while (live.next <= index) {
        buf = await live.reader.next();
        if (!buf) {
          const why = live.stderr().trim();
          throw new Error(`${onEnd()}${why ? ` (ffmpeg: ${why.split("\n").pop()})` : ""}`);
        }
        live.next++;
        c.decoded++;
      }
      return toCanvas(buf, width, height);
    }

    // One read at a time per decoder: two awaits on the same span would otherwise interleave its stream.
    function read(index, onEnd) {
      const run = queue.then(async () => {
        if (cache.has(index)) {
          const hit = cache.get(index);
          cache.delete(index);
          cache.set(index, hit);
          c.cached++;
          return hit;
        }
        const canvas = await decode(index, onEnd);
        cache.set(index, canvas);
        while (cache.size > CACHED_FRAMES) cache.delete(cache.keys().next().value);
        return canvas;
      });
      queue = run.catch(() => {});
      return run;
    }

    function close() {
      if (live) {
        live.proc.stdout.destroy();
        live.proc.kill("SIGKILL");
      }
      live = null;
    }
    return state;
  }

  return {
    frame,
    stats: () => ({ ...counts }),
    dispose() {
      for (const d of decoders.values()) d.close();
      decoders.clear();
      sources.clear();
    },
  };
}

function ranOut(span, index, n, source, fps) {
  const ends = source.duration != null ? `; the source ends at ${source.duration.toFixed(2)} s` : "";
  return `footage "${span.id}": ${span.src} has no frame ${index} after ${span.in} s (span frame ${n}, source ${sourceSecOf(span, index, fps).toFixed(3)} s)${ends}. Shorten the span or move "in"`;
}

/** Exactly `bytes` per call from a readable stream; null once it ends short. */
export function frameReader(stream, bytes) {
  const chunks = [];
  let have = 0;
  let ended = false;
  let wake = null;
  const poke = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  stream.on("data", (c) => {
    chunks.push(c);
    have += c.length;
    poke();
  });
  stream.on("end", () => {
    ended = true;
    poke();
  });
  stream.on("close", () => {
    ended = true;
    poke();
  });
  stream.on("error", () => {
    ended = true;
    poke();
  });
  return {
    async next() {
      while (have < bytes && !ended) await new Promise((r) => (wake = r));
      if (have < bytes) return null;
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      const out = Buffer.from(all.subarray(0, bytes));
      const rest = all.subarray(bytes);
      chunks.length = 0;
      if (rest.length) chunks.push(rest);
      have = rest.length;
      return out;
    },
  };
}
