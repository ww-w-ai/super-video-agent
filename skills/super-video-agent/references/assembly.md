# Assembly films — a build shown step by step, driven by data

Read this only for a film that shows something being built or assembled in many ordered steps
(an object put together, a recipe, a construction timelapse), where step data drives the picture.
Contents: What you need · Required before any render of an LDraw build · One technique: manual and
3D side by side · Reading a model file · Timeline JSON and the drift guard · A film with no narration ·
Fit to a target length · Short scenes, each rendered and marked done · Re-rendering what changed

**Every technique here is an example, never a menu** — except the build-order gate below, which is
required. The model may use another layout or another way to drive the picture if it suits the film
better.

## What you need

You need step data for the build, supplied by the user: the ordered steps, what each step adds or
moves, and where it goes. Ask for it before planning scenes. Put it under "Needs from the owner" in
`FILM.md`. The skill does not source it.

Record where the data came from and its licence terms in `FILM.md`, and keep the original files
with the film.

## Required before any render of an LDraw build

Not an example: a rule (owner 2026-10-26, EV-27, EV-28 and EV-29 in `docs/evolution/ledger.md`). Run the
gate on the **final** order — the exact build.json or order file the renderer reads — before any
still, preview, verify or render, and again after every change to the order:

```
ldraw-order-check.mjs <build.json | model.mpd> --lib <parts-folder> --cameras <camera-track.json> [--order <order.json>] [--groups <groups.json>] [--json <report.json>]
```

- It must end **PASS**: 0 SUPPORT, 0 CROSSING, 0 ORDER, 0 DIRECTION, 0 HIDDEN, 0 NO-CAMERA, 0 UNPLACED.
  Exit 1 lists each violation with its landing index. Review until every count is 0 before rendering;
  a known non-zero count is not "small enough" (owner: "0% 가 될 때까지 검토하고 맞춰").
