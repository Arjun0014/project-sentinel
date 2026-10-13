# Changelog

All notable changes to Project Sentinel (called Control Room until 1.4.0) are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version in
`plugins/project-sentinel/.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json` must
match. `claude plugin tag plugins/project-sentinel` checks this when tagging a release.

## [1.7.0] - 2026-10-13

A hardening and UX pass driven by real long-run failures: a written handoff held for hours by a Vite preview
server while its 775k-token cache went cold, and agents Claude Code showed running that Sentinel said did not
exist. Background work is now classified and only finite work is waited for, within a bound; a Handoff
Supervisor watches every handoff; Keep warm stays on until the old context is really discarded; the person always
has a way out. Agents are tracked from their spawn, workflows included, with an Activity view and a band above
the status bar. The status bar shows the plan's five-hour usage instead of the run's cost; completed milestones
keep evidence and say when it goes stale; navigation has two distinct levels; and new installs start with
Autopilot and Frontier Max on, while existing installs keep what they had. 576 tests pass on Claude Code 2.1.296
and 2.1.289.

### Changed

- **A background process is no longer automatically a handoff blocker.** A written handoff waited for every task
  Claude Code listed in flight, so a persistent Vite preview server kept it in `waiting-background` for good while
  Keep warm stood down and a 775k-token cache went cold. Each task Claude Code's Stop lists is now classified
  (`features/background.ts`): dev, preview and API servers, watchers, tunnels, log followers and monitors are
  never waited for; tests, builds, renders, installs, transfers and agents are; anything unrecognised is waited for
  and, after a minute, asked about once by a small isolated classifier (`$.model.classify`, the command and
  Claude Code's description only, never the conversation). A wait is bounded by **Context → Autopilot → Wait for
  background work** (`autopilot.waitMinutes`, default 20 minutes, 0 never waits): past it the handoff goes on and
  leaves the work running. Claude Code keeps background work across `/clear` and hands its result to the fresh
  context (verified live), which is told what still runs: servers to reuse, results that will arrive there.
- **The Handoff Supervisor** (`features/supervisor.ts`) looks at a handoff under way every 30 seconds, without a
  model call or anything added to the transcript: how long the step has stood, what holds it (finite work, long
  finite work, unrecognised work, a server beside it, a question open to the person, a step whose event never
  came), and the ways out. It shows in Context and on a line above the status bar, traces each change to the debug
  log, and acts by itself only at a wait's end (never under a running turn) or when a wait holds nothing any more
  in a quiet session (a reload that found only servers left, the last task stopped).
- **Keep warm stands down only when the old context is about to be discarded**: the notes check before a clear,
  the clear, the fresh context resuming. Every earlier step reads the old context again (the handoff turn, each
  notification's turn, the person's message), so a due, written, waiting or stuck handoff keeps the cache warm.
- **The person always has a way out of a waiting handoff.** Typed while a handoff is under way, "handoff now",
  "don't wait for the background process", "start the fresh session now", "keep waiting", "stop the server and hand
  off" or "cancel the handoff" is acted on before the Cold Resume Guard and never sent into the old context. Any
  other message while a written handoff waits (or Claude writes the notes) is not let in unasked: hand off and give
  it to the fresh context (it waits in the Mission Queue), send it here, or keep it in the prompt box. The same ways
  out are commands (`/cr handoff now|wait [30m]|stop [id|all]|cancel`, `/cr fresh now`) and buttons (Context and
  the status bar: Hand off now, Stop & hand off, Keep waiting, Call off). `/cr fresh` with only a server running
  starts the fresh context and says the server keeps running.
- A server in the session no longer parks the Mission Queue and watcher wakes, silences the Watcher Scout, excuses
  an early stop to the lazy-exit guard, or makes the headline say "Waiting for …": only work whose notification
  brings a turn back does.
- Handoff Health records what a handoff left running (neither good nor missing), and the run's record notes each
  task's end when its notification reaches the fresh context (Context → Last handoff).
- A 1.6.3 handoff record stuck on a server is classified again after the update, and its wait is bounded.
- **Agents are first-class.** An agent shows from its `agent.spawn` (starting until Claude Code lists it), and the
  agent list is looked at every two seconds while any agent is alive, whether or not the list has caught up: before,
  Sentinel listed agents only before a spawn and polled only once the list showed a running one, so a foreground
  agent stayed invisible until its call returned, and a workflow's agents (which Claude Code never lists) never
  showed at all. The list now reconciles a ledger fed by each agent's spawn, its own loop's calls and requests, its
  `turn.complete` and, for a workflow run, the run's end: an agent the list leaves out for a moment keeps its status
  (no longer listed only after several looks over six seconds), an end Sentinel saw outranks a list a moment behind,
  a message that resumes an agent brings it back, and a teammate's turns leave it idle. Two spawns at once no longer
  both pass a limit of one (a slot is held from the decision until the spawn settles); a workflow's agents are not
  counted against the limit.
- **Activity → Agents**, a view of its own (Activity is now Summary · Operations · Agents · Tool calls; Agents shows
  while agents run or ran in the last ten minutes): each agent under its parent, a workflow's agents under their
  run, with its type, model, status, time, what it is doing (its latest call) and when it last acted, its calls, its
  own plan as a track when it keeps a task list or milestones (never a made-up percent), its result or failure, and
  Stop and Message where Claude Code takes them. Operations keeps one line leading there; the agents chip, `/cr
  agents` and Guardrails' link open it.
- **The agent band**: while subagents run, a line per agent above the status bar (up to three; more are counted by
  what they do, "5 agents · 2 reading · 2 editing · 1 checking"), each opening Activity → Agents; gone when none run.
- `/cr watchers` opens Operations at the watchers.
- **The status bar shows the plan's five-hour usage instead of the run's cost.** `5H ▂▂▂▂▂▂ 63% · 2h14m` in the
  terminal (a thin bar, the percentage, the time to the window's reset), a `5-hour usage` cell on Desktop, and the
  same words on Claude Code's status line (`/cr hud status`). It is Claude Code's own reading
  (`$.session.usage().rateLimits` and `session.measure`), never an estimate: `5H —` before the first response,
  `5H reset · new window` once the window's reset time passes (or the window leaves the list) until a response
  reads the new one, amber from 80%, `5H limit` in red at 100% or when Claude Code ends a request on the rate limit
  (`classic.StopFailure` `rate_limit`; "Rate limited" when no window reads full), until a turn is answered again or
  the window resets. An account with no five-hour window (an API key) shows nothing there in the terminal and
  `Plan usage —` on Desktop. The countdown is redrawn once a minute only while a window counts down. The run's
  cost stays in Overview, Context → Run (which now also spells out each window: 5-hour and 7-day, with their
  resets), `/cr status` and the Run Budget.

- **Two levels of navigation that never look alike.** Activity's views were drawn with the same `● Summary
  ○ Operations` marks as a setting's choice, so they read as random buttons. They are now a second level of their
  own (`subNav`): a breadcrumb, `Activity › Summary`, over a captioned row, `View  [ Summary ]  Operations  Agents
  (2)  Tool calls`, the current view bracketed in the section's accent and the others dim; on Desktop the
  breadcrumb over a bordered group of buttons, apart from the section bar's free-standing ones. Keyboard focus
  walks it like any other control.
- **Color is meaning, not decoration.** Card titles were each drawn in the accent of the section they belong to
  (Overview became a rainbow); they are now quiet structure, bold and gray. Green is verified, amber waiting for
  you or worth a look (a question, a decision, a watcher due, a held message, the fresh context waiting for you:
  these were the brand's orange), red a failure or a blocker (a failing check, a blocked milestone, a blocking
  decision), blue what is current or under way (a handoff in progress: it was orange), gray the default and the
  past. The brand's orange is kept for its mark, the Control Room button, the handoff point on the context meter
  and the Quest log.
- **Each page leads with what needs you, then what is happening, then its controls, then history.** Overview's
  *Now* moved from a box halfway down to a line right under the run; its untitled profile box became a *Setup* card
  like the other sections'. Context no longer repeats its handoff steps above the Autopilot settings while
  Autopilot simply watches (one sentence and *Hand off now*; the numbered steps stay where they teach, with
  Autopilot off). *Ready to resume* speaks up in red and amber only while a fresh start is in play (a handoff under
  way, the Cold Resume Guard armed, a watcher that may wake fresh); otherwise "Not needed yet", in gray. A card with
  nothing in it yet is a quiet line, not a box around one.

- **Opinionated out of the box, for new installs only.** A fresh install now starts with Context Autopilot on
  (handing off at 70% into a fresh context that carries on by itself, compacting if the clear fails), Frontier
  Max on at Extra High effort, the Decision Inbox, Watchers and run milestones on. That set is the new **Normal**,
  so a fresh install reads "Normal", not "Normal · edited". The lazy-exit guard stays off and no permission
  changes: 2 categories Deny (force push and resets, dangerous commands) and 6 Ask (installs, downloads, edits
  outside the project, deleting files, push, deploy) are kept as they were, because "Default" there would hand
  those decisions back to Claude Code. An existing install keeps exactly what it had: settings saved before 1.7.0
  on Normal are relabelled **Classic** (a new built-in profile: Normal as it was, Autopilot and Frontier Max off),
  every value untouched; one that used Sentinel without ever saving a setting (its runs, cache memory or Quest log
  are in the store) is saved as Classic; Frontier Max, Low Resource and Release / QA are what they always were.
  Settings carried over from Control Room's store still win over a fresh install's defaults written moments
  before at the same session's start. Stored settings are read against Classic, so a group an older version
  never saved is never switched on by the new defaults.
- **A fresh install says what it does, once.** A short "Sentinel is on" card at the top of Overview (Autopilot at
  70%, Frontier Max at Extra High, where Guardrails live, Activity's views, Work carries on while Context starts
  over; each with a way there) until *Got it*, and one toast at the first load.
- **Frontier Max no longer turns the lazy-exit guard on by itself** (the switch in Behavior and Overview, and
  `/cr frontier on`; the Frontier Max profile still bundles both). Behavior now says plainly what it does: it adds
  Sentinel's strongest engineering policy to Claude's instructions and asks for the chosen effort where the model
  has an effort setting; it never changes the model; *This context* shows whether and how it reached Claude.
- **Guardrails shows every value's meaning and whether it is the default** ("Asks you first · default"; a changed
  one in amber with its default), so a new user needs no knowledge of profiles.

### Added

- **Milestone evidence snapshots.** When a milestone is completed, Sentinel keeps what it stood on
  (`features/evidence.ts`, in the run record): when it was verified, the checks that were green during its work
  (their kind and command), the files its work changed (edits Sentinel saw while it was under way, and `outputs`
  Claude may now name in the milestones tool) with Git's blob id of each (`git hash-object --no-filters`, only the
  id is kept), their size and time, and HEAD. Never the whole repository. At a handoff (the fresh context is told
  what that comparison found), a session's start or reload, a milestone's completion and (at most once a minute) a
  turn's end, the files are compared with the workspace: an
  unchanged size and time costs no hashing, and a file only touched stays current. A change is never called
  wrong: the milestone's *verification is stale*, with which files changed, since when and which checks to rerun.
  Later milestones changing the same files do not raise noise: quiet while they are under way ("being changed by
  M3"), and re-baselined once the latest run of every kind of check the earlier milestone had passes after the
  change (or, for documentation and check-less milestones, once the later milestone is completed). A change made
  outside Claude's tools clears the same way once the checks pass after Sentinel found it, or when the person
  accepts the files as they are (`/cr evidence accept`, or *Accept files as they are* in Activity). Shown in
  Activity's Run progress (the milestone's row) and Attention, Context's Last handoff (a *Verification current*
  item in Handoff Health, and the stale milestones) and Ready to resume; the handoff prompt asks Claude to rerun
  the checks or say so in the notes, and the fresh context's block names them. `/cr evidence [check|accept]`.

### Verified live (Claude Code 2.1.296, read-only probe plugin, headless)

- Background shell tasks survive `/clear`: the fresh context's Stop still lists them, and a task's
  `<task-notification>` arrives in the fresh context and starts a turn there. A background agent was resumed there.
- A background server started without a timeout (`python -m http.server`) was still running about 25 minutes later,
  across `/clear`, with no notification: nothing bounds such a task by itself. One started with an explicit 45-second timeout was
  killed at 45 seconds and reported `killed`.
- `$.session.usage().rateLimits` is empty before the first response, then reports `five_hour` and `seven_day`
  windows (`percentUsed`, `resetsAt`); `session.measure` fires with `rateLimits` in `changed`.
- Workflow agents (`workflow-subagent`) are never in `$.agent.list()`; a foreground agent is, but Sentinel
  listed agents only before a spawn and polled only once a running agent was listed, so it could miss both.

### Fixed

- **A server health check was refused as a download.** `curl -s -o /dev/null -w "%{http_code}" http://localhost:8781/`
  (Claude checking the preview server it had started) was classified *Downloading files*, set to Ask, so a headless
  run refused it and an interactive one would have asked. Output sent to the null device (`/dev/null`, `NUL`,
  `$null`) or to stdout (`-o -`, `wget -qO-`), and a redirect into the null device, keep no file: such a fetch is
  *Network* only. A file named in any spelling (`-o f`, `-Lo f`, `-of`, `--output=f`, `> page.html`, `-O`) is still
  a download, and a fetch piped into a shell is still refused as dangerous. Found in a live run.
- Keep warm wrote the same refresh plan to the debug log twice at a turn's end; it writes each plan once.
- **Found in the Claude Desktop app**, each with a regression test that fails on the old code:
  - **A prompt pasted in Desktop named the run `<pasted_content id="2961">`.** Desktop wraps a pasted prompt in a tag
    on its own lines (the closing one carries the id too); the objective skipped only the terminal's `[Pasted text …]`
    placeholder. A line that is only a tag is skipped and the wrapper is stripped, so the objective is the paste's
    first sentence; tags the person wrote stay their words.
  - **The status bar's `5-hour usage` caption sat flush right**, apart from its wider reading, the only cell aligned
    to its end. Every caption now starts where its reading starts; the cell keeps the right edge. The Desktop preview
    (`tools/desktop-preview`) now draws a five-hour reading, so it shows that cell as the app does.
  - **A shell call was named after its `cd`.** `cd "/c/Game Dev/GRAVELINE" && npx vite build …` read *Running cd* in
    the status bar through a build. The command doing the work is named, past a change of directory (`cd`, `pushd`,
    `Set-Location`) or an environment setting (`export`, `set`, `source`, `FOO=1`, `$env:FOO='1'`): *Running git log*,
    *Running node*.
  - **The Watcher Scout's question was garbled.** A milestone waiting for "the window reset at 14:50 local" asked
    *Check The window reset local again at 14:50?*. A clock time keeps a following "local" or "local time" with it, and
    an article or a determiner at the start of the label is lowercase inside the question (a name keeps its capital):
    *Check the window reset again at 14:50 local?*

### Verified live (Claude Desktop app, Code tab, its Claude Code 2.1.295, Opus 5.5, 2026-10-13)

- **Desktop loads the installed copy, not the repository folder.** The Code tab runs its own Claude Code and loads a
  plugin from `installed_plugins.json`'s install path: it ran 1.6.3 until `claude plugin update
  project-sentinel@control-room` installed 1.7.0, while the terminal's Claude Code read the folder in place. A fix
  copied into the install path reached the sessions started after it. The settings saved before 1.7.0 read **Classic ·
  edited**, every value kept.
- **Five-hour usage**: the `5-hour usage` cell read 36% · 1h43m with its thin bar at about 13:07 local, and the app's
  own usage card 36%, resetting 09:20:00Z (14:50 local), a minute later; Context agreed too (18%). After the alignment
  fix a new session drew the caption over its bar's left end (37% · 1h34m).
- **Activity's second level**: `Activity › Operations` over a bordered *View* group, `Summary · Operations · Tool calls
  (60)`, the current view the primary button, apart from the section buttons; no Agents button with no agents.
- **Guardrails**: with every permission stored as *Default*, the three whose default is Default read *Claude Code
  decides · default* in gray, the others in amber with their default (*asks you first*, *never runs*).
- **Behavior**: Frontier Max's *This context* read *Delivered in the system prompt from the first request · sent with
  Extra high effort*, and the session's instructions carried the policy at Extra high effort.
- Not seen in the app: the window's reset at 14:50 (the person is watching it), the agent band and Activity › Agents
  (seen in a real terminal above), and `/cr handoff` beside a dev server (driven live headless above).

### Verified live (Claude Code 2.1.296, Sonnet 5.5, this build under a renamed copy, 2026-10-13)

- **Server + render + Keep warm past the TTL** (headless, `FORCE_PROMPT_CACHING_5M=1`, Keep warm on): Claude started
  `python -m http.server` and a 10-minute render in the background, then `/cr handoff`. The server was not waited for
  (`background: not waited for (…: a Python HTTP server)`); the written handoff waited for the render with Keep warm
  still refreshing (two fork HITs reading 37.5k, the expiry moved 06:17:45 → 06:21:45 → 06:25:45); the render's
  notification turn, almost 10 minutes after the last request, read the whole cache (`VERIFIED · read 37726`). Keep
  warm stood down only at the notes check before the clear; the fresh context was told the server runs, and its own
  Stop still listed it.
- **Patience** (`waitMinutes` 2): the supervisor called a 5-minute docs build `long-finite … past its wait` at 2 minutes,
  the handoff went on and left it running, and its notification reached the fresh context three minutes later, where
  Claude recorded it (`left running by the last handoff, ended here (completed)`).
- **The isolated classifier**: `python ingest_daemon.py` (a listener that never exits) matched no rule and was waited for;
  after its minute the supervisor asked once, with the command and description only (`persistent_service → persistent`),
  and the handoff went on at once, leaving it running for the fresh context.
- **"handoff now"** typed while a handoff waited for a 7-minute benchmark beside a server: acted on before anything
  else (`handoff guard: "handoff now" read as "hand off now"`), never entered either conversation, the fresh context
  reused the running server and recorded the benchmark's result when its notification arrived there.
- **Milestone evidence**: a milestone verified with `npm test` (3 files, blob ids, HEAD); `calc.js` edited by hand →
  `/cr evidence check`: *stale: calc.js changed since 11:42 · rerun Tests*; the handoff prompt carried *Verification
  gone stale*; Claude reran the tests in the handoff turn, and the verify step read *current: re-verified by Tests*.
- **Agents in a real terminal** (150 columns, a fresh install): two background agents and a two-agent workflow showed
  in the band above the status bar and in Activity › Agents at once (the workflow's agents grouped under their run,
  `0 of 2 agents ended` → `2 of 2`), each with its activity and calls; the band opened the view; ends while the panel
  was open moved them to *Earlier* with their results; the band left when none ran; a `/reload-plugins` mid-agent
  kept it shown.
- **Fresh install**: *Normal* (not edited), the *Sentinel is on* card, Frontier Max delivered from the first request at
  Extra High, Guardrails' values with *· default*, the lazy-exit guard off.
- **Five-hour usage**: readings 46% → 59% across the runs, all resetting 14:50 local; an interactive session had a
  reading before its first response, headless ones after it; the status bar drew `5H ▂▂▂▂▂▂ 49% · 3h6m`.

## [1.6.3] - 2026-10-09

A continuity fix found in a real 801k-token run: a Context Autopilot handoff whose turn ended while
background work still ran never finished, and the commands meant to recover it did not.

### Fixed

- **A handoff waiting for background work was stranded.** The handoff turn wrote its notes and
  ended while a render was still running, so 1.6.2 rightly held the clear and expected "the turn
  that work brings back" to finish the handoff. Claude Code does bring a turn back, but not as the
  handoff's: when a background task ends while the session is idle, it submits the task's
  notification as a prompt of its own, origin `task-notification`, and that prompt starts a turn
  whose text is the engine's `<task-notification>` report (seen in the run's transcript, then
  reproduced live on Claude Code 2.1.295 with an event probe: `prompt.submit origin=task-notification`,
  `turn.start text="<task-notification>…"`, `classic.Stop background=[]`, `turn.complete`). 1.6.2
  classified turns by their text alone, so a turn with text that was not its own was the person's,
  and a person's turn never moves a handoff on: Autopilot stayed in `handoff` for good, the status
  bar said *Claude is writing the handoff* long after Claude had finished, and no event was left to
  move it. A reload during the wait lost the hold altogether (it was not in the saved record).
  Autopilot now has an explicit state for it, `waiting-background`, entered when the handoff turn's
  Stop lists work in flight. Each task's notification strikes it off the list (and asks Claude, with
  the notification, to record the result in the notes and end its turn); the first turn of any kind
  to end with Claude Code listing nothing in flight finishes the handoff: the notes are checked, the
  context cleared and the work continued, once each. A person's turn that ends with the work still
  running never finishes it, work started meanwhile is waited for too, a task that failed or was
  stopped ends the wait as one that completed, and the wait survives a reload of the plugin.
- **`/cr handoff` said *Handing off* when it did nothing.** It ignored the request during a handoff
  and answered as if it had started one. It now says what really happened: *Handing off: Claude is
  writing the handoff notes*, or *A handoff is already in progress*, *Handoff notes are written;
  waiting for 1 background task to finish before starting fresh (Render the 16:9 master)*, *Handoff
  is complete; Sentinel is checking the notes*, *… starting the fresh context*. A handoff whose turn
  ended unseen is finished when that is safe, and begun again only when it left no notes.
- **`/cr fresh` refused a healthy written handoff.** It started a fresh context only from the
  *waiting for you* state, so a stranded handoff with current notes had only `/clear` left, which
  loses the continuation. It now recovers any handoff no event will move on (`handoff`,
  `waiting-background`, `awaiting`) through the verified clear path, never blindly: background work
  still running (named), or `NEXT_SESSION_PROMPT.md` missing, empty or not written since this
  handoff began, keeps the context and says so. Start fresh context in Context does the same, and is
  offered in those states. A session 1.6.2 left stuck recovers with `/cr fresh` after the update.
- **The turn a background task's notification starts was taken for the person's.** Besides the
  handoff, that counted it as a turn of the person's for watchers, judged it against the
  notification's text as if it were a request, and kept the task in the background list until the
  next turn's end (the resource notice could name work that had finished). Such a turn is now its
  own kind (`notification`), judged against the person's last request, and the task leaves the list
  as its notification arrives.

### Changed

- While a handoff waits for background work, the status bar reads *Handoff written · waiting for
  background work* with the task and *running*, then *Handoff complete · checking the notes* and
  *Handoff complete · starting the fresh context*; Context names the state *Waiting for background
  work* and lists each task with **Stop**. Keep warm stands down, queued work waits, the Scout
  suggests no watcher and the lazy-exit guard stays stood down for the whole wait.
- The handoff prompt says what happens to work left running: say so in the notes; the fresh context
  starts only after it finishes and its result is recorded.
- Handoff Health gains *Background work recorded* for a handoff that waited: whether the notes were
  written again after the last task ended.

### Verified live

Claude Code 2.1.295, headless (`stream-json`, the protocol Claude Desktop's sessions use), Sonnet
5.5, a renamed copy of the plugin beside a probe plugin that logs each engine event to the debug log.
Claude started a 150-second "render" in the background, then `/cr handoff`:

- **1.6.2, the failure reproduced.** The handoff turn wrote the notes and stopped with the render in
  flight (`classic.Stop background=[biokpqbh6:shell:running]`). When the render ended Claude Code
  raised `prompt.submit origin={"kind":"task-notification"}` with no `turnId`, then `turn.start` with
  the `<task-notification>` text; 1.6.2 logged `turn … started (person)`. Claude checked the render
  and updated the notes; the turn ended with `background=[]`. Nothing followed in 45 seconds;
  `/cr status` still said *Claude is writing the handoff*, `/cr fresh` said *No written handoff is
  waiting*, `/cr handoff` said *Handing off* and nothing happened in 20 seconds.
- **1.6.3, the same run.** `autopilot: turnComplete · handoff → waiting-background`; `/cr status`
  read *Waiting for background work · Handoff written. Waiting for background work: Simulate long
  video render*, `/cr handoff` *Handoff notes are written; waiting for 1 background task to finish
  before starting fresh (…)*, `/cr fresh` *1 background task is still running (…). Fresh context was
  not started*. At the render's end: `background: bokbrwxzk ended (completed), as its notification
  says`, `turn … started (notification)`; Claude recorded the result in the notes and the
  milestones; `turn … completed (notification, answer; background in flight: none)`,
  `waiting-background → verifying`, `notes … written (… modified 151 s after the handoff began;
  updated after the background work ended)`, `verifying → clearing`, the fresh session after
  `/clear`, `clearDone → resuming`, `turn … started (continuation)`, `resuming → armed`, all within
  ten seconds of the render's end, with no message from the person. One handoff prompt, one
  `/clear`, one continuation. Session 2 read the notes, finished the two remaining milestones and
  wrote the report; `/cr status`: Run 1 · Session 2, Autopilot watching again.

### Development

- `features/autopilot.ts`: the `waiting-background` state, the `backgroundEnded` and `notesSeen`
  events, the `checkNotes` effect, `turnComplete` carrying the Stop's list, the record carrying the
  wait (older records still load), and `handoffVerdict` / `freshVerdict` (pure: what `/cr handoff`
  and `/cr fresh` do, and the words). Every step of a task's end is traced (`background: <id> ended
  (completed), as its notification says`; `turn … completed (notification, answer; background in
  flight: none)`).
- `tests/background.test.ts` replays the real run's event order through the hooks (the render and its
  waiter, the second notification delivered into the first's turn), plus two tasks ending
  separately, a failed and a stopped task, the person typing while the handoff waits, the render
  ending inside a turn of the person's, every `/cr handoff` and `/cr fresh` answer, a reload while
  waiting and during the notification's turn, the stuck record 1.6.2 left, the queue, decisions and
  milestones carried through, Handoff Health and the status bar. `tests/autopilot.test.ts` covers the
  machine. The core of them fails on 1.6.2 (no clear, `/cr fresh` refusing, `/cr handoff` claiming
  a handoff) and passes now. The test world can age the notes (`notesAt`).

## [1.6.2] - 2026-10-09

A live verification pass over 1.6.1's orchestration layer: each system driven against real Claude
Code 2.1.295 (a renamed copy of the plugin, every request through the recording proxy), and fixed
where it fell short. Each fix has a test that fails without it.

### Fixed

- **Compact first did not compact.** The Cold Resume Guard asked Claude Code to compact from inside
  the prompt it was holding back, where Claude Code refuses a compaction as a turn under way:
  *Compact first* gave up at once and put the message back. It now compacts once that prompt is
  dropped (and asks again while Claude Code still counts it as running; any other refusal is said,
  with its reason).
- **…and once it did, the message never went.** Claude Code does not run a plugin's own
  `session.compact` hook for a compaction the plugin asked for, and the held message waited for
  that hook. The compaction's own result now sends it. Seen live: 185k tokens compacted to 2.9k,
  then the message went once. Context Autopilot's compact handoff had the same blind spot: the
  context meter kept the old size and the next cache rebuild was not put down to the compaction.
- **A message could be sent twice after Start fresh or Compact first.** Claude Code puts a dropped
  prompt's text back in the prompt box; Project Sentinel delivers that same message itself, so one
  Enter sent it a second time. The box is cleared while it still holds just that message (never a
  draft typed since).
- **The run's objective was lost at a fresh start.** Any longer follow-up message became the run's
  objective in place of the one Claude stated with its milestones, and a fresh context (Start
  fresh, a fresh wake, a handoff) carries only Claude's: the fresh context started with none. An
  objective Claude stated now holds while any of its milestones is open.
- **The Cold Resume Guard called a warm cache cold.** Claude Code's own requests while the
  conversation idles (its away summary, seen live reading all 184k tokens three minutes into a
  break) keep the cache warm, and Project Sentinel did not count them. A cost increase with no turn
  running now counts as such a request: nothing calls the cache surely lapsed until that has
  lapsed too.
- **The cache lifetime Claude Code is configured to use was ignored.** On a claude.ai plan Project
  Sentinel assumed the one-hour cache even where `FORCE_PROMPT_CACHING_5M`,
  `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting or `ENABLE_PROMPT_CACHING_1H` say
  otherwise (read in Claude Code's own order): the status bar read *1h left* on a five-minute
  cache, and the guard stayed silent for the hour.
- **Finish the milestone, then pause did not act on a cost limit mid-turn.** Claude Code measures the
  session's cost after a turn, not after each step (seen live: one measurement in a 13-step turn), so
  a cost limit crossed mid-turn went unnoticed until the turn ended. While a cost limit is set, the
  cost is read as Claude works (at most every five seconds; the read costs nothing).
- **Agents after a reload of the plugin.** A running background agent lost **Stop** and **Message**,
  its elapsed time and its model: what the session saw of its agents now survives a reload.
- **Claude was not told who stopped or messaged an agent.** Claude Code reports a plugin's
  `TaskStop` as *stopped by Claude*, and Claude said it could not tell who did it. Claude is now told,
  with its next tool results or prompt, what you did from the Agents panel.
- **Keep warm's hold read as unproven.** A watcher woke six seconds after the third refresh of a
  12-minute hold and read the whole 145k-token cache, yet the panel said *no proof yet*: only the
  newest refresh was checked, and the conversation came back before the expiry that one replaced.
  A read after the expiry the first refresh of the chain replaced proves the chain.
- **A network blip could pause Keep warm with a false reason.** Claude Code retries a request that
  fails to connect, so a refresh sent before the expiry can reach the API after it (seen live:
  sent during a two-minute outage, answered after the cache had lapsed, rebuilding it). Project
  Sentinel read that as *the fork found the cache gone before its expiry*, a failure; two would have
  paused Keep warm. A missed refresh now counts as in time only if it was answered in time.
- **A refused refresh read as "Keep warm was off".** When the API refused a watcher's refresh and the
  cache went cold before the wake, the wake said *Keep warm was off*: the watcher holding the cache
  is no longer armed at its own wake. It now says *Keep warm's refresh failed (The API refused the
  refresh)*.
- **Work queued for after the current milestone went at once while the run waited.** With no
  milestone in progress and one waiting (*Wait for the reviewer*), *After the current milestone*
  fell back to the next safe boundary, which is *now* when nothing runs (seen in an integrated live
  run). A milestone the run waits on or is blocked on now counts as the one under way.
- An answer waiting while a watcher parks the run said only *Goes with your next message*; the wake
  carries it (into a fresh context, or with the wake prompt), and it now says so: *Goes with W-1's
  wake (19:35), or with your next message*.
- `/cr budget` printed a cost limit as a bare number (*Cost $1.43 of $1.2*); it reads as money.
- `/cr queue` and `/cr watch` alone did not put you in their field while the Control Room panel was
  already open: after a command the prompt box holds the keyboard, and Claude Code refuses to focus
  a panel that does not (*that site does not hold the keyboard*; the refusal was not looked at).
  Project Sentinel now asks for the keyboard first; seen live, what you type then goes into the field.
- At a budget limit set to *Ask* or *Finish*, `/cr queue` and the queue said *Due: goes now* for work
  that waits for you; they now say it waits, and how to let it go. *Queued work waits for you* starts
  its sentence with a capital.

### Changed

- **The Cold Resume Guard leads with tokens.** *184k tokens need to be reprocessed …*, and a price
  only as Claude Code's estimate, as a floor: *Claude Code currently estimates at least ~$0.46.*
  (seen live: its $0.36 estimate cost $0.52). *Compact first* says it reads it all once more.
- `/cr agents`, `/cr decisions` and the status bar's chips open Operations at their own card
  (Agents, Needs review, Watchers, Mission Queue, Run budget), not at its top. The first try in a
  live console opened it at its top: the scroll named the card, not the key the panel draws it
  under. It now names that key (seen live: the budget chip opened a closed panel at its Run budget
  card, `/cr decisions` brought Needs review to the top of an open one), tries again while a panel
  opened a moment ago has not drawn the card yet (never once you moved the panel yourself), and
  writes any refusal to Claude Code's debug log.
- A watcher says how it resumes in a few words: *Keep warm · cache held to the wake*, *Fresh ·
  nothing spent while it sleeps*, *Smart · wakes fresh* (was *Fresh: wakes fresh*).
- Operations' log of recent steps stands apart from the Run budget card, as *Recent operations*: it
  read as the budget's history.
- The plugin's own README (its listing in a plugin directory) says how to install it in one step;
  `claude plugin validate --strict` asked for that line.

### Verified live

Claude Code 2.1.295 (the newest; its Mod declarations are identical to 1.6.1's), Sonnet 5.5, a
renamed copy of the plugin with its own store, every request through the recording proxy
(fingerprints and token counts only; `.build/live/evidence/`, not in the repository). Where a run
found a fault, it was fixed and run again.

- **Cold Resume Guard, Start fresh** (CF1): a session of 185k tokens resumed after its five-minute
  cache lapsed. Typing a message brought the question, and no request carried the old context:
  `/clear`, then one fresh request (2 messages, Frontier Max and the policy section in it, the
  `contextAutopilot` block) carrying the message once (once in the new transcript, never in the
  old). The fresh context continued the same milestones, did the work queued for the handoff, got
  the work queued after a milestone with its tool results when that milestone completed, and left
  the open decision and the armed watcher alone.
- **Cold Resume Guard, Compact first** (CF2 found both compaction faults; CF3 after the fixes): the
  compaction ran once the prompt was dropped (185k → 2.9k tokens; the request sent 112k uncached
  and read 72k), then the message went once; the copy in the prompt box was cleared; the cache
  view read *Compacted · Expected*; run state, queue and decision intact.
- **Agent Command Center** (AG1): two background agents listed with status, type, elapsed time,
  model and what each was doing. **Message** to one (Claude Code's `SendMessage`): it ended *ALPHA
  GOT PINEAPPLE*; the other never got it. **Stop** on the other (`TaskStop`): *Stopped before it
  finished*, nothing left running. A third agent across a reload of the plugin kept its row (and,
  after the fix, Stop, Message, time and model); Claude, told what you did, said who stopped it.
- **Run Budget** (RB1–RB3): *Notify* said near once and reached once and changed nothing; *Ask* held
  queued work (nothing in 20 s) until `/cr budget continue`, then sent it once, and asked before your
  message (*Not now* kept it in the box, nothing sent; *Continue the run* sent it once, then the
  held item); *Finish* (after the mid-turn fix) had Claude finish the milestone under way, write
  its notes and stop with two milestones untouched, no tool call cut. The time limit said near at
  80% and reached at 9 minutes; a handoff limit of 1 was reached by a fresh wake's `/clear`. The
  budget survived `/clear` and a reload; a new run in the same project started with none.
- **Watchers** (WA1–WA4): Smart chose *Keep warm · 18m wait · 145k context · a short hold of the
  5-minute cache* and *Fresh · 6h wait · … costs more than a fresh start*. A Keep warm watcher held
  a 145k cache for 12 minutes (three refreshes, each reading about 144,960 tokens and writing at
  most 5); the wake read 144,965 from the cache, in this context, and Claude read the file it was
  waiting for. A watcher whose run moved stood down at its time (nothing sent). With the refresh
  refused by the API (a test proxy's 400), a Smart watcher woke fresh instead of re-reading 145k
  (the fresh request wrote 38k), and a Keep warm watcher waited for you, sending nothing.
- **One integrated run** (INT, the one-hour cache, Kit on): milestones, a background agent, a
  decision, three queued items, a budget set to Ask, a Fresh watcher; the decision answered while the
  run slept rode the fresh wake with the handoff's queued work; each item went once; progress went
  on to 5 of 5 across the `/clear`; the run's cost carried on; no agent was left running.
- **Not verified:** how Operations, the status bar and Kit draw in Claude Desktop (this environment
  cannot look at the app; `tools/desktop-preview` was used); Stop and Message on a teammate.

### Development

- The in-memory host (`tests/fixtures/fake-host.ts`) plays more of Claude Code as it was seen live:
  the prompt box Claude Code puts a dropped prompt back into (`box`, read by `$.prompt.read`), the
  cache lifetime configuration (`ttlConfig`), a refresh answered late (`forkDelayMs`) or refused by
  the API (`forkRefusal`), compactions refused while a turn is under way (`compactRefusals`), a panel
  that has not drawn a card yet (`paneRefusals`), a panel already open (`isPaneOpen`) and each open
  with whether it asked for the keyboard (`opens`), the scroll by the key a card is drawn under
  (`scrolledTo`), and the agent ledger kept across a reload (`agentLedger`). The engine world keeps
  the debug log (`logs`) and each open's `focus`: the test engine scrolls and focuses nothing, so a
  test reads the key a scroll or focus asked for from its trace and finds it in the drawn panel.
- Each fix above has a test that fails without it. 447 tests in 26 files, passing on Claude Code
  2.1.295 and 2.1.289.

## [1.6.1] - 2026-10-09

The release of 1.6.0's orchestration layer. 1.6.0 was pushed (`36d60de`) and never tagged: CI on
Claude Code 2.1.289 found the fault below. A new version, so that an install already at 1.6.0
updates (Claude Code updates by version: at the same version it keeps what it has).

### Fixed

- **The status bar on Claude Code 2.1.289.** The chips that open Operations drew their mark and
  words as styled text inside a button. Claude Code 2.1.289 takes a button's label only, refuses one
  with anything inside, and then skips the whole status bar: on that engine the bar vanished whenever
  a chip showed. The words are the button's label now, the mark beside it in its color; the tests
  refuse such a button on every engine. 430 tests, passing on Claude Code 2.1.295 and 2.1.289.

## [1.6.0] - 2026-10-09

Long-run orchestration: what happens next in a run, and who it waits for. One layer with one home,
Activity → Operations, designed in [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md). Everything in it
belongs to the run, so it survives `/clear`, handoffs, a reload of the plugin and a resumed session,
and nothing of an ended run leaks into a new one. 430 tests.

### Added

- **Mission Queue.** Work you give Claude for later without interrupting it: *Add work for later*
  in Operations, or `/cr queue <text>` (`--turn`, `--milestone`, `--handoff` choose when;
  `/cr queue` alone opens the field). Each item goes only at its boundary: the next safe one (the
  milestone under way completes or the turn ends), after this turn, after the current milestone
  (with the next batch of tool results, never into the reasoning), or into the next fresh context.
  Reorder, edit, deliver now or delete; delivered once (one on its way during a reload reads *Sent
  before a reload*, never resent by itself). `/cr` stays a non-immediate command: a slash command's
  echo and reply become part of the conversation (seen in the requests), so typed mid-turn it runs
  when the turn ends.
- **Decision Inbox.** Claude is offered `decision_request` for a choice that is yours and need not
  stop the work (with its context, up to four options, free text, urgency, whether it blocks, its
  milestone). It waits in *Needs review* with a button per option and a field for your words;
  `/cr decisions`, `/cr decide D-2 [answer]`. The answer reaches Claude with its next tool results
  while it works, as a prompt of its own when the run waits on it, else with your next message
  (**Send now** sends it at once). A blocking decision takes the headline: *Needs you · 1
  decision*. The tool's description keeps status updates, Claude's own choices and every
  permission or safety confirmation out of it; permission prompts are never deferred.
- **Watchers.** Park the run until a time, then wake Claude to check what it waited for:
  Operations' form (`in 2h`, `at 14:00`, quick *In 30m · 1h · 2h · 4h*) or `/cr watch in 2h
  S-002 result`. A strict time grammar: an ambiguous `at 2:30` is asked (both readings, in Claude
  Code's dialog for `/cr watch`), never guessed; local time and a countdown everywhere. *Keep warm*
  holds the conversation's cache to the wake, *Fresh* spends nothing and wakes in a fresh context
  from the handoff notes, *Smart* chooses (and shows why: *Fresh · 6h wait · 742k context · resume
  state ready*). **A watcher never clears a run that moved since it was armed**: it reads *Watcher
  due · this run changed since it was armed* with Check now, Reschedule and Dismiss. Due while
  Claude works, it waits for the turn's end; a fresh wake needs healthy resume state; a warm wake
  whose cache went cold asks instead of re-reading it all. Watchers live in Claude Code's process
  (no daemon); one due while it was closed waits for you when the session is open again. Claude
  Code's own wake-ups are shown beside them, read only.
- **Watcher Scout.** After a turn in which Claude evidently waits for a future result (a milestone
  marked waiting, or its own sentence pairing a check with a time), the status bar asks: *Claude
  seems to be waiting for a future result. Check the leaderboard again in two hours?* (**Create
  watcher**, **Change time**, **Ignore**). Off, Suggest (default) or Arm explicit waits; no model is
  asked.
- **Sleeping.** While a watcher parks the run the headline reads *Sleeping until 14:00 · S-002
  result* (with *cache held warm* or *fresh wake · no keep-alive*), the instruments add `WATCHER ◷
  1h 42m` (on Desktop the Machine cell becomes a Watcher cell), and Kit curls up asleep, or tends
  its fire while the cache is held.
- **Cold Resume Guard.** Before a message is sent into a context of 100k tokens or more (Context →
  *Warn above*) whose prompt cache has surely lapsed, Claude Code's dialog asks: *Continue full
  session*, *Start fresh from resume state* (only with healthy resume state), *Compact first*
  (reads it once, said so), *Cancel* (the message goes back to the prompt box, or is kept in
  Operations where the box cannot take it). It says why the cache lapsed and gives dollars only
  from Claude Code's own estimate for that model (`estimated_cache_write_usd` at a model switch or a
  resume, remembered per model); tokens otherwise. Never mid-turn, never headless, never for a cache
  that may still be warm.
- **Ready to resume (Resume Preview).** Context shows what a fresh context would get: the run and
  objective, milestones done and under way, what it reads (✓/✗), what it carries (queued work, open
  decisions), the next action, or why a fresh start is not offered. The Cold Resume Guard's question
  and fresh wakes use it; `/cr resume` prints it.
- **Agent Command Center.** Operations → Agents shows what Claude Code reports (status, type,
  elapsed time, what each is doing, model, result or failure, parent), with **Stop** (`TaskStop`)
  and **Message** (Claude Code's `SendMessage` delivery) only where Claude Code takes them. No cost
  per agent (none is reported), nothing alive unless Claude Code lists it. `/cr agents` with no
  argument lists them; with one it is still the subagent policy. Guardrails links to it.
- **Run Budget.** Optional limits on cost (as reported), wall-clock time and handoffs; said once at
  80%; at a limit: notify only, ask before Project Sentinel starts more work by itself, or have
  Claude finish the milestone and pause. Never mid-tool, never cancelling a turn. `/cr budget`.
- **The status bar** gains chips that open Operations, each only while it matters: `Review 2`
  (amber), `Watcher 1h 42m`, `Queued 3` (while Claude works), the budget near or at a limit; and the
  alert line's new questions (a watcher that waits for you, a kept message, the budget, a
  suggestion). Overview gains an Operations card only while something is in it.
- **Ended runs never leak**: a new run of the same project is told once what an ended one left
  (watchers, queued work, open decisions) and **Bring them here** moves it; nothing moves by itself.

### Fixed

- **A run written at once could be overwritten by an older copy.** A change saved immediately
  (now every change of the run's operations) left a debounced write of the same run waiting with
  the copy taken before it; that write then put the older copy back. A watcher armed just after a
  turn was lost from the store, and so after a restart (found by the new persistence tests;
  verified to fail without the fix). An immediate write now supersedes the waiting one.
- Kit sleeps or tends its fire while a watcher parks the run even in a context with no turn yet,
  ahead of the fresh context's walk-in.
- **"Some saved settings were invalid" for settings that were only incomplete.** Since 1.4.0,
  stored settings with no permissions group (written by hand or by a tool) were reported as repaired
  at each start until a setting was changed, though nothing in them was invalid: the check for a
  saved Allow added the missing group, and the comparison read that as a change. A missing group now
  takes its defaults quietly (seen in a live test; regression test fails without the fix).

### Development

- Tests: `ops.test.ts` (the model: time grammar, queue boundaries, decisions, watchers and
  checkpoints, Smart, budget, the stored record, resume health and preview, Scout, agents),
  `operations.test.ts` (the Runtime over the in-memory host and its manual clock: every flow, stale
  protection, fresh wakes, the cache going cold before a warm wake, reloads and restarts, the Cold
  Resume Guard's every answer, agents, budget, ended runs), `opsui.test.ts` (engine-driven:
  Operations on terminal, desktop and mobile with its controls pressed, the chips and the sleeping
  bar, Kit's Desktop tree through the page's check, every `/cr` command, the `prompt.submit` drop,
  the decision tool). The fake host and the engine world answer agents, questions and prompt drops.
- The Operations debug trace (`ops: Q-1 queued`, `ops: W-1 due, but the run changed since it was
  armed …`, `ops: the fresh context carries …`, `cold resume: cancelled …`) makes live runs readable
  step by step.
- `tools/desktop-preview` draws an `Input` (its text or placeholder) and a Button's own children (a
  chip's mark and words in its tone), as the app does; before, a field was left out and a chip drawn
  as its bare label.

### Verified live

Claude Code 2.1.295, Sonnet 5.5, a renamed copy of the plugin (its own store), every request through
the recording proxy (fingerprints and token counts only), each step read from the debug trace.

- **Mission Queue.** `/cr queue --turn …` while idle: `Queued Q-1 · Due: goes now.`, then a turn of
  its own that did the work. Typed during a turn running `sleep 12`: Claude Code ran the command when
  that turn ended (the turn's own requests carry no echo of it), and Q-2 went once, after it.
- **Decision Inbox.** Claude called `decision_request` (a blocking question with two options) and
  ended its turn; `/cr decisions` listed D-1; `/cr decide D-1 Spaces` answered it, the answer went as
  a prompt of its own, and Claude acted on it.
- **Watchers.** A Smart watcher a minute out woke the run in its context at its time. A second one
  stood down because a turn ran after it was armed (`due, but the run changed since it was armed …
  nothing sent, nothing cleared`; no request at its time). A third was due while Claude Code was
  closed: resumed later, it read *was due 1 minute ago (Claude Code was not running): it waits for
  you*, and nothing was sent. A Fresh watcher, after Claude had written milestones and notes: Scout
  suggested a watcher from the waiting milestone, `/cr resume` showed the run ready, and at the wake
  `/clear` ran, the fresh session's first message carried the wake, and the fresh context finished
  the check.
- **Cold Resume Guard**, in a real console on a session resumed three hours after its last answer
  (90k tokens, Keep warm off): typing a message brought Claude Code's own dialog, with the cause and
  Claude Code's estimate (about $0.36), and nothing was sent while it asked. *Cancel* dropped the
  message and put it back in the prompt box; no request went. Sent again, *Continue full session*
  sent it (the one request re-wrote 129k tokens; Claude Code's cost rose $0.52, so its estimate reads
  as a lower bound; Troubleshooting says so).
- Not tried live: the Agent Command Center's Stop and Message, the run budget at its limits, *Compact
  first* and *Start fresh* from the Cold Resume Guard, and Operations in Claude Desktop. The Runtime
  and engine suites cover each of them.

## [1.5.1] - 2026-10-09

### Fixed

- **Kit draws on Claude Desktop again.** 1.5.0 widened Kit's lane to the whole status bar by giving
  its image a height and no width, so the box would be the region's. Claude Desktop's page checks a
  surface module's tree more strictly than a hooks module's: there an image needs both a width and a
  height, and a tree that fails the check is not drawn at all. In the app, Kit's lane showed
  *project-sentinel: Client hooks/kit.client.tsx: returned a tree the page cannot draw (malformed or
  past its bounds)* instead of Kit (seen by the person in Claude Desktop 2.26454). The image now asks
  for a width half as wide again as its region (at most 4096 pixels, the most the page draws), and
  the page's own `max-width: 100%` fits it to the region, so the lane still spans the status bar.
  Checked with the page's own code, taken from the app's bundle: every Kit tree the tests draw, at
  five widths, through a touch, is drawn; 1.5.0's is refused. The tests now hold the page's check
  (`tests/fixtures/desktop.ts`) and run Kit's Desktop frames through it, and `tools/desktop-preview`
  shows the app's fault line for a tree the page would refuse.

## [1.5.0] - 2026-10-09

A reliability pass: what Project Sentinel says it does, proven against real requests (a recording
proxy that keeps fingerprints and token counts only, Claude Code 2.1.295, Sonnet 5.5), and fixed
where it fell short. 313 tests.

### Fixed

- **Large prompt-cache rebuilds that Project Sentinel itself caused.** Its notes to Claude (a
  setting changed, the machine's load, the handoff coming) were hidden rows appended to the
  transcript while Claude worked. A row appended while a request is on its way is read at the end of
  the next request, but kept where it was appended; at the next turn Claude Code rebuilds the
  conversation from the transcript, the row sits elsewhere, and from there the prompt no longer
  matches the cache. Claude Code then rewrites the rest of the conversation to the cache and drops
  the thinking made over it (its `thinking_drop` record, reason `prefix_mismatch`). Found in a real
  session (Opus 5.5, 1-hour cache): 301k and 451k tokens rebuilt at the first request of a turn,
  each starting exactly at the first such note, and the same in five other sessions (a 662k rebuild
  at a handoff among them). Cache health had called them "probably evicted by the server". Notes now
  wait and go with the next batch of tool results (Claude Code's own hook context,
  `classic.PostToolBatch`) or with the next prompt; nothing is appended to the transcript. Verified
  through a recording proxy: with the old way the next turn differed from the cached prefix at the
  first note; with the new way every later request extends the one before.
- **Machine load no longer flaps at its ceiling.** A machine sitting at its RAM ceiling (85%, 86%,
  85%…) changed level every few seconds, and each change was a notice to Claude (138 in one session,
  while idle too). High now ends only after two readings 3 points under the ceiling; Claude is told
  once when the load goes high and once when it is back, and only when a note can go.
- **The first request of a session never goes out with default settings.** The system prompt can be
  composed before the session's start has read the saved settings; the compose and step hooks now
  load them first, so Frontier Max is in the first request (verified live: section and `xhigh`).
- **Kit no longer freezes on a loaded machine.** It held one still pose whenever the machine was
  over a ceiling, which a desktop at its memory ceiling always is, so Kit switched on mid-session
  could sit frozen for minutes. Only Reduce motion holds it still now; a busy processor slows it
  (fewer frames, no walking). Switched on, it moves within 600 ms (an ear flick and a bounce), on a
  strained processor too: its first second is drawn at full rate.
- **Autopilot's compaction works in Desktop and other SDK sessions.** Claude Code refuses a plugin's
  compaction there (`$.session.compact`: "not available in a headless (-p / SDK) session yet"), so
  the *Compact* continuation, and the fallback when `/clear` is refused, stopped at "Compaction
  failed" and waited for you. Autopilot now runs `/compact` as a command there and carries on once
  Claude Code has compacted (seen live: a 95k-token context compacted to 3.6k in 15 s, the
  continuation went into it). If no compaction comes within ten minutes, it waits for you.
- **A reload of the plugin mid-turn no longer reads as Frontier Max missing.** The turn under way
  keeps the system prompt composed before the reload; the request after a reload now counts it
  (seen live mid-handoff: the request carried the section, `/cr diagnostics` said *NOT delivered*).
- **Background work Claude Code reports finished leaves Resources** (its list at each stop is the truth).
- **A handoff turn that ends with background work running** is finished by the turn that work
  brings back: the notes are checked, and `/clear` runs, only then.
- **CI on Claude Code 2.1.295:** a headless session lays the engine's type declarations only for a
  watched plugin folder now; the workflow sets `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` for that step.

### Changed

- **Keep warm proves itself on the conversation, refresh by refresh.** Each refresh is recorded: the
  fork's reading (HIT or MISS, read, written), the old and the refreshed expiry, then the main
  conversation's next request: VERIFIED (it read the cache after the old expiry), consistent (back
  before it), NOT TESTED (something changed first: model, effort, tools, policies, style, the earlier
  conversation), or FAILED (it rebuilt before the refreshed expiry with nothing changed), which
  pauses Keep warm with the reason. Context → Cache shows the latest; `/cr cache` lists them.
- **Cache health says how sure it is:** each rebuild's cause is proven, likely or unknown, never put
  on the server without evidence; partial rebuilds say what they still read. A rebuild needs 5% and
  4,096 tokens re-sent, no longer half the prompt.
- **Frontier Max shows that it reached Claude:** Behavior → Frontier Max → *This context* says how
  (system prompt, held section plus note, or the prompt's context) and the effort sent.
- **The lazy-exit guard says what it decided** in the debug log: when it stands down (a handoff
  under way, the context past the handoff point, a turn not the person's) and its verdict on a
  turn's end, with the reasons (fixed phrases, never quoted text).
- **`/cr diagnostics`:** each request of the context with the policy section's fingerprint, whether
  Frontier Max was in it, how it travelled, model and effort; the notes delivered; Keep warm's
  refreshes. Fingerprints only: no prompt text is kept.
- **Kit plays episodes, uses the whole status bar, and knows where it is touched.** In each mood it
  has a set of short episodes of two to five acts (idle: a rest, a look along the lane, a stroll to
  somewhere new, grooming, a stretch and a yawn, a patrol to the far end, a butterfly chase, a peek
  at the prompt, a loaf; thinking: pondering, pacing, a sit with its chin in its paw, an idea, a roam;
  working: typing in bursts, a look at the notes, a move with them under its arm; searching: a book,
  a magnifier along the lane, a dash; a check running: watching it, a nervous tail; waiting on you:
  a look at the prompt, a step closer). They are picked by weight from a seeded generator, none
  again within its cooldown, never the same twice running; a walk goes where Kit has been least
  lately. On Desktop the lane is as wide as the status bar (it was at most 560 pixels), at no extra
  cost per frame: the image fills Kit's region whatever size the app's cells are. A touch reacts by where it lands: a head pat (twice, a purr), a nose boop, a tail
  flick, a pet on its body; three touches in a few seconds are a giggle, five make it dizzy and it
  rests a few seconds; asleep, it is startled. A Desktop touch is placed by its share of the lane, and
  its row says head or body. Measured: 5.6 µs a step, 0.33 ms a drawn Desktop frame (0.33% of one
  core at ten frames a second).

### Verified live

- **Keep warm keeps the conversation's own cache.** Five-minute cache: two refreshes read it
  (47,130 and 47,156 tokens), and the conversation's next request, after the expiry they replaced,
  read 47,156: VERIFIED; without Keep warm the same pause rebuilt 47.2k. One-hour cache with Frontier
  Max on: the refresh read 89,817 of 89,819 tokens, and the request five minutes past the old expiry
  read 89,817: VERIFIED. A refresh goes at the session's effort, not Frontier Max's; on Sonnet 5.5
  that changed nothing the cache keys on.
- **Frontier Max in every case:** the first request of a new session, turned on and off
  mid-session, after Autopilot's `/clear`, after a compaction, across a reload mid-turn; each
  request at the effort it asks for (`xhigh`), the section's fingerprint the same throughout.
- **The Autopilot chain**, step by step from the debug trace: the threshold crossed mid-turn, the
  note with the next tool results, the handoff turn (with tool calls; the notes written late in it),
  the notes checked, `/clear` or compaction, the continuation in the fresh context with the run, its
  objective and its cost carried on. A prompt queued during the handoff turn went into that turn and
  moved nothing on; a reload of the plugin mid-handoff carried it on; no second handoff, no clear
  before the notes; the lazy-exit guard stood down for it (`guard: stands down` in the trace).
- **A clean install** from the directory marketplace into a throwaway configuration (it loads,
  migrates and registers its commands), and the update of an installed 1.4.1 to 1.5.0 then a fresh
  terminal session as a user: the panel and status bar, Frontier Max in the first request, Kit
  switched off and on mid-session (walking again at once), a pat on its head, `/cr cache`, and a
  model switch asking first (679k warm tokens, about $5.43) then kept.

## [1.4.3] - 2026-10-08

### Changed

- **The Control Room button looks like a button on Desktop.** With the panel closed it was the
  app's secondary button, gray on the status bar's own gray, and read as a tag. It is now the app's
  primary button, the panel open or closed: filled, with the app's own hover and press. The
  terminal's filled chip is unchanged.

## [1.4.2] - 2026-10-08

What Anthropic's plugin directory found in 1.4.0, answered: its one blocking finding is gone, and
the plugin's README says, part by part, what each policy hold asks it to.

### Changed

- **The machine sampler runs no shell.** On Windows it was PowerShell running an inline script,
  which the directory blocks: it cannot read which program such a script starts. It is now
  Windows' own counter reader, `typeperf "\Processor(_Total)\% Processor Time" "\Memory\Available
  Bytes" -si 2`, with `systeminfo /fo csv /nh` once for the total memory: lighter (about 0.3 s of
  CPU every 30 s and 9 MB, where PowerShell took 0.5 s and 80 MB), and read live against Windows'
  own figure. On macOS, `top` and `sysctl` run by name instead of through `/bin/sh`. Each program
  is written out in full where it starts, with fixed arguments. On a Windows installed in a
  language other than English the counters have other names, so the readings there show as
  unavailable, with the reason in Guardrails.
- **The listing says what the directory asks.** The plugin folder's README answers each policy
  hold under its own heading: the prompts it submits and what is in them, the one command it runs
  (`/clear`), the one tool it calls (`TaskStop`), what its tool-call hook does with the calls it
  sees, the tool it answers itself (`milestones`), what its subagent hook changes (only the model,
  with the router's subagent routing on), the programs it runs, what it reads and sends, that it
  reads no credentials, and that the icon is only an image.
- **The repository is `Arjun0014/project-sentinel`** (it was `Control-Room-Mod`; GitHub forwards
  the old address, so an existing marketplace keeps updating). The marketplace keeps its name,
  `control-room`, so installs keep their identity and settings, and `/cr` keeps opening the panel,
  which is still Control Room.

### Development

- Names the directory's scanner read as something else: the store's entry names are
  `STORE_ENTRIES` (was `STORE_KEYS`, read as a credential), the carry-over marker `CARRIED_MARK`,
  Kit's curled-up body is `ball` (its old name beside a `|` read as a download piped into a shell),
  and a comment no longer names the manifest's path. Nothing a person sees changes.
- Tests for the new samplers: `typeperf` lines in two locales, `systeminfo`'s total in three,
  `top` and `sysctl` on macOS with `PhysMem` standing in, and both samplers' commands through the
  engine. 282 tests.

## [1.4.1] - 2026-10-08

### Fixed

- **Work counted the finished milestones of the work before.** When Claude states another
  objective with milestones of its own, the run's progress counts from nothing ("0 of 7"), no longer
  on top of what the previous work finished ("10 of 17", which also crowded the track). A list
  rewritten for the same objective, or one that carries any earlier milestone, still keeps the
  finished ones.

### Changed

- **The update's messages are toasts, not warnings in the panel.** "Project Sentinel is Control Room
  renamed…" and "Allow was removed…" were pinned in amber at the top of Overview for the whole
  session. Each is now a toast, once, a moment after the load; the Allow change is also a quiet note
  under the permissions in Guardrails for that session. The top of the panel keeps amber for what
  needs a look (settings repaired, an old Claude Code).

### Development

- Windows CI runs the tests again: the test runner starts `claude` through `cmd.exe` where npm
  installed it as a `.cmd` shim (a bare spawn failed with `ENOENT`, the one red step of 1.4.0's
  release commit).
- Kit's pacing test watches the lane a while instead of sampling it once (a walk there and back
  could land it where it began). 276 tests.

## [1.4.0] - 2026-10-08

Control Room is now **Project Sentinel**, ready for Anthropic's plugin directory: the plugin folder
holds only the plugin, with its listing text, licence and icon, and its source passes the checks
the directory reads. Kit is rebuilt from the ground up, the Desktop status bar gains a Machine
cell, and the cache no longer reads "lapsed?" while Claude works.

### Changed

- **Renamed to Project Sentinel** (`project-sentinel`): Anthropic's directory held `control-room`
  as confusable with another listing. The panel is still Control Room, and `/control-room` and
  `/cr` still open it. The marketplace keeps its name and maps the old name to the new one
  (`renames`), so `claude plugin marketplace update control-room` moves an existing
  `control-room@control-room` install to `project-sentinel@control-room` (checked in an isolated
  configuration: the update rewrote `enabledPlugins`, and the next session installed and loaded
  the renamed plugin).
- **Settings and history come along.** Claude Code keeps a plugin's store under its name, so once,
  when it first loads and before it reads a setting, Project Sentinel reads the store it kept as
  Control Room and copies the settings, the runs, the Quest log and the cache memory over, never
  over what its own store holds. Where Claude Code kept more than one (an installed copy's, an
  in-place load's), it reads the one written last. It finds Claude Code's configuration folder
  from `CLAUDE_CONFIG_DIR` or the home folder (`USERPROFILE`, `HOME`), else from the session's
  transcript path when the session starts. The old file is only read, never changed.
- **Beside a Control Room that still runs, it stands by.** Claude Desktop hands a session its
  plugins when the session's process starts, and the update reloads open sessions, so they gain
  Project Sentinel next to the Control Room they already run (seen live with the release
  candidate: both status bars, Project Sentinel on its defaults). Where Control Room has published
  its status bar in the session, Project Sentinel passes every event on and draws, registers and
  records nothing, with one note, until the session restarts: never two handoffs, two answers to
  one permission check or two milestone tools.
- **Kit, rebuilt.** One surface module (`hooks/kit.client.tsx`) now draws Kit in the terminal and
  on Desktop, on the surface's own clock, with a small behaviour model:
  - **No jump, ever.** Kit moves only by walking, turns only through a frame that faces you, and
    sits, stands and lies down only through a crouch or a lie-down frame; a mood change starts
    from where Kit is. In 1.3.0 Desktop drew Kit as an image that animated itself, and every mood
    change restarted it from its own start (a walk, then a teleport back); the terminal reset its
    place at each entrance (the glitch at a session start).
  - **Moods settle.** A new mood applies once it has held 1.2 seconds and a mood holds at least
    2.5, so a flicker between tool calls restarts nothing; a handoff, a finish, a failure, a
    question and a fresh context apply at once. It walks in once per context, never on a redraw.
  - **Much more to do**, each mood a program of acts chosen without repeats: stretching, yawning,
    grooming, scratching an ear, swishing its tail, looking around, a stroll, a butterfly, a leaf to
    pounce on, a sneeze; pacing with thought dots; typing on a tiny keyboard; reading a book in
    round glasses or walking with a magnifier; watching a check with a spinner; a dance with
    confetti at a green finish (never beside a failing check); a facepalm at a failure; facing you
    with a question mark; fanning itself; tending a fire; nodding off, then curled up asleep with
    Zzz and the odd dream bubble. A flag when a milestone is done, a poke at the fire when Keep warm
    refreshes. At a handoff it carries the notes off and walks back in with the fresh context.
  - **It takes a touch**, on Desktop too: a purr with hearts, a hop, a spin, a blush, an ear flick, a
    nose boop, a roll for a belly rub, a high five (every one before any repeats, never twice
    running); five clicks make it dizzy; asleep it is startled; while Claude works it only looks
    up. A click no longer opens the panel: the status bar's button does.
  - **Drawn anew on Desktop:** an image per frame, 40 × 24 art pixels at 3 pixels each (twice the
    detail), shaded and outlined, with a soft shadow. The terminal keeps its half blocks, with a
    tail and glyphs every terminal font has.
  - **Calm:** Reduce motion and a machine at its limit hold one still pose; a busy processor draws
    two frames a second and never walks. Memory merely high no longer tires Kit.
  - VS Code, which draws no surface module, shows Kit's pose for its mood as a still image.
- **The Allow permission state is removed.** Default, Ask and Deny remain. A saved Allow reads as
  Default (Claude Code's own rules decide), never Ask; the panel says so once. In Bypass
  permissions mode nothing changes; outside it, prompts Allow answered come back unless Claude
  Code's own allow rules cover them.
- **Ask asks in Claude Code's own question dialog.** Where Claude Code would run a call set to Ask
  without asking (its own verdict, from a check that runs nothing), Project Sentinel asks first
  (*Run it* / *Don't run it*) and passes the call on after a yes, so settings rules and PreToolUse
  hooks still apply after it; the headline reads *Waiting for you to approve* meanwhile. Project
  Sentinel no longer answers permission checks itself.
- **The status bar on Desktop has a Machine cell** between Cache and Run: CPU and memory as slim
  level bars with their percentages, amber near a ceiling and red at it. The columns are weighted
  by what they hold (Work and Context wider), the track and the meter fill their column from the
  band's width, and the machine chip leaves the headline on Desktop. The cache cell says what it
  holds where there is room (`warm · 345k`).
- A fresh context's notes after a handoff ride its first message (one more context block,
  `contextAutopilot`) instead of changing the session's start.
- The CPU and memory sampler and `/clear` are written in full where they run; the Windows sampler
  no longer passes `-ExecutionPolicy` (a `-Command` script is not governed by it).
- `gh auth …` commands count as network access (they talk to GitHub); only `gh help` and
  `gh --version` are left alone.

### Fixed

- **The cache read "lapsed?" while Claude was working** (a nine-minute command inside a turn, the
  lifetime not yet known). While a turn runs the cache is warm unless a five-minute lifetime is
  known. A session that reports a claude.ai plan's rate-limit windows starts at the one-hour cache,
  named as the plan's default; a miss after five idle minutes corrects it to five. Overview's Cache
  card says its state once.

### Directory

- The plugin folder carries the directory's listing: `README.md` (what Project Sentinel does,
  five examples, and everything it runs, reads, sends and stores, with a privacy statement),
  `LICENSE` and `.claude-plugin/icon.png` (Kit, 1024 × 1024). `plugin.json` names the icon and the
  documentation, support and privacy links.
- The source passes the directory's reading of it: the handoff card's `h` is `view`; runtime
  accessors are methods; `Client` is named in its element with a fixed path; no `ui.fault` hook
  (not on the directory's list); no `tool.check` hook; `classic.SessionStart` passes its event on
  unchanged; no call shaped like a pattern hook; a token count is `shortCount`, not a "tokens"
  word; the classifier's examples carry no URLs. `types` stays in `plugin.json`: Claude Code's own
  validation needs it.

### Development

- Tests moved to the repository's `tests/`: the plugin folder ships only the plugin. `npm test` and
  the type-check assemble `.build/mod` (plugin plus tests); `tools/test/source.mjs` (`npm run
  source`, also in CI) checks the source rules Anthropic's directory reads;
  `tools/test/snapshot.mjs` (`npm run snapshot`) makes a frozen `cr-test` copy for live tests that
  never carries a former store over. 273 tests, among them a randomized walk through every mood
  with touches that checks Kit never jumps (also fuzzed over thousands of runs).
- The Desktop preview draws Kit's surface module inside its region and shows Kit through a turn.

## [1.3.0] - 2026-10-08

Verified against the live API, and redrawn to be read at a glance. The status bar is a mission
HUD: a headline says in words what the run is doing (or waits for), under it the run's
instruments, each its own shape, and on Desktop a grid that keeps all four readings in place. Kit
is redrawn, Autopilot gives a fresh context room to work and carries the run's milestones across
handoffs, and Cache Guardian's figures now agree with Claude Code's own (checked live).

### Changed

- **The status bar is a mission HUD.** A headline says what is happening in words, with a mark
  for its state: working, thinking, running a check, waiting for you, waiting for a result that
  comes by itself (a background job, a scheduled wake-up, a milestone marked waiting), blocked,
  handing off, done, all milestones done. On its right, only what needs a look (chips: a failing
  check, issues, a busy machine, agents), then the Control Room button, drawn as a filled control
  in the terminal (brand-colored while the panel is open). Under it the instruments: WORK (a track
  of milestones, each its state), CONTEXT (a solid bar with the handoff point as a notch), CACHE
  (only while it matters: when you are away, or after a costly rebuild) and the run's cost on the
  right. A rule marks the HUD's top edge in the terminal. The empty part of a graphic and that rule
  are drawn in the theme's quietest gray rather than dim text, which some terminals draw as a
  bright gray slab.
- **On Desktop the status bar is laid out by the app, as a grid.** Each reading is a cell of an
  equal share of the row, a quiet caption over its graphic and value, with the run's cost at the
  right edge; nothing overflows from 500 pixels to a full window, and a narrow band takes compact
  cells. The four readings always keep their cells, a dim word standing in for one with nothing
  yet (`No milestones yet`, `—`), and the cache stays in view while Claude works (`warm`): a row
  that dropped them showed two readings far apart (seen in the app on a release candidate). Every
  graphic is an image of a fixed size.
- **Kit is redrawn**: larger (18×10 pixels, five terminal rows), a small Claude-orange creature
  with ears and expressive eyes, fifteen moods (idle glances, pacing while Claude thinks, busy
  while it works, a magnifier while it reads, watching a check, hopping at a green finish,
  startled by a failure, a question mark when waiting, sweating on a busy machine, tending a fire
  while Keep warm holds the cache, fading as the cache nears its expiry, carrying the notes off at
  a handoff and walking back in with the fresh context). It stands on the HUD's top edge with no
  box around it; a machine at its limit holds it still. On Desktop each of its pixels is 6 × 6
  (360 × 68 in all): at 4 × 4 it read as a speck beside the app's text.
- **Panel**: Overview's Now is what Claude is doing (machine readings moved to Guardrails' card),
  with the status bar's mark (on Desktop its icon, set on the first line); the empty Cache cards
  are one compact row, and Overview's cache reads as a status line after a small dot (a drawn
  clock face looked like a selected radio button on Desktop); Guardrails groups permissions in
  cards of their own (Project, Network, Git, External, Safety), each titled in the section's
  color, with *Restore safe defaults* and the footnote after the last (headings inside one box read
  as rows on Desktop); Setup lists the four most telling changes from the profile, then *View
  all*; Activity's Now tells idle, waiting for you, waiting for a result, blocked and complete
  apart.
- **Milestones** are asked to be outcomes, never single reads or commands, and may be *waiting*
  (for a result that will come by itself) as well as *blocked* (on the person). After a handoff the
  fresh context is given the whole list, finished milestones included, and the run's objective,
  and is asked to carry them on under the same titles: told only the open ones, a fresh context
  re-planned under new titles and counted finished work twice (seen live: 4 milestones became 8).
- `/cr cache` shows the timeline to the second: the last request, the derived expiry, the last
  refresh (hit or miss, tokens read) and the next one.

### Added

- **A fresh context gets room to work.** A context after a handoff first reads itself in (the
  notes, the docs, the code). Until it starts working (it records its milestones or task list,
  edits a file or hands work to an agent, or ends a turn), it hands off only past the threshold
  plus some room; from where it started working it gets at least that room (20k tokens, or a
  tenth of the threshold), and says so once if that moves its handoff point. A context that fills
  past all that before any work began waits for you instead of handing off again. Seen live with a
  64k threshold: a fresh context started at 44k and read 20k in, and five handoffs in a row did
  one roadmap step each.
- **Development: `tools/desktop-preview`** renders the status bar and the panel's pages on the
  `desktop` surface as HTML, laid out with the CSS Claude Desktop's own renderer gives them (`ch`
  and `lh` units, half-line row gaps, row alignment, the picker), for a look before a build is
  installed and opened in the app.

### Fixed

- **Activity's turn legend disagreed with its strip on Desktop** (a run teal in the strip, green
  in the legend): the legend took theme colors, the strip SVG fills. On Desktop its squares are now
  drawn in the strip's own colors.
- **Kit drew a faint seam between its pixel rows on Desktop** at a display scale like 125%, where a
  sprite pixel is not a whole number of screen pixels; it is now drawn with crisp edges.
- **Desktop drew a white bar in the middle of the status bar** (the work track, Kit's lane): an
  animated SVG was drawn in a sandboxed frame, which Desktop sized at the browser's default 300
  pixels (no width was given) and painted opaque. Every graphic is now a plain image with an
  explicit size (it still animates), and every SVG declares `color-scheme: light dark`.
- **Keep warm's probe read as a mistake.** With the cache's lifetime unknown, Keep warm sends one
  refresh at six idle minutes to learn it; on a five-minute cache that probe finds the cache gone
  and rebuilds it. Cache health called that "preventable" with advice that did not apply; it is
  now the expected, one-time price of learning the lifetime.
- **The model-switch question was cut off.** Claude Code shows a hook's reason on one line, cut at
  the terminal's width, which dropped the cost. The reason is now short, figure first: "this
  re-sends 143k cached tokens uncached (about $0.72). A fresh context avoids it."
- **A rebuild after a model switch names the effort change too**, as Claude Code does.
- **The status bar named the wrong milestone** ("Milestone 8 of 10" while step 3 was under way):
  a milestone being verified outranked the one in progress. The one in progress is the work under
  way; one being verified counts only when nothing is in progress.
- **Cache figures now count as Claude Code's do.** Keep warm's refreshes were counted as requests
  of the conversation, which flattered the hit ratio (83% where Claude Code said 62%). Claude Code
  counts a refresh as a touch that moves the expiry, not a request; so does Control Room now, and
  the two agree exactly (checked live).
- **Autopilot races.** The handoff turn is recognised by the prompt it begins with, so a prompt
  you queued is never taken for it; the handoff moves on when its own turn starts and ends, not
  when its prompt was sent; the `/clear` waits for a running turn (one you queued behind the
  handoff) to end. Claude Code starts a plugin's prompt framed ("The control-room plugin sent a
  message:"), and the match looks past that frame: a live run found the handoff waiting forever
  after its turn ended when it did not (the test kit passes the bare text; engine-driven tests now
  use the framed text). Every step and every turn's start and end is traced to Claude Code's debug
  log (`claude --debug-file <path>`), never on screen.
- **Cache Guardian trusted a remembered lifetime.** A lifetime learned in an earlier session is
  now a hint the current context corrects (an hour remembered, five minutes now), and Keep warm
  no longer blames itself for a refresh timed by the wrong one.
- **Tests on Claude Code 2.1.293.** Its test kit stores a `session.append` row itself, and a hook
  must relay what `next(e)` stored; the test world answered the row on its own, so eight
  engine-driven tests failed there. The world now relays it (and still answers on older engines).
  The plugin itself is unchanged: the 217 tests pass on 2.1.289, 2.1.292 and 2.1.293.

### Security

- New reads and writes, each listed in [SECURITY.md](SECURITY.md): when a turn stops, the
  background jobs still running and the scheduled wake-ups (`classic.Stop`), so the headline can
  say what the run waits for (memory only, until the next turn); and a line in Claude Code's debug
  log at each turn's start and end and each Autopilot step (`$.ui.log` to `debug`: never on
  screen, no prompt or answer text, only with `--debug` or `--debug-file`).

### Verified

- `tsc`, `claude plugin validate --strict` (plugin and marketplace) and 240 tests in
  `claude plugin test` on Claude Code 2.1.293 (the engine Claude Desktop and the CLI run here).
- Live with real models (Sonnet 5.5, Opus 5.5) in a real Windows console: Autopilot end to end in
  four runs, traced step by step (two bugs found and fixed); Keep warm on the 1-hour and the
  5-minute cache, each verified by its own self-check, its figures identical to Claude Code's own;
  a model switch confirmed first and declined, then made; the status bar with Kit and every panel
  section at 80, 100 and 150 columns during the demo driver's turn.
- In Claude Desktop (2.26454): the person's review of a release candidate (rc.5), then rc.6
  installed and loaded by a fresh session, captured read-only from the app's window: the status
  bar's four cells while Claude works and after the turn, Kit at its new size, Overview's cache dot
  and Now's mark. Guardrails' cards and Activity's legend through `tools/desktop-preview`, which
  lays a tree out with the app's own rules, and in a real terminal console.
- Not yet: the answer styles with a real model, and live machine-load sampling on macOS and Linux.

## [1.2.0] - 2026-10-08

The prompt cache comes into view: Cache Guardian explains every rebuild, keeps changes from
throwing a large cache away, and can keep it warm while you are away. The status bar shows the
three lifecycles side by side (context, work, cache), a handoff now checks what it left and what
the fresh context picked up, and Kit, an optional pixel fox, shows what Claude is doing.

### Added

- **Cache Guardian.** Reads every main-thread request's cache figures (tokens read from the
  cache, written to it, sent uncached), learns the cache's lifetime (the engine's own on a model
  switch, or observed: a request after more than five idle minutes that still read the cache
  proves the one-hour TTL), and explains misses: the change seen before one (a model or effort
  switch, the model router's own switch, Control Room's policies, the output style, the tools,
  compaction), idling past the lifetime, or nothing seen; a change made after the cache had
  surely lapsed is not blamed. Claude Code reports no expiry, hit ratio or miss cause; these are
  derived from what it does report, and the panel says so.
