# Super Video Agent — design

[English](design.md) | 한국어

## 1. 무엇을 하는가

카드뉴스 이미지, 기사 텍스트, 블로그 URL, 유튜브 URL, 이미지 묶음, 주제 중 무엇이든 선택적 사용자
지시와 함께 입력하면 → 완성된 내레이션 영상이 나온다. 기본값은 1080×1920, 30 fps. 모든 프레임은 하나의
HTML 페이지 안에서 코드로 그려지고, 헤드리스 브라우저가 프레임을 캡처하며, ffmpeg가 인코딩하고 먹싱한다.

고유한 표현 방식:
요소별 **단계적 흔들림(stepped boil)**(포즈를 N프레임 동안 유지한 뒤 다시 시드를 바꿈)으로 화면이
얼어붙은 것처럼 보이지 않게 하면서, 읽어야 하는 텍스트(자막)는 고정된 채로 둔다.

## 2. 아키텍처

```
reels/<slug>/
  source/        inputs as received (images, fetched text, transcript)
  brief.md       facts extracted from the source, each with a source pointer
  style.md       design language: extracted from the source, or chosen and justified
  plan.json      lines (one sentence = one scene), per-line visual intent, voice settings
  voice/         line-NN.wav, narration.wav, timings.json   (measured, never guessed)
  reel.html      the film: engine + scenes; exposes window.__reel
  assets/        images and fonts the page loads (copied, never hot-linked)
  out/           frames sheets, review.json, preview.mp4, final.mp4   (disposable)
```

데이터는 한 방향으로만 흐른다: `plan.json → voice.mjs → timings.json → reel.html reads timings →
render.mjs → out/*.mp4 → review.mjs → fix list`. `timings.json`이 유일한 타임라인 기준이며, 페이지는
모든 샷의 시작/끝을 여기서 계산한다. 자체 상수에서 계산하지 않는다.

### 2.1 페이지 계약 (`window.__reel`)

```
window.__reel = {
  width, height, fps, duration,      // numbers; duration from timings.json
  ready,                              // Promise: fonts + images loaded
  seek(t),                            // draw time t; pure function of t; may return a Promise
  shots: [{id, start, end, readAt}],  // derived from timings; readAt = representative moment
  issues(),                           // layout problems recorded by engine helpers (text overflow)
  audio: { narration: "voice/narration.wav", renderSfx?: (sampleRate) => Float32Array[2] }
}
```

규칙(`verify.mjs`의 정적 스캔이 앞의 네 가지를 강제한다):
- 장면 코드 안에 `Math.random`, `Date`, `performance.now`, `requestAnimationFrame`, 타이머, `fetch`를
  쓸 수 없다. 무작위성은 오직 `rng(key)`에서만 가져온다.
- `seek(t)`의 결과는 seek 이력과 무관하다(임의 순서로 seek해도 같은 픽셀이 나온다).
- `<canvas>`는 하나만 쓴다; DOM 애니메이션도, CSS 트랜지션도 없다.
- 렌더링 시점에는 네트워크를 쓰지 않는다: 에셋은 `assets/`에 복사해 둔다.
- 읽어야 하는 텍스트(자막, 헤드라인)는 흔들리지 않는다. 그래픽과 주석은 흔들린다.

### 2.2 엔진 (`scripts/engine/reel-engine.js`, 각 reel.html에 인라인으로 포함)

결정론적 헬퍼들이며, 각각 순수 함수다:
- `hash(str)`, `rng(key)`(문자열 해시 위의 mulberry32).
- `boil(key, t, {hz=8, amp=1.2, rot=0.35})` → `rng(key + ":" + floor(t*hz))`에서 나온 `{dx, dy, rot}`.
  매끄럽지 않고 단계적으로 변한다.
- `wobblePath(points, key, t, {hz, amp, step})` → 단계적 노이즈로 흔든, 점이 촘촘해진 폴리라인.
- `hold(t, step)` 시간을 양자화한다(on-twos = 2/fps).
- 그리기 헬퍼: `drawOn(path, u)`(마크가 순서대로 그려짐), `imageCover`, `textBlock`(줄바꿈하고 넘침을
  issues에 기록), `caption(line, t)`.
- 이징: `easeOutCubic`, `easeOutBack`, `settle`.
- 타임라인: `timeline(timings)` → `{line(i) -> {start,end,u(t)}, word(i,j) -> time}`; 단어별 시간은
  제공자의 정렬 정보를 쓰고, 없으면 측정된 줄 안에서 글자 수 비례로 계산한다.

### 2.3 스크립트 (`scripts/*.mjs`, Node ≥ 22, Playwright + ffmpeg)

| 스크립트 | 한 줄 요약 |
|---|---|
| `new-reel.mjs <dir> --ratio 9:16` | 템플릿 reel.html, 인라인 엔진, 복사된 폰트로 릴 폴더를 만든다. |
| `validate-plan.mjs <dir>` | plan.json을 스키마로 검사하고, 실패한 경로와 함께 0이 아닌 코드로 종료한다. |
| `voice.mjs <dir> [--provider qwen3\|melotts\|fishspeech\|fish\|elevenlabs\|say\|file\|none]` | 각 줄을 합성하고 길이를 측정해 narration.wav + timings.json을 쓴다. |
| `still.mjs <dir> --at <t\|shotId> [--out png]` | 원본 크기로 프레임 하나를 렌더링한다. |
| `verify.mjs <dir>` | 정적 계약 스캔 + 결정론 검사(순서대로/뒤섞은 seek 비교, 픽셀 해시). |
| `render.mjs <dir> [--preview] [--workers N] [--plan] [--only ids]` | 샷 단위로 렌더링하고(안 바뀐 것은 재사용), 이어붙이고, 전체 영상 오디오(내레이션 + 페이지 SFX)를 먹싱하고, 라우드니스를 정규화한다. |
| `review.mjs <dir> [--mp4 path]` | 각 샷의 readAt 시점 콘택트 시트, 무음 구간, 흔들림 주기, 오디오/비디오 길이 차이, 엔진 issues를 review.json으로 만든다. |

