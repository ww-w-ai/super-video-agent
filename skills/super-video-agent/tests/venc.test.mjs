import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ffmpeg, resolveVideoEncoder, videoEncodeArgs, hwBitrate, hardwareCandidates, chooseVideoEncoder,
  probeVideoEncoder, concatMp4, cutFrames, encodeFailureReason, belowHardwareMinimum,
} from "../scripts/lib/ffmpeg.mjs";

test("NVENC below its smallest frame encodes with libx264; other encoders and full-size frames keep theirs", () => {
  assert.equal(belowHardwareMinimum("hevc_nvenc", 128, 128), true);
  assert.equal(belowHardwareMinimum("hevc_nvenc", 129, 33), false);
  assert.equal(belowHardwareMinimum("h264_nvenc", 144, 48), true);
  assert.equal(belowHardwareMinimum("h264_nvenc", 145, 49), false);
  assert.equal(belowHardwareMinimum("hevc_videotoolbox", 32, 32), false);
  assert.equal(belowHardwareMinimum("hevc_nvenc", undefined, undefined), false);
  assert.deepEqual(videoEncodeArgs({ crf: 18, width: 64, height: 64, encoder: "hevc_nvenc" }).slice(0, 2), ["-c:v", "libx264"]);
  assert.deepEqual(videoEncodeArgs({ width: 1920, height: 1080, encoder: "hevc_nvenc" }).slice(0, 2), ["-c:v", "hevc_nvenc"]);
});

test("a failed test encode reports the encoder's own complaint, not ffmpeg's last generic line", () => {
  const stderr = [
    "[h264_nvenc @ 0000018c] Driver does not support the required nvenc API version. Required: 13.1 Found: 12.2",
    "[h264_nvenc @ 0000018c] The minimum required Nvidia driver for nvenc is 610.00 or newer",
    "[out#0/null @ 0000018c] Nothing was written into output file, because at least one of its streams received no packets.",
  ].join("\r\n");
  assert.equal(encodeFailureReason(stderr), "Driver does not support the required nvenc API version. Required: 13.1 Found: 12.2");
  assert.equal(encodeFailureReason("Unknown encoder 'h264_qsv'\n"), "Unknown encoder 'h264_qsv'");
});
import { decideSegmentReuse, decideLangUnprobed } from "../scripts/lib/segments.mjs";

const never = () => {
  throw new Error("must not probe");
};
const listed = (...names) => () => new Set(names);
const works = () => null;

test("resolveVideoEncoder auto: HEVC hardware first when it is listed and a test encode works", () => {
  const e = resolveVideoEncoder({ mode: "auto", platform: "darwin", listEncoders: listed("libx264", "hevc_videotoolbox", "h264_videotoolbox"), tryEncode: works });
  assert.equal(e.name, "hevc_videotoolbox");
  assert.equal(e.hardware, true);
  assert.match(e.reason, /1-frame test encode succeeded/);
});

test("resolveVideoEncoder auto: H.264 hardware when HEVC hardware is missing or cannot open", () => {
  const unopenable = resolveVideoEncoder({
    mode: "auto", platform: "darwin",
    listEncoders: listed("hevc_videotoolbox", "h264_videotoolbox"),
    tryEncode: (n) => (n === "hevc_videotoolbox" ? "Error while opening encoder" : null),
  });
  assert.equal(unopenable.name, "h264_videotoolbox");
  assert.match(unopenable.reason, /hevc_videotoolbox test encode failed/);
  assert.equal(resolveVideoEncoder({ mode: "auto", platform: "darwin", listEncoders: listed("h264_videotoolbox"), tryEncode: works }).name, "h264_videotoolbox");
});

test("resolveVideoEncoder auto: listed but unopenable hardware (a VM) falls back to libx264", () => {
  const e = resolveVideoEncoder({ mode: "auto", platform: "darwin", listEncoders: listed("hevc_videotoolbox", "h264_videotoolbox"), tryEncode: () => "cannot open" });
  assert.equal(e.name, "libx264");
  assert.equal(e.hardware, false);
  assert.match(e.reason, /h264_videotoolbox test encode failed: cannot open.*using libx264/);
});

