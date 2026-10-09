---
name: super-video-agent
description: Make a narrated video drawn in code from any source. Use for any video, short, reel, promo or explainer — 영상·쇼츠·릴스·홍보영상, card news/images/article/blog/YouTube/topic → video — even unnamed. Not for editing footage or AI video models.
---

# Super Video Agent

Make one film from whatever the user hands you. Draw every frame in code, render it, watch your
own frames, fix, and deliver.

This skill follows how the viral Opus 5.5 code-drawn films were actually made
(`references/community.md`): the maker gave a premise and a tone — and the model chose the
tools, invented the look, and checked its own renders. Keep that freedom. Everything under `guides/`, `references/` and `scripts/` is support you may
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
   scene to fit them. Align a scene change with the first spoken word of its sentence
   or clause. For a list or contrast, let each clause introduce its own picture.
   Mark the moment a key word is heard with a visual or sound effect, using the existing
   `word:` cues. Keep these anchors when revising. Avoid splitting every phrase when
   it would make the scene restless. Never time scenes by estimate and fit the voice afterwards — synthetic
   voices land seconds away from any estimate. Review the script in passes before any synthesis
   (`references/script-review.md`: facts, story, spoken wording, listener, read-out, final read) so the
   voice is made once.
   Every wording change after synthesis costs a re-synthesis and shifts every line after it.
   A film with no narration has no voice to set the clock: its clock is the step or scene timeline,
   written once as `voice/timings.json` and a silent `voice/narration.wav` by `scripts/silent-clock.mjs`
   (`references/assembly.md` "A film with no narration"). The review's silence gate then counts quiet
   between scenes (`references/sound.md` "A film with little or no narration").
   After the voice is made, change a line only to fix a confirmed error. STT flags are advisory
   evidence: compare the intended and recognized text before deciding to regenerate.
   Regenerate only the affected voice with `voice.mjs --lines <id>`. A pronunciation fix keeps the
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
5. **Rendering is the costliest work: reuse what exists.** Render or encode only the spans that
   changed (`render.mjs --span`, `--only` for browser pictures; affected Blender frames and
   reassembly in `references/blender.md`), copy the rest without re-encoding, and build what
   several versions share (a picture, a language-neutral span) once. Before any render, synthesis or
   dub, list what changed and make only that; redo the whole thing only when you can say in one line
   why the parts cannot be reused (`references/pipeline.md` "Render reuse").

## Flow

