// WebGPU-compatible no-op for the WebGL RectAreaLight LTC uniforms lib.
// three.webgpu supports RectAreaLight without this LTC texture setup, so init()
// is a no-op. Lighting from RectAreaLights may differ slightly from WebGL LTC.
export const RectAreaLightUniformsLib = { init() {} };
