# Brief — the user's request in seven slots

A film starts from a request in the user's own words. Before the script, the request is rewritten
into seven slots and written to `FILM.md` under "Brief". The user does not have to fill all seven:
the more they write, the more of their intent reaches the film, and the skill fills the empty ones.
This step is what makes that true: every slot is marked, so the user can see what they said and
what was filled in.

## The seven slots

| # | Slot | What it holds |
|---|---|---|
| 1 | Viewer and action | who watches, and what they should think or do after the last second |
| 2 | Technique | the look and how pictures are made (a 3D cast, cut-out animation, charts drawn in code, a build shown step by step ...). Unknown: "pick the fitting technique for each scene and say which and why" |
| 3 | Flow | the opening (about the first 3 seconds), the development, the closing line |
| 4 | Camera and transitions | how the camera moves and how one place becomes the next (one take, cuts, a zoom into the next scene) |
| 5 | Facts and sources | what the film may state, from which file or page; "no number that is not in the source" |
| 6 | Voice and tone | who speaks, how, in which voice (the user's own recording, a character, a narrator) |
| 7 | Size, length, language | frame ratio, target length, base language and any dubs |

## Procedure

1. Read the request and the source. Put what the user said into the slots, in their words, and mark
   each such slot `from the user`.
2. For an empty slot, fill it from the source and the request and mark it `filled by the skill`,
   with the reason in a few words ("source is a menu, so the viewer is a customer").
3. A gap the source cannot settle (who the viewer is, a voice only the user can supply) is asked
   once, in the same question round as frame size, style, length and checkpoint level. Never open a
   second round. Slots 1, 5 and 6 are the likeliest to need the user; slots 2 to 4 are usually the
   skill's to fill.
4. Unattended (nobody can answer): fill every gap, mark it `filled by the skill`, and add the line
   "unattended: filled without asking" to the Brief.
5. Write the Brief to `FILM.md` before planning. Later stages read it, not the conversation. A user
   change in a later round updates the slot and its mark.

## Shape in `FILM.md`

```
## Brief
1 Viewer and action: <text> [from the user | filled by the skill: why]
2 Technique: ...
...
7 Size, length, language: ...
```

## Worked example

Request: "Make a short video about our community garden's spring plant sale. Friendly. Use the
flyer."

```
## Brief
1 Viewer and action: neighbours scrolling a feed; they come to the sale on Saturday [filled by the skill: the flyer names a Saturday sale]
2 Technique: flat cut-out look, one picture per plant; the skill picks per scene [filled by the skill: no look was asked for]
3 Flow: hook with the date, three plants, the address as the closing line [filled by the skill]
4 Camera and transitions: slow push-ins, a wipe between plants [filled by the skill]
5 Facts and sources: dates, prices and plant names only from the flyer; no other numbers [from the user: "use the flyer"]
6 Voice and tone: one narrator, warm and friendly [from the user: "friendly"; voice filled by the skill]
7 Size, length, language: 9:16, about 30 s, the flyer's language [filled by the skill: a feed film]
```

The slot text is the film's own words for itself; the wording above is only an illustration of the
shape, not a template to copy.

## What the Brief is not

- It does not replace the source. Facts still come only from the source (`SKILL.md`, "Hard lines").
- It is not a form the user must complete. A one-line request is enough; slots the user left empty
  are filled and marked.
- It is not a ban on change. A later stage that finds a slot wrong records the change and the
  reason in `FILM.md`, and the mark becomes `changed`.
