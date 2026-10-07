# Running the stages unattended

Read this when the film's stages will run with nobody at the keyboard — overnight, or as a batch
of language versions — driven by a runner that starts one non-interactive session per job
(for example `claude -p`). The bundled runner in `scripts/runner/` does the waiting, locking,
retrying and logging; you write one plan file for this film and one prompt file per session job.
Shape both to the film.

## What goes wrong without it

- **A job dies with the session that started it.** A session that launches a render in the
  background and then ends its turn takes the render down with it. The output never appears.
- **A session's background task has a time limit.** A host may stop a background task after about
  two hours, and a foreground command after about ten minutes. A render owned by a session
  therefore dies when the limit comes, together with every other job that session owned.
- **Long sessions hit the host's time limit.** One session that writes, voices, renders and reviews
  several languages crosses it; the work stops halfway with no file to resume from.
- **"Done" in a session's reply is not done.** Only the hand-off file is.
- **A long loop in one job loses everything on one error.** A job that renders many scenes or lines
  in one run and fails near the end leaves nothing to resume from.

## How to cut the work

1. **The runner owns long jobs; sessions own judgment.** A render, a dub, a join, a synthesis batch
   or any job that can run longer than a few minutes belongs to the runner, which starts it detached
   from any session, waits, retries and logs. A session's background task is never the owner of a long
   job. Each session does one piece of judgment work and leaves one file.
2. **One session, one job, one done-file.** Use the stage table's hand-off files as done-files
   (`plan.json`, `voice/timings.json`, a review verdict; for a `dub.mjs --lang <code>` job,
   `<reel>/out/final-<code>.mp4`, the file `dub.mjs` writes). Write every done-file as an absolute path:
   the runner refuses a relative one, and it appends `Done-file (absolute path): <path>` to the
   session's prompt so the session writes exactly the file the runner checks.
3. **Jobs that depend on each other run one after another, each in a fresh session.** Jobs that
   do not (the languages of one film) run side by side, a few at a time.
4. **Deterministic heavy jobs run in the runner, not in a session.** `render.mjs`, `dub.mjs`,
   audio extraction and joins need no judgment. Heavy jobs run one at a time under the render slot
   (`scripts/runner/lock.mjs`), since two renders on one machine slow each other down more than they
   gain.
5. **Inside a loop, split the job into chunks with a done marker per chunk.** A loop over scenes,
   lines, languages or shots runs one chunk per job (or one chunk per pass) and writes a marker
   for each chunk when it finishes. A restart skips the chunks that have a marker and redoes only
   the rest. One error then costs one chunk. Even a film with no narration is split into short
   scenes (`references/pipeline.md` "Splitting a film into short scenes from the start").
6. **A review loop goes through files.** The review session writes a verdict file (`ok`, or
   `redo` after fixing the lines it found); the runner reruns the deterministic step and asks for
   one more review. Cap the rounds.
7. **Check the done-file, then resume.** If a session ends and its done-file is missing, the runner
   resumes that session by its id with a short note, up to a cap. After the cap the stage is marked
   failed, the stages that need it are skipped, and the others go on.
8. **Never edit a script while it runs.** A shell script is read as it executes, so an edit changes
   the running job. Copy it and edit the copy, or let the runner run a `script` stage from its own
   snapshot copy.
9. **Log one line per start and finish** to a status file, with the done-file's state. That line
   is what anyone checking in the morning reads first.

## Safety rules for every unattended session

- **Never print a secret key.** Do not run `env`, `printenv` or `set` to look for one, and do not echo
  a variable that may hold a key. To learn whether a key is set, test it without printing it (for
  example `[ -n "$NAME" ] && echo set`). Tools report a key as set or not set, never its value.
- **Never kill a process by name.** `pkill <name>` and `killall <name>` stop other people's and other
  sessions' work. Stop only a process this session started, by the pid it recorded when it started it.
- **Wait for the GPU.** The render slot also waits while any other work, another session's included,
  keeps the machine's GPU busy. Do not start a GPU job (a render, a speech-to-text run) around it by hand.

## The bundled runner

`scripts/runner/` holds the parts. Read a script's `--help` before use.

| Script | What it does |
|---|---|
| `run.mjs <plan.json> [--check] [--redo a,b]` | runs the stages of a film in dependency order, unattended; validates the plan with `--check`; prints the cost report at the end |
| `lock.mjs run [options] -- <command>` / `lock.mjs status` | the render slot: one heavy job at a time per machine and user, fair order by priority then arrival, a dead owner's slot released and its leftover child processes stopped. Options: `--priority <n>` (higher first, default 0), `--label <text>` (shown in status), `--no-gpu` (wait for the slot only, never probe the GPU), `--poll <sec>` (how often to look again, default 5) |
| `gpu-probe.mjs [--threshold <pct>] [--wait]` | reads how busy the machine's GPU is, whoever is using it (macOS `ioreg`, NVIDIA `nvidia-smi`); exit 0 idle, 2 busy, 3 no probe |
| `queue.mjs list [--older-than <hours>]` / `queue.mjs remove --ids ...` | lists stale queue entries as facts (`--older-than` sets the age for the `older-than-<hours>` reason, default 24, `0` turns it off), then removes exactly the entries you name |
| `cost-report.mjs <film-dir> [--results <dir>]` (results default `<film-dir>/results`) | per stage: sessions, cost, session time, wall time, turns, tokens, flags; TTS usage when the synthesis tools logged it |

