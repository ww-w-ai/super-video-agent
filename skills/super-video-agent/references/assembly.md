# Assembly films — a build shown step by step, driven by data

Read this only for a film that shows something being built or assembled in many ordered steps
(an object put together, a recipe, a construction timelapse), where step data drives the picture.
Contents: What you need · One technique: manual and 3D side by side · Reading a model file ·
Timeline JSON and the drift guard · A film with no narration · Fit to a target length · Short
scenes, each rendered and marked done · Re-rendering what changed

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

- **Step order from the part hierarchy.** A model file often stores a tree: a main model that
  references sub-models, each with its own steps. Read that tree from the source file and take the
  order from it: a sub-assembly's steps run together, then the sub-assembly joins its parent as one
  piece. A loader that flattens the file into one list of steps mixes a sub-model's parts into its
  parent's steps and gives a wrong order, so list the tree first (which model contains which, in
  which order) and build the step list from that, not from the flattened loader output. When the
  file has no tree, say so in `FILM.md` and show the order you chose in a sheet of stills before the
  voice is written.
- **Press direction from the connection.** A part is pressed in along the line its connection lines
  up on (the axis of the peg and its socket, the screw's axis, the hinge pin), toward the part it
  joins. It is not the direction from where it first appears to where it ends, and not an axis of
  its bounding box. Take the direction from the connection's own geometry, and let the part arrive
  along it for the length of one connection before it rests. For a model in the LDraw text format,
  `scripts/ldraw-bake.mjs` computes it (see "Reading a model file").
- **Collision by surface, not by box.** To check that a part's path is clear, cast the part's
  surface (its triangles, or a dense sample of points on them) against the surfaces of the parts
  already placed. A bounding-box sweep cannot tell a crossing (a part cutting through another) from
  a socket contact (a part seating into a socket it is meant to enter): both overlap the box.
  Use the box only to skip pairs that are clearly apart, then decide on the surfaces. Report each
  pair that crosses with the step and the frames, and decide by eye whether it is meant.
  The page helper `scripts/engine/reel-crossing.js` does this check (below, "Reading a model file").
- **Turn-over icon in the booklet.** When the model is turned over (see below), the manual side
  shows a turn-over icon on that step (a curved arrow around a small model of the part, or a
  half-turn symbol), so the viewer reads the flip as an instruction and not as a jump.

- **Sub-assemblies.** A group of parts built on its own, shown as a small inset or in its own steps,
  then moved onto the main build as one piece. Give the group an id and let the step list place it
  once, so the viewer sees it finished before it joins.
- **Turning the model over.** When the next parts go on the other side, turn the whole model over
  (or move the camera round it) in its own short step, with a visible arrow or a pause, and the
  turn-over icon in the booklet. Do not change the view silently between two steps.
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

## Reading a model file

For a model in the LDraw text format (MPD or LDR), `scripts/ldraw-bake.mjs` turns the file into data
a page loads. The user supplies the model and a parts folder (a library root that holds `parts/` and
`p/`, with `LDConfig.ldr` for colours, or a flat folder of part files); the skill does not find them.
Another reader or another way to get the step data may be used; this is one that exists.

```
ldraw-bake.mjs <model.mpd> --lib <parts-folder> --out <reel>/data [--until <n>] [--classes <json>] [--detail]
```

- It reads `0 FILE` models, `0 STEP` and `0 ROTSTEP` (a step each), type 1 to 4 lines, colour 16
  (the referencing line's colour) and 24 (its edge colour), direct colours and `~Moved to` titles.
  The order is the file's own tree: a sub-model's steps run first, then its parent's step where the
  sub-model joins as one item. A model that main only wraps is followed down to the model that is built.
- A part missing from the folder, or a model that contains itself, stops the bake and names it.
- `build.json`: `tree` (text lines), `order` (`{model, step, via}` in viewing order; `via` is the item
  that joins a sub-model), and per model the steps with each item: `uid`, `kind` (`part` or `model`),
  `part` or `model`, `color`, `m` (3x4 row-major matrix, LDU), `bounds`, `class`, `join`
  (`axis`, `from` = the direction the part comes from, LDraw's -Y is up, `travel`, `seatLen`,
  `reason`) and `pathCheck` per model (triangle pairs that cross on the way in).
- `parts.json`: per part `title`, `triCount`, `bounds`, `tris` and `lines` by colour key as base64
  Float32 (9 numbers per triangle, 6 per line), and `colours` used with value, edge and alpha. Keys:
  `M` the main colour, `E` its edge, `c:<code>` and `e:<code>` a fixed colour and its edge. An item
  with colour `16` takes the colour of the item that references its model: walk up the tree.
- The page loads two files, not hundreds of library files. Decode each part's arrays once and reuse
  them for repeats.
- Insertion direction, from the part itself: a stud part comes from above when a part under it
  carries it and from below when only a part above holds it (the model then turns over for that
  part, see "Turning the model over"); a pin, axle or bush comes along its own axis from the end
  whose path crosses fewer triangles; a sub-assembly joins like a stud part. The class comes from the
  part's title; `--classes {"<part id>": "stud"|"axis"|"hole"}` sets it where the title does not say.
  These are estimates. `pathCheck` is the judge: a count above 0 is a fact for you to look at (a part
  seating into its socket crosses a little at the end of its path), not a failure.
- `--until <n>` bakes the first n steps of the built model, for a film of one span.

The surface check is a page helper too: copy `scripts/engine/reel-crossing.js` into the reel's
`src/` and load it with `<script src="src/reel-crossing.js">` (no dependencies; it adds
`globalThis.ReelCrossing`). It counts the triangle pairs where an edge of one passes through the
inside of the other, and leaves out pairs whose two faces both run along the motion (a stud in its
tube, an axle in its hole). An example hook for `overlap.mjs`, which seeks every frame and prints the
frame spans per pair:

```
const RC = globalThis.ReelCrossing;
// one surface per part, built once from its triangles in the model frame (9 numbers per triangle)
surfaces[id] = RC.surfaceOf(worldTriangles);
window.__reel.overlap = (t) => {
  const m = movingPartAt(t);                       // {id, dir, off} from the step data: off = dir * distance left to travel
  const placed = placedPartsAt(t).map((p) => ({ id: p.id, surface: surfaces[p.id] }));
  return RC.crossingsAt(surfaces[m.id], placed, m.off, m.dir).pairs.map((p) => ({ pair: m.id + "/" + p.with, count: p.count }));
};
```

`RC.pathCrossings` samples a whole path and `RC.bestEnd` compares the two ends of an axis; the baker
uses both.

## Timeline JSON and the drift guard

Generate `timeline.json` from the step data with one script, and have the page read it. Do not
type step times into the page by hand: with many steps a hand edit goes unnoticed. Scene code may
not call `fetch` (`references/qa.md` "Gates"), so the page reads the file where it loads its other
JSON: in the template's boot code, inside `ready`, call `loadJSON("timeline.json", true)` next to
the `voice/timings.json` load, keep the result in a variable, and pass it to the guard and to the
scene functions.

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

## A film with no narration

A film with no narration still needs a clock: `render.mjs` makes `out/final.mp4` from
`voice/narration.wav` and `voice/timings.json`, and `--span` and `--assemble` read a real timings
file (`--assemble` refuses the `--stub` clock; `--stub` is for the picture-only probe before there
is a timeline). The step or scene timeline is that clock. After it is final (and fitted), write it once:

```
silent-clock.mjs <dir> --timeline <timeline.json> [--fps <n>] [--force]
```

- `voice/timings.json` gets one silent line per timeline item (`text` empty, `words` empty) with the
  item's exact start and end; `voice/narration.wav` is silence of exactly the film's length. The
  timeline holds `steps`, `stages`, `scenes`, `lines` or `shots`, each `{id, start, end}` in seconds,
  and optionally `duration` (default: the last end). Use one line id per scene, the scene's `shots` id.
- It stops when an id repeats, an item is not a span, items overlap or run out of order, or an end
  passes the duration, and it refuses to replace a timings file that holds real text or words unless
  `--force`. Gaps between items, a first item that does not start at 0, a tail past the last item and
  edges off the frame grid (`--fps`) are printed as facts.
- Run it again after the timeline changes. Keep the old `voice/timings.json` first: `changed-spans.mjs`
  compares it with the new one (below).
- The review's silence gate counts quiet at the line boundaries, which here are the scene
  boundaries (`references/sound.md` "A film with little or no narration").

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

- Find what changed from the timelines, not by hand: keep the old `timeline.json` (or
  `voice/timings.json`), then `changed-spans.mjs <old.json> <new.json> --fps <n>` lists the steps
  that changed or were added as seconds, the runs that only moved (old and new frames, shift), and a
  `--span` value. A step is kept when its id, text and owned length are the same; a changed length
  moves every step after it, and those are copied, not drawn.
- A few seconds changed: `render.mjs <dir> --span <from>-<to>`. Untouched frames are reused.
- A timeline that shifted (a step added or removed): `render.mjs <dir> --assemble <edl.json>`
  copies the old scenes to their new places and puts in the new drafts; no page frame is
  rendered for the copied scenes. After a successful assemble the segment cache follows the new
  timeline, and a failed finish leaves the cache untouched. `changed-spans.mjs --edl-out` writes
  the EDL for this (`references/pipeline.md` "Re-rendering only some seconds"). A copied scene whose
  frames are not what the page draws now is reported and left out of the cache. Cheap new frames
  come from drafts (`render.mjs --only <id> --handle <sec>`): pass them as `--new-film` and the
  tool maps the film's frames to each draft's own (`references/pipeline.md`).
- Segments carry a keyframe every second, so a cut copies whole groups of pictures and re-encodes
  only the frames up to the next keyframe. Joining scenes is a stream copy, not a re-encode.
- Language versions: the picture is rendered once and each language is laid over it
  (`references/pipeline.md` "Picture first and language versions").

The commands and their limits are in `references/pipeline.md` "Re-rendering part of a film".
