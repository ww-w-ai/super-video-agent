// Builds <reel-dir>/sound-judge.md (the scoring sheet the film agent — "the
// current model" — fills by hand when no TYPESAFE_API_KEY/OPENROUTER_API_KEY
// is set, the normal case now) and the matching sound-scores.json template.
// references/sound.md "Sound cards".
import { FIT_CRITERIA, FIT_INSTRUCTIONS, FIT_THRESHOLD, describeMeasured } from "./sfx-judge-rubric.mjs";

/** @returns {string} a self-contained markdown scoring sheet. */
export function buildJudgeSheet(cards) {
  const lines = [
    "# Sound card scoring sheet",
    "",
    "No TYPESAFE_API_KEY or OPENROUTER_API_KEY is set, so nothing here was scored by Jev. Score every",
    "card below (fit, 1-10) as the rubric describes, then write them into `sound-scores.json`",
    '(one object per card: `{"id": "...", "fit": <1-10>, "backend": "manual", "reason": "<one sentence>"}`).',
    `\`sfx-cards.mjs report\` warns on any card scoring under ${FIT_THRESHOLD}.`,
    "",
    "## Rubric",
    "",
    FIT_INSTRUCTIONS,
    "",
    "| Score | Level |",
    "|---|---|",
    ...FIT_CRITERIA.map((level, i) => `| ${i + 1} | ${level} |`),
    "",
    "## Cards",
    "",
  ];
  for (const card of cards) {
    lines.push(`### ${card.id}`, "");
    lines.push(`- **at**: ${card.at}s`);
    lines.push(`- **event**: ${card.event}`);
    lines.push(`- **intent**: ${card.intent}`);
    lines.push(`- **this film's world/topic**: ${card.world || "(not given)"}`);
    lines.push(`- **recipe**: \`${JSON.stringify(card.recipe)}\``);
    lines.push(`- **measured**: ${describeMeasured(card.measured)}`);
    lines.push(`- **fit (1-10)**: `);
    lines.push(`- **reason**: `);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

/** @returns {object[]} a sound-scores.json template — one row per card, fit unset. */
export function buildScoresTemplate(cards) {
  return cards.map((card) => ({ id: card.id, fit: null, backend: "manual", reason: "" }));
}
