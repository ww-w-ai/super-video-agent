# Assembly films — a build shown step by step, driven by data

Read this only for a film that shows something being built or assembled in many ordered steps
(an object put together, a recipe, a construction timelapse), where step data drives the picture.
Contents: What you need · One technique: manual and 3D side by side · Timeline JSON and the drift
guard · Fit to a target length · Short scenes, each rendered and marked done · Re-rendering what
changed

**Every technique here is an example, never a menu.** The model may use another layout or another
way to drive the picture if it suits the film better.

## What you need

You need step data for the build, supplied by the user: the ordered steps, what each step adds or
moves, and where it goes. Ask for it before planning scenes. Put it under "Needs from the owner" in
`FILM.md`. The skill does not source it.

Record where the data came from and its licence terms in `FILM.md`, and keep the original files
with the film.

## One technique: manual and 3D side by side

A technique that suits a build film: a manual page on the left and the 3D model on the right, both
drawn from the same camera so the viewer sees the same part from the same side. One step list drives
both halves:

- The step data is the single source. For each step: an id, the parts it adds or moves, the camera
  that frames them, and a duration weight.
- The 3D side builds the model up to step `n` at time `t`: a part appears, moves into place (the
  insertion direction first, then the final position), eased, as a pure function of `t`.
- The manual side draws the same step from the same camera: the new parts highlighted, the earlier
  parts plain, a callout for the part count.
- Both halves read the same step index at `t`, so they never drift apart.

Order the steps so that a part a later part sits on appears first (a base before what stands on it).
Check each step in a still for parts that pass through each other (`references/3d.md` "Covers and
soft bodies"; `overlap.mjs`).

Further assembly techniques, each an example; a different or better way may be chosen:

- **Sub-assemblies.** A group of parts built on its own, shown as a small inset or in its own steps,
  then moved onto the main build as one piece. Give the group an id and let the step list place it
  once, so the viewer sees it finished before it joins.
- **Turning the model over.** When the next parts go on the other side, turn the whole model over
  (or move the camera round it) in its own short step, with a visible arrow or a pause. Do not
  change the view silently between two steps.
- **Hidden parts.** A part that ends up behind others cannot be seen at the moment it is placed.
  Show it from the side it can be seen from, make the covering parts see-through for that step, or
  cut away the cover, then restore them. Check each step in a still: every part added in the step
  is visible in at least one frame.
- **Opened pose.** For a part with joints or hinges (a lid, a door, a folding arm), place the
  pieces in the opened pose, and close it in a later step. Parts placed inside need the opened
  pose to be reachable.
- **Load tips.** A large step list makes a heavy page. Load each part's geometry once and reuse it
  for repeats, group parts that never move apart into one object, and warm only the steps a segment
  draws (render in short scenes, see below).

## Timeline JSON and the drift guard

Generate `timeline.json` from the step data with one script, and have the page read it. Do not
type step times into the page by hand: with many steps a hand edit goes unnoticed.

```
{"steps": [{"id": "s01", "start": 0, "end": 4.2, "parts": ["p1", "p2"]}, ...], "duration": 312.4}
```

A drift guard in the page compares what the page declares (its step ids, its duration) and the
measured voice timings with `timeline.json` when it loads. It is a bundled example helper: copy
`scripts/engine/reel-drift.js` into the reel's `src/` and load it with `<script src="src/reel-drift.js">`
(no dependencies; it adds `globalThis.ReelDrift`). In the page's `ready`:

```
ReelDrift.guard(timeline, {duration, fps, timings, pageStepIds, toleranceSec, minStepSec})
window.__reel.driftReport = ReelDrift.report
```

A step may name the voice line it starts with (`"line": "<id>"`).

- A definite drift stops that step: a step that starts after it ends or before 0, a step ending
  beyond the film, overlapping steps, steps out of order, a repeated id, a page step id that is not in
  the timeline, a step count that differs, a duration that differs by more than one frame, a step
  naming a line that is not in the voice timings or starting more than `toleranceSec` (0.5 s) from it.
  The guard throws in `ready`, so the render stops and the error names the step. A film built on a
  wrong timeline has to be made again, so stopping early is right. (Only this step stops; the
  autonomous run goes on with what the error says.)
- A graded difference is reported, not stopped: a step shorter than `minStepSec` (0.5 s), a step
  starting within the tolerance but more than a frame from its line. `render.mjs` and `verify.mjs`
  print them as `drift note: ...` after the page loads, for you to judge in the review.

The AI chooses whether to activate the guard. On a film with many steps (dozens) it earns its cost;
on a film with a handful of hand-timed scenes it is not needed.

## Fit to a target length

When the film has a target length, fit the steps to it with one tempo factor rather than editing
steps one by one:

```
tempo = natural_total / target_total          (greater than 1 = faster)
step_duration = natural_duration / tempo
```

- `scripts/tempo.mjs --target <sec> --timeline <timeline.json> [--floor <sec>] [--report <json>]`
  prints the plain factor, the factor with the floor, and each step's factor and new times. It changes
  nothing unless you add `--out <file>`, which writes the fitted timeline (new `start`/`end`,
  `duration` = the target, the applied `tempo`). `--timings <voice/timings.json>` fits a voice
  timings file instead (report only). Whether to apply the factor is your call.
- Apply it in the generator that writes `timeline.json`, so the page and the voice slots read one
  clock.
- Report the factor. A factor beyond roughly 0.7 to 1.5 means the steps are too many or too long
  for the target: cut or merge steps, or ask whether the target should change, rather than
  speeding up until steps cannot be read.
- Keep a floor for each step (long enough to read a change) and let the floor, not the tempo, win
  (`--floor`): the steps at the floor stay there, the others take the rest, and the report says when
  the target cannot be reached because of the floors.

## Short scenes, each rendered and marked done

Split the film into short scenes from the start, even when it has no narration: one `shots` entry
per scene (about 20 s is a size that has worked; the right size depends on the render time of a
frame). Render each scene on its own and mark it done before the next. An error then costs one
scene, not the whole film.

```
render.mjs <dir> --stub <sec> --segments N     # picture-only run before there is a voice
render.mjs <dir> --only a,b                    # render those scenes; the rest stay pending
render.mjs <dir> --plan                        # which scenes are cached (REUSE) or need a render
```

A scene's segment in the cache (`out/segments/…`) is its rendered state. Also keep a table in
`FILM.md`: scene id, draft or segment path, done yes or no, where the old draft is. A later session
reads that table and does not rebuild what exists. In a script that runs the stages, a done marker
per scene (`references/unattended.md`) does the same.

## Re-rendering what changed

Render reuse is a base principle: when step data changes, render only the changed spans, copy
the rest, and build what versions share once.

- A few seconds changed: `render.mjs <dir> --span <from>-<to>`. Untouched frames are reused.
- A timeline that shifted (a step added or removed): `render.mjs <dir> --assemble <edl.json>`
  copies the old scenes to their new places and puts in the new drafts; no page frame is
  rendered for the copied scenes. After a successful assemble the segment cache follows the new
  timeline, and a failed finish leaves the cache untouched.
- Segments carry a keyframe every second, so a cut copies whole groups of pictures and re-encodes
  only the frames up to the next keyframe. Joining scenes is a stream copy, not a re-encode.
- Language versions: the picture is rendered once and each language is laid over it
  (`references/pipeline.md` "Picture first and language versions").

The commands and their limits are in `references/pipeline.md` "Re-rendering part of a film".