- **Keep warm** (off by default; Context → Cache, `/cr cache keep on`): refreshes the cache
  before it lapses while you are away, by re-sending the last request once (`$.model.fork`,
  which the transcript never sees), ten minutes ahead of the expiry for the one-hour cache and a
  minute ahead for the five-minute one, for at most a set idle time (the five-minute cache at
  most 45 minutes: past that, refreshing costs more than one rebuild). With the lifetime
  unknown, one refresh at six idle minutes learns it. It stands down while a handoff is about to
  clear the context and keeps the cache through a handoff that compacts. It checks itself: the
  first request after the expiry a refresh replaced must still read the cache, and it stops
  itself if refreshes do not hold it; turning it on again lets it try afresh.
- **Cache-aware changes**: a model switch you make is confirmed first when a large warm cache
  would be lost (with Claude Code's own cost estimate); the model router no longer downgrades the
  main conversation while its cache is warm; while the cache is warm, settings changed
  mid-context reach Claude as a note instead of rewriting the system prompt (Keep policies
  stable); an effort change on a model where it was seen to rebuild the cache is announced.
- **The prompt cache in the panel**: Context's Cache card (state, time left, tokens cached, hit
  ratio, Keep warm with its idle limit, Ask before a model switch, Keep policies stable) and
  Cache health (the recent rebuilds: what happened, tokens re-cached, preventable, expected or
  unexplained, and what would avoid it); a toast for a costly preventable rebuild; `/cr cache`.
