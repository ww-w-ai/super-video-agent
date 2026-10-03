# Audio editing guide

Edit an existing voice recording, then replace the narration in a finished video.

- [Edit pauses and tempo](#edit-pauses-and-tempo)
- [Use the edited audio in a reel](#use-the-edited-audio-in-an-existing-reel)
- [Replace narration in a finished video](#replace-narration-in-a-finished-video)

## Edit pauses and tempo

Use `audio-edit.mjs` to change pauses in an existing mono WAV without generating the voice again. It works with any provider's audio. It makes no API calls and loads no model.

Inspect first:

```sh
node scripts/audio-edit.mjs /absolute/path/line.wav --inspect
```

The JSON on stdout contains quiet-span candidates and a quietest point in each span. This is advisory evidence, not a speech detector or an instruction to remove every pause. Inspection writes no files.

Choose the spans yourself, then save an edit file:

```json
{
  "pauses": [
    { "start": 0.4, "end": 0.8, "duration": 0.2 },
    { "start": 1.2, "end": 1.3, "duration": 0.4 }
  ],
  "padStartSec": 0.1,
  "padEndSec": 0.2,
  "tempo": 1
}
```

The first pause becomes shorter; the second becomes longer. Pause coordinates refer to the **original input**, even when an earlier edit changes the clip's length. Only the selected quiet spans are replaced with zero-valued silence. Existing leading and trailing audio stays intact unless explicitly selected. Padding adds silence at the edges; it never trims them.

```sh
node scripts/audio-edit.mjs /absolute/path/line.wav \
  --edits /absolute/path/edits.json \
  --out /absolute/path/line-edited.wav \
  --words /absolute/path/words.json
```

The words file is optional. Its times are relative to the input clip:

```json
{
  "words": [
    { "w": "Hello", "start": 0.1, "end": 0.3 },
    { "w": "again", "start": 0.9, "end": 1.1 }
  ]
}
```

The command writes the new WAV and `line-edited.wav.json`. Use `--report /absolute/path/report.json` to choose another new report path. The report contains the applied pause map, remapped words, padding, tempo, sample rate, and measured output duration. Read its `words` directly; do not reuse the old word times after editing.

## Timing and audio behavior

- Input must be a mono WAV. Output is mono, 48 kHz, float PCM WAV. FFmpeg converts other input sample rates to 48 kHz before editing.
- At tempo `1`, unselected decoded samples stay identical. This is sample preservation, not preservation of WAV headers or the original file encoding.
- Times round to the nearest 48 kHz sample for actual edits and padding. The report records the applied boundaries.
- `tempo` is a pitch-preserving FFmpeg `atempo` multiplier, from `0.5` to `2`. Pause durations apply before tempo; `padStartSec` and `padEndSec` are final durations added after tempo.
- Words before an edit retain their relative place. Later words move by the edit's duration difference. A boundary within an edited quiet interval maps proportionally through that interval. Then tempo and leading padding apply.
- Actual tempo-filter duration can differ slightly from the ideal duration. The report uses the achieved output duration. A mapped word extending past the achieved speech buffer causes an error; it is never silently clamped.

## Refused edits

Every explicitly selected pause must remain at or below −50 dBFS **peak**. Candidate detection uses 10 ms RMS windows, so a candidate containing a transient can still fail this stricter edit check. Quiet measurements do not prove that speech is absent; inspect the source and listen to the result.

Overlapping or out-of-range pauses, nonfinite values, invalid tempo, malformed words, and edits that collapse a word to zero duration are rejected. Words must be ordered, nonoverlapping, and have positive duration inside the input clip.

Output directories must already exist. Output and report paths must be new and distinct. Existing paths—including symlinks, hardlinks, and aliases of the input WAV or JSON sidecars—are refused. The original WAV, edit file, and words file are never overwritten.

A useful failure check is to select an audible word as a pause: the command should report `pause intersects nonquiet audio` and create no output. Choose an actual quiet span before retrying. A structural failure is not a reason to regenerate the voice.

## Use the edited audio in an existing reel

The same local workflow works for a Typecast line or a locally generated Qwen line: supply the finished mono WAV and, if available, its clip-relative words. No provider choice is involved in `audio-edit.mjs`.

To install a finished edit, work in a copy of a completed reel or dub folder. Its other `voice/line-<id>.wav` files must already exist:

```sh
node scripts/voice.mjs /absolute/path/reel/dub/en \
  --provider none \
  --use l02=/absolute/path/line-edited.wav \
  --no-stt
```

`--use` installs the supplied audio without synthesizing it, reapplying the configured speaking rate, or retrying flagged synthesis. `--no-stt` also skips a transcription model. The existing command still levels the installed line and rebuilds narration and timings, so it is a separate mutation of the working reel—not part of the non-overwriting local edit command. Keep all source audio outside that reel copy.

In a dub folder the edited line retains its natural length; the later dub placement step must fit it to the fixed picture. In a base reel `--use` normally fits to the old slot; `--retime` changes that behavior and can shift later scenes. Choose that deliberately.

**`--use` does not import the audio-edit report or its remapped word times.** With `--no-stt`, changed-line word times are rebuilt proportionally. Keep the report as timing evidence. If a caller installs its remapped words into film timings, it must explicitly add the line's final placement offset and account for any later tempo/slot fitting. Do not treat the report as an automatically discovered sidecar.

## Replace narration in a finished video

Use this when the wording, line-level captions, and picture timing stay the same.
The final MP4 video stream is copied. No scene or caption frames are rendered.
For changed text, translations, or word-by-word highlights needing new timings,
use the normal dub pipeline instead.

Keep the original final MP4, its placed timing JSON, and its clean background
sound bed. The bed must have the same clock and contain no narration. Do not
extract the final video's mixed audio as a substitute. A missing bed must be
restored separately; this command does not guess which sounds are speech.

1. Copy the final video's placed timings to a stable file before changing voices.
2. Generate only the selected speaker/line IDs, or edit existing WAVs locally.
3. Keep `dub/<lang>/plan.json` caption text and line IDs unchanged. Update
   `dub/<lang>/voice/timings.json` to describe the actual current clips.
4. Run the same command in Claude Code or Codex:

```bash
node /absolute/skill/scripts/dub.mjs /absolute/reel --lang en \
  --replace-audio /absolute/original-final.mp4 \
  --timings /absolute/original-placed.json \
  --bed /absolute/original-clean-bed.wav
```

Each clip starts at its frozen start and must fit before its frozen end. The
existing edge trim, modest tempo fit, line leveling, and bed ducking are reused.
If a clip is too long, inspect and edit its pauses with `audio-edit.mjs` before
paying for another generation. A structural failure names the affected line;
it never silently cuts speech or changes the video clock.

The output is a new `out/revoice-<lang>-<stamp>-<suffix>.mp4` with a JSON sidecar.
The original video, voice inputs, frozen timing file, and existing latest-video
link remain unchanged. Review the new audio in context before publishing it.
The sidecar describes the replacement audio timing; the original caption clock
is still embedded in the copied video.
