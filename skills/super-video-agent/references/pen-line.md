# Pen line art (a drawing that draws itself)

Contents: What it is · When it fits · Model sheet first · Draw in code · Motion · Reveal effects · Covers and thumbnails show finished drawings · Getting a figure right · Accuracy · Checks

**Generated images are the model sheet, never the frames. Every drawing on screen is drawn in code.**

## What it is

Black ink lines on paper, like the figures in a book, a manual or an instruction leaflet. Lines
appear stroke by stroke as if a pen draws them. Drawings change a few times a second rather than
moving smoothly (limited animation). A slight redrawn wobble (boil) is optional per scene
(`references/craft.md` "Aliveness").

The look is a choice, not a default. Line weight, hatching, paper colour, an accent colour and
how many drawings a second all come from the film's source and direction.

## When it fits

Examples, not a list to pick from:

- step-by-step instructions (a posture, an exercise, using a device, a recipe step)
- a film built from a book, a leaflet or a manual whose own figures are line drawings
- a calm, warm explainer where photographs or 3D would feel cold or heavy
- a subject that is hard to photograph cleanly (a baby, a medical position, a hand on a small part)

If the source already has line-art figures, match their weight and detail so the film reads as
that book come alive. Name the technique in `FILM.md` ("pen line art, limited animation").

## Model sheet first

1. Generate a few reference images at the main angles: the subject from the side, front, back
   and three-quarter above; any hands or tools that touch it; the props. Use an image generator
   that accepts a reference image, and pass the first approved image to every later call so the
   face, clothes and line weight stay the same.
2. Look at every sheet image. Redo one that does not match the first.
3. Measure the proportions on the sheet (head length as the unit: body, trunk, limbs, hands) and
   write them in `FILM.md`. The code follows these numbers.

Do not generate one image per shot or per frame. The sheet is reference only; it never goes on
screen.

## Draw in code

- Write one drawing module (`src/pen.js` or similar) that every film and version of the project
  loads. A fix to a subject goes into that module, not into a copy.
- Draw the subject as a posable figure: parts placed by joints, poses as parameters the shots
  need (lift, bend, turn, reach). A shot's sequence is the same figure at a few poses.
- Detail that code curves draw poorly (face, ear, hair, hands, feet) can be traced from the
  sheet's own lines: threshold, thin and simplify them into stroke data, then attach them to the
  rig's joints. Use a traced part only at the angle the sheet drew it; elsewhere the rig draws it.
- Keep to plain Canvas2D (paths, strokes, clip, `drawImage`), so the module runs in the browser
  and in a native canvas renderer alike.
- Draw strokes in reading order (outline first, then detail) so a reveal looks like a hand drawing.

## Motion

- Limited animation: hold each drawing for a step (`hold(t, step)` in the engine; 2-3 drawings a
  second is a common choice) and switch, never tween between drawings.
- Reveal a drawing the first time it appears with one of the reveal effects below, at a pace the
  eye can follow.
- Boil (a small seeded wobble on the same step) is a per-scene choice, not the default. Keep
  informational drawings the viewer studies still (a posture to copy, a step list, a labelled
  diagram) and bring them to life by drawings arriving and switching instead. Judge boil in the
  source, not from frames (`references/craft.md` "Aliveness").
- Something on the page changes every moment: a stroke, a drawing switch, a label being written.

## Reveal effects

Pick one per drawing, or combine two, to suit the film and the line that introduces the drawing.
Record the choice per shot in `FILM.md`. All of them are a function of time (`reveal` 0..1), so
seeking any frame draws the same picture.

| Effect | What the viewer sees | Fits | Build in Canvas2D |
|---|---|---|---|
| Strokes together | every stroke draws at once from start to end | a small drawing that should appear quickly | each stroke drawn up to `reveal × its length` (partial polyline, or `setLineDash([len, len])` with `lineDashOffset`) |
| Strokes staggered | strokes start one after another with a small delay and overlap | most drawings; feels like a quick hand | per-stroke start = index × delay, same duration |
| One stroke at a time | each stroke finishes before the next starts | a slow, deliberate drawing; a diagram being explained | stroke k starts when k−1 ends; duration by length (constant pen speed) or fixed |
| Scripted parts | each part has its own start and duration, set to the words that name it | a narrated explanation: the hand appears as "hand" is spoken | per-part `start`/`duration` taken from the voice's word times |
| Pencil under, ink over | faint pencil construction lines appear first, the dark ink line then traces over them, then shading, shadow and background are added; the pencil may fade at the end | a drawing that should feel crafted; a title illustration; a slower moment | layer 1 thin light-grey loose strokes (fast), layer 2 ink strokes (staggered), layer 3 hatching and shadow, layer 4 background; alpha-fade layer 1 |
| Direction wipe | the finished drawing is uncovered left to right or top to bottom along a slightly rough edge | reading order; a wide scene; a step list | clip to a rect (or rough polygon) that grows with `reveal` |
| Focal first, then spread | the part the line talks about is drawn first, then the rest spreads outward from it | the key part matters most (a hand placement, a gap, a joint) | sort strokes by distance from the focal point; start = distance × rate |
| Brush mask | broad hand-made brush strokes sweep across and uncover the drawing | a softer, painted feel; a background | draw mask strokes into an offscreen canvas, then `drawImage` the drawing through it (`destination-in`) |
| Hand or pen on screen | a pen tip or a hand follows the stroke being drawn | whiteboard style; a tutorial feel | draw the pen image at the current stroke tip; hide it between strokes |
| Ink bloom | lines appear as ink spreading from points along them | a watercolor or ink-wash look | grow a soft dot per sample point with `reveal`; keep it subtle |

Timing: either a fixed duration per drawing or a constant pen speed (longer strokes take
longer); pause briefly when a drawing completes before the next starts, so the eye lands on it.
Finish the reveal before the line moves to its next point.

## Covers and thumbnails show finished drawings

The rule for every appearing effect is in `references/craft.md` "Marks are made". For pen lines:
draw a cover or thumbnail with `reveal = 1` (and the pencil layer already faded, if the effect
fades it), rather than hunting for a frame where every drawing happens to be done.

## Getting a figure right

A code-drawn figure goes wrong in quiet ways (a paw-like hand, a tube leg, a face that is off).
What has worked:

1. Anchor first. Bring one drawing (the subject at the sheet's main angle) to an approved state
   before drawing the rest. Its proportions and line weight become the reference for all others.
2. Review by someone who did not draw it: a fresh session given the contact sheet, the model sheet,
   the source and a short rubric (age or type reads right, posture matches the source, same
   subject as the anchor, clean line, only the moving part changes in a sequence, nothing strange).
3. Fix what the review names and review again. When a few rounds no longer raise the scores, keep
   the best version, list it as weak in `FILM.md`, and move on.
4. Set the number of rounds and a time limit before starting. This stage can take longer than the
   rest of the film; decide what is good enough (posture correct first, looks second).

## Accuracy

A drawing that shows how to do something is a claim (`SKILL.md` "Hard lines"). Check each
drawing's posture, side, order and amount against the source sentence the line speaks. Where a
drawing still reads wrong, show less: fewer drawings, a closer crop on the part that is right, or a
label instead of the picture.

## Checks

- Render every subject's drawings onto a contact sheet and look at it beside the model sheet.
- `still.mjs` at the key moments shows the drawings in the film's layout.
- The dead-air scan can read a held drawing whose only motion is a small boil or a slow write-on
  as frozen. Check those spans in the source before adding motion only to satisfy the scan.
