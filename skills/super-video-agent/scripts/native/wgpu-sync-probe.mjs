import { create, globals } from "webgpu";
const gpu = create([]);
console.log("gpu own+proto:", [...Object.keys(gpu), ...Object.getOwnPropertyNames(Object.getPrototypeOf(gpu))].filter((k) => /tick|process|poll|instance|event|wait/i.test(k)));
console.log("globals sync-ish:", Object.keys(globals).filter((k) => /tick|process|poll|Instance|event|wait/i.test(k)));
const a = await gpu.requestAdapter();
const d = await a.requestDevice();
console.log("device sync-ish:", Object.getOwnPropertyNames(Object.getPrototypeOf(d)).filter((k) => /tick|poll|process|work|wait/i.test(k)));
console.log("queue sync-ish:", Object.getOwnPropertyNames(Object.getPrototypeOf(d.queue)).filter((k) => /tick|poll|process|work|wait|submit/i.test(k)));
process.exit(0);
