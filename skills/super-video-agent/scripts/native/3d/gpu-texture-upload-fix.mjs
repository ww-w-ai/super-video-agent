// Fix image-texture upload for headless WebGPU in Node. three.webgpu uploads a
// non-data texture via `device.queue.copyExternalImageToTexture({source})`, which
// Dawn only accepts for ImageBitmap/HTMLCanvasElement/OffscreenCanvas — NOT a
// skia-canvas Canvas/Image. three wraps that call in a try/catch that swallows the
// error (for bad video frames), so a skia-backed source uploads as a silent BLACK
// texture (skyline, character face, on-screen content all vanish).
//
// We wrap the queue method: when the source is a skia Canvas/Image, read its RGBA
// pixels and upload with `writeTexture` (the raw path, which works). Everything
// else passes through unchanged.
import skia from "skia-canvas";

function skiaPixels(image) {
  let cv;
  if (image instanceof skia.Canvas || typeof image.getContext === "function") {
    cv = image;
  } else {
    // skia Image (or anything drawable): rasterize to a canvas first
    cv = new skia.Canvas(image.width || image.naturalWidth, image.height || image.naturalHeight);
    cv.getContext("2d").drawImage(image, 0, 0);
  }
  const w = cv.width, h = cv.height;
  const data = cv.getContext("2d").getImageData(0, 0, w, h).data; // Uint8ClampedArray RGBA, top-down
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), w, h };
}

function isSkiaSource(image) {
  return !!image && (image instanceof skia.Canvas || image instanceof skia.Image || typeof image.getContext === "function");
}

/** Wrap device.queue.copyExternalImageToTexture to accept skia sources via writeTexture. */
export function patchCanvasTextureUpload(device) {
  const queue = device.queue;
  if (queue.__svaTexPatched) return;
  const orig = queue.copyExternalImageToTexture.bind(queue);
  queue.copyExternalImageToTexture = (src, dst, size) => {
    const image = src && src.source;
    if (!isSkiaSource(image)) return orig(src, dst, size);
    let { data, w, h } = skiaPixels(image);
    // copyExternalImageToTexture honors src.flipY; writeTexture does not — flip here.
    if (src.flipY) {
      const row = w * 4;
      const f = new Uint8Array(data.length);
      for (let y = 0; y < h; y++) f.set(data.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      data = f;
    }
    const ew = (size && size.width) || w;
    const eh = (size && size.height) || h;
    queue.writeTexture(
      { texture: dst.texture, mipLevel: dst.mipLevel || 0, origin: dst.origin || { x: 0, y: 0, z: 0 } },
      data,
      { offset: 0, bytesPerRow: w * 4, rowsPerImage: h },
      { width: ew, height: eh, depthOrArrayLayers: 1 }
    );
  };
  queue.__svaTexPatched = true;
}
