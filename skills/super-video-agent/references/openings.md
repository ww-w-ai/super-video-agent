# Opening types

How a film can spend its first seconds. These are examples to choose from and mix, not rules:
a film may take one as it is, combine two (a talking head with a result cut in, a question over a
generated picture), change one, or do something none of them describes.

## Choosing at the start

At the start (SKILL.md flow step 1), pick the three types below that fit this film best and
recommend them to the user, one line each on why it suits this film. Offer a fourth choice:
"recommend other types". If the user picks it, offer three different ones the same way. The
user can also answer "no opening": the first story line starts at once. If nobody can answer
(an unattended run), use your first pick. Record the chosen type and how it will be built in
`FILM.md`.

What usually decides the pick: what the film has that a viewer would stop for in the first
second (a finished result, a striking number, a question the listener already has, a scene in
mid-action), the frame (a 9:16 Short starts talking at once and keeps a large caption on screen;
a long film can afford a title), and whether a cover image already exists.

Across these types speech usually starts within the first second. The exception is a title
sting, where the picture and sound carry the first seconds and the voice comes in later.

## The types

| Type | What the viewer sees | When it fits |
|---|---|---|
| A. Result first | The finished thing from t = 0, then the words for what it is and how it was made | The film builds or explains something that can be shown finished |
| B. Front talking head | A speaker facing the viewer, graphics cut in after a few seconds | A presenter or character carries the film |
| C. Question or problem | A question or a familiar trouble over text, an illustration or a picture, then the body | The listener already has the question |
| D. Number card | A large number with where it comes from, then the promise of the film | The source has one striking, checked number |
| E. Title or brand sting | A short moving title of letters, icons or a logo; the voice comes late or not at all | A series, a brand, or a long film that can afford a title |
| F. Start mid-scene | Straight into the middle of an action, a conversation or a demo | A scene that reads on its own and pulls the viewer in |
| G. Highlight preview | A quick run of the film's own best shots, marked as a preview | A long film with several strong moments |
| H. Excerpt in a fixed frame | A span of a longer film played inside a frame whose title and footer never change | A Short cut from a longer film |
| I. Cover, then motion | The first frame equals the cover; after about a second it moves or breaks into the first scene | A film whose cover is designed first |

## How to build each with this skill

Every type is drawn in code like the rest of the film. A real person filmed on camera, someone
else's broadcast, and a screen recording of a live site are out of reach; draw a character, a
scene of your own, or a mock-up of the screen instead.

**A. Result first.** Choose a result shot that makes sense with no setup (about 3–10 s), a hook
line that names what the film shows (spoken from t = 0), and a line back into the story ("let's
start from the beginning"). Write the plan in that order, so the voice clock already has the
result first. When the film itself is the result ("this video was made by …"), no reordering is
needed: add the hook line only. A result taken from a scene built later in the film can also be
cut out of the rendered film and put in front with `join.mjs`, like a highlight preview (G).

**B. Front talking head.** A drawn character facing the viewer (a 2D face or a 3D cast member,
`references/3d.md` "The cast stage"), with mouth shapes timed from the word times in
`voice/timings.json`. Write the first line to the viewer; plan which existing scene is cut in
after a few seconds.

**C. Question or problem.** One line that can be read in about two seconds, set as a text card
(`Reel.textBlock`, inside the safe area) over one picture that shows the trouble. Make the first
body scene the one that answers it.

**D. Number card.** Only a number the source states, with its unit and where it comes from (hard
line 1 in SKILL.md: never invent numbers). A large number that counts up or lands, the source in
small type, then the promise line.

**E. Title or brand sting.** Use `meta.lead` (`references/pipeline.md` "Timeline"): the lead
draws the moving title, and the first story line starts after it. The lead needs its own sound
(`references/sound.md` "Lead sound") — a music bed from t = 0 or an effect on the title's
motion. Choose how late the voice comes in. A channel title card that is not part of the film
belongs in `references/bookends.md` instead.

**F. Start mid-scene.** Either write the first line mid-action (the scene is already moving at
t = 0), or, after the film is built, copy a strong span (cut on sentence boundaries) to the front
with `join.mjs` and follow it with a short line that winds back. Check that the span reads on its
own.

**G. Highlight preview.** After the film is built, take about 5–10 s of its own best shots
(1–2 s each), cut them from the rendered film and put them in front with `join.mjs`; a small
"preview" label on those shots tells the viewer what they are.

**H. Excerpt in a fixed frame.** Build a reel whose page draws the fixed frame — a title of one or
two lines and a footer, for the whole film — and the excerpt inside it. The banded frame in
`references/shorts-formula.md` is one such frame. Cut the excerpt from the longer film on sentence
boundaries, never mid-phrase, and draw its frames inside the frame (`render.mjs --insert-stills`
writes a clip's frames as stills the page can draw).

**I. Cover, then motion.** Design the cover first. Make the film's first frame match it, with a
`meta.lead` of about 1–1.5 s in which the cover holds and then moves, breaks apart or opens into
the first scene. `still.mjs --at 0` shows the first frame to compare with the cover.

## Combining

Two types in one opening are common: a talking head with result shots cut in (B + A), a question
spoken over a generated picture (C + A), a cover frame that opens into a scene in motion (I + F).
Name the combination in `FILM.md` the same way.
