// Minimal WAV reader: PCM16 and float32 files to a mono Float32Array. The counterpart of wav.mjs
// (which only writes). No dependencies.
import fs from "node:fs";

/**
 * @param {Buffer} buf a RIFF/WAVE file
 * @returns {{samples: Float32Array, sampleRate: number, channels: number}} channels averaged to mono
 */
export function parseWav(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let fmt = null;
  let data = null;
  for (let p = 12; p + 8 <= buf.length; ) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(buf.length, body + size));
      break;
    }
    p = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV has no fmt or data chunk");
  const isFloat = fmt.format === 3 && fmt.bits === 32;
  const isPcm16 = (fmt.format === 1 || fmt.format === 0xfffe) && fmt.bits === 16;
  if (!isFloat && !isPcm16) throw new Error(`unsupported WAV encoding (format ${fmt.format}, ${fmt.bits} bit)`);
  const bytes = isFloat ? 4 : 2;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * bytes;
      sum += isFloat ? data.readFloatLE(o) : data.readInt16LE(o) / 32768;
    }
    samples[i] = sum / fmt.channels;
  }
  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

/** Reads a WAV file path. */
export function readWav(filePath) {
  return parseWav(fs.readFileSync(filePath));
}
