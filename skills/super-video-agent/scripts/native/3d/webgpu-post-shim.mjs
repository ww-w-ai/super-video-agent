// WebGPU-compatible stand-ins for the WebGL postprocessing addons the 3D reels
// use (EffectComposer / RenderPass / UnrealBloomPass / OutputPass). The real
// addons are WebGL-only; the reel's render loop drives them as:
//   composer = new EffectComposer(renderer); composer.addPass(renderPass);
//   composer.addPass(bloomPass); composer.addPass(outputPass);
//   render3D: renderPass.scene/camera = world; bloomPass.strength = ...; composer.render()
//
// Pass 1 (this file): pass-through — EffectComposer.render() renders the active
// RenderPass's scene/camera through the WebGPU renderer (no bloom). This gets the
// reel rendering end-to-end so SSIM can be measured; bloom is added next.

export class RenderPass {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;
    this.isRenderPass = true;
  }
  setSize() {}
  dispose() {}
}

export class UnrealBloomPass {
  constructor(resolution, strength = 0.5, radius = 0.5, threshold = 0.8) {
    this.resolution = resolution;
    this.strength = strength;
    this.radius = radius;
    this.threshold = threshold;
    this.enabled = true;
    this.isBloom = true;
    // the reel sets bloomPass.highPassUniforms.smoothWidth.value each frame
    this.highPassUniforms = { smoothWidth: { value: 0.3 } };
  }
  setSize() {}
  dispose() {}
}

export class OutputPass {
  constructor() {
    this.enabled = true;
    this.isOutput = true;
  }
  setSize() {}
  dispose() {}
}

export class EffectComposer {
  constructor(renderer) {
    this.renderer = renderer;
    this.passes = [];
  }
  addPass(p) {
    this.passes.push(p);
  }
  insertPass(p, i) {
    this.passes.splice(i, 0, p);
  }
  removePass(p) {
    const i = this.passes.indexOf(p);
    if (i >= 0) this.passes.splice(i, 1);
  }
  setSize(w, h) {
    this._w = w;
    this._h = h;
    for (const p of this.passes) p.setSize && p.setSize(w, h);
  }
  setPixelRatio() {}
  render() {
    // Pass-through: render the active scene pass through the (WebGPU) renderer.
    const rp = this.passes.find((p) => p.isRenderPass);
    if (rp) this.renderer.render(rp.scene, rp.camera);
  }
  dispose() {}
}
