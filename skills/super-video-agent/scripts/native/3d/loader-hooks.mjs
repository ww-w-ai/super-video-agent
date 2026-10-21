// module.register hooks for the native 3D path. Every `import "three"` (the reel,
// its scene modules, and three's own addons like GLTFLoader) must resolve to the
// SAME module instance, or objects built by one won't pass instanceof in the other.
// We point "three" at the WebGPU shim (which re-exports three/webgpu + a
// WebGLRenderer adapter), and "three/addons/*" at the real examples/jsm files.
//
// A virtual SCENE module is served through the `load` hook: the host registers
// a sentinel specifier "sva-scene:<id>" whose URL sits inside the reel dir (so
// the scene's relative imports — ./scenes/x.js, ./assets/models/y.js — resolve
// against the reel), and whose source is the scene block.
//
// Each page open registers its own layer with its own `openId`. The scene URL
// carries it as a `sva-open=<id>` query, and every file the scene graph imports (outside
// node_modules) gets it too, so a reopened page builds its own module graph
// instead of reusing the last page's module state. three and its addons stay
// shared. The newest layer answers first; a specifier it does not own passes on.

let CFG = null; // { shimUrl, threeWebgpuUrl, threeTslUrl, addonsBaseUrl, addonOverrides, sceneUrls, scenes, openId }

export async function initialize(data) {
  CFG = data;
}

export async function resolve(specifier, context, nextResolve) {
  if (!CFG) return nextResolve(specifier, context);
  if (specifier === "three") return { url: CFG.shimUrl, shortCircuit: true };
  if (specifier === "three/webgpu") return { url: CFG.threeWebgpuUrl, shortCircuit: true };
  if (specifier === "three/tsl") return { url: CFG.threeTslUrl, shortCircuit: true };
  if (specifier.startsWith("three/addons/")) {
    const suffix = specifier.slice("three/addons/".length);
    // Some WebGL-only addons (postprocessing, Reflector's GLSL ShaderMaterial,
    // RectAreaLight LTC lib) have no WebGPU drop-in; the host overrides them
    // with WebGPU-compatible shims/stubs. Everything else uses the real file.
    if (CFG.addonOverrides && CFG.addonOverrides[suffix]) return { url: CFG.addonOverrides[suffix], shortCircuit: true };
    return { url: CFG.addonsBaseUrl + suffix, shortCircuit: true };
  }
  if (CFG.sceneUrls[specifier]) return { url: CFG.sceneUrls[specifier], shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  if (fromThisOpen(context.parentURL) && resolved.url.startsWith("file:") && !resolved.url.includes("?") && !resolved.url.includes("/node_modules/")) {
    return { ...resolved, url: `${resolved.url}?sva-open=${CFG.openId}` };
  }
  return resolved;
}

function fromThisOpen(parentURL) {
  if (!parentURL) return false;
  try {
    return new URL(parentURL).searchParams.get("sva-open") === String(CFG.openId);
  } catch (e) {
    return false;
  }
}

export async function load(url, context, nextLoad) {
  if (CFG && CFG.scenes && CFG.scenes[url] != null) {
    return { format: "module", source: CFG.scenes[url], shortCircuit: true };
  }
  return nextLoad(url, context);
}
