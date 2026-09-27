// Minimal PCM16 WAV writer for page-rendered SFX (Float32Array[2] stereo
// channels -> 16-bit little-endian WAV), no dependencies.
import fs from "node:fs";

/**
 * @param {string} outPath
 * @param {Float32Array[]} channels one array per channel, same length
 * @param {number} sampleRate
 */
export function writeWavPCM16(outPath, channels, sampleRate) {
  const numChannels = channels.length;
  const numFrames = channels[0] ? channels[0].length : 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i] || 0));
      buf.writeInt16LE(Math.round(sample * 32767), offset);
      offset += 2;
    }
  }
  fs.writeFileSync(outPath, buf);
}
