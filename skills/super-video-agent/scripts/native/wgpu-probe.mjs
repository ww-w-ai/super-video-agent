// Probe: does the Dawn WebGPU binding give a real device on this machine?
import { create, globals } from "webgpu";

Object.assign(globalThis, globals); // GPUBufferUsage, GPUTextureUsage, etc.
const gpu = create([]); // navigator.gpu-like
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
if (!adapter) {
  console.log("NO ADAPTER");
  process.exit(1);
}
const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
const device = await adapter.requestDevice();
console.log("adapter:", JSON.stringify({ vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }));
console.log("device:", !!device, "limits.maxTextureDimension2D:", device.limits.maxTextureDimension2D);
console.log("features sample:", [...device.features].slice(0, 8).join(", "));
process.exit(0);