- **Handoff Health and Continuity**: when the handoff notes are checked, what the handoff left
  for the fresh context (run state saved, the milestone under way, the notes, the docs updated,
  validation recorded, CLAUDE.md); after the fresh context's first turn, what it picked up (notes
  read, run state restored, milestone picked up, docs read, work resumed), with a toast. Shown in
  Context → Last handoff, counted from tool calls only.
- **Milestones may be verifying (with evidence) or blocked (with the blocker)**, in Control
  Room's milestones tool, Activity and the continuation context.
- **Kit**, an optional pixel companion (Setup → Companion, `/cr companion on`; off by default):
  a small fox in Claude orange on a row of its own under the status bar, showing what Claude is
  doing (working, reading, waiting on a check, celebrating, worried, carrying the handoff notes,
  tending the cache, asleep). The terminal plays it in a surface module on its own clock, and a
  click on it opens Control Room; Desktop draws an SVG that animates itself. Reduce motion (Setup,
  `/cr motion off`) holds it still.
- **Git in the terminal**: the branch and the uncommitted files in Overview and `/cr status`
  (one read-only `git status` at session start and after a turn, at most every 15 s). Desktop
  shows Git itself.
- Development: `/demo miss` plays a model switch halfway through the scripted turn, with
  realistic cache figures; `tools/console` takes `-Also <plugin folder>` to load the demo beneath
  Control Room.

