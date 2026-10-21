// WebGPU-compatible stand-in for the WebGL Reflector addon. The real Reflector
// renders the scene from a mirrored virtual camera into a WebGLRenderTarget and
// samples it through a GLSL ShaderMaterial — neither the GLSL ShaderMaterial nor
// the per-frame onBeforeRender re-render ports to WebGPURenderer as-is.
//
// This stub renders the Reflector plane as a dark, low-roughness metallic surface
// (an environment/screen-space reflection would need a TSL re-author). The floor
// is present and plausibly shiny, but does NOT mirror the scene — a known
// fidelity gap vs the browser WebGL render, measured and reported.
import { Mesh, MeshStandardMaterial, Color } from "three";

export class Reflector extends Mesh {
  constructor(geometry, options = {}) {
    const color = options.color != null ? new Color(options.color) : new Color(0x111418);
    super(geometry, new MeshStandardMaterial({ color, metalness: 0.9, roughness: 0.25 }));
    this.isReflector = true;
    this.type = "Reflector";
  }
  getRenderTarget() { return null; }
  dispose() {}
}
