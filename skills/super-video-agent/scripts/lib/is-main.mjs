// Whether a module is the script node was started with. `file://${process.argv[1]}` only matches
// on POSIX (a Windows path needs file:///C:/...), and neither form matches when argv[1] is a
// symlink (npm bin) because node resolves the main module's real path for import.meta.url.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  let file = path.resolve(argv1);
  try { file = fs.realpathSync(file); } catch { /* keep the resolved path */ }
  return metaUrl === pathToFileURL(file).href;
}