### Changed

- **The status bar.** The top line says what is happening and where in the plan, with the whole
  run's cost and a Control Room button (bright while the panel is open) on its right. The second
  line holds the three lifecycles, each its own shape: Context (a line with the handoff tick),
  Work (a track of milestones, ●─●─◉─○; SVG circles on Desktop, the current one pulsing) and
  Cache (a clock face emptying as the cache's lifetime runs out). A handoff that needs you takes
  a line of its own above.
- **Overview** leads with the run (its number, the session, the run's cost, the objective), then
  Work, Context and Cache cards, each with how it starts over, then Now.
- Work progress is drawn as a track of milestones everywhere (it was squares).
- The handoff prompt names four places, each for what it is for: the run's milestones (the
  canonical run state), the project's own docs, CLAUDE.md (durable instructions only, never a
  progress log) and the notes (the prompt Claude would want to receive).

### Security

- **Keep warm makes model requests.** Off by default. When you turn it on, it asks Claude Code to
  re-send the main conversation's last request with one short message (`$.model.fork`, through
  Claude Code's own client); each refresh costs tokens, mostly cheap cache reads. Nothing is
  added to the transcript.
- SECURITY.md lists the new engine calls and data: `$.model.fork` (Keep warm),
  `classic.PreModelSwitch` answering *ask* (a switch that would re-send a large warm cache),
  `$.session.repo` and `$.process.run` (one read-only `git status`, terminal only; only the branch
  and counts are kept), `$.tool.list` at each turn start (a change of tools rebuilds the cache),
  Kit's surface module (it runs on the drawing thread with no `$`, and only ever posts
  `{ open: true }`), and the store key `cache.v1` and the run record's `lastHandoff`.

