import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { blenderCandidates, selectEngine, probeBlender } from "../scripts/probe-blender.mjs";

test("missing Blender selects Three.js without attempting a launch", () => {
  assert.equal(selectEngine([], () => assert.fail("unexpected launch")).engine, "threejs");
});

test("explicit binary suppresses auto-discovery", () => {
  assert.deepEqual(blenderCandidates({ env: { SVA_BLENDER_BIN: "/custom path/Blender", PATH: "/bin" } }), ["/custom path/Blender"]);
});

test("discovery excludes cwd and keeps platform paths", () => {
  assert.deepEqual(blenderCandidates({ env: { PATH: ":.:relative:/bin:/bin" }, platform: "linux" }), ["/bin/blender"]);
  assert.ok(blenderCandidates({ env: {}, platform: "darwin", home: "/home/user" }).includes("/Applications/Blender.app/Contents/MacOS/Blender"));
  assert.deepEqual(blenderCandidates({ env: { PATH: "C:\\Tools" }, platform: "win32", list: () => ["Blender 4.5", "unrelated"] }),
    ["C:\\Tools\\blender.exe", "C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe"]);
});

test("failed candidate falls back or tries the next installed candidate", () => {
  assert.equal(selectEngine(["bad"], () => ({ ok: false, reason: "timeout" })).engine, "threejs");
  const result = selectEngine(["bad", "good"], file => ({ ok: file === "good" }));
  assert.equal(result.engine, "blender");
  assert.equal(result.executable, "good");
});

test("relative executable is not launched", () => {
  assert.equal(probeBlender("./blender", { run: () => assert.fail("unexpected launch") }).ok, false);
});

test("runtime failures cannot pass even with a success marker", () => {
  for (const result of [
    { status: 1, stdout: "SVA_BLENDER_OK fake" },
    { status: null, error: { code: "ETIMEDOUT" } },
    { status: 0, stdout: "SVA_BLENDER_OK fake" },
    { status: 0, stdout: "Blender 5.2" },
  ]) {
    let output;
    const proof = probeBlender(path.resolve("/fake/blender"), { run: (_file, args) => { output = args.at(-1); return result; } });
    assert.equal(proof.ok, false);
    assert.equal(fs.existsSync(path.dirname(output)), false, "owned temporary directory removed");
  }
});

test("only a successful render proof selects Blender, with shell disabled and timeout", () => {
  let output;
  const result = probeBlender(path.resolve("/fake path/blender"), { timeoutMs: 123, run: (file, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 123);
    assert.equal(options.killSignal, "SIGKILL");
    assert.ok(args.includes("--disable-autoexec"));
    assert.ok(args.includes("--python-exit-code"));
    output = args.at(-1);
    const png = Buffer.alloc(40);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write("IHDR", 12); png.writeUInt32BE(32, 16); png.writeUInt32BE(32, 20);
    fs.writeFileSync(output, png);
    return { status: 0, stdout: 'render log\nSVA_BLENDER_OK {"version":"5.2.2 LTS","renderEngine":"BLENDER_EEVEE"}\n' };
  } });
  assert.deepEqual(result, { ok: true, version: "5.2.2 LTS", renderEngine: "BLENDER_EEVEE" });
  assert.equal(fs.existsSync(path.dirname(output)), false);
});

test("corrupt output never selects Blender", () => {
  const result = probeBlender(path.resolve("/fake/blender"), { run: (_file, args) => {
    fs.writeFileSync(args.at(-1), "not a PNG");
    return { status: 0, stdout: "SVA_BLENDER_OK fake\n" };
  } });
  assert.equal(result.ok, false);
});

test("CLI invoked through a symlink still returns a routing decision", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-probe-link-"));
  try {
    const script = path.join(dir, "probe.mjs");
    fs.symlinkSync(fileURLToPath(new URL("../scripts/probe-blender.mjs", import.meta.url)), script);
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8", env: { ...process.env, SVA_BLENDER_BIN: path.join(dir, "absent-blender") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).engine, "threejs");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
