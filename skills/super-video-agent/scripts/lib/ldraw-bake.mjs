// Bakes an LDraw-format model into the data a page loads: the model tree and step order exactly as the file
// states them, each placement's matrix, colour and insertion direction, and the geometry of every part used.
// Geometry is read from the user's parts folder once per part; a page then opens two JSON files instead of
// hundreds of library files. See references/assembly.md "Reading a model file".
import {
  parseMpd, stepsOf, findBuildModel, treeLines, isSubModel, norm, openLibrary, flattenPart, partTitle,
  readColours, colourOf, mul, boundsOf, transformBounds,
} from "./ldraw.mjs";
import { planJoins, checkPaths } from "./ldraw-connect.mjs";
import { surfaceOf, transformTriangles } from "./surface-crossing.mjs";

const b64 = (arr) => Buffer.from(new Float32Array(arr).buffer).toString("base64");
const allTriangles = (flat) => [...flat.tris.values()].flat();

/** One part's data, once per library file: id, title, triangle count, local box, flattened geometry. */
function partRegistry(library) {
  const parts = new Map();
  return {
    parts,
    ensure(file) {
      const id = norm(file).replace(/\.dat$/, "");
      if (parts.has(id)) return id;
      const flat = flattenPart(library, file);
      const triCount = [...flat.tris.values()].reduce((n, a) => n + a.length / 9, 0);
      parts.set(id, { id, file, title: partTitle(library, file), triCount, bounds: boundsOf([...flat.tris.values()]), flat });
      return id;
    },
  };
}

/** The items of a model in build order, each with its matrix, colour and what it references. */
function itemsOf(mpd, key, registry, stepLimit) {
  const steps = stepsOf(mpd, key).slice(0, stepLimit ?? undefined);
  const name = mpd.models.get(norm(key)).name;
  return steps.map((s) => ({
    n: s.n,
    items: s.refs.map((ref, order) => {
      const sub = isSubModel(mpd, ref.file);
      const item = { uid: `${name}#${s.n}.${order + 1}`, model: name, step: s.n, order, kind: sub ? "model" : "part", color: ref.color, m: ref.m };
      if (sub) item.ref = norm(ref.file);
      else item.part = registry.ensure(ref.file);
      return item;
    }),
  }));
}

/** Every model reachable from `key`, deepest first, with its steps' items; stops on a model that contains itself. */
function collectModels(mpd, key, registry, stepLimit, acc = new Map(), path = []) {
  if (path.includes(norm(key))) throw new Error(`sub-model ${key} contains itself (${[...path, norm(key)].join(" -> ")})`);
  const steps = itemsOf(mpd, key, registry, stepLimit);
  for (const it of steps.flatMap((s) => s.items)) {
    if (it.kind === "model" && !acc.has(it.ref)) collectModels(mpd, it.ref, registry, null, acc, [...path, norm(key)]);
  }
  acc.set(norm(key), { key: norm(key), name: mpd.models.get(norm(key)).name, steps });
  return acc;
}

/**
 * Surfaces and boxes of baked models, in whatever frame the caller asks for. A part's triangles are moved by
 * the composed matrix; a model's surfaces are its items' surfaces moved by the model's own matrix.
 */
function geometryOf(registry, models) {
  const cache = new Map();
  const partSurface = (partId, M) => {
    const key = `${partId}:${M.join(",")}`;
    if (!cache.has(key)) cache.set(key, surfaceOf(transformTriangles(allTriangles(registry.parts.get(partId).flat), M)));
    return cache.get(key);
  };
  const surfacesOf = (item, M) => {
    if (item.kind === "part") return [{ id: item.uid, surface: partSurface(item.part, M) }];
    return models.get(item.ref).steps.flatMap((s) => s.items).flatMap((c) => surfacesOf(c, mul(M, c.m)));
  };
  const boxOf = (item, M) => {
    if (item.kind === "part") return transformBounds(M, registry.parts.get(item.part).bounds);
    const boxes = models.get(item.ref).steps.flatMap((s) => s.items).map((c) => boxOf(c, mul(M, c.m)));
    return boundsOf(boxes.map((b) => [b[0], b[1], b[2], b[3], b[4], b[5]]));
  };
  return { surfacesOf, boxOf };
}