```
0. Brief: rewrite the user's request into seven slots (viewer and action, technique, flow, camera
   and transitions, facts and sources, voice and tone, size/length/language) and mark each slot
   "from the user" or "filled by the skill"; fill a gap from the source and the request, or ask
   it in step 1's one question round (no second round); unattended: fill it and note that. Write
   the result to `FILM.md` "Brief" before planning; every later stage reads it
   (`references/brief.md`). The user need not fill all seven
1. Read the source and the user's direction; ask style (Shorts formula or free), frame size,
   length (a target, not a limit: the film may run over when the story needs it), the opening: pick the three types in
   `references/openings.md` that fit this film best, recommend them with one line each on why,
   and offer a fourth choice, "recommend other types", the checkpoint level (how far they want to
   review before the film is finished: the storyboard, the script, the voice, or fully automatic;
   "Checkpoint levels" below), the order — voice first
   (default) or picture first; both make the base language's voice (the user's language) before
   the picture, and picture first then renders the picture once without captions so other
   languages are laid over it — recommend picture first when the picture renders slowly
   (3D/WebGL drawn on CPU, heavy effects) or several languages share one picture, for a 9:16
   film the voice speed (1.0–1.2×, default 1.1), and whether to compare a few tones on the
   opening line first (default when nobody can answer: no), if not given; start
   FILM.md with one line naming the skill version (`version` in the skill's `package.json`,
   e.g. `super-video-agent <version>`, the version the skill reports), then (the listener, from the Brief: who watches (one audience, or two when the film serves two, each with its own takeaway) and what they should think or do, and who speaks if a
   character does — the voice, how the character refers to themselves and how they look on
   screen agree, and the delivery fits that speaker; with several speakers, a line takes its own
   `voice` over `meta.voice` (`references/voice.md`); facts with where
   they came from, cautions, scope, the style choice, the tone choice, decisions, what the owner
   must supply; for every scene, the technique and why it fits, also in films without
   characters (`references/craft.md` "Named 2D techniques"); only when the film carries persistent
   labels or logos in one or more of the four corners: each corner used and its box, also as
   `meta.corners`, which the film stage keeps clear from the first build (`references/pipeline.md`
   "Corner reserve"))
2. Write the lines → plan.json, and while writing, decide what each visible event sounds like in
   this film. Look in the asset library first (`assets.mjs search`) and use a sound as a line
   `cue` only if it fits the event and the film's world (fit 8 or more, `references/sound.md`
   "Sound cards"); where nothing fits, make the sound for this film
   → review passes until a full read changes nothing; estimate the length before any synthesis
     (`validate-plan.mjs --estimate`, `references/script-review.md`) — a length check only; the
     voice still sets the clock
   → opening lead (the film's choice, not forced): if the film or the user wants a few seconds
     before the first story line, set `meta.lead` (seconds; `true` = 3 s) and give it sound — a
     music bed from t=0 (`meta.sound.bed`), a sound cue, sound the page makes itself (`meta.sound.page`), or an opening line marked `lead: true` —
     e.g. one that leads naturally into the next scene (`references/pipeline.md` "Timeline", `references/sound.md`
     "Lead sound"); absent = no lead
   → at the script level or higher: show the whole script as plain text in the conversation (and
     say where it differs) and wait; apply their edits, then continue
   → if a tone comparison was requested: make the opening line in 2–4 tones chosen freely for
     this film from the full emotion list (`EMOTIONS` in `scripts/lib/tags.mjs`; e.g.
     `confident`) with `voice.mjs --lines <openingId> --takes <tone>,<tone>`, show the comparison
     table, and install the user's pick (`--pick <id>=<k>`); the pick becomes the film's
     delivery (`meta.voice.delivery`) for every other line (`references/voice.md`)
   → make the voice once → voice/timings.json (measured line times); review STT evidence and fix confirmed errors
   → 3D in voice-first order: play the whole narration to the user and get a confirm before
     building scenes (a changed line length re-renders every later shot, and a 40 s 3D film
     took 11–20 min to render). Every other case: build the film and fix voice lines after
     (a 2D film re-renders only the changed shots in minutes; picture first only re-dubs)
3. From the first build, register every string drawn inside a browser picture with
   `Reel.pictureText(key, defaultText)`. For Blender picture text, use the keyed text table
   described in `references/blender.md`. Keep stable keys so another language can replace
   the text without searching scene code. `verify.mjs` reports direct unregistered
   language literals in `fillText` and identifies dynamic expressions for review.
   It is advisory, not proof that every drawing API or helper is covered.
   `assets.mjs fetch`, then build scenes onto the measured times: hardest frame first, look at
   it, fix it; then the rest. Build scene drafts on the locked voice slots; an approved draft can
   be the final segment (e.g. trim or speed only; when one element is fixed, keep the rest). One
   way is to render a draft shot with a short handle before and after its slot: `render.mjs --only
   <ids> --handle 0.5` (about 0.5 s each side is a starting point) writes `out/drafts/<id>.mp4` + `<id>.json`, so it
   can be trimmed or reused if the voice shifts a little; `--use-draft <id>` cuts the slot back
   out and splices it in without a page render. Rendering a draft a little longer than its
   slot and cutting it to fit is the same practice as generated video clips, which are made long
   and trimmed in the edit. The handle costs the extra frames (+25% for a 4 s shot at 0.5 s), and
   a film with slow 3D pictures may choose smaller handles
   For a demonstration clip, show the actual recorded result at the matching spoken
   moment. Modest playback-speed changes can help; judge whether motion still looks
   natural instead of forcing the clip to fill a slot. A final hold can be as short
   as a spoken breath, about 0.5 seconds. Keep the clip's effects below the narration.
   Prefer the existing clip insertion path; no separate demonstration tool is needed.
   For familiar reactions or gestures, try a stronger expression specific to this
   moment first. If it does not communicate better, use a familiar example: a brief
   celebration for a payoff, or a directional gesture toward comments or a description.
   These are examples, not a visual template or a required reusable hand asset.
4. Render → look at a contact sheet → fix → repeat until it holds. After the sounds are built:
   write `sound-cards.json` → `sfx-cards.mjs measure`, `judge`, `report` (`references/sound.md`
   "Sound cards"); redesign any sound scoring fit < 8, re-measure, re-judge, up to 3 rounds
5. Final render; report numbers, what you looked at, what you did not check, and a few
   timestamps for the owner to listen to; print the cost and time report to the user (below)
```

**Cost and time report.** After a film, print per stage the time, the sessions, the cost and the
tokens, and the speech-synthesis usage, in the final message. Stages run under the runner give it
by `scripts/runner/cost-report.mjs <film-dir>` (`references/unattended.md`). In a single session, report
what you measured and say what you could not measure; never estimate a figure.

### Checkpoint levels

The user's answer sets where the film stops for review. It applies to the whole film; ask once.

| Level | The film stops for the user | What to show |
|---|---|---|
| Storyboard | after the script, before the voice | the draft frames (`still.mjs` stills of the key shots, or sketches) together with each line, as one sheet |
| Script | after the review passes, before the voice | the whole script as plain text |
| Voice | after the voice, before the picture | the narration to listen to; `fit-track.mjs --draft` writes a track fitted to an existing picture even when some lines need more than the speed limit, listing them, so the user can hear it before the words are fixed |
| Fully automatic | never before the final | the final report |

