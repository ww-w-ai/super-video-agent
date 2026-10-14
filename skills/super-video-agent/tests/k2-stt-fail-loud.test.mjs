// Sprint K2 — an STT check that was configured (SVA_STT_PYTHON or SVA_STT_ENGINE set)
// but cannot run is a failure, not a skip; with nothing configured it stays a skip.
// Transient decode errors (EBADF / ffmpeg exit 247) are retried a bounded number of times.
// No network, no models: Python and ffmpeg are replaced by fake executables.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sttTranscribe } from "../scripts/lib/stt-engine.mjs";
import { isTransientDecodeError, withRetry, withTransportRetry } from "../scripts/lib/retry.mjs";
import { run } from "../scripts/lib/ffmpeg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VOICE_MJS = path.join(here, "..", "scripts", "voice.mjs");

const tmp = (p = "sva-k2-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const quiet = { log: () => {} };
const NOWHERE = tmp("sva-k2-voice-");
after(() => fs.rmSync(NOWHERE, { recursive: true, force: true }));
const ENTRY = [{ id: "l1", wav: "a.wav" }];

// --- engine ----------------------------------------------------------------------

test("T1: nothing configured and no Python stays skipped (today's contract)", async () => {
  const res = await sttTranscribe(NOWHERE, ENTRY, "ko", { env: {}, ...quiet });
  assert.equal(res.failed, undefined);
  assert.match(res.skipped, /SVA_STT_PYTHON/);
});

test("T1: SVA_STT_ENGINE=mlx set but no Python fails and names every way out", async () => {
  const res = await sttTranscribe(NOWHERE, ENTRY, "ko", { env: { SVA_STT_ENGINE: "mlx" }, ...quiet });
  assert.equal(res.skipped, undefined);
  assert.match(res.failed, /SVA_STT_PYTHON/);
  assert.match(res.failed, /SVA_STT_ENGINE=groq/);
  assert.match(res.failed, /--no-stt/);
  assert.doesNotMatch(res.failed, /Apple/i);
});

test("T1: an unknown or retired engine is a failure (it can only come from SVA_STT_ENGINE)", async () => {
  const other = await sttTranscribe(NOWHERE, ENTRY, "ko", { env: { SVA_STT_ENGINE: "nope" }, ...quiet });
  assert.match(other.failed, /unknown STT engine "nope"/);
  assert.match(other.failed, /--no-stt/);
  const faster = await sttTranscribe(NOWHERE, ENTRY, "ko", { env: { SVA_STT_ENGINE: "faster-whisper" }, ...quiet });
  assert.match(faster.failed, /no Python is set/);
});

test("T1: SVA_STT_ENGINE=groq without GROQ_API_KEY fails and names the key, SVA_STT_PYTHON and --no-stt", async () => {
  let fetched = 0;
  const fetch = async () => {
    fetched++;
    throw new Error("must not be called");
  };
  for (const allowPartial of [false, true]) {
    const res = await sttTranscribe(NOWHERE, ENTRY, "ko", { env: { SVA_STT_ENGINE: "groq" }, fetch, allowPartial, ...quiet });
    assert.equal(res.skipped, undefined);
    assert.equal(res.incomplete, undefined);
    assert.match(res.failed, /GROQ_API_KEY is not set/);
    assert.match(res.failed, /SVA_STT_PYTHON/);
    assert.match(res.failed, /--no-stt/);
  }
  assert.equal(fetched, 0, "nothing is sent without a key");
});

test("T2: SVA_STT_PYTHON without mlx_whisper fails, with and without allowPartial", async () => {
  const run = async () => {
    throw new Error("/py stt_check.py exited 1\nTraceback (most recent call last):\nModuleNotFoundError: No module named 'mlx_whisper'");
  };
  const env = { SVA_STT_ENGINE: "mlx", SVA_STT_PYTHON: "/py" };
  const plain = await sttTranscribe(NOWHERE, ENTRY, "ko", { env, runPythonBatch: run, ...quiet });
  assert.equal(plain.skipped, undefined);
  assert.match(plain.failed, /cannot run mlx-whisper/);
  assert.match(plain.failed, /No module named 'mlx_whisper'/);
  assert.match(plain.failed, /SVA_STT_ENGINE=groq/);
  assert.match(plain.failed, /--no-stt/);
  const partial = await sttTranscribe(NOWHERE, ENTRY, "ko", { env, runPythonBatch: run, allowPartial: true, ...quiet });
  assert.equal(partial.incomplete, undefined);
  assert.match(partial.failed, /cannot run mlx-whisper/);
});

test("T2: SVA_STT_PYTHON that does not start (ENOENT) fails", async () => {
  const res = await sttTranscribe(NOWHERE, ENTRY, "ko", { env: { SVA_STT_ENGINE: "mlx", SVA_STT_PYTHON: path.join(NOWHERE, "no-such-python") }, ...quiet });
  assert.match(res.failed, /cannot run mlx-whisper/);
  assert.match(res.failed, /failed to start/);
});

test("T2: a model that is not downloaded and a mid-run crash keep their old shapes", async () => {
  const env = { SVA_STT_PYTHON: "/py" };
  const notDownloaded = await sttTranscribe(NOWHERE, ENTRY, "ko", { env, runPythonBatch: async () => { throw new Error("/py x exited 3\nno model"); }, ...quiet });
  assert.match(notDownloaded.skipped, /not downloaded/);
  const crash = await sttTranscribe(NOWHERE, ENTRY, "ko", { env, runPythonBatch: async () => { throw new Error("/py x exited 1\nfake crash"); }, ...quiet });
  assert.match(crash.skipped, /stt check failed to run/);
  assert.equal(crash.failed, undefined);
});

// --- retry predicate --------------------------------------------------------------

test("T3: isTransientDecodeError matches only the EBADF / exit-247 signature", () => {
  assert.ok(isTransientDecodeError(new Error("ffmpeg exited 247\nargs: -i a.wav -f f32le -")));
  assert.ok(isTransientDecodeError(new Error("pipe:: Bad file descriptor")));
  assert.ok(isTransientDecodeError(new Error("OSError: [Errno 9] EBADF")));
  assert.ok(isTransientDecodeError(new Error("subprocess.CalledProcessError: Command '[ffmpeg]' returned non-zero exit status 247.")));
  assert.equal(isTransientDecodeError(new Error("ffmpeg exited 1\nInvalid data found")), false);
  assert.equal(isTransientDecodeError(new Error("ffmpeg exited 2470")), false);
  assert.equal(isTransientDecodeError(null), false);
});

test("T3: withRetry uses the injected predicate; withTransportRetry keeps its own", async () => {
  let calls = 0;
  const seen = [];
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("Bad file descriptor");
      return "ok";
    },
    { isRetryable: isTransientDecodeError, onRetry: (k) => seen.push(k) }
  );
  assert.equal(out, "ok");
  assert.deepEqual(seen, [1, 2]);
  let tCalls = 0;
  await assert.rejects(
    withTransportRetry(async () => {
      tCalls++;
      throw new Error("Bad file descriptor");
    }),
    /Bad file descriptor/
  );
  assert.equal(tCalls, 1, "a decode error is not a transport error");
});