test("resolveVideoEncoder auto: no hardware listed -> libx264; nothing is test-encoded", () => {
  const e = resolveVideoEncoder({ mode: "auto", platform: "linux", listEncoders: listed("libx264"), tryEncode: never });
  assert.equal(e.name, "libx264");
});

test("hardwareCandidates: HEVC then H.264 for auto and hw; one codec for hevc and h264", () => {
  assert.deepEqual(hardwareCandidates("auto", "darwin"), ["hevc_videotoolbox", "h264_videotoolbox"]);
  assert.deepEqual(hardwareCandidates("hw", "linux"), ["hevc_nvenc", "hevc_qsv", "h264_nvenc", "h264_qsv"]);
  assert.deepEqual(hardwareCandidates("hevc", "linux"), ["hevc_nvenc", "hevc_qsv"]);
  assert.deepEqual(hardwareCandidates("h264", "darwin"), ["h264_videotoolbox"]);
  const e = resolveVideoEncoder({ mode: "h264", platform: "linux", listEncoders: listed("hevc_nvenc", "h264_qsv"), tryEncode: works });
  assert.equal(e.name, "h264_qsv");
  assert.equal(videoEncodeArgs({ width: 1920, height: 1080, encoder: "h264_qsv" }).at(-1), "nv12");
});

