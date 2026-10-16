// A "three" module for the native 3D path: re-exports three's WebGPU build and
// adds a `WebGLRenderer` that is actually a WebGPURenderer underneath, so an
// unmodified reel's `new THREE.WebGLRenderer(...)` runs on WebGPU/Dawn in Node.
//
// The reel composites with `renderer.getContext().readPixels(...)` (synchronous
// WebGL). WebGPU readback is async, so the adapter exposes `__readPixelsAsync()`
// and the host patches the reel's copyToStage to await it; getContext().readPixels
// copies from the last async readback (and warns if used before one completes).
//
// The device is created by the host and shared via globalThis.__svaGpuDevice.

import * as THREE from "three/webgpu";

export * from "three/webgpu";

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

/**
 * Drop-in for THREE.WebGLRenderer, backed by WebGPURenderer. Renders to an
 * internal RenderTarget; pixels are read back asynchronously.
 */
export class WebGLRenderer {
  constructor(params = {}) {
    const device = globalThis.__svaGpuDevice;
    if (!device) throw new Error("WebGLRenderer(shim): host must set globalThis.__svaGpuDevice first");
    this._device = device;
    this._wgpu = new THREE.WebGPURenderer({ device, canvas: makeGpuCanvas(device, 2, 2), antialias: params.antialias !== false });
    this._w = 1;
    this._h = 1;
    this._rt = null;
    this._lastPixels = null;
    this._initP = this._wgpu.init();
    this.shadowMap = { _enabled: false, _type: null, get enabled() { return this._enabled; }, set enabled(v) { this._enabled = v; }, get type() { return this._type; }, set type(v) { this._type = v; } };
    this.domElement = params.canvas || makeGpuCanvas(device, 1, 1);
  }
  async init() { await this._initP; }
  setPixelRatio() {}
  setSize(w, h) {
    this._w = w; this._h = h;
    this._wgpu.setSize(w, h, false);
    if (this._rt) this._rt.dispose();
    // sRGB-encoded RT so the read-back bytes match the browser's sRGB canvas
    // (a linear RT reads back ~1/8 the value — dark). depthBuffer for shadows/3D.
    this._rt = new THREE.RenderTarget(w, h, { colorSpace: THREE.SRGBColorSpace, depthBuffer: true, samples: 0 });
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
  setRenderTarget(rt) { this._userRT = rt; this._wgpu.setRenderTarget(rt || this._rt); }
  getRenderTarget() { return this._userRT || null; }
  setViewport(...a) { this._wgpu.setViewport(...a); }
  setScissor(...a) { this._wgpu.setScissor(...a); }
  setScissorTest(v) { this._wgpu.setScissorTest(v); }
  clear(...a) { this._wgpu.clear(...a); }
  clearDepth() { this._wgpu.clearDepth && this._wgpu.clearDepth(); }
  compile(scene, cam) { return this._wgpu.compileAsync ? this._wgpu.compileAsync(scene, cam) : undefined; }
  setOpaqueSort(fn) { this._wgpu.setOpaqueSort && this._wgpu.setOpaqueSort(fn); }
  setTransparentSort(fn) { this._wgpu.setTransparentSort && this._wgpu.setTransparentSort(fn); }
  dispose() { this._wgpu.dispose(); }
  get capabilities() { return this._wgpu.capabilities || { isWebGL2: true }; }
  get info() { return this._wgpu.info; }
  // The reel calls render() synchronously then reads pixels. We render to the
  // internal RT (unless the reel set its own), queue a readback, and keep the
  // promise so __readPixelsAsync / copyToStage can await it.
  render(scene, camera) {
    this._syncShadow();
    if (!this._userRT) this._wgpu.setRenderTarget(this._rt);
    this._wgpu.render(scene, camera);
    if (!this._userRT) {
      this._readbackP = this._wgpu.readRenderTargetPixelsAsync(this._rt, 0, 0, this._w, this._h).then((px) => { this._lastPixels = px; return px; });
    }
  }
  async __readPixelsAsync(dest) {
    await this._initP;
    if (this._readbackP) await this._readbackP;
    if (this._lastPixels && dest) dest.set(this._lastPixels.subarray(0, dest.length));
    return this._lastPixels;
  }
  getContext() {
    return {
      RGBA: GL.RGBA,
      UNSIGNED_BYTE: GL.UNSIGNED_BYTE,
      readPixels: (x, y, w, h, fmt, type, dest) => {
        if (!this._lastPixels) { if (!this._warned) { this._warned = true; console.warn("getContext().readPixels before async readback; copyToStage must be patched to await __readPixelsAsync"); } return; }
        dest.set(this._lastPixels.subarray(0, dest.length));
      },
      getParameter: () => 0,
      getExtension: () => null,
    };
  }
}
