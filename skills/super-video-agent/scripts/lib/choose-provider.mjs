// Pure priority-order decision for voice.mjs's provider auto-choice
// (design.md §2.3): the caller resolves each condition from fs/env, this
// function only picks. Keeping it pure makes the priority order directly
// unit-testable without touching disk or environment variables.

/**
 * @param {{hasVoiceInDir?:boolean, qwen3PythonFound?:boolean, refAudioSet?:boolean,
 *   fishKeySet?:boolean, elevenKeySet?:boolean, melottsPythonFound?:boolean}} ctx
 * @returns {{provider:string, reason:string}}
 */
export function chooseProvider(ctx) {
  const c = ctx || {};
  if (c.hasVoiceInDir) {
    return { provider: "file", reason: "voice/in/ has user-provided line audio" };
  }
  if (c.qwen3PythonFound && c.refAudioSet) {
    return { provider: "qwen3", reason: "qwen3 python venv found and meta.voice.refAudio is set" };
  }
  if (c.fishKeySet) {
    return { provider: "fish", reason: "FISH_AUDIO_API_KEY is set" };
  }
  if (c.elevenKeySet) {
    return { provider: "elevenlabs", reason: "ELEVENLABS_API_KEY is set" };
  }
  if (c.melottsPythonFound) {
    return { provider: "melotts", reason: "melotts python venv found" };
  }
  return { provider: "say", reason: "zero-key macOS default" };
}
