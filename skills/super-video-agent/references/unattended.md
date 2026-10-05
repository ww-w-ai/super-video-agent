# Running the stages unattended

Read this when the film's stages will run with nobody at the keyboard — overnight, or as a batch
of language versions — driven by a script that starts one non-interactive session per job
(for example `claude -p`). Write that script for this film; what follows is what such a script
has to get right, with one example. Shape it to the film.

## What goes wrong without it

- **A job dies with the session that started it.** A session that launches a render in the
  background and then ends its turn takes the render down with it. The output never appears.
- **Long sessions hit the host's time limit.** A host may cap how long one non-interactive
  session runs. One session that writes, voices, renders and reviews several languages crosses
  it; the work stops halfway with no file to resume from.
- **"Done" in a session's reply is not done.** Only the hand-off file is.

## How to cut the work

1. **The runner owns order; sessions own judgment.** The script is plain shell, started detached
   from any session (`nohup … &`). It decides what runs next, waits, retries and logs. Each
   session does one piece of judgment work and leaves one file.
2. **One session, one job, one done-file.** Use the stage table's hand-off files as done-files
   (`plan.json`, `voice/timings.json`, a review verdict). A session is short when its job is one
   of these, not a chain of them.
3. **Jobs that depend on each other run one after another, each in a fresh session.** Jobs that
   do not (the languages of one film) run side by side, a few at a time.
4. **Deterministic heavy jobs run in the runner, not in a session.** `render.mjs`, `dub.mjs`,
   audio extraction and joins need no judgment. When the script runs them itself, no session
   can end under them. Run them one at a time under a lock (`mkdir <lock>` succeeds for one
   process only), since two renders on one machine slow each other down more than they gain.
5. **A review loop goes through files.** The review session writes a verdict file (`ok`, or
   `redo` after fixing the lines it found); the runner reruns the deterministic step and asks for
   one more review. Cap the rounds.
6. **Check the done-file, then resume.** If a session ends and its done-file is missing, resume
   that session by its id with a short note ("continue from FILM.md Progress; run every job in the
   foreground"). If a heavy job still holds the lock, wait for it to finish instead of resuming.
   Cap the resumes; after the cap, log it and move on to work that does not depend on it.
7. **Log one line per start and finish** to a status file, with the done-file's state. That line
   is what anyone checking in the morning reads first.

Write the shell for the shell that will run it: macOS ships bash 3.2, which has no `wait -n`
(count live jobs with `jobs -rp` instead).

## Example

An example (synthetic) for one film with several language versions. Names and counts are
placeholders.

```bash
#!/bin/bash
D=/abs/path/to/film; S=/abs/path/to/skill/scripts; LOCK=$D/.render.lock
log() { echo "$(date '+%m-%d %H:%M') $*" >> "$D/status.txt"; }

session() { # name promptfile donefile — one job; resume if its file is missing
  local name=$1 pf=$2 done=$3 n=0 sid
  [ -s "$done" ] && { log "skip: $name"; return; }
  log "start: $name"
  claude -p --output-format json < "$pf" > "$D/result-$name.json"
  while [ ! -s "$done" ] && [ $n -lt 3 ]; do
    n=$((n+1)); while [ -d "$LOCK" ]; do sleep 30; done
    sid=$(python3 -c "import json;print(json.load(open('$D/result-$name.json'))['session_id'])")
    log "$name: missing, resume $n"
    echo "Continue from FILM.md Progress. Run every job in the foreground." |
      claude -p --resume "$sid" --output-format json > "$D/result-$name.json"
  done
  log "finished: $name ($( [ -s "$done" ] && echo ok || echo MISSING ))"
}

locked() { until mkdir "$LOCK" 2>/dev/null; do sleep 30; done; "$@"; rmdir "$LOCK"; }

language() { # script+voice (session) → dub (runner) → review (session), at most 2 rounds
  local c=$1 r
  session "voice-$c" "$D/prompts/voice-$c.txt" "$D/reel/dub/$c/voice/timings.json"
  for r in 1 2; do
    locked node "$S/dub.mjs" "$D/reel" --lang "$c" > "$D/logs/dub-$c-$r.log" 2>&1
    session "review-$c-$r" "$D/prompts/review-$c-$r.txt" "$D/reel/dub/$c/.review-$r"
    grep -q redo "$D/reel/dub/$c/.review-$r" || break
  done
}

for c in ja es fr de; do
  while [ "$(jobs -rp | wc -l)" -ge 3 ]; do sleep 30; done
  language "$c" &
done
wait
log "ended"
```

Each prompt file states its one job, the files to read, the done-file, and what not to run
(a voice or review session never starts `dub.mjs` or `render.mjs`).
