// Caption words timed from measured spoken words (engine alignment or speech-to-text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { wordsOnCaption } from "../scripts/lib/timing.mjs";

const t = (w, start, end) => ({ w, start, end });

test("wordsOnCaption: same word count pairs in order, keeping the caption's spelling", () => {
  const out = wordsOnCaption("파로스 MCP를 공개했습니다.", [t("파로스", 0.1, 0.5), t("엠씨피를", 0.6, 1.2), t("공개했습니다", 1.3, 2.0)], 10);
  assert.deepEqual(out.map((w) => w.w), ["파로스", "MCP를", "공개했습니다."]);
  assert.deepEqual(out.map((w) => [w.start, w.end]), [[10.1, 10.5], [10.6, 11.2], [11.3, 12.0]]);
});

test("wordsOnCaption: a pause between measured words stays a gap between caption words", () => {
  // Speech-to-text heard "할수" as one word, so the counts differ (caption 6, heard 5).
  const heard = [t("성호전자", 0.2, 0.8), t("그룹도", 0.8, 1.2), t("할수", 1.2, 1.5), t("있고", 1.5, 1.9), t("해야합니다", 2.9, 3.6)];
  const out = wordsOnCaption("성호전자 그룹도 할 수 있고, 해야 합니다.", heard);
  assert.equal(out.length, 7);
  const i = out.findIndex((w) => w.w === "해야");
  assert.ok(out[i].start >= 2.9, `해야 starts after the pause, got ${out[i].start}`);
  assert.ok(out[i - 1].end <= 1.9 + 1e-9, `있고, ends before the pause, got ${out[i - 1].end}`);
  for (let k = 1; k < out.length; k++) assert.ok(out[k].start >= out[k - 1].start, "times never run backwards");
  assert.ok(out[0].start >= 0.2 && out[out.length - 1].end <= 3.6 + 1e-9, "inside the measured span");
});

test("wordsOnCaption: nothing measured gives nothing, so the caller keeps its estimate", () => {
  assert.deepEqual(wordsOnCaption("안녕 세상", []), []);
  assert.deepEqual(wordsOnCaption("", [t("안녕", 0, 1)]), []);
});
