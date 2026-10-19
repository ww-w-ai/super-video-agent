// SVA_NATIVE_RASTER picks how the native renderer rasterizes: on the CPU (the
// default, runs on every host) or on the GPU (Metal on macOS, Vulkan on Linux),
// so a machine with a GPU can move drawing off busy CPU cores. This file imports
// nothing: lib/browser.mjs and native/reel-host.mjs both read it.

export const RASTERS = ["cpu", "gpu"];

/**
 * How the native renderer rasterizes: SVA_NATIVE_RASTER=cpu (default) | gpu.
 * @param {Record<string, string|undefined>} env
 * @returns {"cpu"|"gpu"}
 */
export function nativeRaster(env = process.env) {
  const mode = (env.SVA_NATIVE_RASTER || "cpu").trim().toLowerCase();
  if (!RASTERS.includes(mode)) throw new Error(`SVA_NATIVE_RASTER takes ${RASTERS.join(" | ")} (got "${env.SVA_NATIVE_RASTER}")`);
  return mode;
}
