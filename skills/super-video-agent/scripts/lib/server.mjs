// Minimal static file server for a reel directory, bound to 127.0.0.1 on a
// random free port. No network dependency beyond node:http; used so the
// page loads reel.html, assets/, and voice/ the same way a browser normally
// would (relative URLs, real fetch of local files) without any hot-linking.
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

/**
 * Serve `rootDir` over http on 127.0.0.1:<random free port>.
 * @param {string} rootDir absolute path to the reel directory
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function serveDir(rootDir) {
  const root = path.resolve(rootDir);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url, "http://127.0.0.1");
        let rel = decodeURIComponent(reqUrl.pathname);
        if (rel === "/") rel = "/reel.html";
        const filePath = path.join(root, rel);
        if (!filePath.startsWith(root)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end("not found: " + rel);
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, {
            "content-type": MIME[ext] || "application/octet-stream",
            "cache-control": "no-store",
          });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500);
        res.end(String(e && e.message ? e.message : e));
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        port,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