**The plan file** (`run.mjs`) is JSON, every path absolute: `dir` (state, logs, results, `status.txt`),
`claude` and `claudeArgs` (the command for session stages), `maxParallel`, `lock`
(`gpu`, `threshold`, `gpuWaitMaxSec`, `gpuIdleSamples`) and `stages`. A stage has a `name`, a `kind`
(`session` or `job`), a `done` file, optional `needs` (stage names), `owns` (files or folders it writes)
and `verify` (`json`, `contains`, `matches`, `minBytes`), and either a `prompt` file (session) or a
`cmd` array or a `script` path (job). `maxResumes` caps a session's resumes, `maxAttempts` caps a job's
retries; a job is `heavy` by default and so runs under the render slot.

What the runner enforces:

- A done-file counts only when it exists, is non-empty, was written after the stage started (an old
  output does not count) and passes `verify`.
- Stages that can run together must not own the same file or folder (the done-file counts as owned);
  the plan is refused otherwise.
- Finishing a stage again (a rerun or `--redo`) forgets the stages after it and renames their
  done-files to `<name>.invalid-<stamp>`, so a stale output never satisfies a later stage.
- A restart skips stages whose recorded state still matches their done-file.
- A `script` stage runs from a snapshot copy under `.runner/snapshots/`.

**The render slot.** `lock.mjs` takes the slot with `mkdir`; waiters queue by priority and arrival. A
heavy job also waits while the machine's GPU is above the threshold (`SVA_GPU_BUSY_PCT`, default 50%)
for several readings in a row (`SVA_GPU_IDLE_SAMPLES`, default 3), so a pause between two bursts of
someone else's work does not count as idle. After `--gpu-wait-max` (5400 s) it goes on and says so; with
no GPU probe it waits for the slot only and says so once. The slot folder is per user, mode 700;
`SVA_RENDER_LOCK` overrides its path.

**Stale queue entries take two steps.** `queue.mjs list` prints facts for each entry: whether its pid is
alive, its age, and whether the output it declared (`--output` on `lock.mjs run`) already exists, with
candidate reasons (`owner-dead`, `output-present`, `older-than-<hours>`). It removes nothing. Read
those facts yourself, decide which entries are really stale, then run `queue.mjs remove --ids <id,id>`
with exactly those ids. An unknown id stops the command with nothing removed; an entry whose pid is
alive is refused unless `--force`.

## Cost and time report

When a film's stages finish, print the report to the user in the final message: per stage the
sessions, cost, session time, wall time, turns and tokens, and the TTS usage. `run.mjs` prints it
at the end and writes `<dir>/cost-report.txt`; `cost-report.mjs <film-dir>` prints it again.
Whatever a tool could not measure (a session result with no cost field, no TTS usage log) is listed as
not logged, never estimated.

## Where the earlier stages left things

A stage that starts from another stage's work looks in `FILM.md` first, so it does not rebuild what
exists. Keep one table in `FILM.md` and update it whenever a stage writes a file of these kinds:

| What | Where it lives | Done marker | Replaced or old |
|---|---|---|---|
| scene drafts (`out/drafts/<id>.mp4`) | path | marker file or `--plan` state | older drafts and where they were moved |
| rendered segments and the picture | path | the done-file | |
| voice and timings | path | `voice/timings.json` | |

Write the paths as they are in this reel. A new stage reads the table, then checks the files exist.

## When a document and the schema disagree

Whenever a reference, a template, a script's help or the schema says one thing and the file in front
of you or another of those sources says another, find out which is right before going on; do not
guess and do not silently pick one. Decide whether to fix your file, use the value as the tool needs it,
or note the mismatch in `FILM.md` and the final report. `validate-plan.mjs` prints
`doc/schema mismatch: <field>` when a plan carries a field the schema rejects but a reference or
template names, or the page reads a `meta.<field>` the schema lacks. Treat that line as the prompt to
check which side is right. The same habit applies to any sync you cannot make exact: say what differs,
say which value you used and why.

## Prompt files

Each prompt file states its one job, the files to read, the done-file (the runner appends its
absolute path), and what not to run: a voice or review session never starts `dub.mjs` or
`render.mjs`, because those are runner jobs. Examples, not a menu: shape the stage list and the
prompts to the film; any split that keeps one judgment job per session and every heavy job in the
runner works.

## Watching a long stage

Use the waiting coordinator as a watcher, separate from the stage session. Keep a
small record beside the runner state: stage, session ID, owned PID, last event,
last progress time, lock owner, wait reason, retry count and next action.
The runner state and the actual event stream are evidence; a success reply is not.

Track three clocks separately: host session lifetime, time waiting for the render
slot or GPU, and active job time. A host time limit includes waiting. A long lock
wait alone does not show a stalled render. Inspect `lock.mjs status`, the runner's
`status.txt`, the stage log and its latest result before deciding.

While waiting, sample those signals at a modest interval. Look for an advancing
frame count, a tool result, a live lock owner or a new stage event. File size and
modification time are supporting signals, not proof of progress or completion.
Compare active time with that stage's observed baseline when one exists. Without
a baseline, record uncertainty instead of inventing a universal timeout.

If the host call is interrupted, keep its session ID and check whether its owned
job still runs. Resume that same session with the current stage, last event and
missing done-file after the heavy job releases its slot. Avoid starting a duplicate
render. Use the current host's supported resume mechanism; adapters and flags can
differ. The bundled runner's session adapter and `maxResumes` behavior are described
above. A different host adapter needs its own verified resume command.

On repeated unchanged signals, ask the stage for its current operation and blocker.
Continue when there is evidence of progress. Stop only an owned process when a
terminal failure is confirmed. Record the reason and preserve resumable state.
Notify the owner when a required input or external condition blocks progress;
continue independent stages. Keep retries within the plan's cap.

A useful watcher record is `{stage, sessionId, pid, phase, lastEvent, waitReason,
retry, action}`. `phase` can be waiting, running, interrupted, blocked or done.
For example, a live lock held by another render means waiting. An exited job with
no valid done-file means interrupted or blocked. It never means done.
