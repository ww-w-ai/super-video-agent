// Small shared CLI helpers: absolute-path resolution and flag parsing.
import path from "node:path";

/** Resolve `p` against cwd, never silently accepting a relative reel dir. */
export function abs(p) {
  return path.resolve(process.cwd(), p);
}

/**
 * Parse argv (already stripped of node + script path) into
 * {positional: string[], flags: {name: string|boolean}}.
 * `--foo bar` -> flags.foo = "bar"; `--foo` (no value / next is another flag)
 * -> flags.foo = true.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export function printHelpAndExit(text, code = 0) {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  process.exit(code);
}

export function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}
