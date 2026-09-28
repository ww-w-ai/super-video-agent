---
name: super-video-agent
description: Make a narrated video drawn in code from any source. Use for any video, short, reel, promo or explainer — 영상·쇼츠·릴스·홍보영상, card news/images/article/blog/YouTube/topic → video — even unnamed. Not for editing footage or AI video models.
---

# Super Video Agent

Make one film from whatever the user hands you. Draw every frame in code, render it, watch your
own frames, fix, and deliver.

This skill follows how the viral Opus 5.5 code-drawn films were actually made
(`references/community.md`): the maker gave a premise and a tone — and the model chose the
tools, invented the look, and checked its own renders. Keep that freedom. Everything under `references/` and `scripts/` is support you may
use, adapt or ignore; none of it is a template.

## What you must hold

1. **The source is material, not the film.** Whatever the source is (card news, storyboard, deck,
   article, URL, topic), take its words and pictures apart and use them.
   Words: tell it in your own lines for this film. Reorder, cut, merge or add a hook as the film
   needs. Keep the source's facts and every caution; never invent numbers, names or claims the
   source does not contain.
   Pictures: a deck or page is material to take photos, logos and facts from. Reusing a part is
   fine; reusing a whole scene as it is, is not. In every scene, at least half of the composition,
   layout and motion is made new for the film. Two things are never a scene: a capture of a page
   shown as it is, and a rebuild that keeps the page's card arrangement or positions.
   **Exception — the user supplied the words.** If the input includes a script, storyboard or
   narration, ask before writing: use it as written, or let you rework it? If nobody can answer
   (an unattended run), use it as written and note that in `FILM.md`. Used as written, split long
   sentences only at clause boundaries and give each piece its own picture, so no shot is held
   through a whole paragraph.
2. **Voice first; the voice sets the clock.** Generate the narration before building any scene.
   Its measured line and word times (`voice/timings.json`) are the film's timeline; build every
   scene to fit them. Never time scenes by estimate and fit the voice afterwards — synthetic
   voices land seconds away from any estimate. Review the script in passes before any synthesis
   (`references/script-review.md`: facts, story, spoken wording, read-out, final read) so the
   voice is made once.
   Every wording change after synthesis costs a re-synthesis and shifts every line after it.
   After the voice is made, change a line only to fix a real error (an STT flag, a misread),
   then regenerate its voice with `voice.mjs --lines <id>`. A pronunciation fix keeps the
   line's old time slot, so the film does not change: re-render only to remix the audio.
   While a scene or film session runs, its reel's `plan.json` and `voice/` are frozen: make
   voice fixes in a copy of those two, and bring them into the reel once, after the film is done.
   A film session never re-syncs to a voice that changed under it; it builds to the timings it
   started with and reports.
3. **Something changes every moment.** A new line brings a new picture. No frame
   sits frozen. No composition repeats while only the caption changes.
4. **Watch your own output.** Render frames, look at them, fix, repeat. You cannot watch motion or
   hear audio: every claim about either comes from a measurement or a frame you actually looked
   at. Say what you did not check.

## Flow

```
1. Read the source and the user's direction; ask style (Shorts formula or free), frame size,
   length, whether they want to review the script before the voice, and for a 9:16 film the
   voice speed (1.0–1.2×, default 1.1), if not given; start
   FILM.md (facts with where they came from, cautions, scope, the style choice, decisions, what
   the owner must supply)
2. Write the lines → plan.json, and while writing, pick sound effects and reaction clips from
   the asset library as line `cues` (`assets.mjs search`; skip if nothing fits)
   → review passes until a full read changes nothing
   → if the user wants to review: show the whole script (text, and say where it differs) and
     wait; apply their edits, then continue
   → make the voice once → voice/timings.json (measured line times); fix only STT flags
3. `assets.mjs fetch`, then build scenes onto the measured times: hardest frame first, look at
   it, fix it; then the rest
4. Render → look at a contact sheet → fix → repeat until it holds
5. Final render; report numbers, what you looked at, what you did not check, and a few
   timestamps for the owner to listen to
```

### Four stages, four sessions

The film is made in four stages. Each stage reads only the files the stage before it left in the
reel folder, so run each one in a fresh session: a new session starts without the previous
stage's reading and tool output, which keeps its context for its own work.

| Stage | Flow steps | Reads | Leaves | Effort |
|---|---|---|---|---|
| Script | 1, 2 up to the first draft | the source, the user's direction | `plan.json` (draft), `script-v0.md` (the same draft, never edited again), `FILM.md` | xhigh |
| Review | 2: the review passes | `plan.json`, `FILM.md`, the source | the locked `plan.json`; the review record in `FILM.md` | low |
| Voice | 2 from "make the voice" | `plan.json` | `voice/` with `timings.json`; STT flags handled | low |
| Film | 3–5 | `plan.json`, `voice/`, `FILM.md`, the source | `reel.html`, `out/final.mp4`, the report | xhigh |