- SUPPORT: at its landing every part (or sub-assembly) joins a part already placed, or the table:
  a stud seated in an underside (found from the parts' stud primitives and the receiving part's own
  walls and tubes, not from boxes), axle/pin in a hole, clip/bar, hinge, wheel, minifig joint.
  CROSSING: the arrival sweep (from `travel` away along the arrival direction to `seatLen` away; the
  joint closing is not sampled) passes through no triangle of a placed part, flush faces included.
  ORDER: nothing arrives from above into a column where a placed part already sits above it (from
  below: below it); a sideways arrival is judged by its path.
  DIRECTION: the arrival is how a joint it seats on is actually made — a stud joint along the stud
  axis from the open side (SNOT and bracket faces too); an axle or pin into a hole, or a wheel, drum,
  pulley or rim onto an axle, along the axle axis from either end, never across it; a clip square to
  its bar (the bar axis read from the part's radius-4 cylinders). Hinge, minifig and loose joints set
  no direction. A part with several joints (studs below and an axle sideways) passes when it matches
  any one it seats on, and its path must still be clear. `"from": "auto"` picks the first clear joint
  direction.
  VISIBILITY (required): each landing is seen from the camera of its moment, with everything placed
  before it in the way (sample points on the part's own triangles cast to the eye against the placed
  parts' triangles; seen = at least `--min-visible` of them, default 0.1). It needs the film's camera
  track: `{"cameras": [...k0/k1 or t0/t1 ranges...], "landingTimes": [...], "perLanding": [...]}`
  (format below). No camera track, a landing with no camera, or any hidden landing fails. The one
  exception: a part flagged internal by design (`--internal <regex>`) that lands in a shot marked
  `"opening": true` (seen through an opening) is listed as excepted, still counted. `--structure-only`
  skips VISIBILITY for a planning run; its stamp opens no render or verify gate.
- It writes `order-check.json` beside the order file (the hashes of the files it checked).
  `render.mjs` and `verify.mjs` refuse a reel whose `data/build.json` (or `data/<dir>/build.json`) has no
  current passing stamp. `--skip-order-check "<reason>"` gets past it and appends the reason to
  `out/order-check-override.log`; a bare flag is refused. Use it only for a probe that is not shown.
- **Any custom renderer, page or planner must run it too** (a project's own WebGL page, a staging or
  one-by-one planner, a re-sorted order): run the CLI on the order it wrote, or call
  `assertOrderChecked(<order file>)` from `scripts/lib/ldraw-order-check.mjs` before drawing.
- **Planners prevent, not only detect.** `createModel` + `createBuild` give the same checks for one
  candidate at a time, before it is placed: `supportOf`, `blockersOf`, `crossingsOf`, `jointsOf`,
  `directionOf`, `arrivalOptions` / `bestArrival` (the joint directions, clear ones first: take the
  arrival from here, never a fixed "from above"), `visibleOf(candidate, camera)`,
  `visibleCandidates(candidates, camera)` and `proposeCamera(candidate, camera)` (the smallest orbit
  turn that shows it), then `place`. A planner picks only supported, clear, visible candidates with a
  joint-matching arrival. When none is visible, turn the camera (`proposeCamera`) or move that area
  into a sub-assembly shot.
- Options, each recorded in the stamp: `--ignore-tail <n>` (assembled minifigs added last),
  `--ignore <regex>` (landings not checked), `--loose <regex>` (hinged or odd parts held by any box
  contact), `--classes <json>` (joint kind for a part whose title does not say), `--ground none`.
  Minifig parts are not swept against each other (their joints interlock deeper than a stud); build
  a figure as its own piece.

How to fix a failing order:

- Bottom-up per column: a part goes in only after every part under it in its column, never under a
  part already placed. A staged or zone order sorts within each zone by height first.
- Back to front, toward the camera, so a landing is not hidden behind parts already in front; when
  the next landing would be hidden, turn the camera first (`proposeCamera`) or build that area as a
  sub-assembly on its own screen.
- Arrive along the joint: a drum, pulley or wheel slides along its axle from the free end, an axle
  goes into its holes along its own axis, a part pressed onto studs comes along the stud axis.
- A part held only from above or from the side (an overhang, a plate under a groove tile, a beam
  over a gap) waits until what holds it is placed, or goes in a sub-assembly built on its own:
  beside the model, upright, or on its own screen, then carried in as one piece (an `--order` step
  with `ids`, or a `--groups` range). Its own build is checked too; its first part is free.
- Underside parts: turn the model (or build them into a sub-assembly upside down and turn it over)
  so they arrive from above; do not slide them up through the base.
- A part pushed sideways must have a clear path: not across studs it would drag through, not
  through a neighbour in the same course. Press it down from above, or let it come in last on that
  side.

### The order file

Without `--order` the order is the input's own: a bake build.json in its step order with each item's
`join` (`from`, `travel`, `seatLen`), or an MPD/LDR in its step order with the arrival direction found
from the joint. An order file re-orders an MPD/LDR (the `//` notes are for reading; the file is plain
JSON, and a bare list of steps also works):

```
{"defaults": {"from": "auto", "travel": "auto", "seatLen": 8},
 "steps": [
   {"id": "model.ldr#1.1"},                                  // a part uid, as ldraw-bake.mjs writes it
   {"id": 4, "from": "-z", "travel": 40},                    // or its 0-based index in file order
   {"ids": ["model.ldr#3.1", "model.ldr#4.1"], "from": "above", "build": [{"id": "model.ldr#3.1"}, {"id": "model.ldr#4.1"}]},
   {"id": "model.ldr#5.1", "arrive": "swing"}                // swung in: support checked, path listed as unchecked
 ]}
```

`from` is where the part comes from (`[x,y,z]`, `above`, `below`, `+x`, `-x`, `+z`, `-z`, or `auto`
= from its joint; LDraw -Y is up). A step with several `ids` is a sub-assembly: built in `build` order
(default: `ids` order), then landed as one piece. A sub-model item's uid names the whole sub-model.
Every part must be placed exactly once. `--groups` folds index ranges of any order into
sub-assemblies: `{"units": [{"k0": 120, "k1": 180, "kind": "fly", "name": "tower", "from": [0,-1,0]}]}`
(k1 exclusive; a staged planner's `stage.json` works as is; kind `panel` swings in). `--cameras`,
the film's camera track in the build model's LDraw frame:
`{"cameras": [{"k0": 0, "k1": 400, "eye": [x,y,z], "target": [x,y,z], "up": [0,-1,0], "fov": 40, "aspect": 1.778}]}`
with k = main landing index (after `--groups` folding); or entries with `"t0"`/`"t1"` seconds plus
`"landingTimes": [seconds of each landing]`; or `"perLanding": [camera per landing]`, which wins.
`fov` is vertical, in degrees. Export it from the same data the page's camera reads.

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
At the moment it lands, every part must join a part already placed (or the base): no part may rest in
mid-air waiting for the parts under it. For an LDraw build the check is the required gate above
(`ldraw-order-check.mjs`); for any other build data, run a pass that, for each step in order, tests
the new part's connections against the parts placed so far, and lists every part with none. A part that is only held from above or from the side (an overhang,
a beam across a gap, a roof edge) goes in a sub-assembly built on its own (beside the model, or upside
down and turned over), which then joins as one piece; or it waits until what it hangs from is placed.
Large generated models with a staged order (layers, zones) are where this goes wrong most: a stage
that sorts by zone can put an upper course of a wall before the courses below it.
A part's arrival path must never pass through a part already placed: never place a part under one
that is already in place above it, and sweep every arrival path against the placed surfaces before
rendering (0 crossings; for LDraw, the gate above does both). Build from the far side toward the camera, so a landing part is never hidden behind parts already
placed in front of it. When a near zone has to come first, turn the model or move the camera so the
side being built faces the viewer. Count the parts that land out of view (none should). A wall or
rock face that joins the model as one piece is built standing up, a little away from the base,
course by course from the bottom, and then carried over and pressed into place; building it flat and
swinging it up reads less like real building. A large or complex chunk can also be built in its own
shot, on a clean table framed close (as a booklet's sub-assembly page does), then the film returns to
the main model and the finished chunk is carried over and attached.
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
  The page helper `scripts/engine/reel-crossing.js` does this check (below, "Reading a model file");
  for an LDraw build the required gate (`ldraw-order-check.mjs`, above) runs it over the whole order.
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
  part's title; `--classes <file.json>` (a file holding `{"<part id>": "stud"|"axis"|"hole"}`, not inline JSON) sets it where the title does not say.
  These are estimates, and `pathCheck` is the bake's own note on them. The judge is the required
  gate, `ldraw-order-check.mjs`, run on the order that will be rendered (it leaves the seat out of
  the sweep, so a part closing into its socket is not counted).
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

### Minifig hands hold bars only

A part placed near another is not joined to it: check the kind of connection, never placement by
proximity. A minifig hand is the clearest case (owner 2026-10-23, Niagara: a fishing rod, then a
camera, were put "in" hands without a bar — the rod swung on its own pivot, the camera body sat in
the clip; "레고 손에 꽂을 수 있는 부분과 아닌 부분이 있는데 그 부분이 제대로 처리가 안되고 있네").

- A hand (LDraw `3820`, formerly `983`, and every hand inside a composite arm or torso) is a C-clip
  for a 3.18 mm bar (8 LDU across). In `3820.dat` the grip centre is (0, -0.8229, -9.8948), its axis
  (0, -10.64966, -2.75422) (the hand's 14.5 degree tilt), 11 LDU long, inner radius 4 LDU.
- It grips: bar elements, antennas, lightsaber hilts, tool handles, the handle of camera `30089b`,
  the bar of binoculars `30162`, oar and paddle shafts, fishing rod `2614` at its handle, and
  clip-compatible pins of the same diameter. It does not grip a stud, a brick body, a plate edge, a
  tile, a camera body, a saddle or a boat hull.
- The bar's axis passes through the clip axis (within a degree or two and about 1 LDU) and the bar
  fills the grip length. Place the item by its bar: compute the item's matrix so its bar segment
  lands on the hand's grip axis, then check it.
- The held item moves only with the hand and arm: in animation data it belongs to the same group as
  its hand and arm, and that group turns about the shoulder (on the arm's own swing axis) or the
  figure's body, never about the item's own pivot. No hand moves without what it holds.
- `scripts/ldraw-handhold.mjs <model> --lib <parts-folder> [--moving <json>]` checks all of this
  without a bake (well under a second on a 6,000-part model): FAIL names the item, the hand, the
  angle and offset; bars come from the part's radius-4 cylinder primitives (holes marked
  `BFC INVERTNEXT` and studs are not bars). Run it after every model change that adds or moves a
  minifig, and before any render.

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
