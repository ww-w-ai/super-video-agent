// Pixel read-back layout for the native 3D path.
//
// three.webgpu reads a render target with copyTextureToBuffer, whose rows must
// start on a 256-byte boundary. It returns that buffer as is: every row but the
// last is padded to the boundary. tightRows() repacks it to rows of exactly
// width × texel bytes, which is what putImageData and the encoder take.

const TEXEL_BYTES = [4, 8, 16, 2, 1];

/** Bytes in a read-back of `width` × `height` texels of `texel` bytes, rows padded to 256 bytes but the last. */
export function paddedByteLength(width, height, texel) {
  const row = width * texel;
  return (height - 1) * Math.ceil(row / 256) * 256 + row;
}

/**
 * `px` (a typed array from readRenderTargetPixelsAsync) with its rows de-padded,
 * as the same typed array type. Already-tight input is returned unchanged.
 * Throws when the length fits neither a tight nor a padded layout.
 * @template {ArrayBufferView} T
 * @param {T} px
 * @param {number} width
 * @param {number} height
 * @returns {T}
 */
export function tightRows(px, width, height) {
  const bytes = px.byteLength;
  for (const texel of TEXEL_BYTES) {
    if (bytes === width * height * texel) return px;
  }
  const texel = TEXEL_BYTES.find((b) => paddedByteLength(width, height, b) === bytes);
  if (!texel) throw new Error(`read-back of ${bytes} bytes fits no ${width}x${height} texel layout (tight or 256-byte rows)`);
  const row = width * texel;
  const stride = Math.ceil(row / 256) * 256;
  const src = new Uint8Array(px.buffer, px.byteOffset, bytes);
  const out = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) out.set(src.subarray(y * stride, y * stride + row), y * row);
  const Type = px.constructor;
  return new Type(out.buffer, 0, out.byteLength / Type.BYTES_PER_ELEMENT);
}

/** Tight rows in reverse order (top-down <-> bottom-up), as a new Uint8Array. */
export function flipRows(px, width, height) {
  const row = (px.byteLength / height) | 0;
  const src = new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
  const out = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) out.set(src.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return out;
}
