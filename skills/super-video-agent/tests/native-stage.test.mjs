// SVA_RENDERER=native: the host clears the stage before each seek (skia-canvas
// keeps every drawing command since the last full clear), the reel's opt-out,
// and the read-back row layout helpers of the 3D path.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openReel, captureRgbaFrame } from "../scripts/lib/browser.mjs";
import { serveDir } from "../scripts/lib/server.mjs";
import { tightRows, flipRows, paddedByteLength } from "../scripts/native/3d/readback.mjs";

process.env.SVA_RENDERER = "native";

const tmpRoots = [];
after(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

async function withReel(html, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-native-stage-"));
  tmpRoots.push(dir);
  fs.writeFileSync(path.join(dir, "reel.html"), html);
  const server = await serveDir(dir);
  try {
    return await fn(server.url);
  } finally {
    await server.close();
  }
}

// seek(t) paints one 8x8 square whose x follows t and never clears the stage.
const SQUARE = (keep) => `<!doctype html><html><body>
<canvas id="stage" width="64" height="16"></canvas>
<script>
(function () {
  var ctx = document.getElementById("stage").getContext("2d");
  window.__reel = { width: 64, height: 16, fps: 30, duration: 2, shots: [], layers: [], ready: Promise.resolve(),
    ${keep ? "nativeKeepStage: true," : ""}
    seek: function (t) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.translate(2, 0); ctx.fillStyle = "#fff"; ctx.fillRect(Math.round(t * 20), 4, 8, 8); } };
})();
</script></body></html>`;

const alphaAt = (rgba, x, y, w = 64) => rgba[(y * w + x) * 4 + 3];

test("native host clears the stage before each seek: a frame never keeps the last one's pixels", async () => {
  await withReel(SQUARE(false), async (url) => {
    const s = await openReel(url, { warm: false });
    try {
      await captureRgbaFrame(s.page, 1.5); // square at x 32..39
      const f = await captureRgbaFrame(s.page, 0); // square at x 2..9
      assert.equal(alphaAt(f, 4, 8), 255, "this seek's square is drawn");
      assert.equal(alphaAt(f, 35, 8), 0, "the previous seek's square is gone");
    } finally {
      await s.close();
    }
  });
});

test("native host: a reel with nativeKeepStage: true keeps drawing over the last frame", async () => {
  await withReel(SQUARE(true), async (url) => {
    const s = await openReel(url, { warm: false });
    try {
      await captureRgbaFrame(s.page, 1.5);
      const f = await captureRgbaFrame(s.page, 0);
      assert.equal(alphaAt(f, 35, 8), 255, "the page asked to keep the stage");
    } finally {
      await s.close();
    }
  });
});

// putImageData over the whole stage without clearRect: skia-canvas would keep
// every call (600x600x4 = 1.44 MB each, 100 seeks = 144 MB) without the host clear.
const PUT_ONLY = `<!doctype html><html><body>
<canvas id="stage" width="600" height="600"></canvas>
<script>
(function () {
  var ctx = document.getElementById("stage").getContext("2d");
  var img = ctx.createImageData(600, 600);
  window.__reel = { width: 600, height: 600, fps: 30, duration: 10, shots: [], layers: [], ready: Promise.resolve(),
    seek: function (t) { img.data[0] = Math.round(t * 30) % 256; img.data[3] = 255; ctx.putImageData(img, 0, 0); } };
})();
</script></body></html>`;

test("native host: a page that only putImageData's the stage stays at bounded memory over 100 seeks", async () => {
  await withReel(PUT_ONLY, async (url) => {
    const s = await openReel(url, { warm: false });
    try {
      for (let f = 0; f < 5; f++) await captureRgbaFrame(s.page, f / 30);
      const rss0 = process.memoryUsage().rss;
      for (let f = 5; f < 105; f++) await s.page.evaluate((t) => window.__reel.seek(t), f / 30);
      await captureRgbaFrame(s.page, 3);
      const growthMb = (process.memoryUsage().rss - rss0) / 1e6;
      assert.ok(growthMb < 80, `RSS grew ${growthMb.toFixed(0)} MB over 100 seeks (the stage history was kept)`);
    } finally {
      await s.close();
    }
  });
});

test("tightRows: a 256-byte-row read-back (last row unpadded) repacks to tight rows; tight input passes", () => {
  const w = 3, h = 3; // 12-byte rows, 256-byte stride
  assert.equal(paddedByteLength(w, h, 4), 2 * 256 + 12);
  const padded = new Uint8Array(paddedByteLength(w, h, 4));
  for (let y = 0; y < h; y++) for (let i = 0; i < 12; i++) padded[y * 256 + i] = y * 16 + i;
  const tight = tightRows(padded, w, h);
  assert.equal(tight.length, w * h * 4);
  assert.deepEqual([...tight.subarray(12, 24)], Array.from({ length: 12 }, (_, i) => 16 + i));
  assert.deepEqual([...tight.subarray(24, 36)], Array.from({ length: 12 }, (_, i) => 32 + i));
  const already = new Uint8Array(64 * 2 * 4);
  assert.equal(tightRows(already, 64, 2), already);
  const floats = new Float32Array(paddedByteLength(5, 2, 16) / 4);
  floats[64] = 7; // row 1 starts at byte 256 (element 64)
  const tf = tightRows(floats, 5, 2);
  assert.ok(tf instanceof Float32Array);
  assert.equal(tf.length, 5 * 2 * 4);
  assert.equal(tf[20], 7);
  assert.throws(() => tightRows(new Uint8Array(13), 3, 3), /fits no 3x3 texel layout/);
});

test("flipRows reverses the row order", () => {
  const px = Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual([...flipRows(px, 1, 2)], [2, 2, 2, 2, 1, 1, 1, 1]);
});
