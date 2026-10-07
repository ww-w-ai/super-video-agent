// `voice.mjs --list-voices`: the voices a TTS provider offers, filtered by language when the
// provider's list carries one. A provider module exports `listVoices()` returning raw entries;
// this file shapes and prints them. Facts only: nothing here picks or ranks a voice.

/** First non-empty value among `keys` of `obj`. */
function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  return undefined;
}

const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? []
  : String(v).split(/[,;]/).map((s) => s.trim()).filter(Boolean));

/**
 * One provider entry as {id, name, gender, age, uses, languages}. Fields a provider does not list
 * stay empty. Languages are lower-case tags or names as the provider writes them.
 * @param {object} raw
 */
export function normalizeVoice(raw) {
  const labels = raw.labels || {};
  const langs = asList(pick(raw, ["languages", "supported_languages"]) ?? raw.language ?? labels.language)
    .concat((raw.verified_languages || []).map((v) => v.language || v.locale).filter(Boolean));
  return {
    id: String(pick(raw, ["voice_id", "id", "voiceId"]) ?? ""),
    name: String(pick(raw, ["voice_name", "name"]) ?? ""),
    gender: String(pick(raw, ["gender"]) ?? labels.gender ?? ""),
    age: String(pick(raw, ["age"]) ?? labels.age ?? ""),
    uses: asList(pick(raw, ["use_cases", "use_case"]) ?? labels.use_case),
    languages: [...new Set(langs.map((l) => String(l).toLowerCase()))],
  };
}

/** Whether a voice's language list names `lang` (BCP 47 primary subtag) or one of `aliases` (e.g. the provider's own code). */
function speaks(voice, lang, aliases) {
  const wants = [String(lang).toLowerCase().split(/[-_]/)[0], ...aliases.map((a) => String(a).toLowerCase())];
  return voice.languages.some((l) => wants.includes(l) || wants.includes(l.split(/[-_]/)[0]));
}

/**
 * @param {object[]} rawVoices provider entries
 * @param {{lang?:string, aliases?:string[]}} [opts]
 * @returns {{voices:object[], total:number, filtered:boolean, note:string}}
 */
export function shapeVoices(rawVoices, opts = {}) {
  const all = (rawVoices || []).map(normalizeVoice).filter((v) => v.id);
  const hasLanguageField = all.some((v) => v.languages.length);
  if (!opts.lang) return { voices: all, total: all.length, filtered: false, note: "" };
  if (!hasLanguageField) {
    return { voices: all, total: all.length, filtered: false, note: `this provider's voice list has no language field, so all ${all.length} voices are shown; the language for a request comes from the line's language (plan.json meta.lang or the line's lang)` };
  }
  const voices = all.filter((v) => speaks(v, opts.lang, opts.aliases || []));
  return { voices, total: all.length, filtered: true, note: voices.length ? "" : `no voice lists "${opts.lang}" among ${all.length}` };
}

/**
 * Runs the listing for one provider module and returns the report text. A provider without a
 * `listVoices` export stops this step with a message naming it.
 * @param {string} providerName
 * @param {{listVoices?:Function, languageCode?:Function}} mod the provider module
 * @param {{lang?:string}} [opts]
 * @returns {Promise<string>}
 */
export async function listVoicesReport(providerName, mod, opts = {}) {
  if (typeof mod.listVoices !== "function") throw new Error(`provider "${providerName}" has no voice list; typecast and elevenlabs do (--provider typecast)`);
  const alias = opts.lang && typeof mod.languageCode === "function" ? mod.languageCode(opts.lang) : undefined;
  const shaped = shapeVoices(await mod.listVoices(), { lang: opts.lang, aliases: alias ? [alias] : [] });
  return formatVoiceList(providerName, shaped, opts);
}

/** The report: one voice per line, tab-separated after the id so a script can split it. */
export function formatVoiceList(provider, shaped, opts = {}) {
  const head = `voices (${provider}${opts.lang ? `, lang ${opts.lang}` : ""}): ${shaped.voices.length}${shaped.filtered ? ` of ${shaped.total}` : ""}`;
  const rows = shaped.voices.map((v) => [v.id, v.name, v.gender, v.age, v.uses.join("/"), v.languages.join(",")].join("\t"));
  const cols = "id\tname\tgender\tage\tuse\tlanguages";
  return [head, ...(shaped.note ? [`note: ${shaped.note}`] : []), ...(rows.length ? [cols, ...rows] : [])].join("\n") + "\n";
}
