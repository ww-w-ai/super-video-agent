// Delivery marks ({pause}, {confident}): each engine gets them in its own tags, or not at all;
// the speech-to-text check and caption word timings never see them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTags, forEngine, unknownMarks, applyDeliveryMark } from "../scripts/lib/tags.mjs";
import { compareLine, isGrossMismatch } from "../scripts/lib/stt-compare.mjs";
import * as fish from "../scripts/voice/fish.mjs";
import * as elevenlabs from "../scripts/voice/elevenlabs.mjs";
import * as qwen3 from "../scripts/voice/qwen3.mjs";

const MARKED = "{confident} 텔레칩스도 할 수 있고, {pause} 해야 합니다.";
const PLAIN = "텔레칩스도 할 수 있고, 해야 합니다.";

test("forEngine: Fish S2 gets its own tags", () => {
  assert.equal(forEngine(MARKED, fish, {}), "[confident] 텔레칩스도 할 수 있고, [break] 해야 합니다.");
  assert.equal(forEngine("{emphasis} 지금", fish, { model: "s2.1-pro" }), "[emphasis] 지금");
});

test("forEngine: Eleven v3/v4 get theirs, and a mark with no v3 tag is dropped", () => {
  assert.equal(forEngine(MARKED, elevenlabs, { model: "eleven_v3" }), "[confident] 텔레칩스도 할 수 있고, [pauses] 해야 합니다.");
  assert.equal(forEngine("{emphasis} 지금 {sigh}", elevenlabs, { model: "eleven_v4" }), "지금 [sighs]");
});

test("forEngine: engines and models that read no tags get plain text, native tags included", () => {
  assert.equal(forEngine(MARKED, fish, { model: "s1" }), PLAIN);
  assert.equal(forEngine(MARKED, elevenlabs, {}), PLAIN);
  assert.equal(forEngine(MARKED, qwen3, {}), PLAIN);
  assert.equal(forEngine("[whispers sweetly] 안녕", qwen3, {}), "안녕");
  assert.equal(forEngine("[whispers sweetly] 안녕", fish, {}), "[whispers sweetly] 안녕");
});

test("applyDeliveryMark: prepends the film's delivery emotion when the line has none", () => {
  assert.equal(applyDeliveryMark(PLAIN, "confident"), `{confident} ${PLAIN}`);
});

test("applyDeliveryMark: a line's own emotion mark wins, the film delivery is not added", () => {
  assert.equal(applyDeliveryMark(MARKED, "sad"), MARKED);
});

test("applyDeliveryMark: no-op with no delivery, or a delivery outside EMOTIONS", () => {
  assert.equal(applyDeliveryMark(PLAIN, undefined), PLAIN);
  assert.equal(applyDeliveryMark(PLAIN, "dance"), PLAIN);
});

test("unknownMarks: names a mark that is neither ours nor an emotion", () => {
  assert.deepEqual(unknownMarks("{pause} {confident} {dance} 안녕"), ["dance"]);
  assert.equal(forEngine("{dance} 안녕", fish, {}), "안녕");
});

test("stripTags / compareLine: marks and native tags are never counted as heard words", () => {
  assert.equal(stripTags(MARKED), PLAIN);
  assert.equal(stripTags("[in a hurry tone] 빨리 가요 [laughs]."), "빨리 가요.");
  // The caption spells MCP, the voice says 엠씨피: only the say target can match.
  const { cer, against } = compareLine({
    text: "파로스 MCP를 공개했습니다.",
    say: "{confident} 파로스 엠씨피를 {pause} 공개했습니다.",
    heard: "파로스 엠씨피를 공개했습니다",
  });
  assert.equal(against, "say");
  assert.equal(cer, 0);
  assert.equal(isGrossMismatch(MARKED, "텔레칩스도 할 수 있고 해야 합니다", 0), false);
});

test("alignmentWithoutTags: tag characters never become caption words", () => {
  const sent = "[excited] 안녕 [pauses] 세상";
  const characters = [...sent];
  const starts = characters.map((_, i) => i * 0.1);
  const ends = characters.map((_, i) => i * 0.1 + 0.1);
  const out = elevenlabs.alignmentWithoutTags({
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  });
  assert.equal(out.text.split(/\s+/).filter(Boolean).join(" "), "안녕 세상");
  assert.equal(out.text.length, out.starts.length);
  assert.equal(out.starts[out.text.indexOf("안")], starts[sent.indexOf("안")]);
});
