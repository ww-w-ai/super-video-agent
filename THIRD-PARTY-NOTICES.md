# Third-party notices

Super Video Agent bundles no third-party code, fonts, sounds or model weights. The dependencies below are
installed separately, on your machine, under their own licenses.

| Dependency | License | Used for |
|---|---|---|
| [Playwright](https://github.com/microsoft/playwright) (`playwright-core`) | Apache-2.0 | Headless Chromium that renders each frame |
| [FFmpeg](https://ffmpeg.org) | LGPL/GPL (your build) | Encoding, muxing, audio analysis |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | Apache-2.0 | Default voice-cloning provider |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | MIT | Speech-to-text check of every generated line |
| [MeloTTS](https://github.com/myshell-ai/MeloTTS) | MIT | Optional voice provider |
| [Fish-Speech / OpenAudio S1-mini](https://github.com/fishaudio/fish-speech) | Weights CC-BY-NC-SA-4.0 | Optional; its model weights are licensed for non-commercial use, and Super Video Agent warns on every use |
| [Pretendard](https://github.com/orioncactus/pretendard) | SIL OFL 1.1 | Default Korean/Latin typeface when installed on your system; copied into a reel at scaffold time |
