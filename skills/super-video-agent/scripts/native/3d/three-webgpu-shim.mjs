// A "three" module for the native 3D path: re-exports three's WebGPU build and
// adds a `WebGLRenderer` that is actually a WebGPURenderer underneath, so an
// unmodified reel's `new THREE.WebGLRenderer(...)` runs on WebGPU/Dawn in Node.
//
// Three host-level fixes to three.webgpu live here, because every renderer a
// page makes (the adapter's or its own WebGPURenderer) needs them:
// - readRenderTargetPixelsAsync returns tight rows. three hands back the
//   copyTextureToBuffer layout (rows padded to 256 bytes but the last), which
//   shears an image whose row is not a multiple of 256 bytes.
// - The node frame follows the reel's clock. Node uniforms updated once per
//   frame (light colour, intensity, position) refresh only when
//   nodeFrame.frameId changes, and three advances it only in its
//   requestAnimationFrame loop, which never runs here. beginSeek(t) makes the
//   next render of every renderer a new frame at time t.
// - disposeRenderers() frees every renderer when the page closes.
//
// The adapter renders into its own target as the renderer's OUTPUT target, so
// tone mapping, the output colour space and 4x MSAA apply as on a canvas. Its
// read-back is async: readPixelsAsync() (the copy hook a 3D page awaits);
// getContext().readPixels copies the last finished read-back for pages that
// still read synchronously (the host rewrites those, see reel-host-3d.mjs).
//
// The device is created by the host and shared via globalThis.__svaGpuDevice.

import * as THREE from "three/webgpu";
import { tightRows, flipRows } from "./readback.mjs";

export * from "three/webgpu";

const live = new Set();
const clock = { stamp: 0, t: 0, dt: 0 };

const proto = THREE.WebGPURenderer.prototype;
const baseRender = proto.render;
const baseRead = proto.readRenderTargetPixelsAsync;

proto.render = function render(scene, camera) {
  live.add(this);
  syncNodeFrame(this);
  return baseRender.call(this, scene, camera);
};

proto.readRenderTargetPixelsAsync = async function readRenderTargetPixelsAsync(renderTarget, x, y, width, height, ...rest) {
  return tightRows(await baseRead.call(this, renderTarget, x, y, width, height, ...rest), width, height);
};

function syncNodeFrame(renderer) {
  if (!clock.stamp || renderer._svaSeekStamp === clock.stamp || !renderer._nodes) return;
  renderer._svaSeekStamp = clock.stamp;
  const frame = renderer._nodes.nodeFrame;
  frame.frameId++;
  frame.time = clock.t;
  frame.deltaTime = clock.dt;
}

/** The next render of every renderer starts a new node frame at time `t` (one frame is 1/fps). */
export function beginSeek(t, fps = 30) {
  clock.stamp++;
  clock.t = t;
  clock.dt = fps > 0 ? 1 / fps : 0;
}

/** Disposes every renderer that has rendered, and forgets them and the clock. */
export function disposeRenderers() {
  for (const r of live) {
    try {
      r.dispose();
    } catch (e) {
      /* a renderer whose device is already gone */
    }
  }
  live.clear();
  clock.stamp = 0;
}

