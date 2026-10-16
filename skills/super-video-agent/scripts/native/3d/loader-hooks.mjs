// module.register hooks for the native 3D path. Every `import "three"` (the reel,
// its scene modules, and three's own addons like GLTFLoader) must resolve to the
// SAME module instance, or objects built by one won't pass instanceof in the other.
// We point "three" at the WebGPU shim (which re-exports three/webgpu + a
// WebGLRenderer adapter), and "three/addons/*" at the real examples/jsm files.
//
// A virtual SCENE module is served through the `load` hook: the host registers
// a sentinel specifier "sva-scene:<id>" whose URL sits inside the reel dir (so
// the scene's relative imports — ./scenes/x.js, ./assets/models/y.js — resolve
// against the sample reel), and whose source is the patched SCENE block.

let CFG = null; // { shimUrl, threeWebgpuUrl, threeTslUrl, addonsBaseUrl, scenes: { "<url>": "<source>" } }

export async function initialize(data) {
  CFG = data;
}

export async function resolve(specifier, context, nextResolve) {
  if (!CFG) return nextResolve(specifier, context);
  if (specifier === "three") return { url: CFG.shimUrl, shortCircuit: true };
  if (specifier === "three/webgpu") return { url: CFG.threeWebgpuUrl, shortCircuit: true };
  if (specifier === "three/tsl") return { url: CFG.threeTslUrl, shortCircuit: true };
  if (specifier.startsWith("three/addons/")) {
    return { url: CFG.addonsBaseUrl + specifier.slice("three/addons/".length), shortCircuit: true };
  }
  if (specifier.startsWith("sva-scene:")) {
    return { url: CFG.sceneUrls[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (CFG && CFG.scenes && CFG.scenes[url] != null) {
    return { format: "module", source: CFG.scenes[url], shortCircuit: true };
  }
  return nextLoad(url, context);
}