### Verified

- `tsc`, `claude plugin validate --strict` (plugin and marketplace) and 217 tests in
  `claude plugin test`, on Claude Code 2.1.292 and on 2.1.289 (the engine bundled with Claude
  Desktop).
- A live pass in a real Windows console (Claude Code 2.1.292, 150 columns, docked and full width)
  during a scripted turn with a model switch: the status bar with Kit, Overview, Context's Cache
  card and Cache health, `/cr cache`, and Activity; and the Git line in a throwaway repository,
  before and after a turn that changed four files.
- Not yet: Keep warm against a real model (the refresh, its timing and its self-check are tested
  through the engine, not with a live API), and the look of 1.2.0 inside Claude Desktop (tested
  on the `desktop` surface in the harness).

## [1.1.0] - 2026-10-07

A two-line status bar that says what is happening, graphics in the panel, and new ways for Claude
to write to you: brief, Simplified Technical English, mission-control calls, or a quest log that
pays XP only for progress Control Room can count.

### Added

- **Answer styles** (Behavior → Answer style, `/cr style`): Standard; Brief (bottom line first);
  Plain technical (Simplified Technical English, after the writing rules of ASD-STE100; it does
  not check the STE dictionary); Mission control (GO, NO-GO and HOLD calls, GO only for what was
  verified); Quest log. They govern Claude's messages only, never code, files or commit messages.
  A Claude Code output style you chose outranks them, and Behavior reads *Paused*.
