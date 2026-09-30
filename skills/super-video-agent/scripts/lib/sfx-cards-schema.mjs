// Shape validation for <reel-dir>/sound-cards.json (references/sound.md
// "Sound cards"). Hand-written, in the style of lib/schema-check.mjs — this
// shape is small enough not to need a JSON-Schema file of its own.

const RECIPE_KINDS = ["kit", "asset", "custom"];
const PITCH_TRENDS = ["rising", "falling", "flat", "none"];

/** @returns {string[]} errors; [] means valid. */
export function validateRecipe(recipe, path) {
  const errors = [];
  if (!recipe || typeof recipe !== "object") {
    errors.push(`${path}: missing or not an object`);
    return errors;
  }
  if (!RECIPE_KINDS.includes(recipe.kind)) {
    errors.push(`${path}.kind: must be one of ${JSON.stringify(RECIPE_KINDS)}, got ${JSON.stringify(recipe.kind)}`);
    return errors;
  }
  if (recipe.kind === "kit" && !recipe.kit) {
    errors.push(`${path}.kit: required when recipe.kind is "kit"`);
  }
  if (recipe.kind === "asset" && !recipe.assetId) {
    errors.push(`${path}.assetId: required when recipe.kind is "asset"`);
  }
  if (recipe.kind === "custom" && !recipe.custom) {
    errors.push(`${path}.custom: required when recipe.kind is "custom"`);
  }
  return errors;
}

/** @returns {string[]} errors; [] means valid. */
export function validateMeasured(measured, path) {
  const errors = [];
  if (measured == null) return errors; // optional until `measure` fills it
  if (typeof measured !== "object") {
    errors.push(`${path}: not an object`);
    return errors;
  }
  const numberFields = ["durationSec", "peakDb", "attackMs", "brightnessHz", "noisiness"];
  for (const f of numberFields) {
    if (typeof measured[f] !== "number" || Number.isNaN(measured[f])) {
      errors.push(`${path}.${f}: expected a number, got ${JSON.stringify(measured[f])}`);
    }
  }
  if (!PITCH_TRENDS.includes(measured.pitchTrend)) {
    errors.push(`${path}.pitchTrend: must be one of ${JSON.stringify(PITCH_TRENDS)}, got ${JSON.stringify(measured.pitchTrend)}`);
  }
  if (measured.lufs != null && typeof measured.lufs !== "number") {
    errors.push(`${path}.lufs: must be a number or null/absent, got ${JSON.stringify(measured.lufs)}`);
  }
  return errors;
}

/** @returns {string[]} errors; [] means valid. */
export function validateCard(card, path = "$") {
  const errors = [];
  if (!card || typeof card !== "object") {
    errors.push(`${path}: not an object`);
    return errors;
  }
  if (typeof card.id !== "string" || card.id.length === 0) {
    errors.push(`${path}.id: required non-empty string`);
  }
  if (typeof card.at !== "number" || Number.isNaN(card.at) || card.at < 0) {
    errors.push(`${path}.at: required non-negative number (seconds)`);
  }
  if (typeof card.event !== "string" || card.event.length === 0) {
    errors.push(`${path}.event: required non-empty string`);
  }
  if (typeof card.intent !== "string" || card.intent.length === 0) {
    errors.push(`${path}.intent: required non-empty string`);
  }
  if (card.world != null && typeof card.world !== "string") {
    errors.push(`${path}.world: must be a string when present`);
  }
  errors.push(...validateRecipe(card.recipe, `${path}.recipe`));
  errors.push(...validateMeasured(card.measured, `${path}.measured`));
  return errors;
}

/**
 * Validate a whole sound-cards.json array. Also checks id uniqueness — a
 * duplicate id makes `judge`/`report` ambiguous about which card a score
 * belongs to.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateCards(cards) {
  const errors = [];
  if (!Array.isArray(cards)) {
    return { valid: false, errors: ["$: sound-cards.json must be a JSON array"] };
  }
  const seenIds = new Set();
  cards.forEach((card, i) => {
    errors.push(...validateCard(card, `$[${i}]`));
    if (card && typeof card.id === "string") {
      if (seenIds.has(card.id)) errors.push(`$[${i}].id: duplicate id "${card.id}"`);
      seenIds.add(card.id);
    }
  });
  return { valid: errors.length === 0, errors };
}