function makeGpuCanvas(device, w, h) {
  return {
    width: w, height: h, style: {}, addEventListener() {}, removeEventListener() {},
    getContext(type) {
      if (type !== "webgpu") return null;
      let cfg = null, tex = null;
      return {
        configure(c) { cfg = c; tex = null; },
        unconfigure() { tex = null; },
        getCurrentTexture() {
          if (!tex) tex = device.createTexture({ size: [w, h, 1], format: (cfg && cfg.format) || "bgra8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
          return tex;
        },
      };
    },
  };
}

// WebGL2 enum values the reel's copyToStage reads off the "gl" context.
const GL = { RGBA: 0x1908, UNSIGNED_BYTE: 0x1401 };

// Delegate anything the adapter does not override to the real WebGPURenderer, so
// three internals (PMREMGenerator, nodes, etc.) that call renderer methods we did
// not anticipate still work. Our explicit methods/getters win over delegation.
const DELEGATE = {
  get(target, prop) {
    if (prop in target || typeof prop === "symbol") {
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    }
    const w = target._wgpu;
    if (w && prop in w) {
      const v = w[prop];
      return typeof v === "function" ? v.bind(w) : v;
    }
    return undefined;
  },
  set(target, prop, value) {
    if (prop in target) target[prop] = value;
    else if (target._wgpu) target._wgpu[prop] = value;
    else target[prop] = value;
    return true;
  },
  has(target, prop) { return prop in target || (target._wgpu && prop in target._wgpu); },
};

/**
 * Drop-in for THREE.WebGLRenderer, backed by WebGPURenderer. Renders into an
 * internal RenderTarget set as the renderer's output target; pixels are read
 * back asynchronously.
 */
export class WebGLRenderer {
  constructor(params = {}) {
    const device = globalThis.__svaGpuDevice;
    if (!device) throw new Error("WebGLRenderer(shim): host must set globalThis.__svaGpuDevice first");
    this._device = device;
    this._samples = params.antialias === false ? 0 : 4;
    this._wgpu = new THREE.WebGPURenderer({ device, canvas: makeGpuCanvas(device, 2, 2), antialias: this._samples > 0 });
    this._w = 1;
    this._h = 1;
    this._rt = null;
    this._lastPixels = null;
    this._initP = this._wgpu.init();
    this.shadowMap = { _enabled: false, _type: null, get enabled() { return this._enabled; }, set enabled(v) { this._enabled = v; }, get type() { return this._type; }, set type(v) { this._type = v; } };
    this.domElement = params.canvas || makeGpuCanvas(device, 1, 1);
    return new Proxy(this, DELEGATE);
  }
  async init() { await this._initP; }
  setPixelRatio() {}
  setSize(w, h) {
    this._w = w; this._h = h;
    this._wgpu.setSize(w, h, false);
    this._makeTarget(this._rtSamples || 0);
  }
  // The output pass writes sRGB-encoded bytes, so the target stores them as
  // plain rgba8unorm (an sRGB-format target would encode a second time).
  // With tone mapping or a non-linear output, three draws into its own 4x
  // multisampled frame buffer and the output pass resolves into this target,
  // so the target needs no samples (samples on it too cost a further ~17% of
  // the frame rate at 1080x1920, measured). On the direct path (no tone mapping, linear output) three draws
  // straight into it, so then it carries the samples and the depth buffer.
  _makeTarget(samples) {
    if (this._rt) this._rt.dispose();
    this._rtSamples = samples;
    this._rt = new THREE.RenderTarget(this._w, this._h, { colorSpace: THREE.NoColorSpace, depthBuffer: true, samples });
  }
  _targetSamples() {
    const direct = this._wgpu.toneMapping === THREE.NoToneMapping && this._wgpu.outputColorSpace === THREE.ColorManagement.workingColorSpace;
    return direct ? this._samples : 0;
  }
  getSize(target) { if (target) { target.x = this._w; target.y = this._h; return target; } return { x: this._w, y: this._h }; }
  getPixelRatio() { return 1; }
  set outputColorSpace(v) { this._wgpu.outputColorSpace = v; }
  get outputColorSpace() { return this._wgpu.outputColorSpace; }
  set toneMapping(v) { this._wgpu.toneMapping = v; }
  get toneMapping() { return this._wgpu.toneMapping; }
  set toneMappingExposure(v) { this._wgpu.toneMappingExposure = v; }
  get toneMappingExposure() { return this._wgpu.toneMappingExposure; }
  // Shadow enable syncs to the underlying renderer.
  _syncShadow() { this._wgpu.shadowMap.enabled = this.shadowMap.enabled; if (this.shadowMap.type != null) this._wgpu.shadowMap.type = this.shadowMap.type; }
  setClearColor(c, a) { this._wgpu.setClearColor(c, a === undefined ? 1 : a); }
  setClearAlpha(a) { this._wgpu.setClearAlpha(a); }
  // null = the output target (the adapter's own), as null is the canvas in a browser.
  setRenderTarget(rt) { this._userRT = rt || null; this._wgpu.setOutputRenderTarget(this._rt); this._wgpu.setRenderTarget(this._userRT); }
  getRenderTarget() { return this._userRT || null; }
  setViewport(...a) { this._wgpu.setViewport(...a); }
  setScissor(...a) { this._wgpu.setScissor(...a); }
  setScissorTest(v) { this._wgpu.setScissorTest(v); }
  clear(...a) { this._wgpu.clear(...a); }
  clearDepth() { this._wgpu.clearDepth && this._wgpu.clearDepth(); }
  compile(scene, cam) { return this._wgpu.compileAsync ? this._wgpu.compileAsync(scene, cam) : undefined; }
  setOpaqueSort(fn) { this._wgpu.setOpaqueSort && this._wgpu.setOpaqueSort(fn); }
  setTransparentSort(fn) { this._wgpu.setTransparentSort && this._wgpu.setTransparentSort(fn); }
  dispose() { live.delete(this._wgpu); this._wgpu.dispose(); }
  get capabilities() { return this._wgpu.capabilities || { isWebGL2: true }; }
  get info() { return this._wgpu.info; }
  // The reel calls render() synchronously then reads pixels. Draw to the output
  // target (unless the reel set its own), queue a read-back, and keep the
  // promise so readPixelsAsync can await it.
  render(scene, camera) {
    this._syncShadow();
    if (this._rt && this._rtSamples !== this._targetSamples()) this._makeTarget(this._targetSamples());
    this._wgpu.setOutputRenderTarget(this._rt);
    if (!this._userRT) this._wgpu.setRenderTarget(null);
    this._wgpu.render(scene, camera);
    if (!this._userRT) {
      this._readbackP = this._wgpu.readRenderTargetPixelsAsync(this._rt, 0, 0, this._w, this._h).then((px) => { this._lastPixels = px; return px; });
    }
  }
  /**
   * The copy hook: the last render's pixels as tight RGBA rows, top-down (as
   * putImageData wants them), or bottom-up with { bottomUp: true } (WebGL's
   * readPixels order). Copies into `dest` too when given. Null before any render.
   * @param {Uint8Array|Uint8ClampedArray} [dest]
   * @param {{bottomUp?: boolean}} [opts]
   */
  async readPixelsAsync(dest, { bottomUp = false } = {}) {
    await this._initP;
    if (this._readbackP) await this._readbackP;
    if (!this._lastPixels) return null;
    const px = bottomUp ? flipRows(this._lastPixels, this._w, this._h) : this._lastPixels;
    if (dest) dest.set(px.subarray(0, dest.length));
    return px;
  }
  getContext() {
    return {
      RGBA: GL.RGBA,
      UNSIGNED_BYTE: GL.UNSIGNED_BYTE,
      readPixels: (x, y, w, h, fmt, type, dest) => {
        if (!this._lastPixels) { if (!this._warned) { this._warned = true; console.warn("getContext().readPixels before an async read-back finished; await renderer.readPixelsAsync() instead"); } return; }
        dest.set(flipRows(this._lastPixels, this._w, this._h).subarray(0, dest.length));
      },
      getParameter: () => 0,
      getExtension: () => null,
    };
  }
}
