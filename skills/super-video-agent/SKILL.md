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
   needs. When a source is given, keep its facts and every caution, and never invent numbers,
   names or claims it does not contain.
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
   (`references/script-review.md`: facts, story, spoken wording, listener, read-out, final read) so the
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
   length, whether they want to review the script before the voice, the order — voice first
   (default) or picture first; both make the base language's voice (the user's language) before
   the picture, and picture first then renders the picture once without captions so other
   languages are laid over it — recommend picture first when the picture renders slowly
   (3D/WebGL drawn on CPU, heavy effects) or several languages share one picture, for a 9:16
   film the voice speed (1.0–1.2×, default 1.1), and whether to compare a few tones on the
   opening line first (default when nobody can answer: no), if not given; start
   FILM.md (the listener: who watches and what they should think or do, and who speaks if a
   character does — the voice, how the character refers to themselves and how they look on
   screen agree, and the delivery fits that speaker; with several speakers, a line takes its own
   `voice` over `meta.voice` (`references/voice.md`); facts with where
   they came from, cautions, scope, the style choice, the tone choice, decisions, what the owner
   must supply)
2. Write the lines → plan.json, and while writing, decide what each visible event sounds like in
   this film. Look in the asset library first (`assets.mjs search`) and use a sound as a line
   `cue` only if it fits the event and the film's world (fit 8 or more, `references/sound.md`
   "Sound cards"); where nothing fits, make the sound for this film
   → review passes until a full read changes nothing; estimate the length before any synthesis
     (`validate-plan.mjs --estimate`, `references/script-review.md`) — a length check only; the
     voice still sets the clock
   → if the user wants to review: show the whole script (text, and say where it differs) and
     wait; apply their edits, then continue
   → if a tone comparison was requested: make the opening line in 2–4 tones chosen freely for
     this film from the full emotion list (`EMOTIONS` in `scripts/lib/tags.mjs`; e.g.
     `confident`) with `voice.mjs --lines <openingId> --takes <tone>,<tone>`, show the comparison
     table, and install the user's pick (`--pick <id>=<k>`); the pick becomes the film's
     delivery (`meta.voice.delivery`) for every other line (`references/voice.md`)
   → make the voice once → voice/timings.json (measured line times); fix only STT flags
   → 3D in voice-first order: play the whole narration to the user and get a confirm before
     building scenes (a changed line length re-renders every later shot, and a 40 s 3D film
     took 11–20 min to render). Every other case: build the film and fix voice lines after
     (a 2D film re-renders only the changed shots in minutes; picture first only re-dubs)
3. `assets.mjs fetch`, then build scenes onto the measured times: hardest frame first, look at
   it, fix it; then the rest
4. Render → look at a contact sheet → fix → repeat until it holds. After the sounds are built:
   write `sound-cards.json` → `sfx-cards.mjs measure`, `judge`, `report` (`references/sound.md`
   "Sound cards"); redesign any sound scoring fit < 8, re-measure, re-judge, up to 3 rounds
5. Final render; report numbers, what you looked at, what you did not check, and a few
   timestamps for the owner to listen to
