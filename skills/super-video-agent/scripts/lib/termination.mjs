// SIGTERM / SIGINT stop a long run for real: its child processes (ffmpeg, the browser) are
// ended, its temporary files are removed, and it exits with the conventional 128+n code.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export const SIGNAL_EXIT = { SIGTERM: 143, SIGINT: 130 };

/** Ends this process's direct children so none keeps running after a signal. */
export function killChildren() {
  try {
    spawnSync("pkill", ["-TERM", "-P", String(process.pid)], { stdio: "ignore" });
  } catch {
    // no pkill on this system: the children end when their pipes close with this process
  }
}

/**
 * The handlers are injectable so the behaviour can be tested without a signal.
 * @param {{name:string, temps?:Iterable<string>, kill?:()=>void, exit?:(code:number)=>void, write?:(s:string)=>void}} opts
 */
export function createTerminationGuard({ name, temps = [], kill = killChildren, exit = (code) => process.exit(code), write = (s) => process.stderr.write(s) }) {
  const handlers = new Map();
  const handle = (signal) => {
    kill();
    // A child that is still dying can write into a temp folder while it is removed (ENOTEMPTY);
    // one failed removal must not stop the others or the exit code.
    for (const p of temps) {
      try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
      } catch (e) {
        write(`${name}: could not remove ${p} (${e.code || e.message})\n`);
      }
    }
    write(`${name}: stopped by ${signal}; child processes ended and temporary files removed\n`);
    exit(SIGNAL_EXIT[signal]);
  };
  return {
    handle,
    install() {
      for (const signal of Object.keys(SIGNAL_EXIT)) {
        const fn = () => handle(signal);
        handlers.set(signal, fn);
        process.on(signal, fn);
      }
    },
    uninstall() {
      for (const [signal, fn] of handlers) process.off(signal, fn);
      handlers.clear();
    },
  };
}