- **Quest log:** XP only for outcomes Control Room counts (a milestone done, once per run; a
  check's first pass in a turn, or passing again after failing; a finished plan of three or
  more; a handoff with verified notes), never for lines, files or tool calls. Levels,
  achievements, a Quest card in Activity and the level in the status bar. Claude is told never to
  state points itself.
- **Graphics in the panel**, as SVG on Desktop and glyphs in the terminal: the turn's time strip
  by kind of work (read, edit, run, check, web, agent) with a legend; peak context per session
  against the handoff line in Context; each check's runs as dots; diffstat squares per file.
- The milestones tool takes the objective in Claude's own words.
- **Development: the demo driver plays a real turn.** `/demo` submits a request and answers each
  model step from a script, so Claude Code runs every tool call inside a genuine turn, without a
  model or a login: the status bar's top line, This turn and the Quest log can be captured.
  `/demo calls` keeps the old replay outside a turn; `/demo slow` paces the turn.

### Changed

- **The status bar has two layers.** On top: what Claude is doing, where the milestone under way
  sits ("Milestone 2 of 5", or its name when the line names a call instead), and how long a slow
  call has run; after a turn, what it did in counted words. Below: the readings, each with a name
  and a graphic (Context, Work, Checks, a busy machine, the level, the run's cost).
- **The readings take the richest form that fits.** Names (Context, Work, Checks, Run) show from
  100 columns in the terminal and 70 on Desktop; below that the meters stand alone, then check
  names go, then the meters shorten, and only then do the least important readings drop. Docked
  beside the panel, checks keep their names (`✓ Tests ✗ Lint`).
- A failing check is no longer counted again as an issue: Checks already shows it, by name.
- Changes: the diffstat squares and the `+n −n` figures use the panel's green and red.

### Fixed

- **Activity's turn legend disagreed with its strip on Desktop** (a run teal in the strip, green
  in the legend): the legend took theme colors, the strip SVG fills. On Desktop its squares are now
  drawn in the strip's own colors.