The user may name more than one stop. Their changes to a storyboard go into the plan as each line's `visual`
field, so the film is built from what they approved. Unanswered or unattended: fully automatic, noted
in `FILM.md`.

### Revision rounds

When the owner asks for changes over several rounds, keep one cumulative list of every request they
have made in `FILM.md` ("Owner requests"), each with its state (done, open, changed by a later
request). Before a round starts, read the whole list and plan the round against it, so a new change does
not undo an earlier one. After the round, check the result against the same list and mark each item;
report any earlier request that no longer holds.

Before a revision round, choose a small tool-call budget for the requested changes.
Use the existing checks and the smallest useful preview. Avoid new measurement tables
or one-off analysis scripts for an ordinary revision. Measurements remain useful for
protecting an irreversible output or fixing a confirmed skill defect. When the budget
is spent, report what is unresolved and plan the next round. Group non-blocking findings
into that next planned step instead of starting a new investigation for each one.

For a changed line, preview from the preceding line's end to the following line's
start. At the film edges, use the film boundary. Prefer the current mixed encode so
picture, narration and bed are heard together. `scripts/preview-changes.mjs <reel-dir>
--lines <ids> --media <mixed.mp4>` overwrites its clips in `out/preview/`. For a dub,
pass its `--timings <timings.placed.json>`. Refresh the affected encode first; an old
encode cannot demonstrate a new edit. Silent drafts are not a mixed preview.

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
| Script | 0, 1, 2 up to the first draft | the source, the user's direction | `FILM.md` with the Brief, `plan.json` (draft), `script-v0.md` (the same draft, never edited again) | xhigh |
| Review | 2: the review passes | `plan.json`, `FILM.md` (Brief included), the source | the locked `plan.json`; the review record in `FILM.md` | low |
| Voice | 2 from "make the voice" | `plan.json` | `voice/` with `timings.json` in the base language, in either order; STT flags handled | low |
| Cast (3D films with their own characters) | between 2 and 3 | `plan.json`, `FILM.md` (who appears, in which lines, doing what; selected renderer) | character and prop assets for that renderer, an approved lineup still, the contract table in `FILM.md` (`references/3d.md` or `references/blender.md`) | xhigh |
| Film | 3–5 | `plan.json`, `voice/`, `FILM.md`, the source (and the cast files) | `reel.html`, Blender scene source when selected, final MP4, the report | xhigh |
| Language dub (one film, several language versions) | after the base voice | the locked base `plan.json`, `voice/timings.json` | `dub/<code>/plan.json`, `voice/`, `out/final-<code>.mp4` | medium |

The language dub stage is adaptation more than creation, so a lighter path is a good starting
point: write every language's `dub/<code>/plan.json` at once (no command scaffolds it; `references/pipeline.md` shows its shape), make the voice without a review before it,
fix the lines that fail, and run one review focused on caption breaks (`references/pipeline.md`).
Add passes where a language needs them; the creation stages keep their repeated review passes.

A language you cannot read yourself is reviewed by a separate session that acts as that language's
editor: it reads the lines as a native editor would (idiom, register, meaning, caption breaks) and
fixes what it finds, so no language ships unread. Run `scripts/punct-check.mjs <dir>`: it checks each
language's punctuation and script rules from the table in `references/pipeline.md` ("Punctuation and
script table"), reading the languages from the film's own plan and dub folders, not from a fixed set.
Extend the table when a language needs a rule it lacks (examples, not a menu: quote and dash forms,
spacing, numerals, the characters its writing system allows). Before you trust a new rule, show it
fails: run it on a deliberately wrong sentence and see it report that sentence. A check that has
never failed proves nothing. Its findings are facts; the editor session judges them.

