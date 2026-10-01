// Serving a reel for review.mjs --scan --layer captions. The page's caption
// layer loads dub/<code>/timings.placed.json and dub/<code>/plan.json. For
// the base language those exist only after a dub run, so the base language
// is served from voice/timings.json and plan.json under those names —
// nothing is written into the reel directory.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { serveDir } from "./server.mjs";

/**
 * URL path -> file for each caption-layer file the base language lacks.
 * Empty for a non-base language (its dub run wrote the files) and for a
 * base language whose files already exist.
 * @param {string} dir reel directory
 * @param {{code:string, baseCode:string}} args
 * @returns {Record<string,string>}
 */
export function captionLayerAliases(dir, { code, baseCode }) {
  if (code !== baseCode) return {};
  const wanted = {
    [`/dub/${code}/timings.placed.json`]: path.join(dir, "voice", "timings.json"),
    [`/dub/${code}/plan.json`]: path.join(dir, "plan.json"),
  };
  const aliases = {};
  for (const [urlPath, source] of Object.entries(wanted)) {
    if (!fs.existsSync(path.join(dir, urlPath))) aliases[urlPath] = source;
  }
  return aliases;
}

/**
 * The language's own film length: `duration` of dub/<code>/timings.placed.json
 * (written by dub.mjs from the widened timeline when --min-gap was used), read
 * from its alias source when the base language is served in place.
 * @returns {number|null} null when the file is missing or has no duration
 */
export function placedDuration(dir, aliases, code) {
  const urlPath = `/dub/${code}/timings.placed.json`;
  const file = aliases[urlPath] || path.join(dir, urlPath);
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8")).duration;
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/**
 * serveDir(dir) plus `aliases` (URL path -> absolute file). Aliased paths
 * are answered here; everything else is forwarded to serveDir unchanged.
 * @returns {Promise<{url:string, close:() => Promise<void>}>}
 */
export async function serveDirWithAliases(dir, aliases) {
  const inner = await serveDir(dir);
  if (Object.keys(aliases).length === 0) return inner;
  const innerUrl = new URL(inner.url);
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const source = aliases[pathname];
    if (source) {
      fs.readFile(source, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found: " + pathname);
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(data);
      });
      return;
    }
    const fwd = http.request(
      { host: innerUrl.hostname, port: innerUrl.port, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      }
    );
    fwd.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e.message));
    });
    req.pipe(fwd);
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: async () => {
      await new Promise((r) => server.close(() => r()));
      await inner.close();
    },
  };
}
