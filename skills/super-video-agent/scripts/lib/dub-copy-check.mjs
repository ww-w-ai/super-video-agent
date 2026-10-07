// Caption copies are checked against the current plan and live base narration, not frozen picture slots.
import { sameLanguageTag } from "./lang-tag.mjs";

export function staleDubText({ dubPlan, dubTimings, basePlan, baseTimings }) {
  const findings = [];
  const planLines = new Map((dubPlan.lines || []).map((line) => [line.id, line]));
  const baseLines = new Map((baseTimings?.lines || []).map((line) => [line.id, line]));
  const basePlanLines = new Map((basePlan?.lines || []).map((line) => [line.id, line]));
  const seen = new Set();
  for (const line of dubTimings.lines || []) {
    seen.add(line.id);
    const planned = planLines.get(line.id);
    if (!planned) findings.push({ id: line.id, source: "dub plan", reason: "timing line is absent from the plan" });
    else if (line.text !== planned.text) findings.push({ id: line.id, source: "dub plan", reason: "caption text differs", copied: line.text, current: planned.text });
    const base = baseLines.get(line.id);
    if (!base || !planned) continue;
    const dubLang = planned.lang || dubPlan.meta?.lang;
    const baseLang = basePlanLines.get(line.id)?.lang || basePlan?.meta?.lang || baseTimings.lang;
    if (sameLanguageTag(dubLang, baseLang) !== true) continue; // translated lines are intentional
    if (line.text !== base.text) findings.push({ id: line.id, source: "base voice timings", reason: "same-language caption text differs", copied: line.text, current: base.text });
  }
  for (const line of planLines.values()) if (!seen.has(line.id)) findings.push({ id: line.id, source: "dub voice timings", reason: "plan line is absent from copied timings" });
  return findings;
}

export function formatStaleDubText(findings) {
  return findings.map((finding) => `WARN: dub line "${finding.id}": ${finding.reason} against ${finding.source}${finding.current == null ? "" : `; copied ${JSON.stringify(finding.copied)}, current ${JSON.stringify(finding.current)}`}. Refresh the copied timings and matching audio before captions.\n`).join("");
}