A stage ends only when its files are written, and its notes count as files: a stage or a probe
writes what it found (in `FILM.md` or the probe's own notes) before it ends, because the next
stage reads the notes, not the session. Wait for any job it started — synthesis, render — to
finish before the session ends; a job left running dies with the session. When one session has
to do everything, keep the same order and the same hand-off files. When a script runs the stages
with nobody watching, read `references/unattended.md`.

Every stage ends by writing a stage report into `FILM.md`, in this shape, so the next stage reads
what was done, what was not, and what is asked of it:

```
## Stage report: <stage>
Done: what this stage made or changed
Files left: <path> - what it is (done markers, drafts and old drafts included)
Checked: what you looked at or measured, and the result
Not checked: what you did not look at, could not measure, or took on trust
Decisions: choices made and why
Needs from the owner: what only they can supply
Requests to next stage: what the next stage must do or watch for
```

"Not checked" is never left out; an empty list says "nothing", so a missing line cannot read as a
pass. "Files left" is the table the next stage uses to find drafts and done markers instead of
rebuilding them (`references/unattended.md` "Where the earlier stages left things").

For the browser renderer, `reel.html` is the only picture source. Make later edits there.
For Blender, keep the scene source and overlay source separate (`references/blender.md`).
Do not keep a stale generator that could overwrite later edits.

When the user asks to fix only some scenes, change only those: regenerate only the changed
lines' voice (`voice.mjs --lines`). For browser pictures, re-render only those shots
(`render.mjs --only`) and splice them into the existing film (`references/pipeline.md`).
For Blender pictures, render the affected frame ranges, reassemble and reinsert the picture,
then dub it (`references/blender.md`). Do not render the browser placeholder as a replacement.

### Picture first

"Picture first" does not mean the picture comes before the voice. The base is the user's
language: build its `voice/` first, same as always, and build the picture on its timings. Other
languages come after, as variations over that picture. The picture itself renders once, with no caption baked in
(`render.mjs --no-captions` for browser pictures; include the full-picture `--insert` for
Blender as described in `references/blender.md`), and every language — including the base one — is laid over it with
`dub.mjs`, each in its own `dub/<code>/`. A language whose lines run longer than the base
language's is sped up to fit (`dub.mjs` and `fit-track.mjs` fit a line by at most 10% faster, 5% slower by
default) or the film reports which lines to shorten; the picture
never moves unless you ask for it (`--min-gap`, below) and no other language's lines run long
because of it (`references/pipeline.md`).
When one film gets several language versions or several voice/subtitle versions, write every
language's lines to the same time slots from the start; the picture is not lengthened for a
language. Example words shown inside the picture in the source language can be localised or
translated per language version; IDs and handles usually stay as they are.
A film with its own caption look (word-by-word highlight, emphasis colours) keeps that look in
every dub — write `drawCaptions(t)` in `reel.html` (the scaffold's reference implementation) and
declare `"captions"` in `__reel.layers`; otherwise `dub.mjs` falls back to the engine's default
caption box and says so. Judge each language's line by the silence after it, against that
line's own scene rather than the base language: not so full that it runs into the next line
(at least 0.4 s), not so empty that the scene sits in silence (at most about a quarter of
the scene), anywhere in between is fine (`dub.mjs --table` lists each line). When `dub.mjs`
warns about a line — crammed, sparse, or atempo — inspect the timing first. Use local
pause or tempo edits when they solve the issue (`guides/audio-editing.md`). Rewrite and
regenerate only when local editing cannot solve it, up to 3 rounds. When the wording
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

Ask this together with frame size, length, the checkpoint level, the voice-first-or-picture-first
order and (for 9:16) the voice speed, in one question. If the user already said, do not ask
again. If nobody can answer (an unattended run), use free style, fully automatic (no review stop), use
your first opening pick, leave
the speed at 1.1, use voice first unless the brief names a slow 3D picture (then picture first),
and note these in `FILM.md`. Write the choice in `FILM.md` so the later stages follow it.

In free style, everything inside the frame (margins, caption size, layout) is your call, or the
user's if they specify it. Length: a target from the user, not a limit; if unstated, ask, or infer
it from where the film goes. Language: the user's — the base language whose voice sets the clock; other languages
are dubbed over the picture (picture first).

When the user asks for an upload version with an opening or ending attached to a film (a channel
end card, a title card, a series episode), read `references/bookends.md`; otherwise skip it.

When the user asks for 3D in any words ("3D", "like a video game", "WebGL", "Three.js"), make a
3D film and render picture first. Before authoring a new 3D film or its cast, run
`node <skill>/scripts/probe-blender.mjs`. Use Blender when its JSON says `engine: "blender"`;
follow `references/blender.md`. Otherwise scaffold with `new-reel.mjs --3d` and follow
`references/3d.md`. Record the result and selected executable in `FILM.md` for later stages.
Never install or download Blender for this choice. A missing, failed or timed-out probe uses
the existing Three.js path. A version check alone is not a successful probe.
An explicit renderer request takes precedence. Existing-film edits keep their current renderer.
Ordinary 2D films keep the browser path. This selection guides scene authoring; it does not
convert existing Three.js code into Blender or change `render.mjs` into a Blender renderer.
A short request is enough; fill in the camera move, the places and the look yourself. A "one take",
"no cuts" or "camera that never cuts" request is a continuous camera path (`references/3d.md` "Craft
that worked"). A photo or screenshot can go on a surface in the scene as a texture, an object
"at its official size" is modelled to published dimensions recorded with their date in `FILM.md`,
and "take it apart in layers" is an exploded view, one layer per spoken beat (all in `references/3d.md`).
Characters and sets built for an earlier film are reused, not rebuilt (`references/3d.md` "The cast stage").

When the user names an existing game, film, show or brand as the look ("like <title>"), take the
style from it — shapes, proportions, palette, mood, how things move — and describe it in your own
words in `FILM.md` (e.g. "round, big-headed characters, soft pastels, a cozy life-sim game
feel"). Never copy its characters, names, logos or signature designs, and never name it in the
film. A news desk, broadcast graphic or live-score look is drawn the same way, in code
(`references/craft.md` "Broadcast and news-desk screens").

In either style, pictures fill the whole frame. Where the film is shown decides how much of it
text may use: on a platform that draws buttons over the video (Shorts, TikTok, Reels), text and
anything the viewer must see stay inside that platform's safe area (`references/pipeline.md`,
"Safe area"; `textBlock` and `caption` check it for you). Where nothing covers the video (a
messenger, a TV, a site player), `Reel.setSafeArea("none")` frees the whole frame, or set the
film's own margins. Keep the composition centred on the frame (x 540): avoiding a button column
must not shift titles, captions or pictures left.

## Hard lines (these protect the owner, not the look)

- Facts come from the source: no numbers, names or claims it does not contain. For research or
  news films, check dates and figures against the primary official source and note the reference
  date in `FILM.md`; whether it also appears on screen is the film's call.
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
| setup | `scripts/setup.mjs [--check] [--dir <reel>] [--stt-models]` — run once before the first script; `--check` only reports | Node dependency and Chromium installed in this folder; FFmpeg checked; browser cache and render-folder disk, real GPU or software renderer (`SVA_GPU`), speech-to-text engines and models listed; `--dir` measures the reel's `out/`; `--stt-models` downloads the speech-to-text models. A browser script run before setup stops with one line naming this command |
| 3D renderer | `scripts/probe-blender.mjs` | JSON decision after an isolated EEVEE render; Blender if usable, otherwise Three.js; no installation |
| scaffold | `scripts/new-reel.mjs <dir> --ratio 9:16\|16:9 [--title "..."] [--fps 30] [--3d\|--testbed]` | page with contract + optional helpers; `--title` sets the page title (default: the folder name) and `--fps` the frame rate (default 30); `--3d` scaffolds a WebGL/three.js reel, `--testbed` a page that shows the GLBs in `assets/models/` one view per second for the cast stage (`references/3d.md`) |
| model facts | `scripts/glb-info.mjs <file.glb>` | roots, clips with lengths, node names as three.js's GLTFLoader sees them, morph targets, triangle counts — for the cast contract (`references/3d.md`) |
| script check | `scripts/validate-plan.mjs <dir> [--estimate] [--listener]` — run before the voice | `plan.json` matches the schema; every `word:` cue names a word in its line; `--estimate` the film length before synthesis, `--listener` the ending and punctuation counts for pass 4 (`references/script-review.md`) |
| voice | `scripts/voice.mjs <dir>`; `voice.mjs --list-voices [--lang <code>] [--provider <name>]` | per-line audio + measured `voice/timings.json`; takes, picking and pauses in a finished take; the provider's own voice list (`references/voice.md`) |
| look | `scripts/still.mjs <dir> --at <t\|shotId>[,<t\|shotId>...] [--no-captions \| --dub <code>] [--out-dir <dir>] [--no-warm]`; `--sheet <out.png> <a.png> ... [--cell <px>] [--cols N]` | one full-size PNG per value, one browser session; `--no-captions` draws the picture without the caption layer (as `render.mjs --no-captions`); `--dub <code>` shows that language's captions, labels and corner notes over its picture; `--sheet` tiles PNGs you already have into one sheet, 540 px tiles by default |
| assets | `scripts/assets.mjs search <words>` / `fetch <dir>` | recorded sound effects and reaction clips from the asset library: `SVA_ASSET_LIB` if set, else `~/.super-video-agent/library` (licenses in `references/pipeline.md`) |
| sound cards | `scripts/sfx-cards.mjs measure\|judge\|report <dir>` | fills each sound card's measured audio features, scores its fit (Jev or the current model), and warns on fit < 8 (`references/sound.md` "Sound cards") |
| check | `scripts/verify.mjs <dir> [--range <t0>-<t1> \| --only <shotIds> \| --world <key>]` | determinism (warm and cold first-seek probes) + contract scan of `reel.html` and `src/` + `boil(` call-site info line; a WebGL error fails it; `--range`/`--only`/`--world` probe one part of a long film |
| poke-through (3D) | `scripts/overlap.mjs <dir> [--step <frames>] [--out <json>]` | per cover/part pair, the frame spans where the page hook `window.__reel.overlap(t)` counts vertices on the wrong side; reports only, never fails (`references/3d.md` "Covers and soft bodies") |
| word times | `scripts/word-times.mjs <dir> [--threshold <ms>]` | re-measures word starts from `narration.wav` and lists words whose sound is off the recorded time; reports only (`references/qa.md`) |
| sound cue words | `scripts/cue-check.mjs <dir> [--threshold <ms>] [--page \| --marks <json>]` | warns when a `word:` cue word is missing from the line, not heard, interpolated or moved; `--page` (or `--marks`) also reads the sound events the page makes itself (`window.__reel.marks`) and reports each one against the recorded word times; reports only (`references/qa.md`) |
| page mix level | `scripts/mix-level.mjs <dir> [--under <dB>] [--bed <wav>] [--line <id> \| --voice-lufs <n>] [--out <json>]` | the page's own sound (`out/picture.bed.wav`) against a leveled narration line: the gap in dB, the page's true peak, and with `--under` the offset to add to the page's level; reports only (`references/sound.md` "Mix") |
| text, glyphs, flicker | `scripts/state-checks.mjs <dir> [--only overlap,glyphs,flicker,covers,reserve,langglyphs] [--range <t0>-<t1>]` | text boxes that overlap, characters drawn by a fallback font, one-frame flicker (source windows first, then every frame's state), labels over declared key regions (`covers`), picture text inside a corner box kept clear for a label or logo (`reserve`), characters a language's font lacks (`langglyphs`, the one check that exits 1); `--range` reads only those seconds; reports otherwise (`references/pipeline.md` "Checks and reports") |
| punctuation and script | `scripts/punct-check.mjs <dir> [--lang <code>,...]` | each language's caption text (plan.json and each dub/<code>/plan.json) against that language's row of the table in `references/pipeline.md`; a form that cannot be right exits 1 for that step, the rest is reported for the editor session |
| blink | `scripts/blink-check.mjs <dir> [--glb <file>]` | per character blink count, intervals, durations; flags blinks under ~100 ms, under 1.5 s apart, flutter; source first, then the page hook `window.__reel.blink(t)` (`references/3d.md`); reports only |
| cut-out rig joints (example) | `scripts/rig-check.mjs <dir> [--step <sec>] [--out <json>]` | per joint, the largest gap in px between a child's pivot and its parent's anchor over the film, and angles outside limits, from the page hook `window.__reel.rigCheck`; reports only; helper `scripts/engine/reel-rig.js` (`references/characters.md`) |
| mouth schedule (example) | `scripts/mouth.mjs <dir> [--dub <code>] [--mode amplitude\|steady] [--threshold <0-1>] [--rate <hz>] [--out <json>]` | per line, when the mouth is open (from the audio level, or at a steady rate), as JSON the page reads; no language model, and with several languages it may not match (`references/characters.md`) |
| tempo | `scripts/tempo.mjs --target <sec> --timeline <json>\|--timings <json> [--floor <sec>] [--out <json>]` | the speed factor that fits a timeline to a length, per step, floors respected; reports unless `--out` writes the fitted timeline (`references/assembly.md`) |
| silent clock | `scripts/silent-clock.mjs <dir> --timeline <json> [--fps <n>] [--force]` | for a film with no narration: `voice/timings.json` (one silent line per timeline item, exact starts and ends) and a silent `voice/narration.wav` of the film's length, so `render.mjs` final, `--span` and `--assemble` work; stops on a repeated id, overlap or an end past the duration, and on a real voice unless `--force`; gaps and off-grid edges are printed as facts (`references/assembly.md`) |
| model file reader | `scripts/ldraw-bake.mjs <model.mpd\|.ldr> --lib <parts-folder> --out <dir> [--until <n>] [--classes <json>] [--detail]` | a model in the LDraw text format (parts folder from the user) baked into `build.json` (tree, build order, per item matrix, colour, insertion direction, path check) and `parts.json` (geometry by colour as base64 floats, colours); a missing part stops and is named (`references/assembly.md` "Reading a model file") |
| surface crossing (example) | page helper `scripts/engine/reel-crossing.js` (the baker runs the same code) | whether a part's path crosses the triangles of parts already placed; use it in `window.__reel.overlap` for `overlap.mjs` (`references/assembly.md` "Collision by surface, not by box") |
| 2.5D parallax / living photo | engine helpers `Reel.parallax(ctx, t, spec)`, `Reel.parallaxCoverage`, `Reel.cutLayer`, `Reel.holePlate`; `render.mjs` and `verify.mjs` print the page hook `window.__reel.parallaxReport` | a still as depth layers under one camera path; layers from one photo; layers whose edge shows during the move are listed with the scale that fixes them; reports only. Use it when the user asks for 2.5D, parallax, a living photo or a layered photo with depth, in any words (`references/parallax.md`). For parallax, load the full set: photo sources, three-layer separation, optional alpha masks and depth maps, and aligned masked key-photo mixing. Polygon cuts remain the default |
| drift guard (example) | page helper `scripts/engine/reel-drift.js`; `render.mjs` and `verify.mjs` print its notes | a timeline against the page's duration and the voice timings: a definite mismatch throws in the page and stops the render, graded drift is printed as `drift note:` for you to judge (`references/assembly.md`) |
| child in its container, highlight on its target (example) | page helper `scripts/engine/reel-layout.js` (`ReelLayout`); its issues count in the review layout gate | chips and tags laid into a box by measured width with every one that does not fit recorded; a frame, bracket or arrow checked against the rect it marks and against draw order (a highlight drawn under its target) (`references/pipeline.md` "Children, highlights and corners") |
| review | `scripts/render.mjs <dir> --preview` then `scripts/review.mjs <dir>` | contact sheet, dead-air runs, A/V sync, loudness, sync marks |
| dense layout scan | `scripts/review.mjs <dir> --scan [stepSec] [--layer captions [--dub <code>]]` | issue runs with times from seeking the whole film every `stepSec` (default 0.1s), catching a layout bug the once-per-shot Layout gate misses; `--layer captions` scans only the overlay layer, fast on a slow 3D picture |
| file review | `scripts/review.mjs --file <mp4> [--holds a-b,c-d]` | a finished or joined file with no page: A/V stream lengths, loudness whole and per part, dead air (intended holds listed apart), black frames (`references/qa.md`) |
| review copy | `scripts/review.mjs <dir> --copy [--lang a,b] [--out <dir>]` | per language, the existing encode stream-copied with a subtitle track `<line id> <text>`, for a human reviewer; nothing is rendered. With no encode yet, the base layer is `voice/narration.wav` under a black picture |
| subtitles | `scripts/srt.mjs build <dir> [--dub <code>]` / `align <media> --script <file> --lang <code>` / `compare <a.srt> <b.srt> ...` | one SRT per language from the placed timings, breaking where the caption breaks; an SRT for an existing video from its audio and your script; cue count and time equality across files (`references/pipeline.md` "Subtitles") |
| draft with handles | `scripts/render.mjs <dir> --only <ids> --handle <sec>`; later `--use-draft <id>` | `out/drafts/<id>.mp4` over the shot's slot ± handle (clamped to the film) + `<id>.json` (slot start/end, handle); `--handle 0` (default) keeps the plain `--only` full-film render; `--use-draft` cuts the slot from the draft and splices it like `--insert` (`references/pipeline.md`) |
| changed seconds only | `scripts/render.mjs <dir> --span <from>-<to>[,...]` (with `--no-captions --lang <code>` for in-scene text) | re-renders only those seconds (+0.5 s each side) and splices them into the cached segments at exact frame cuts; the rest is reused unprobed (`references/pipeline.md` "Re-rendering only some seconds") |
| assemble from runs | `scripts/render.mjs <dir> --assemble <edl.json>` | builds the film from cached segments and new draft clips by stream copy when the timeline shifted; only new frames and seams are hashed; each copied segment's probe frames are compared with what the page draws. A mismatch is reported and left out of the cache by default. Add `--keep-assembled-copies` to retain those copied frames for later `--span` edits; normal probed renders still redraw mismatches |
| changed spans | `scripts/changed-spans.mjs <old-timeline.json> <new-timeline.json> [--fps <n>] [--out <json>] [--edl-out <edl.json> --old-film <mp4> --new-film <mp4>[,<mp4>...] [--reel <dir>]]` | diffs two timelines (`voice/timings.json` or a dump of the page's shots): the frames to draw, the frames to copy and where they moved, the `--span` value, and an `--assemble` EDL; `--new-film` may be draft clips under `out/drafts/`, whose sidecar `frameStart` maps the film's frames to the clip's own; reports only (`references/pipeline.md` "Re-rendering only some seconds") |
| draft check | `scripts/draft-check.mjs <dir> [--out <json>]` | each draft in `out/drafts/` against the page now: current, slot-unchanged, stale or unstamped; opens the page only when a stamp moved; reports only (`references/pipeline.md`) |
| picture set | `scripts/render.mjs <dir> --check-pair [--lang <code>]`; `--no-captions --fix-picture-duration`; `--no-captions --bed-only` | check that picture, bed and timings are one render; write the picture's length into the timings; rebuild only the sound bed (`references/pipeline.md`) |
| picture-only probe | `still.mjs`, `verify.mjs`, `render.mjs` with `--stub <sec>` | runs on a reel with no `voice/timings.json` yet, as one silent line of that length; `render.mjs --stub <sec> --segments N` splits it into N segments |
| final | `scripts/render.mjs <dir>` | `out/final-<YYYYMMDD-HHMMSS>.mp4` at -16 LUFS; `out/final.mp4` links to the newest |
| picture (picture first) | `scripts/render.mjs <dir> --no-captions [--insert <clip.mp4>@<sec>]` | `out/picture.mp4` (video only) + `out/picture.bed.wav` + `out/picture.timings.json` — the picture, rendered once, no caption baked in; `--insert` puts an approved clip in from `<sec>` (`references/pipeline.md`) |
| language (picture first) | `scripts/dub.mjs <dir> --lang <code> [--min-gap <sec>] [--max-speed <x>]` | `out/final-<code>.mp4` — that language's caption + voice laid over `out/picture.mp4`; each line is trimmed, sped up by at most 10% (`--max-speed`), kept at least 0.5 s of breath, then left its voice-free gap (up to 1.0 s, else slowed to 0.95x); `--min-gap` widens the tight slots for that language; neutral spans are encoded once and shared by every language; reports caption contrast (`dub/<code>/contrast.json`), bed duck swing and cut clicks |
| language audio / time insert | `scripts/dub.mjs <dir> --lang <code> --audio-only [--audio-format m4a\|wav]`; `dub.mjs <dir> --insert-time <sec> --seconds <n>` | only that language's track, for a video already uploaded; shift every language's placed timings and SRTs for a hold inserted before upload (`references/pipeline.md` "More dub reports and operations") |
| dub plan | `scripts/dub.mjs <dir> --lang <code> --init-plan [--copy]` | writes `dub/<code>/plan.json` from the base plan: ids, pauses and lead kept, text left empty to translate (`--copy` keeps the base copy) |
| track fitted to a video | `scripts/fit-track.mjs --timings <picture.timings.json> --voice <voice-dir> --out <track.wav> [--video <mp4>] [--draft]` | one narration track of exactly the video's length (trim → speed ≤10% → breath ≥0.5 s → gap ≤1.0 s), with the silence gate; a line needing more is listed for rewording, or with `--draft` placed at the speed limit and listed so the track can be heard (`references/pipeline.md`) |
| unattended run | `scripts/runner/run.mjs <plan.json>`; `lock.mjs`, `gpu-probe.mjs`, `queue.mjs`, `cost-report.mjs` | stages in dependency order with done-files, resumes, one heavy job at a time that also waits for other work on the GPU, a stale-queue check, and the cost and time report (`references/unattended.md`) |
| upload version (on demand) | `scripts/join.mjs <out.mp4> <part1> <part2> [...]` | joins an opening + body + ending (any count, any order) into one file, and reports each join's loudness, click risk and frame match (`references/bookends.md`) |

## Support reading (optional, read when useful)

| File | What is in it |
|---|---|
| `references/community.md` | How the viral Opus 5.5 films were prompted and built — read first |
| `references/3d.md` | WebGL/three.js films — when to use them, capture path, determinism, speed, characters and the cast stage |
| `references/blender.md` | Installed Blender path — scene authoring, render validation, and existing audio/caption pipeline |
| `references/shorts-formula.md` | The Shorts formula: structure, pacing, banded layout, captions — only when the user chose it |
| `references/openings.md` | Opening types (result first, question, number card, title sting, mid-scene, preview, cover then motion, ...): what each looks like, when it fits, how to build it — read at the start to recommend three |
| `references/assembly.md` | A film that shows something built in many ordered steps, driven by data (reading a model file, insertion direction, surface check, timeline JSON, drift guard, the clock of a film with no narration, short scenes) — read only for that film type |
| `references/brief.md` | The seven-slot Brief of Flow step 0: the slots, how they are marked and filled, a worked example |
| `references/characters.md` | A film with characters (a presenter, a host, a cast that moves or talks): rigs, mouth shapes, a person from a photo, photo animation, collage — read only when characters appear |
| `references/parallax.md` | A still turned into depth layers under a camera move (2.5D, parallax, living photo): depth convention, camera moves, edge coverage, cutting layers from one photo |
| `references/sources.md` | Getting material out of each source type; a data film: search for figures with date and URL, chart drawn from that table |
| `references/craft.md` | Observations from earlier films and the failures viewers called out |
| `references/sound.md` | Effects on visible events, music bed, mix |
| `references/script-review.md` | The review passes a script goes through before the voice is made |
| `references/voice.md` | Voice providers, cloning, pronunciation |
| [Audio editing guide](guides/audio-editing.md) | Local pause and tempo edits, timing updates, and replacing narration in a finished video |
| `references/unattended.md` | Running the stages with nobody watching: the bundled runner, one short session per job, long jobs owned by the runner, done-files, resuming, safety rules |
| `references/pipeline.md` | The page contract, per-language cover stills, render reuse (`--span`, `--assemble`), picture first and dubs, and the checks and reports (`still`, `verify`, `state-checks`, `review`, `srt`, `setup`) — read when you build on the bundled scripts |
| `references/qa.md` | What the review numbers mean and what they cannot see |