// --- ffmpeg run -------------------------------------------------------------------

/** A fake ffmpeg: fails with EBADF/247 on the first `failRuns` runs, then prints bytes. Counts runs in a file. */
function fakeBin(dir, failRuns) {
  const bin = path.join(dir, "fake-ffmpeg");
  const counter = path.join(dir, "count");
  fs.writeFileSync(counter, "0");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nn=$(cat "${counter}")\nn=$((n+1))\necho $n > "${counter}"\nif [ $n -le ${failRuns} ]; then echo "pipe:: Bad file descriptor" >&2; exit 247; fi\nprintf 'BYTES'\n`,
    { mode: 0o755 }
  );
  return { bin, count: () => Number(fs.readFileSync(counter, "utf8").trim()) };
}

test("T4: a decode-only run (output '-') retries EBADF and resolves on the third run", async () => {
  const dir = tmp();
  const fake = fakeBin(dir, 2);
  const res = await run(fake.bin, ["-i", "a.wav", "-f", "f32le", "-"]);
  assert.equal(res.stdout.toString(), "BYTES");
  assert.equal(fake.count(), 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T5: retries are bounded (3 runs) and the last error surfaces unchanged", async () => {
  const dir = tmp();
  const fake = fakeBin(dir, 99);
  await assert.rejects(run(fake.bin, ["-i", "a.wav", "-f", "s16le", "pipe:1"]), (e) => /exited 247/.test(e.message) && /Bad file descriptor/.test(e.message));
  assert.equal(fake.count(), 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T5: a run that writes a file is never retried", async () => {
  const dir = tmp();
  const fake = fakeBin(dir, 99);
  await assert.rejects(run(fake.bin, ["-i", "a.wav", path.join(dir, "out.wav")]), /exited 247/);
  assert.equal(fake.count(), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T6: the STT Python run retries a transient decode error, then returns the transcript", async () => {
  let calls = 0;
  const logs = [];
  const runPy = async (_p, args) => {
    calls++;
    if (calls === 1) throw new Error("/py stt_check.py exited 1\nOSError: [Errno 9] Bad file descriptor");
    const job = JSON.parse(fs.readFileSync(args[2], "utf8"));
    return { stdout: JSON.stringify(job.map((j) => ({ id: j.id, heard: "hi", words: [] }))) };
  };
  const res = await sttTranscribe(NOWHERE, ENTRY, "en", { env: { SVA_STT_PYTHON: "/py" }, runPythonBatch: runPy, log: (m) => logs.push(m) });
  assert.equal(res.results.get("l1"), "hi");
  assert.equal(calls, 2);
  assert.ok(logs.some((m) => /transient decode error, retrying \(1\/2\)/.test(m)));
});

// --- voice step -------------------------------------------------------------------

/** A provider-`none` reel with one line; `--stt-only` needs the wav and timings already there. */
function makeReel() {
  const dir = tmp("sva-k2-reel-");
  fs.mkdirSync(path.join(dir, "voice"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: { lang: "en-US", voice: { provider: "none" } }, lines: [{ id: "l1", text: "hello there" }] }));
  return dir;
}

const NO_PYTHON = { SVA_STT_PYTHON: "", SVA_STT_ENGINE: "mlx" };

function voice(dir, extra, env) {
  return spawnSync(process.execPath, [VOICE_MJS, dir, ...extra], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("T7: the voice step exits 1 with STT check FAILED and still writes timings.json", () => {
  const dir = makeReel();
  const res = voice(dir, [], NO_PYTHON);
  assert.equal(res.status, 1, res.stderr + res.stdout);
  assert.match(res.stderr, /STT check FAILED: .*SVA_STT_PYTHON/);
  assert.doesNotMatch(res.stdout, /STT check skipped/);
  assert.ok(fs.existsSync(path.join(dir, "voice", "timings.json")), "timings written");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T7: with nothing configured the voice step still skips and exits 0", () => {
  const dir = makeReel();
  const res = voice(dir, [], { SVA_STT_PYTHON: "", SVA_STT_ENGINE: "" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /STT check skipped/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T8: --stt-only exits 1 with STT check FAILED", () => {
  const dir = makeReel();
  assert.equal(voice(dir, [], { SVA_STT_PYTHON: "", SVA_STT_ENGINE: "" }).status, 0);
  const res = voice(dir, ["--stt-only"], NO_PYTHON);
  assert.equal(res.status, 1, res.stderr + res.stdout);
  assert.match(res.stderr, /STT check FAILED/);
  assert.doesNotMatch(res.stdout, /STT check skipped/);
  fs.rmSync(dir, { recursive: true, force: true });
});