A stage ends only when its files are written. Wait for any job it started — synthesis, render —
to finish before the session ends; a job left running dies with the session. When one session
has to do everything, keep the same order and the same hand-off files.

When the user asks to fix only some scenes, change only those: regenerate only the changed
lines' voice (`voice.mjs --lines`), re-render only those shots (`render.mjs --only`), and let
the renderer splice them into the existing film (`references/pipeline.md`).

Frame size: let the user pick one of these (`new-reel.mjs --ratio`). If they did not say and
you can ask, ask; otherwise infer it from where the film goes.

| `--ratio` | Size | Where |
|---|---|---|
| `9:16` | 1080×1920 | vertical — YouTube Shorts, Reels, TikTok; voice speed from the user (1.0–1.2×) into `meta.voice.rate`; unanswered, 1.1 in every language and style, which `voice.mjs` fills in when the plan sets none |
| `16:9` | 1920×1080 | horizontal — YouTube long-form, presentations |
| `1:1` | 1080×1080 | square — feed posts |
| `4:5` | 1080×1350 | portrait feed — Instagram, LinkedIn |

Style: at the start, ask the user which one to use.

| Style | What it means |
|---|---|
| Shorts formula | The shape popular Shorts converge on: hook first, fast, a banded frame with a fixed hook title (`references/shorts-formula.md`); story order and look stay yours |
| Free style | No preset; you invent the look and structure for this film |

Ask this together with frame size, length, the script review and (for 9:16) the voice speed, in
one question. If the user already said, do not ask again. If nobody can answer (an unattended
run), use free style, skip the script review, leave the speed at 1.1, and note these in `FILM.md`. Write the choice in `FILM.md` so the later stages follow it.

In free style, everything inside the frame (margins, caption size, layout) is your call, or the
user's if they specify it. Length: from the user; if unstated, ask, or infer it from where the
film goes. Language: the source's.

In either style, pictures fill the whole frame, but text and anything the viewer must see stay
inside the platform safe area, clear of the player's buttons (`references/pipeline.md`, "Safe
area"; `textBlock` and `caption` check it for you). Keep the composition centred on the frame
(x 540): avoiding the button column must not shift titles, captions or pictures left.

## Hard lines (these protect the owner, not the look)

- Facts come from the source: no numbers, names or claims it does not contain.
- A commercial film never uses a non-commercial voice model (`references/voice.md`).
- A library asset marked `commercialSafe: false` goes only into a film the owner marked
  personal (`meta.distribution`) or explicitly allowed; record every used asset's license in
  `FILM.md`.
- Anything you cannot produce (host footage, real screens, licensed music) goes in `FILM.md` under
  "Needs from the owner".

## Tools you can use

Use any tools you need — plain Canvas/SVG/WebGL and Web Audio in one HTML page is the proven
default, but a Python/numpy/cairo pipeline is equally valid. The bundled scripts save time if you
build on the `window.__reel` page contract (`references/pipeline.md`):

| Step | Script | Gives you |
|---|---|---|
| setup | `scripts/setup.mjs` — run once before the first script; `--check` only reports | Node dependency and Chromium installed in this folder; FFmpeg checked |
| scaffold | `scripts/new-reel.mjs <dir> --ratio 9:16\|16:9` | page with contract + optional helpers |
| script check | `scripts/validate-plan.mjs <dir>` — run before the voice | `plan.json` matches the schema; every `word:` cue names a word in its line |
| voice | `scripts/voice.mjs <dir>` | per-line audio + measured `voice/timings.json` (providers: `references/voice.md`) |
| look | `scripts/still.mjs <dir> --at <t\|shotId>[,<t\|shotId>...]` | one full-size PNG per value, one browser session |
| assets | `scripts/assets.mjs search <words>` / `fetch <dir>` | recorded sound effects and reaction clips from `library/` (git-ignored; licenses in `references/pipeline.md`) |
| check | `scripts/verify.mjs <dir>` | determinism + contract scan |
| review | `scripts/render.mjs <dir> --preview` then `scripts/review.mjs <dir>` | contact sheet, dead-air runs, A/V sync, loudness, sync marks |
| final | `scripts/render.mjs <dir>` | `out/final-<YYYYMMDD-HHMMSS>.mp4` at -16 LUFS; `out/final.mp4` links to the newest |

## Support reading (optional, read when useful)

| File | What is in it |
|---|---|
| `references/community.md` | How the viral Opus 5.5 films were prompted and built — read first |
| `references/shorts-formula.md` | The Shorts formula: structure, pacing, banded layout, captions — only when the user chose it |
| `references/sources.md` | Getting material out of each source type |
| `references/craft.md` | Observations from earlier films and the failures viewers called out |
| `references/sound.md` | Effects on visible events, music bed, mix |
| `references/script-review.md` | The review passes a script goes through before the voice is made |
| `references/voice.md` | Voice providers, cloning, pronunciation |
| `references/qa.md` | What the review numbers mean and what they cannot see |