test("resolveVideoEncoder hw, hevc, h264: fail loud with every reason when no such hardware encoder works", () => {
  assert.throws(
    () => resolveVideoEncoder({ mode: "hw", platform: "darwin", listEncoders: listed("h264_videotoolbox"), tryEncode: () => "no device" }),
    (e) => /SVA_VENC=hw but no hardware video encoder/.test(e.message) && /hevc_videotoolbox not listed/.test(e.message) && /h264_videotoolbox test encode failed: no device/.test(e.message)
  );
  assert.throws(
    () => resolveVideoEncoder({ mode: "hevc", platform: "linux", listEncoders: listed("h264_nvenc"), tryEncode: works }),
    /SVA_VENC=hevc but no HEVC hardware video encoder works here \(hevc_nvenc not listed/
  );
  assert.throws(
    () => resolveVideoEncoder({ mode: "h264", platform: "darwin", listEncoders: listed("hevc_videotoolbox"), tryEncode: works }),
    /SVA_VENC=h264 but no H\.264 hardware video encoder/
  );
});

test("resolveVideoEncoder sw: libx264 without probing; a bad mode is refused", () => {
  assert.equal(resolveVideoEncoder({ mode: "sw", listEncoders: never, tryEncode: never }).name, "libx264");
  assert.throws(() => resolveVideoEncoder({ mode: "gpu", listEncoders: never, tryEncode: never }), /SVA_VENC=gpu is not one of auto, hw, hevc, h264, sw/);
});

test("videoEncodeArgs sw: libx264 with exactly the call site's crf and preset", () => {
  assert.deepEqual(videoEncodeArgs({ crf: 18, preset: "medium", encoder: "libx264" }), ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"]);
  assert.deepEqual(videoEncodeArgs({ crf: 16, encoder: "libx264" }), ["-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p"]);
  assert.deepEqual(videoEncodeArgs({ preset: "veryfast", encoder: "libx264" }), ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"]);
});

test("videoEncodeArgs hw: HEVC 4 Mb/s at 1080p by pixels tagged hvc1; VideoToolbox H.264 at -q:v 77; no software fallback", () => {
  assert.equal(hwBitrate(1920, 1080, "hevc_videotoolbox"), 4_000_000);
  assert.equal(hwBitrate(3840, 2160, "hevc_nvenc"), 16_000_000);
  assert.equal(hwBitrate(1280, 720, "hevc_videotoolbox"), 1_778_000);
  assert.equal(hwBitrate(1920, 1080, "h264_nvenc"), 3_200_000);
  assert.deepEqual(videoEncodeArgs({ crf: 18, preset: "medium", width: 1920, height: 1080, encoder: "hevc_videotoolbox" }),
    ["-c:v", "hevc_videotoolbox", "-b:v", "4000000", "-allow_sw", "0", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"]);
  assert.deepEqual(videoEncodeArgs({ crf: 18, preset: "medium", width: 1920, height: 1080, encoder: "h264_videotoolbox" }),
    ["-c:v", "h264_videotoolbox", "-q:v", "77", "-allow_sw", "0", "-profile:v", "high", "-pix_fmt", "yuv420p"]);
  assert.deepEqual(videoEncodeArgs({ width: 1920, height: 1080, encoder: "hevc_nvenc" }),
    ["-c:v", "hevc_nvenc", "-b:v", "4000000", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"]);
  assert.throws(() => videoEncodeArgs({ crf: 18, encoder: "hevc_videotoolbox" }), /needs the output size/);
});

test("segment reuse: a segment made with another encoder is re-rendered, so a reel never mixes codecs", () => {
  const base = { frameStart: 0, frameEnd: 30, fps: 30, width: 1920, height: 1080, probes: ["a", "b", "c"] };
  const hw = { ...base, encoder: "hevc_videotoolbox" };
  const legacy = decideSegmentReuse({ stored: base, current: hw, mp4Exists: true });
  assert.equal(legacy.reuse, false);
  assert.match(legacy.reason, /video encoder changed \(libx264 -> hevc_videotoolbox\)/);
  assert.equal(decideSegmentReuse({ stored: { ...base, encoder: "libx264" }, current: hw, mp4Exists: true }).reuse, false);
  assert.equal(decideSegmentReuse({ stored: hw, current: hw, mp4Exists: true }).reuse, true);
  assert.equal(decideSegmentReuse({ stored: base, current: { ...base, encoder: "libx264" }, mp4Exists: true }).reuse, true, "meta from before SVA_VENC is libx264");
  const storedBase = { ...base, encoder: "libx264", picture: { keys: [] } };
  assert.equal(decideLangUnprobed({ storedBase, storedLang: null, current: hw, strings: {}, baseMp4Exists: true, langMp4Exists: false }), null, "a base segment from another encoder is not copied");
  assert.equal(decideLangUnprobed({ storedBase, storedLang: null, current: { ...hw, encoder: "libx264" }, strings: {}, baseMp4Exists: true, langMp4Exists: false }).action, "COPY");
});

async function clip(file, args) {
  await ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30", "-frames:v", "30", ...args, file]);
}

test("concatMp4: parts from two encoders are refused with both named, never joined", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-venc-"));
  try {
    const a = path.join(dir, "a.mp4");
    const b = path.join(dir, "b.mp4");
    await clip(a, ["-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    const hw = chooseVideoEncoder();
    if (hw.hardware) await clip(b, ["-c:v", hw.name, "-b:v", "500k", "-pix_fmt", "yuv420p"]);
    else await clip(b, ["-c:v", "mpeg4"]);
    const out = path.join(dir, "joined.mp4");
    await assert.rejects(concatMp4([a, b], out, 30), (e) => {
      assert.match(e.message, /cannot join b\.mp4/);
      if (hw.hardware) assert.match(e.message, new RegExp(`b\\.mp4 \\(${hw.name}\\) to a\\.mp4 \\(libx264\\).*one video encoder`));
      return true;
    });
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cutFrames re-encodes the edge pieces with the source's encoder, whatever SVA_VENC picks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-venc-cut-"));
  const saved = process.env.SVA_VENC;
  try {
    const src = path.join(dir, "src.mp4");
    await clip(src, [...videoEncodeArgs({ crf: 18, preset: "medium", encoder: "libx264" }), "-g", "10"]);
    process.env.SVA_VENC = "auto";
    const out = path.join(dir, "cut.mp4");
    const r = await cutFrames({ src, from: 3, to: 25, fps: 30, crf: 18, preset: "medium", outPath: out });
    assert.deepEqual(r.pieces.map((p) => p.kind), ["encode", "copy", "encode"]);
    assert.equal(r.fellBack, false);
    assert.equal(await probeVideoEncoder(out), "libx264");
  } finally {
    if (saved === undefined) delete process.env.SVA_VENC;
    else process.env.SVA_VENC = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
