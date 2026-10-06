// BCP 47 comparison shared by dub.mjs (scene spans) and the caption layer (review.mjs, layout-scan-serve.mjs).

const MULTI_SCRIPT = new Set(["zh", "sr", "uz", "pa", "az", "mn", "ks"]); // languages written in more than one script
const REGION_SCRIPT = { TW: "Hant", HK: "Hant", MO: "Hant", CN: "Hans", SG: "Hans" };

/** {lang, script} of a BCP 47 tag; script is explicit, inferred from a zh region, or null. null when the tag is not readable. */
export function parseLangTag(tag) {
  if (typeof tag !== "string" || !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(tag.trim())) return null;
  const [language, ...rest] = tag.trim().split(/[-_]/);
  const lang = language.toLowerCase();
  const scriptPart = rest.find((p) => /^[A-Za-z]{4}$/.test(p));
  const region = rest.find((p) => /^([A-Za-z]{2}|\d{3})$/.test(p));
  const script = scriptPart ? scriptPart[0].toUpperCase() + scriptPart.slice(1).toLowerCase() : lang === "zh" && region ? REGION_SCRIPT[region.toUpperCase()] || null : null;
  return { lang, script };
}

/**
 * Whether two BCP 47 tags name the same written language: true, false, or null when that cannot be told
 * (a tag is unreadable, or a multi-script language such as zh names its script on one side only).
 * Region differences (ko / ko-KR, en-US / en-GB) do not matter; script differences (zh-Hans / zh-Hant) do.
 */
export function sameLanguageTag(a, b) {
  const x = parseLangTag(a);
  const y = parseLangTag(b);
  if (!x || !y) return null;
  if (x.lang !== y.lang) return false;
  if (x.script && y.script) return x.script === y.script;
  if (!x.script && !y.script) return true;
  return MULTI_SCRIPT.has(x.lang) ? null : true;
}
