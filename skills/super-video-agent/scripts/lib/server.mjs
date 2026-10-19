// Minimal static file server for a reel directory, bound to 127.0.0.1 on a
// random free port. No network dependency beyond node:http; used so the
// page loads reel.html, assets/, and voice/ the same way a browser normally
// would (relative URLs, real fetch of local files) without any hot-linking.
// Every server records what it serves (servedSite), so the native renderer,
// which opens the reel without a browser, reads the same files from the same URL.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Origin ("http://127.0.0.1:<port>") -> {root, bodies} for every server open in this process. */
const SITES = new Map();

/**
 * What the server behind `url` serves: {root, bodies} (bodies: pathname ->
 * JSON text answered instead of the file), or null when no server of this
 * process owns that origin.
 * @param {string} url
 */
export function servedSite(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  return SITES.get(origin) || null;
}

/**
 * The file a served pathname maps to under `root` ("/" is reel.html), or
 * null when it would leave the root.
 * @param {string} root
 * @param {string} pathname URL pathname, still percent-encoded
 */
export function servedFilePath(root, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/reel.html";
  const filePath = path.join(root, rel);
  return filePath.startsWith(root) ? filePath : null;
}

/** Content type for a served file, by extension. */
export function mimeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * Serve `rootDir` over http on 127.0.0.1:<random free port>.
 * @param {string} rootDir absolute path to the reel directory
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function serveDir(rootDir) {
  const root = path.resolve(rootDir);
  return listen(root, {}, (req, res) => {
    try {
      const reqUrl = new URL(req.url, "http://127.0.0.1");
      const filePath = servedFilePath(root, reqUrl.pathname);
      if (!filePath) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found: " + decodeURIComponent(reqUrl.pathname));
          return;
        }
        res.writeHead(200, { "content-type": mimeOf(filePath), "cache-control": "no-store" });
        res.end(data);
      });
    } catch (e) {
      res.writeHead(500);
      res.end(String(e && e.message ? e.message : e));
    }
  });
}

/**
 * A loopback server that answers `bodies[pathname]` (JSON text) and forwards
 * every other request to `origin` (a serveDir() server).
 * @param {{url: string}} origin
 * @param {Record<string, string>} bodies
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function serveOverrides(origin, bodies) {
  const site = servedSite(origin.url);
  if (!site) throw new Error(`serveOverrides: ${origin.url} is not a server opened by serveDir()`);
  return listen(site.root, bodies, async (req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (bodies[pathname] !== undefined) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(bodies[pathname]);
      return;
    }
    try {
      const r = await fetch(origin.url.replace(/\/$/, "") + req.url);
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/octet-stream", "cache-control": "no-store" });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(502);
      res.end(String(e.message));
    }
  });
}

function listen(root, bodies, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const origin = `http://127.0.0.1:${port}`;
      SITES.set(origin, { root, bodies });
      resolve({
        url: `${origin}/`,
        port,
        close: () =>
          new Promise((res) => {
            SITES.delete(origin);
            server.close(() => res());
          }),
      });
    });
  });
}