음성 제공자는 하나의 인터페이스를 공유한다(`scripts/voice/<name>.mjs`):
`synth({text, voice, lang, params}) → {wavPath, words?: [{w, start, end}]}`와 선택적으로
`clone({samplePath}) → voiceId`. 환경 변수: `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `SAY_VOICE`(기본값 `Yuna`).

### 2.4 QA 기준값 (기본값, plan.json에서 조정 가능)

- 무음: 픽셀 변화가 0.2 % 미만인 구간이 0.8 s 이상 이어지지 않아야 한다(64-px 그레이스케일 차이 기준).
- 흔들림 확인: 전환 장면이 아닌 프레임에서 포즈 변화가 계획된 주기대로 일어난다(±1 프레임).
- 오디오/비디오: 영상과 내레이션 길이 차이가 50 ms 이하이며, 마지막 줄이 마지막 프레임보다 먼저 끝난다.
- 결정론: 뒤섞은 순서로 seek한 해시와 순서대로 seek한 해시가 샷 경계를 포함한 12개 이상의 확인 시점에서
  같아야 한다.
- 레이아웃: `issues()`가 비어 있어야 한다(텍스트 넘침 없음, 안전 영역 밖으로 나간 것 없음).

### 2.5 에셋 라이브러리 (효과음과 리액션 클립)

녹음된 효과음과 짧은 리액션 클립("짤")은 사용자가 스킬 폴더 안 `library/`에 보관하는 로컬
라이브러리에서 가져온다. `library/`는 git에서 제외되어 있다: 라이브러리의 파일은 대부분 제3자 권리가
걸려 있기 때문에 공개되지 않는다.

- **라이브러리** = `catalog.json`과 파일들이 들어 있는 폴더. `<skill>/library/`에서 자동으로 찾고,
  `SVA_ASSET_LIB`가 위치를 대신한다. 라이브러리가 없으면 이전과 똑같이 동작한다(합성 효과음만 사용).
  `catalog.json`: `{version: 1, assets: [{id, role: "sfx"|"reaction", kind: "audio"|"video",
  path, description, tags[], durationSec, width?, height?, hasAudio, license: {kind,
  commercialSafe}}]}`. `path`는 라이브러리 폴더 기준 상대 경로다.
- **대본 단계에서 선택한다.** 한 줄은 `cues`를 가질 수 있다: `[{asset, at, offsetMs?, gainDb?,
  maxSec?, play?}]`. `at` = `"start"` | `"end"` | `"word:<text>"`(자막에서 `<text>`가 포함된 첫
  단어). `play` = `"sound"` | `"picture"` | `"both"`; role이 sfx면 기본값 `sound`, reaction이면
  기본값 `both`. 소리가 있는 리액션은 내레이션이 멈추는 곳에 들어간다: 해당 줄의 `pauseAfterMs`가
  클립 길이를 감당하고, `at: "end"`로 지정한다.
- **`assets.mjs`**: `search <query> [--role] [--limit]`는 설명과 태그에서 키워드로 일치하는 항목을
  길이·라이선스와 함께 나열한다. `fetch <dir>`는 큐로 지정된 모든 에셋을 `<dir>/assets/lib/`에
  복사한다: 오디오는 그대로, 비디오는 계획의 fps에 맞춘 JPEG 프레임과 wav로 된 오디오 트랙으로
  복사하며, `assets/lib/manifest.json`(에셋별로 files, durationSec, frames, fps, size,
  license)과 `assets/lib/cues.json`(계획의 cues)을 쓴다. `commercialSafe`가 false인 에셋은
  `plan.meta.distribution`이 `"personal"`이거나 호출에 `--allow-personal-scope`를 붙이지 않으면
  거부한다; 어느 경우든 가져온 모든 에셋의 라이선스가 출력되고 manifest에 기록된다.
- 엔진 안의 **하나의 큐 시간 함수**(`Reel.cueTime(cue, line, timings)`)를 페이지가 사용해 픽처 큐를
  그리고, `render.mjs`도 이 함수를(페이지를 거쳐) 사용해 사운드 큐 위치를 정한다.
  `__reel.soundCues()`는 `[{file, at, gainDb, maxSec}]`를 반환한다.
- **픽처**: `Reel.clipFrame(id, tLocal)`은 클립의 로컬 시간(frame = floor(tLocal × fps), 마지막
  프레임에서 정지)에 해당하는 미리 로드된 프레임 이미지를 반환하며, 장면은 이를 `imageCover`로
  그린다. 결정론적이다: 같은 t는 항상 같은 프레임을 그린다.
- **사운드**: `render.mjs`는 각 사운드 큐를 영상 오디오에 믹스한다: `maxSec`(또는 클립 길이)만큼
  자르고, 30 ms 페이드아웃, -6 dBFS로 피크 정규화한 뒤 `gainDb`를 적용하고, 지정된 시간만큼
  지연시켜, 내레이션과 페이지 효과음에 합산한 뒤 마지막 라우드니스 패스를 거친다.

## 3. 범위 밖 (첫 버전)

토킹 헤드 리스타일링, AI 영상 생성 모델, 단순 Web Audio SFX를 넘어서는 음악 작곡, 플랫폼 자동 업로드.