```

**Skill defects.** Do not edit the skill's own files; work around a defect inside the reel. List
each one in the final report under "Skill defects" (what broke, how you worked around it). Then
ask the user whether to report them to the makers. Only on a yes: open a prefilled issue at
https://github.com/ww-w-ai/super-video-agent/issues/new?template=skill-defect.md (or `gh issue
create --repo ww-w-ai/super-video-agent` when `gh` is signed in), containing the defect, the
workaround, the steps to reproduce, the skill version and the tool output — never the user's
source, script, film or file paths.

### Four stages, four sessions

The film is made in four stages. Each stage reads only the files the stage before it left in the
reel folder, so run each one in a fresh session: a new session starts without the previous
stage's reading and tool output, which keeps its context for its own work. A 3D film with its
own characters adds a cast stage between voice and film.

| Stage | Flow steps | Reads | Leaves | Effort |
|---|---|---|---|---|
| Script | 1, 2 up to the first draft | the source, the user's direction | `plan.json` (draft), `script-v0.md` (the same draft, never edited again), `FILM.md` | xhigh |
| Review | 2: the review passes | `plan.json`, `FILM.md`, the source | the locked `plan.json`; the review record in `FILM.md` | low |
| Voice | 2 from "make the voice" | `plan.json` | `voice/` with `timings.json` in the base language, in either order; STT flags handled | low |
| Cast (3D films with their own characters) | between 2 and 3 | `plan.json`, `FILM.md` (who appears, in which lines, doing what) | the character and prop GLBs, a lineup still the owner approved, the contract table in `FILM.md` (`references/3d.md`) | xhigh |
| Film | 3–5 | `plan.json`, `voice/`, `FILM.md`, the source (and the cast files) | `reel.html`, `out/final.mp4`, the report | xhigh |

A stage ends only when its files are written, and its notes count as files: a stage or a probe
writes what it found (in `FILM.md` or the probe's own notes) before it ends, because the next
stage reads the notes, not the session. Wait for any job it started — synthesis, render — to
finish before the session ends; a job left running dies with the session. When one session has
to do everything, keep the same order and the same hand-off files.

In the film stage `reel.html` is the only source of the film. Make every later edit in it, and
keep no draft or generator script that could be copied back over those edits.

When the user asks to fix only some scenes, change only those: regenerate only the changed
lines' voice (`voice.mjs --lines`), re-render only those shots (`render.mjs --only`), and let
the renderer splice them into the existing film (`references/pipeline.md`).

### Picture first

"Picture first" does not mean the picture comes before the voice. The base is the user's
language: build its `voice/` first, same as always, and build the picture on its timings. Other
languages come after, as variations over that picture. The picture itself renders once, with no caption baked in
(`render.mjs --no-captions`), and every language — including the base one — is laid over it with
`dub.mjs`, each in its own `dub/<code>/`. A language whose lines run longer than the base
language's is sped up to fit (up to 1.2×) or the film reports which lines to shorten; the picture
never moves unless you ask for it (`--min-gap`, below) and no other language's lines run long
because of it (`references/pipeline.md`).
A film with its own caption look (word-by-word highlight, emphasis colours) keeps that look in
every dub — write `drawCaptions(t)` in `reel.html` (the scaffold's reference implementation) and
declare `"captions"` in `__reel.layers`; otherwise `dub.mjs` falls back to the engine's default
caption box and says so. Judge each language's line by the silence after it, not by how much of
its slot it fills: a line that fills its slot leaves no breath before the next one and sounds
rushed. About 0.5 s after each line, or the base line's own pause if that is longer, is a
starting point, not a limit. When `dub.mjs` warns about a line — a short gap after it, a fill
low enough that the scene sits in silence, or atempo — rewrite that line's wording and re-make
only it with `voice.mjs --lines`, up to 3 rounds, without asking. When the wording
cannot get shorter, `dub.mjs --min-gap <sec>` slows only the tight slots' picture and bed so each
gap reaches `<sec>`, voice speed unchanged (`references/pipeline.md`).

Frame size: let the user pick one of these (`new-reel.mjs --ratio`). If they did not say and
you can ask, ask; otherwise infer it from where the film goes.

| `--ratio` | Size | Where |
|---|---|---|
| `9:16` | 1080×1920 | vertical — YouTube Shorts, Reels, TikTok; voice speed from the user (1.0–1.2×) into `meta.voice.rate`; unanswered, 1.1 in every language and style, which `voice.mjs` fills in when the plan sets none (Fish: confident delivery by default) |
| `16:9` | 1920×1080 | horizontal — YouTube long-form, presentations |
| `1:1` | 1080×1080 | square — feed posts |
| `4:5` | 1080×1350 | portrait feed — Instagram, LinkedIn |

Style: at the start, ask the user which one to use.

| Style | What it means |
|---|---|
| Shorts formula | The shape popular Shorts converge on: hook first, fast, a banded frame with a fixed hook title (`references/shorts-formula.md`); story order and look stay yours |
| Free style | No preset; you invent the look and structure for this film |

Ask this together with frame size, length, the script review, the voice-first-or-picture-first
order and (for 9:16) the voice speed, in one question. If the user already said, do not ask
again. If nobody can answer (an unattended run), use free style, skip the script review, leave
the speed at 1.1, use voice first unless the brief names a slow 3D picture (then picture first),
and note these in `FILM.md`. Write the choice in `FILM.md` so the later stages follow it.

In free style, everything inside the frame (margins, caption size, layout) is your call, or the
user's if they specify it. Length: from the user; if unstated, ask, or infer it from where the
film goes. Language: the user's — the base language whose voice sets the clock; other languages
are dubbed over the picture (picture first).

When the user asks for an upload version with an opening or ending attached to a film (a channel
end card, a title card, a series episode), read `references/bookends.md`; otherwise skip it.

When the user asks for 3D in any words ("3D", "like a video game", "WebGL", "Three.js"), make a
3D film: scaffold with `new-reel.mjs --3d`, render picture first, and follow `references/3d.md`.
A short request is enough; fill in the camera move, the places and the look yourself.

When the user names an existing game, film, show or brand as the look ("like <title>"), take the
style from it — shapes, proportions, palette, mood, how things move — and describe it in your own
words in `FILM.md` (e.g. "round, big-headed characters, soft pastels, a cozy life-sim game
feel"). Never copy its characters, names, logos or signature designs, and never name it in the
film.

In either style, pictures fill the whole frame. Where the film is shown decides how much of it
text may use: on a platform that draws buttons over the video (Shorts, TikTok, Reels), text and
anything the viewer must see stay inside that platform's safe area (`references/pipeline.md`,
"Safe area"; `textBlock` and `caption` check it for you). Where nothing covers the video (a
messenger, a TV, a site player), `Reel.setSafeArea("none")` frees the whole frame, or set the
film's own margins. Keep the composition centred on the frame (x 540): avoiding a button column
must not shift titles, captions or pictures left.

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
| setup | `scripts/setup.mjs` — run once before the first script; `--check` only reports | Node dependency and Chromium installed in this folder; FFmpeg checked. A browser script run before setup stops with one line naming this command |
| scaffold | `scripts/new-reel.mjs <dir> --ratio 9:16\|16:9 [--3d\|--testbed]` | page with contract + optional helpers; `--3d` scaffolds a WebGL/three.js reel, `--testbed` a page that shows the GLBs in `assets/models/` one view per second for the cast stage (`references/3d.md`) |
| model facts | `scripts/glb-info.mjs <file.glb>` | roots, clips with lengths, node names as three.js's GLTFLoader sees them, morph targets, triangle counts — for the cast contract (`references/3d.md`) |
| script check | `scripts/validate-plan.mjs <dir> [--estimate] [--listener]` — run before the voice | `plan.json` matches the schema; every `word:` cue names a word in its line; `--estimate` the film length before synthesis, `--listener` the ending and punctuation counts for pass 4 (`references/script-review.md`) |
| voice | `scripts/voice.mjs <dir>` | per-line audio + measured `voice/timings.json`; takes, picking and pauses in a finished take (`references/voice.md`) |
| look | `scripts/still.mjs <dir> --at <t\|shotId>[,<t\|shotId>...]`; `--sheet <out.png> <a.png> ...` | one full-size PNG per value, one browser session; `--sheet` tiles PNGs you already have into one sheet |
| assets | `scripts/assets.mjs search <words>` / `fetch <dir>` | recorded sound effects and reaction clips from `library/` (git-ignored; licenses in `references/pipeline.md`) |
| sound cards | `scripts/sfx-cards.mjs measure\|judge\|report <dir>` | fills each sound card's measured audio features, scores its fit (Jev or the current model), and warns on fit < 8 (`references/sound.md` "Sound cards") |
| check | `scripts/verify.mjs <dir>` | determinism (warm and cold first-seek probes) + contract scan + `boil(` call-site info line |
| poke-through (3D) | `scripts/overlap.mjs <dir> [--step <frames>] [--out <json>]` | per cover/part pair, the frame spans where the page hook `window.__reel.overlap(t)` counts vertices on the wrong side; reports only, never fails (`references/3d.md` "Covers and soft bodies") |
| review | `scripts/render.mjs <dir> --preview` then `scripts/review.mjs <dir>` | contact sheet, dead-air runs, A/V sync, loudness, sync marks |
| dense layout scan | `scripts/review.mjs <dir> --scan [stepSec] [--layer captions [--dub <code>]]` | issue runs with times from seeking the whole film every `stepSec` (default 0.1s), catching a layout bug the once-per-shot Layout gate misses; `--layer captions` scans only the overlay layer, fast on a slow 3D picture |
| file review | `scripts/review.mjs --file <mp4>` | a finished or joined file with no page: A/V stream lengths, loudness whole and per part, dead air, black frames (`references/qa.md`) |
| picture-only probe | `still.mjs`, `verify.mjs`, `render.mjs` with `--stub <sec>` | runs on a reel with no `voice/timings.json` yet, as one silent line of that length |
| final | `scripts/render.mjs <dir>` | `out/final-<YYYYMMDD-HHMMSS>.mp4` at -16 LUFS; `out/final.mp4` links to the newest |
| picture (picture first) | `scripts/render.mjs <dir> --no-captions [--insert <clip.mp4>@<sec>]` | `out/picture.mp4` (video only) + `out/picture.bed.wav` + `out/picture.timings.json` — the picture, rendered once, no caption baked in; `--insert` puts an approved clip in from `<sec>` (`references/pipeline.md`) |
| language (picture first) | `scripts/dub.mjs <dir> --lang <code> [--min-gap <sec>]` | `out/final-<code>.mp4` — that language's caption + voice laid over `out/picture.mp4`; `--min-gap` widens the tight slots for that language |
| upload version (on demand) | `scripts/join.mjs <out.mp4> <part1> <part2> [...]` | joins an opening + body + ending (any count, any order) into one file, and reports each join's loudness, click risk and frame match (`references/bookends.md`) |

## Support reading (optional, read when useful)

| File | What is in it |
|---|---|
| `references/community.md` | How the viral Opus 5.5 films were prompted and built — read first |
| `references/3d.md` | WebGL/three.js films — when to use them, capture path, determinism, speed, characters and the cast stage |
| `references/shorts-formula.md` | The Shorts formula: structure, pacing, banded layout, captions — only when the user chose it |
| `references/sources.md` | Getting material out of each source type |
| `references/craft.md` | Observations from earlier films and the failures viewers called out |
| `references/sound.md` | Effects on visible events, music bed, mix |
| `references/script-review.md` | The review passes a script goes through before the voice is made |
| `references/voice.md` | Voice providers, cloning, pronunciation |
| `references/qa.md` | What the review numbers mean and what they cannot see |