/** Joins and checks for one model, in its own frame. */
function planModel(model, registry, geometry, overrides) {
  const items = model.steps.flatMap((s) => s.items);
  for (const it of items) it.wb = geometry.boxOf(it, it.m);
  const env = {
    overrides,
    partOf: (it) => registry.parts.get(it.part),
    surfacesOf: (it) => geometry.surfacesOf(it, it.m),
  };
  planJoins(items, env);
  model.pathCheck = checkPaths(items, env);
  model.bounds = boundsOf(items.map((it) => it.wb));
}

/** The order a viewer builds in: a sub-model's steps run first, then its parent's step where it joins. */
function buildOrder(models, key, via = null, out = []) {
  const model = models.get(key);
  for (const s of model.steps) {
    for (const it of s.items) if (it.kind === "model") buildOrder(models, it.ref, it.uid, out);
    out.push({ model: model.name, step: s.n, via });
  }
  return out;
}

function usedColours(models, registry, colours) {
  const codes = new Set();
  for (const model of models.values()) for (const s of model.steps) for (const it of s.items) codes.add(it.color);
  for (const part of registry.parts.values()) {
    for (const k of [...part.flat.tris.keys(), ...part.flat.lines.keys()]) if (k.includes(":")) codes.add(k.slice(2));
  }
  const out = {};
  for (const c of codes) if (c !== "16" && c !== "24") out[c] = colourOf(colours, c);
  return out;
}

const stripItem = (it, registry) => ({
  uid: it.uid, step: it.step, order: it.order, kind: it.kind,
  ...(it.kind === "part" ? { part: it.part, title: registry.parts.get(it.part).title } : { model: it.ref }),
  color: it.color, m: it.m, bounds: it.wb, class: it.cls, join: it.join,
});

/**
 * @param {{text:string, name?:string, libraryDir:string, until?:number|null, classes?:Record<string,string>}} args
 *   `until` bakes only the first N steps of the model that is built (sub-models they join are baked whole).
 *   `classes` maps a part id to "stud" | "axis" | "hole" where the title does not say.
 * @returns {{build:object, partsData:object, report:object}}
 */
export function bakeModel({ text, name = "model.ldr", libraryDir, until = null, classes = {} }) {
  const mpd = parseMpd(text, name);
  const library = openLibrary(libraryDir);
  const registry = partRegistry(library);
  const target = findBuildModel(mpd);
  const models = collectModels(mpd, target.key, registry, until);
  const geometry = geometryOf(registry, models);
  for (const model of models.values()) planModel(model, registry, geometry, classes);

  const colours = readColours(library);
  const used = usedColours(models, registry, colours);
  const unknown = Object.keys(used).filter((c) => !used[c]);
  const modelsOut = {};
  for (const [key, m] of models) {
    modelsOut[key] = { name: m.name, bounds: m.bounds, steps: m.steps.map((s) => ({ n: s.n, items: s.items.map((it) => stripItem(it, registry)) })), pathCheck: m.pathCheck };
  }
  const steps = models.get(target.key).steps.length;
  const build = {
    source: name, units: "LDU", mainModel: mpd.models.get(mpd.main).name, buildModel: target.name, buildKey: target.key, buildMatrix: target.matrix, until,
    tree: [mpd.models.get(mpd.main).name, `  -> ${target.name} (${steps} steps)`, ...treeLines(mpd, target.key, 1)],
    order: buildOrder(models, target.key), models: modelsOut,
  };
  const partsData = { units: "LDU", colours: used, parts: {} };
  for (const p of registry.parts.values()) {
    const tris = {}, lines = {};
    for (const [k, a] of p.flat.tris) tris[k] = b64(a);
    for (const [k, a] of p.flat.lines) lines[k] = b64(a);
    partsData.parts[p.id] = { file: p.file, title: p.title, triCount: p.triCount, bounds: p.bounds, tris, lines };
  }
  return { build, partsData, report: { models: models.size, parts: registry.parts.size, unknownColours: unknown, noColourTable: Object.keys(colours).length === 0 } };
}