- **Kit drew a faint seam between its pixel rows on Desktop** at a display scale like 125%, where a
  sprite pixel is not a whole number of screen pixels; it is now drawn with crisp edges.
- **Desktop: rows drawn in a monospace face.** The app draws a text with spaced-out runs of blanks
  as a table; rows now separate their parts with " · " on Desktop.
- Attention read "all clear" while a call was still running; it says "still running".
- A running call's glyph looked like a truncation ("…") on Desktop.
- After a reload, This turn counted the run's earlier milestones as finished in it.

## [1.0.2] - 2026-10-07

A public-release polish pass: the status bar and Activity now show how far the run is and what
needs a look, and a reload mid-handoff can no longer start a second one.

### Added

- **Run progress.** The run's objective (your latest substantial request) and its milestones, done
  of the total Claude listed, counted from Claude's own task list: TodoWrite, or TaskCreate,
  TaskUpdate and TaskList. It is kept with the run, so it survives `/clear`, reloads and restarts,
  and after a handoff the fresh context is told the open milestones, so the work meter keeps
  climbing while the context meter starts over. A subagent's list is its own. Progress needs a list
  to count: without one there is no work meter.
- **A `milestones` tool where Claude Code has none.** Claude Code 2.1.29x offers no task list by
  default (its task tools are behind flags). There, Control Room offers Claude one small tool,
  `mcp__control-room__milestones`, with a short "Run progress" policy, so it can keep one. Where a
  task list exists, nothing is added. Behavior → *Run progress* switches it (`progress.milestones`,
  on by default). It has not yet been watched with a real model.
- **Activity: Attention and Validation.** Attention lists failures nothing has fixed (with the line
  of output that says why and how many tries), refusals, calls the machine-load limit held back,
  long-running and unusually slow calls, then failures a later attempt recovered from, dimmed.
  Validation has one row per kind of check (tests, build, type-check, lint, checks, simulation),
  recognised by its runner; readers such as `grep` or `cat` are not checks.
- **Activity: this turn in counted lines,** such as "Changed 4 files · 2 in code, 1 in tests, 1 in
  docs" and "Ran tests 3×, passing after a fix". No model writes them.
- **Moving around.** Choosing a section starts its page at the top, and every page ends with
  *↑ Sections*, which brings the section bar back. The plugin API has no pinned region inside a
  pane, so this is the supported way back.
- **Continuous integration.** GitHub Actions run the type-check, strict validation of the plugin
  and the marketplace, and the tests on every push and pull request: on Linux, Windows and macOS
  with the latest Claude Code, and on Linux with 2.1.289. No step signs in.
- **Development tools.** `tools/console` saves the console as a PNG (`capture`), sets its font
  (`-Font`), and starts the child session clean of the calling session's `CLAUDE*`, `ANTHROPIC*`
  and `NO_COLOR` variables. `tools/demo` is a development-only driver that replays scripted work
  through real tool calls, for screenshots without a model turn.

### Changed

- **Status bar: the run at a glance.** Context is a line with Autopilot's handoff tick; work is one
  square per milestone with `done/total`; then what Claude is doing right now, in the room that is
  left; then the run's total cost (a session's own cost moved to the panel). Failing checks, open
  issues, a busy machine (calm CPU and memory readings moved to the panel), running agents and
  handoffs show only while they matter. Labels drop at medium widths and meters shorten when
  narrow; Desktop draws both meters as graphics.
- **Activity leads with the run.** Its summary reads: run progress (objective, milestones, now,
  next, checks), this turn, Attention, Validation, then Changes grouped as code, tests, docs,
  config and other, with generated and temporary files (temp and build folders, `.claude`, the
  handoff notes, files outside the project) folded into one row. Every tool call, newest first, is
  now the secondary view.
- **Overview** shows the run's work under the context meter.
- **README:** screenshots from the terminal and from Claude Desktop, badges, and the new status bar.
- The workspace `package.json` no longer carries a version of its own, which disagreed with the
  plugin's.

### Fixed

- **Activity's turn legend disagreed with its strip on Desktop** (a run teal in the strip, green
  in the legend): the legend took theme colors, the strip SVG fills. On Desktop its squares are now
  drawn in the strip's own colors.
- **Kit drew a faint seam between its pixel rows on Desktop** at a display scale like 125%, where a
  sprite pixel is not a whole number of screen pixels; it is now drawn with crisp edges.
- **Autopilot: a reload mid-handoff started a second one.** A hot reload or `/reload-plugins`
  starts a fresh runtime with empty memory, so a handoff in progress was forgotten and the context
  crossing the threshold again began another. The step under way is now kept in `$.state`, which
  outlives a reload but not a restart or `/clear`, so it never applies to the wrong context. A
  fresh runtime carries it on: a pending or running handoff waits for its turn to end, an owed
  check or `/clear` is carried out, and a step that may or may not have happened (the handoff
  prompt about to go out, a compaction) waits for you instead of being repeated.
- **Changes said `+0 −0` for files without a diff.** A file written whole now counts its lines, and
  one with no reported diff reads `new · diff unavailable` or `diff unavailable`.
- **A failure's reason was often just `Exit code 1`.** Attention now shows the line that names the
  error (`npm error Missing script: "lint"`, `not ok 1 - …`), skipping the exit status and a
  runner echoing its script.
- **Desktop: the profile name field's button read "save".** It reads "Save"; the terminal keeps its
  lowercase key hint.

### Security

- **Deleting files is high-risk.** Like edits outside the project, push and deploys, it can ask or
  be refused but no longer answers an approval for you: *Allow* is not offered. A saved *Allow*,
  in settings or in a custom profile, reads as *Ask*, is named once in the panel, and is saved
  tightened. This is a tightening: a setup that relied on it now asks.
- SECURITY.md lists the new engine calls: `$.tool.list` (tool names, once per session, to see
  whether a task list exists), `$.tool.register` (the `milestones` tool), `$.ui.scroll` (the
  panel's own pane) and the `autopilot` record in `$.state`.

## [1.0.1] - 2026-10-07

Desktop fixes after a look at the panel in Claude Desktop's Code tab.

### Fixed

- **Activity's turn legend disagreed with its strip on Desktop** (a run teal in the strip, green
  in the legend): the legend took theme colors, the strip SVG fills. On Desktop its squares are now
  drawn in the strip's own colors.
- **Kit drew a faint seam between its pixel rows on Desktop** at a display scale like 125%, where a
  sprite pixel is not a whole number of screen pixels; it is now drawn with crisp edges.
- **Desktop: lines ran past their cards.** In Activity, a long tool call pushed past the card's
  edge and hid its duration. A browser keeps a flex item as wide as its text, so lines that should
  end in an ellipsis overflowed instead. They now cut at the card's edge, and so do file names,
  card asides and the status bar's readings.
- **Desktop: the profile name field overflowed.** In Setup, *Keep as a profile* squeezed its
  label into a narrow column and its text field ran past the card. In a narrow panel the field now
  sits under its label.

### Changed

- **Desktop: section buttons.** When they all fit, they sit in one row at their own widths with an
  even gap, like the panel's other choices. In a narrow panel they form three equal cells per row,
  each button centred, so the columns line up. At full size they no longer spread across the
  window.
- **Desktop: a readable page width.** At full size the page keeps to 80 columns, centred, as in a
  wide terminal, so a setting's label and its control stay close together.

## [1.0.0] - 2026-10-07

The first stable release. It finishes the 0.2 redesign after a live pass in a real terminal, and
fixes Autopilot's handoff in the interactive terminal.

### Changed

- **Status bar: live readings only.** Context, cost, CPU and memory (with recent history in wide
  terminals), running agents, and events as they happen. Settings such as Frontier Max or the
  handoff threshold are no longer shown there. CPU and memory are sampled while *Live CPU and
  memory* (Setup, on by default) or a machine-load limit is on, every 3 s by default.
- **Panel: settings-list rows and cards.** Each row has its label and a one-line description on the
  left and its control on the right, at every width. Groups sit in rounded cards with a title in
  their section's accent (one quiet hue per section).
- **Overview** is a map of the product: the live readings, then one color-coded card per section
  with its systems and an *Open ›* link.
- **Context** explains the handoff in three numbered steps, with the actions beside them.
- **Behavior** gives each system its own card, with its live state in the title.
- **Desktop:** the section buttons form an even grid (one row when wide, three per row when narrow),
  and rows are spaced so native buttons never touch.
- **Overview** opens with a compact block of live readings: context with its meter, cost, CPU and
  memory. The first screen now shows the systems too, even in the short frame above the prompt.
- **No repeated titles.** A row never repeats its card's title. Behavior's cards say what each
  system does ("Keep Claude going when it stops early"), Context's reads "Hand off before the
  context fills up", and Subagents reads "Allowed  No limit". Overview's profile row has no title.
- A segmented choice moves under its label only when the label or description would not fit beside
  it (or it would take over half the row), so text never wraps into a narrow column, and wide
  panels keep each setting on one line.
- **Terminal:** a page is at most 80 columns, centred in a wider frame. In the frame above the prompt
  the tabs sit right under the title. Action buttons keep a blank line above them.
- **Setup** lists changes in the panel's own words and units (`Effort  Maximum › High`,
  `Hand off at  70% › 75%`). The field for saving a profile reads "Type a name".
- The status bar's sparklines appear once there are six readings, so the bar does not shift with
  each new sample. Guardrails' sparklines grow from the right.
- A handoff that waits for you because you chose *Wait for me* reads calm (the accent color), not
  red. Red is kept for a handoff that went wrong (no notes, clearing refused).
- Notifications, Autopilot notices and `/cr` replies use the panel's words: "Autopilot on. Hands
  off at 70%", "Machine load Medium", "Status bar above the prompt", "Kept Claude going". They no
  longer start with "Control Room:", since Claude Code already heads each notification with the
  plugin's name.

### Fixed

- **Activity's turn legend disagreed with its strip on Desktop** (a run teal in the strip, green
  in the legend): the legend took theme colors, the strip SVG fills. On Desktop its squares are now
  drawn in the strip's own colors.
- **Kit drew a faint seam between its pixel rows on Desktop** at a display scale like 125%, where a
  sprite pixel is not a whole number of screen pixels; it is now drawn with crisp edges.
- **Autopilot in the interactive terminal:** its `/clear` was taken for one of yours. The terminal
  finishes the reset after the command returns (the Desktop host protocol does it before), so the
  run recorded "cleared" instead of a handoff, the fresh context missed its continuation note, and
  the continuation prompt carried the old session number. Control Room now waits for the fresh
  session before it continues. If no fresh session comes, the clear counts as refused and
  compaction takes over (when allowed).
- Guardrails' CPU and memory gauges read "—" while live readings were on without a machine-load
  limit. They now show the same readings as the status bar.
- In a narrow status bar, the panel button read "Open" while the panel was open. After a hot reload
  Control Room also forgot that the panel was open.
- `/control-room`'s description listed the sections of 0.1.
- At a very low handoff point, the status bar's ten-cell meter drew its tick over its only filled
  cell, hiding that the context was past it. A reading past the tick now always shows beyond it.

### Added

- The manifest and the marketplace entry link to the repository (`homepage`, `repository`).
- The README covers the one-line install from inside a session and how to get updates.

### Verified

- `tsc`, `claude plugin validate --strict` (plugin and marketplace) and 127 tests in
  `claude plugin test`, on Claude Code 2.1.292 and 2.1.289.
- A live pass in a real Windows terminal (Claude Code 2.1.292) at 150, 120, 100 and 80 columns,
  docked and above the prompt: the status bar, every panel section, the pickers, profiles, and
  keyboard focus.
- The full Autopilot chain in the interactive terminal, twice: the mid-turn notice, the handoff
  notes, *Wait for me*, then *Start fresh*, the seeded fresh context and the continuation.

## [0.2.0] - 2026-10-07

A redesign of everything you see, for the terminal and Desktop. The design is recorded in
[docs/DESIGN.md](docs/DESIGN.md).

### Changed

- **Status bar** (formerly the HUD) now uses plain words and shows only what is on or needs a
  look. "Context ━━━━── 31%", "Hands off at 70%" and "Memory 91%" replace codes like `CTX`,
  `AUTO 700k` and `RES MED ▲`. There are no separators or all-caps labels. Its button opens and
  closes the panel.
- **Control Room panel** has six sections instead of nine tabs: Overview, Context (Autopilot and
  the session chain), Behavior, Guardrails (permissions, subagents, machine load), Activity and
  Setup (profiles, display, about). Each section answers one question.
- **A design system** (`hooks/ui/primitives.tsx`) draws every control natively per surface:
  - switches, segmented choices, choices that open in place with one line per option, − / +
    steppers, thin meters with a threshold tick, and callouts for anything that needs you;
  - Desktop gets native buttons and popups, plus SVG meters and charts.
- **Progressive disclosure:** a system is one switch, and its finer settings appear only while it
  is on.
- **Profiles** read "Normal · edited" when changed, and Setup lists each change
  (`Machine load  Off › Medium`), with *Save as* and *Back to Normal*.
- `/cr status` and `/cr help` use the same plain language.
- The Autopilot's state notes and the guard's pause reasons are reworded the same way.

### Fixed

- **Activity's turn legend disagreed with its strip on Desktop** (a run teal in the strip, green
  in the legend): the legend took theme colors, the strip SVG fills. On Desktop its squares are now
  drawn in the strip's own colors.
- **Kit drew a faint seam between its pixel rows on Desktop** at a display scale like 125%, where a
  sprite pixel is not a whole number of screen pixels; it is now drawn with crisp edges.
- Terminal choices could get stuck open: Claude Code's terminal dropdown opens on a click, but its
  options could not be clicked and it could not be closed with the pointer. The terminal no longer
  uses dropdowns. Every choice works with a click or with Tab and Enter, and closes on a pick or a
  second click.

## [0.1.0] - 2026-10-07

First release.

### Added

- **HUD**: a persistent band above the prompt with context tokens, %, a threshold meter, session
  and run cost as reported, profile, Frontier Max, Autopilot state and threshold, Resource
  Governor, subagents, guard, router, Focus View and the run/session. Segments are fitted to the
  width by priority. A second line appears only when something needs you. The HUD can go on the
  status line instead.
- **Control Centre**: a docked pane with nine tabs (Overview, Autopilot, Modes, Resources,
  Permissions, Chain, Activity, Profiles, Settings). Keyboard-driven in the terminal (`1`–`9`,
  Tab/arrows, Enter, Esc) and native controls on Desktop. Mobile falls back to cycling buttons.
- **`/control-room` and `/cr`**: every control as a sub-command.
- **Context Autopilot**: thresholds by tokens or %, clamped below Claude Code's auto-compact point.
  HANDOFF PENDING with a mid-turn notice to finish the current unit of work. A handoff turn that
  verifies the state, updates docs, records unfinished work, runs minimal validation and writes
  `NEXT_SESSION_PROMPT.md` in Claude's own words. A freshness check of that file. `/clear`, a
  seeded fresh context, and an automatic continuation. Compaction only as a fallback. A START
  FRESH CONTEXT action when it needs you.
- **Session Chain**: run and session records across context resets, with reported costs only.
  The current run and recent runs appear in the Chain tab.
- **Frontier Max**: a professional evaluation policy and the maximum supported reasoning effort,
  never invented for models without effort. It persists across continuations.
- **No-Lazy-Exit Guard**: heuristic premature-exit detection that credits completion evidence and
  exempts blockers, your decisions and optional ideas. An optional low-cost model check when
  unsure. Per-turn and per-session caps, and repeat detection. It stands down during handoffs.
- **Model Router**: Balanced, Performance, Economy and Custom tables for subagents (by type) and
  for the main conversation (per turn, only when cheap to switch, only to model ids seen
  answering). It never downgrades under Frontier Max.
- **Subagent Control**: Unrestricted, Off, Ask or Max *N*, with live counts.
- **Focus View**: compact tool rows that expand in place, hidden results and inline diffs by
  default, an activity summary in the spinner, and the Activity tab with tool calls and per-file
  diffs.
- **Resource Governor**: Low, Medium, High or Custom advisory CPU/RAM ceilings, a lightweight
  machine-wide sampler for each platform, mid-task notices to Claude, heavy-job gating, and
  stopping Claude-started background tasks on request.
- **Permission Policy**: 11 categories with Claude Code decides / Allow / Ask / Deny, safe
  defaults, and invariants that never loosen a deny or plan mode. Allow is not offered for
  high-risk categories.
- **Profiles**: Normal, Frontier Max, Low Resource, Release/QA and custom profiles, each shown as
  an exact diff.
- Policy delivery that falls back from the system prompt to prompt context on machines whose
  managed guard skips user plugins' prompt sections.

### Verified

- `claude plugin validate --strict` (plugin and marketplace), `tsc` against the declarations of
  Claude Code 2.1.292 and 2.1.289, and 115 tests in `claude plugin test` (pure logic,
  engine-driven hooks, and UI on the terminal, desktop and mobile surfaces).
- Live headless runs in the Desktop host protocol on Windows 11:
  - the full Autopilot chain (threshold mid-turn, handoff, verified file, `/clear`, new session,
    automatic continuation)
  - Deny before execution
  - subagents blocked
  - the Windows sampler through Claude Code's process API
  - Router routing to a learned model id
- Real-terminal rendering of the HUD and every Control Centre tab at 150 columns, including
  hot reload.
- Marketplace install, enable and load in an isolated Claude Code configuration.

### Known limitations

See the README's [Limitations](README.md#limitations). In short: the resource ceilings are
advisory; shell classification is pattern-based; Ask is refused in headless runs; the Desktop
app's own sidebar cannot be modified; and the Desktop visuals and macOS/Linux sampling are not yet
verified live.
