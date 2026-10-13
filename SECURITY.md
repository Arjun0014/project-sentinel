# Security and privacy

Claude Code plugins with function hooks ("mods") are highly privileged: they see what Claude
does and can change it. Project Sentinel (called Control Room until 1.4.0; its panel still is) is
written to be conservative. This page lists everything it can observe, everything it can change,
what it never does, and how it fails.

## In one paragraph

Project Sentinel runs inside Claude Code's plugin environment. It has no DOM, no Node.js and no
direct filesystem or network APIs; every action goes through Claude Code's plugin interface
(`$`), which validates and logs it. It makes **no network requests** of its own and sends **no
telemetry**. It hooks none of Claude Code's telemetry streams and collects no analytics. It never
reads environment variables, secrets, or the contents of your project's files: for a completed
milestone's own files it asks Git for their blob ids (`git hash-object`), so it can tell later
whether they changed, and keeps only those ids. It persists only its own settings, run records
(with the run's operations: work you queued, decisions and your answers, watchers, a run budget;
and its milestones' evidence: file paths, blob ids, sizes, times, the checks that passed) and what
it learned about the prompt cache in Claude Code's per-plugin store. Three features ask Claude Code
to send a request to a model, and each is visible: the guard's optional smart check, **Keep warm**
(off by default), which re-sends the conversation's last request so the prompt cache stays warm,
and the Handoff Supervisor's one-off question about a background task it cannot recognise (its
command and description only, never the conversation). Run
`claude plugin validate plugins/project-sentinel` to see every engine call the code can make.

## Privacy

Project Sentinel collects nothing for anyone but you. It has no server, no account, no telemetry
and no analytics, and makes no network request of its own: the only requests that leave your
machine are Claude Code's own model requests, including the ones it asks Claude Code to make
(listed under [What it can change](#what-it-can-change): Autopilot's prompts, the guard's optional
check, Keep warm's refreshes, the Handoff Supervisor's question about a background task). What it
reads stays in memory, and what it keeps (your settings and
run records, [Data at rest](#data-at-rest)) stays in Claude Code's plugin store on your machine
until you delete it. It is not directed at children. Questions: open an issue on the repository.

## What it observes

| Data | Used for | Kept |
| --- | --- | --- |
| Session figures: context tokens, window and percent, cost in USD *as Claude Code reports it*, the model id, the session id, the Claude Code version, the attached surfaces | HUD, Context Autopilot threshold, Session Chain | Run records (see [Data at rest](#data-at-rest)) |
| The plan's rate-limit windows as Claude Code reports them (`$.session.usage().rateLimits`, `session.measure`: each window's kind, percent used and reset time), and whether Claude Code ended a request on the rate limit (`classic.StopFailure`: only its error kind) | The status bar's five-hour usage (`5H`), Context → Run | Memory only (a reload reads them again) |
| The prompts you submit, and Claude's final message when a turn stops | Model Router task class (keyword match). No-Lazy-Exit Guard comparison of the request with the final answer. The first sentence of your latest substantial request is the run's *objective* in Activity. While a handoff is under way, whether a short message is an instruction about the handoff ("handoff now", "keep waiting"; a fixed pattern match) | The objective: in the run record. The rest: memory only, for the current turn |
| Tool calls as they happen: tool name, and input such as a shell command or file path; whether each succeeded, and for a failed or refused call the first line of its answer | Permission Policy classification, the heavy-command check, Activity (Attention, Validation), Focus View rows | Memory only (last 300 calls) |
| Edit/Write results (the structured patch Claude Code returns; for a file written whole, its content as the added lines) | The Changes view's per-file diffs | Memory only (200 files, hunks capped) |
| Claude's own task list: the inputs and results of TodoWrite, TaskCreate, TaskUpdate and TaskList, or of Project Sentinel's `milestones` tool where it is offered (subjects, statuses, the "doing" form) | Run progress in Activity and the status bar; after a handoff, the open milestones are named in the fresh context so its task list carries on | In the run record (at most 60 tasks) |
| The names of the tools Claude is offered (`$.tool.list`), at session start and at the start of each turn | To see whether Claude Code offers a task list, so the `milestones` tool is added only where none exists; and to see a tool added or removed, which rebuilds the prompt cache | Nothing |
| Each main-conversation request's token counts as Claude Code reports them (sent uncached, read from the cache, written to it), its model and its effort; the name of Claude Code's output style | Cache Guardian: what the cache holds, how long it stays warm, why it was rebuilt | Memory only, for the current context (totals and the last 20 rebuilds). In `cache.v1`: the cache's lifetime and the short names of models on which an effort change rebuilt it |
| A model switch as Claude Code reports it (`classic.PreModelSwitch`, `classic.PostModelSwitch`): from and to which model, who made it, whether the cache is warm, its lifetime, the context's tokens, Claude Code's estimate of the cost of re-caching | *Ask before a model switch*; the cache's lifetime | The lifetime, in `cache.v1` |
| In the terminal only: whether the project is a Git repository (`$.session.repo`) and the output of `git status --porcelain=v1 --branch` | The branch, how far it is ahead or behind, and how many files are uncommitted, in Overview and `/cr status` | Memory only: the branch name and the counts. The file paths in the output are not kept |
| From the tool calls above: which documentation files the handoff turn changed and the fresh context read, whether the notes and CLAUDE.md were written, which checks ran | Handoff Health and Continuity (Context → *Last handoff*) | In the run record (`lastHandoff`): at most two file names per item (more as a count) and the subject of the milestone under way, as the run's plan already holds it |
| File *metadata* only (`stat`): the handoff file's modification time; the real path of a file Claude is about to edit; the size and modification time of each file a completed milestone's work changed | Verifying that the handoff was written; detecting edits outside the project, including through links; milestone evidence | The milestone files' sizes and times, in the run record (`evidence`) |
| For a completed milestone's own files only (those Claude's editing tools changed while it was under way, at most 12, and outputs Claude named in the `milestones` tool, at most 10; never generated or temporary files, never the handoff notes, never the repository as a whole): Git's blob id of each (`git hash-object --no-filters -- <files>`, files up to 8 MiB) and the commit HEAD points at (`git rev-parse --verify -q HEAD`). Project Sentinel receives only the ids: Git reads the files, Project Sentinel does not | Milestone evidence: whether a verified milestone's files changed since (*verification stale*), shown in Activity, Context and Ready to resume, and told to Claude at a handoff | The ids, with the files' paths, sizes and times and the milestone's subject, in the run record (`evidence`) |
| The session's agents as Claude Code lists them (`$.agent.list`: id, type, description, status, parent, name, a teammate's address); an agent's start as Claude Code reports it (`agent.spawn`: its type, description, model, whether it runs in the background or is a fork, its parent, a workflow run's id and place); its loop's tool calls (counted, and the latest one's label), its requests' model, and the task list or milestones it keeps (subjects and statuses); its end (`turn.complete`: the first line of its answer, or why it stopped) | Subagent counts and limits; Activity → Agents and the agent band | In `$.state` (`agents`), which a reload of the plugin keeps and the session's end removes; an ended agent stays shown ten minutes |
| When a session is resumed (`classic.SessionStart`, source `resume` or `fork`): seconds since the last answer, the context's tokens, whether the prompt cache likely expired, Claude Code's estimate of re-caching it; at a model switch, that estimate and how it was priced (`configured`, `catalog` or `default`) | The Cold Resume Guard: whether the cache surely lapsed, and its dollar figure | The price per token per model (from a `configured` or `catalog` estimate only, at most 30 days old), in `cache.v1`; the rest in memory |
| Claude's final message when a turn stops (already read for the guard) | The Watcher Scout: whether Claude said it will check back at a time (a fixed pattern match, no model call) | Memory only; a watcher armed from it keeps its label (a few of Claude's words, at most 80 characters) in the run record |
| Your answers in Activity → Operations or `/cr decide`, the work you queue, the labels and times of watchers you arm, a run budget | The orchestration layer | In the run record (see [Data at rest](#data-at-rest)) |
| When a turn stops (`classic.Stop`): the background jobs still running (their id, type, description, else their command, cut to 80 characters, and the command itself, cut to 200) and the scheduled wake-ups (their schedule and whether they recur), and whether Claude's final message ends with a question | The status bar's headline between turns: *Waiting for the test run*, *Waiting to check back · wakes at 06:12*, *Waiting for your answer*; whether a handoff waits for a job (a server or watcher, recognised by fixed patterns over its command and description, never; a test, build or render, within the wait's limit) | Memory only, until the next turn (at most 8 of each). While a handoff waits: in `$.state` (`autopilot`). A job a handoff left running: its id, description and class in the run record (`lastHandoff`, at most 8), with its end once Claude Code reports it |
| The names of registered slash commands | Only so as not to take `/cr` if something else uses it | Nothing |
| Whether managed (organisation) policy settings exist (only whether any key is set) | Choosing how to deliver policies (system prompt, or prompt context where a managed guard skips user plugins' prompt sections) | Nothing |
| Claude Code's own verdict on a call set to *Ask* (`$.tool.check`: allow, ask or deny, from your rules and the permission mode; the check runs nothing) | Asking you itself only where Claude Code would not | Nothing |
| Once, when it first loads after the rename: the store file it kept as Control Room (`plugins/store/control-room_<source>-<id>.json` in Claude Code's configuration folder, found from the environment variables `CLAUDE_CONFIG_DIR`, `USERPROFILE` or `HOME`, or from the session's transcript path; of several, the one written last, by its modification time) | Carrying your settings, runs, Quest log and cache memory over | What it copied, in its own store; the old file is never changed |
| When it loads: whether Control Room (the former name) published its status bar in this session (`$.state`, `control-room` `hud`) | Standing by, passing every event on, while Control Room still runs in the session | Nothing |
| With Kit on: where you click in Kit's lane (the cell, in the lane's own coordinates) | Kit's reaction | Nothing |
| Machine-wide CPU busy % and memory used % (while *Live CPU and memory* or a machine-load limit is on) | Pressure levels, meters, notices | Memory only (a short sliding window) |

**How the machine metrics are read.** One long-lived sampler process runs only while the
status bar shows live CPU and memory (Setup → *Live CPU and memory*, on by default) or a
machine-load limit is set. It stops when both are off or the session ends. Each program is started
by name with fixed arguments, written out in `hooks/register.tsx`, never through a shell:

- **Windows:** `typeperf "\Processor(_Total)\% Processor Time" "\Memory\Available Bytes" -si 2`
  (`$.process.spawn`), Windows' own performance-counter reader, and once `systeminfo /fo csv /nh`
  (`$.process.run`, 30-second timeout) for the total memory. The counter names are those of an
  English Windows; on a Windows installed in another language `typeperf` finds no counters and
  the readings show as unavailable.
- **macOS:** `top -l 0 -s 2 -n 0` (`$.process.spawn`; its CPU line, and its memory line when the
  kernel's level cannot be read) and `sysctl -n kern.memorystatus_level` (`$.process.run`,
  5-second timeout) at each reading.
- **Linux:** no process. It reads `/proc/stat` and `/proc/meminfo`.

It reads totals only: no per-process data, no process names, nothing about other users.

## What it can change

| Change | When |
| --- | --- |
| Add a section to the system prompt (or, on managed machines, prompt context) with the active policies | Frontier Max, Release check, machine load, subagent limits or Autopilot are on, the `milestones` tool is offered ("Run progress": record the run's steps with it), or an answer style other than Standard is chosen (how to write messages to you, never code, files or commit messages; it stands down while you use one of Claude Code's own output styles) |
| Offer Claude one tool, `milestones` (`mcp__project-sentinel__milestones`, `$.tool.register`). Its answer only records the list in the run plan; it reads and writes nothing else | Only where Claude Code offers no task list of its own (TodoWrite or the Task tools) and Behavior → *Run progress* is on (the default) |
| Offer Claude one more tool, `decision_request` (`mcp__project-sentinel__decision_request`). Its answer only records Claude's question (at most 300 characters, its context at most 800, up to four options of 80) in the run record and tells Claude to carry on; a subagent's call is answered that the inbox is the main conversation's. Its description tells Claude never to route permission, safety or destructive-action confirmations through it | While the Decision Inbox is on (Activity → Operations → *Needs review*; on by default). Turned off mid-session, the tool stays until the session ends and answers that the inbox is off |
| Add short notes for Claude, with the next batch of tool results (`classic.PostToolBatch`) or the next prompt's context; nothing is appended to the transcript | Autopilot pending, resource pressure, or you changed a setting mid-session (while *Keep policies stable* holds a warm cache, the note carries the policies now in force); work you queued for after a milestone that just completed; your answers to Claude's decisions while it works or with your next message; a run budget set to *Finish the milestone* reached mid-turn |
| Keep its own system-prompt section as it was while the prompt cache is warm | *Keep policies stable* (on by default): a setting changed mid-context reaches Claude as a note instead of rebuilding the cache |
| Ask Claude Code to re-send the main conversation's last request with one short message, `Control Room cache keep-alive (automatic, not from the user): reply with the single word ok and nothing else.` (`$.model.fork`). The request and its answer are never added to the transcript | Only with *Keep warm* on (off by default), while you are away, shortly before the cache would lapse, up to the idle limit you set. Each refresh costs tokens, mostly cache reads. The panel shows the next refresh and how many were made |
| Ask you to confirm a model switch, with the reason (answers Claude Code's model-switch check with *ask*) | A switch you make that would re-send 100k or more warm tokens, while *Ask before a model switch* is on (the default). It never refuses one |
| Run `git status --porcelain=v1 --branch --untracked-files=normal` (`$.process.run`, read-only, 10-second timeout) | In the terminal, inside a Git repository: at session start and after a turn, at most every 15 seconds |
| Run `git hash-object --no-filters -- <files>` (`$.process.run`, read-only: without `-w` Git writes nothing, 10-second timeout, at most 50 files a call) and `git rev-parse --verify -q HEAD` (read-only, 5-second timeout); by name with fixed arguments, never through a shell | Only while the run has a completed milestone with files: when a milestone is completed (its files, and HEAD); then, to compare, at a handoff, at a session's start, at each completion and at most once a minute after a turn, hashing only files whose size or modification time moved since. Never the whole repository |
| Ask a separate small model one question about a background task (`$.model.classify`: the task's command and Claude Code's description of it, and three labels: a service that keeps running, a job that ends, unclear). It sees nothing of the conversation, and its answer is not added to the transcript | Only while a written handoff waits for a background task that the fixed patterns do not recognise, after a minute of waiting, once per task. Its verdict shows beside the task in Context; a failed or unclear answer leaves the task waited for, within the wait's limit |
| Draw Kit with a surface module (`hooks/kit.client.tsx`), which runs on the surface's drawing thread (in the terminal, and in Desktop's own page) with no access to `$`: it gets only Kit's mood, a caption, the calm switches, the local hour, when the context began, and four counts or times (milestones done, a green finish, failed checks, a Keep warm refresh); a click on it is only a reaction; it posts only `{ fault }` if it cannot draw, which leaves Kit out | Only with the companion on (off by default). VS Code, which draws no surface module, gets a still image instead |
| Submit prompts in the session: the handoff prompt, one corrective retry, the continuation prompt | Only with the Context Autopilot on, or when you ask for a handoff |
| Submit the orchestration layer's prompts (`$.prompt.submit`), one at a time, only while nothing runs: work you queued (your words), your answers to Claude's decisions, a watcher's wake (its id, label, when it was armed, the milestone then), a fresh context's first prompt (why it is fresh, the notes' path, what to do; with the Cold Resume Guard's *Start fresh*, your message), *Write notes first* when you press it on a watcher | Only for what you set up: an item you queued reaching its boundary, an answer the run waits on (or *Send now*), a watcher you or its Scout armed reaching its time with the run still where it left it. At a run budget limit set to *Ask* or *Finish*, none goes without your yes |
| Submit your own message unchanged, as yours (`$.prompt.submit` with `asUser`) | After the Cold Resume Guard's *Compact first*, once Claude Code has compacted; or when you press *Send now* on a message it kept |
| Ask before a message is sent (`prompt.submit` answered with `drop`: the message does not enter; the reason is shown) | The Cold Resume Guard: before a message re-reads a context of at least its threshold (100k tokens by default) whose cache has surely lapsed, in Claude Code's question dialog (*Continue full session*, *Start fresh from resume state*, *Compact first*, *Cancel*); the Run Budget at a limit set to *Ask*. Never for a prompt typed while Claude works, never for its own prompts, never where no one can be asked |
| Act on a short instruction about a handoff instead of sending it (`drop`, with what was done as the reason), or ask where a message goes while a handoff waits | Only with Autopilot on and a handoff under way. "handoff now", "don't wait for the background process", "start the fresh session now", "keep waiting", "stop the server and hand off" (asked first), "cancel the handoff" are carried out; any other message, once the handoff is written or being written, is asked about in Claude Code's question dialog: give it to the fresh context (it waits in the Mission Queue), send it here, or back to the prompt box. Where no one can be asked, it goes as it would have |
| Put a message back in the prompt box (`$.prompt.fill`) | The Cold Resume Guard's *Cancel*, and the Run Budget's *Not now*. Where the box cannot take it, the message is kept in memory only (Operations: *Put back*, *Send now*, *Discard*), never stored |
| Add one block to a fresh context's first message (`prompt.context`, named `contextAutopilot`): the run and session numbers, the handoff notes' path, the run's milestones and its objective; for a fresh context the orchestration layer started, also why (a watcher's wake), the work you queued for it, and the decisions still open or answered | Only once, in a fresh context after its own handoff, a watcher's fresh wake or the Cold Resume Guard's *Start fresh* |
| Run `/clear`; run `/compact` as a fallback | After a handoff whose file was verified as freshly written (`/compact` only if `/clear` fails and the fallback is allowed); for a watcher's fresh wake, only while the run is still at the watcher's checkpoint (no turn, no change of milestones or context since it was armed) and the resume state is healthy (milestones, handoff notes of 200 bytes or more written since the milestones last changed, no failed pickup since); when you choose *Start fresh* (healthy resume state only) or *Compact first* in the Cold Resume Guard |
| Set timers (`$.clock.after`, `$.clock.every`) for watchers | While a watcher is armed: they live in Claude Code's process only, and die with it. No daemon, service or scheduled task is installed |
| Set the reasoning effort or model of a request | Frontier Max (the maximum the model supports; never invented for models without effort), Model Router |
| Refuse a tool call; or, before a call set to *Ask* goes on, ask you in Claude Code's question dialog (`$.ui.ask`, *Run it* / *Don't run it*) | Permission Policy and heavy-job gating (see the rules below). It never answers a permission check |
| Hide, refuse or ask about a subagent | Subagent Control |
| Continue a turn that stopped early, with a short message | No-Lazy-Exit Guard (capped per turn and per session) |
| Stop a background job that Claude started (`TaskStop`, through `$.tool.call`) | Only when you ask: *Stop* in Guardrails → Machine load or beside a task in Context's handoff card; *Stop & hand off*, `/cr handoff stop [id\|all]`, or "stop the server and hand off" (confirmed in Claude Code's question dialog first). *Stop & hand off* stops only the work the handoff waits for, never a server |
| Stop an agent (`TaskStop`, through `$.tool.call`), or send it a message (Claude Code's own `SendMessage` delivery, `$.session.send`) | Only when you press *Stop* or *Send* on that agent in Activity → Agents, offered only where Claude Code takes them (background agents and teammates). Claude Code's refusal is shown as it words it |
| Keep in `$.state` (`ops`, `cacheMemo`, `agents`) the Operations view, the cache's last request (when, its size, model and lifetime) and the agent ledger | So a reload of the plugin keeps knowing when the cache lapses and which agents run; gone when the session ends |
| Draw UI: the status bar above the prompt, the panel, compact tool rows, spinner text, status line, toasts; scroll its own pane back to the top (`$.ui.scroll`) | Always (Focus view and the status bar can be turned off). The scroll happens when you change section or press *↑ Sections* |
| Write a line to Claude Code's debug log (`$.ui.log` with `to: 'debug'`): each turn's start and end and whose turn it is (yours, the handoff, the continuation), each Autopilot step and the Handoff Supervisor's diagnosis, where the handoff notes stand, each background task waited for or not, agents started, milestone evidence verdicts, five-hour readings. Never on screen: the log exists only when you start Claude Code with `--debug` or `--debug-file` | At those moments. A line holds no answer text and no prompt text, except the first 60 characters of a short message read as an instruction about a handoff (`handoff guard: "handoff now" read as …`); otherwise turn ids, step names, the handoff file's path, its size and age, a task's id and description (60 characters), an agent's type and description (60 characters), a milestone's subject and its files' names |
| Keep the Autopilot step under way in `$.state` (`autopilot`) | While a handoff is under way or waiting, so a reload of the plugin carries it on instead of starting a second one |
| Keep in `$.state` (`standby`) whether it told you it stands by | In a session that still runs Control Room, so the note shows once per session, not at every reload |
| Write its own store | Settings changes, run records; once, what it carried over from the store it kept as Control Room (never over what its own store holds), with a marker, `migrated.v1`; once, at the first load of 1.7.0: a fresh install's defaults and `onboarding.v1`, Classic for an install used before without saved settings, or, for settings saved before 1.7.0, the `defaults` marker (a profile named Normal relabelled Classic; no value changed) |
| Show a toast and a first-run card | Once, on a fresh install: what is on (Autopilot at 70%, Frontier Max at Extra High) and where things live, until you press *Got it* |

**Permission rules that always hold:**

- A deny is never loosened, whether it comes from your rules, your organisation's managed
  settings or Claude Code.
- Plan mode is never overridden.
- It never answers a permission check, and there is no *Allow* (removed in 1.4.0): only Claude
  Code and you approve a call. A saved *Allow* reads as *Default*; a toast says so once, and Guardrails for that session.
- *Ask* always asks. Where Claude Code would ask anyway, its own prompt does. Where it would not
  (an allow rule, auto mode, Bypass permissions), Project Sentinel asks in Claude Code's question
  dialog first and passes the call on only after *Run it*, so your rules and other hooks still
  apply to it. Which case it is comes from Claude Code's own verdict (`$.tool.check`).
- Shell commands are tokenised and each segment is classified. The strictest finding wins. This
  is pattern-based and narrows what Claude may do. It is not a sandbox.

## What it never does

- No network requests of its own, no telemetry or analytics, and no model calls you cannot see.
  The guard's optional check is one small classification through Claude Code's own client, made
  only when the heuristics are unsure. Turn it off in Behavior → *Smart check*. Keep warm's
  refreshes go through Claude Code's own client too, only while you turned it on, and the panel
  lists them. The Handoff Supervisor's question about an unrecognised background task is one small
  classification of its command and description, once per task, its verdict shown beside the task.
- It never reads your project's file contents or environment variables. `git status` says which
  files changed, not what is in them, and Project Sentinel keeps only the counts. For a completed
  milestone's own files, `git hash-object` reads them and hands back only Git's blob id of each;
  Project Sentinel keeps those ids, never the content.
- It never adds anything to the transcript to watch a handoff: the Handoff Supervisor reads the
  facts Claude Code already reports (the background tasks at a Stop, the notes' file times).
- It never writes your files. Claude writes `NEXT_SESSION_PROMPT.md` with its normal,
  permission-checked tools.
- It never terminates or modifies programs other than its own sampler, and never stops a task
  you did not ask it to stop.
- It never bypasses organisation or managed restrictions.
- It never defers, answers or reroutes a permission prompt, a confirmation Claude Code requires, or
  its own *Ask* approvals into the Decision Inbox; an approval waiting for you holds every delivery
  of the orchestration layer back.
- It never clears a context a watcher did not leave untouched: a run that moved since the watcher
  was armed is only reported (*Watcher due*), and nothing is sent or cleared until you choose.
- It never prices a cold resume itself: the dollar figure is Claude Code's own estimate, or none.
- It never estimates or invents costs ("—" means Claude Code did not report one).
- It never claims or attempts an OS-level CPU or RAM quota.

## How it fails

- Every gating hook has a fallback. If Project Sentinel's tool-call check itself fails, obviously
  dangerous shell commands are still refused, and everything else falls back to Claude Code's own
  behaviour. If Claude Code's verdict cannot be read for a call set to *Ask*, it asks you; if the
  question cannot be shown or is not answered, the call is refused. A failed subagent check refuses
  the subagent while subagents are set to Off.
- A corrupt or hand-edited store falls back to defaults or repaired values, with a one-time notice.
- If the sampler fails, machine load shows "Readings unavailable", restarts up to twice, and the
  static policy still applies.
- The Autopilot never clears a context without a verified, freshly written handoff file. If the
  file is missing it asks once more, then waits for you.
- A Keep warm refresh that fails is tried again in two minutes while the cache can still be
  saved. If refreshes do not hold the cache, Keep warm says so and stops itself until you turn it
  on again.
- A prompt of the orchestration layer that Claude Code refuses goes back to waiting and is logged;
  one on its way when the plugin reloads reads *Sent before a reload* and is never sent again by
  itself. A watcher whose time passed while Claude Code was closed waits for you when the session
  is open again.
- If `git status` fails or takes longer than 10 seconds, the Git line is left out. If Kit's module
  fails to draw, it says so and Kit is left out until the plugin reloads; the status bar draws
  without it.
- If the store it kept as Control Room cannot be found or read, nothing is carried over and it
  starts from defaults; it does not try again.
- If `git hash-object` cannot run or fails, a milestone's evidence keeps the files' sizes and times
  instead of their ids, and says so in the debug log. If the Handoff Supervisor's classifier fails
  or cannot tell, the task stays waited for, within the wait's limit. If Claude Code reports no
  rate-limit windows, the status bar shows `5H —` (or nothing, with no five-hour window), never a
  guess.

## Data at rest

Claude Code keeps each plugin's store as JSON under `~/.claude/plugins/store/`, one file per
plugin name and source (`project-sentinel_<source>-<id>.json`). Project Sentinel uses:

- `settings.v1`: your settings and custom profiles, and `defaults`, the generation of defaults
  they were saved under.
- `onboarding.v1`, on a fresh install only: when the first-run card first showed and when you
  dismissed it.
- `run.v1.<id>`, `runs.index.v1`, `runs.counter.v1`: run records. Each holds the project root
  path, session ids, start and end times, peak and last context, reported cost, turn counts, model
  ids, end reasons and transitions, and for run progress the run's objective (Claude's statement
  of it through the `milestones` tool, or the first sentence of your latest substantial request; at
  most 140 characters) and Claude's task list (subjects and statuses, at most 60). With the Quest
  log style, a run also keeps its XP and the milestones already paid for (their subjects in lower
  case, at most 200). At most 30 runs and 60 sessions per run are kept; older ones are pruned.
- `quest.v1`, only once the Quest log style has earned something: the total XP, when each
  achievement was unlocked, and the last 8 award lines, which may name a milestone ("Milestone:
  Fix orbitalSpeed") or a kind of check ("Tests pass").
- `cache.v1`, once the prompt cache taught it something: the cache's lifetime (`5m` or `1h`) and
  how it was learned, Keep warm's verdict on itself and when it was reached, and the short names
  of models on which an effort change rebuilt the cache (`opus-5-5`; at most 12), and Claude Code's
  own cache-write price per model and lifetime, from its estimates (at most 8, kept 30 days).
- In a run record, `ops` (1.6.0): the Mission Queue (your queued words, at most 4,000 characters
  each, their targets and states), the Decision Inbox (Claude's questions with their context and
  options, your answers, at most 2,000 characters, and when each was delivered), watchers (their
  label, at most 80 characters, times, strategy, Smart's reason, and the run's fingerprint when
  armed: the session id, a count of your turns and a digest of the milestones' keys and states),
  the run budget (its limits and which were said), and the layer's log (its last 30 lines, such as
  "W-1 woke the run in this context"). At most 30 open and 10 finished queue items, 20 open and 10
  finished decisions, 10 open and 10 finished watchers.
- In a run record, `lastHandoff` after a handoff: when it happened, from and to which session, and
  the Handoff Health and Continuity items with a short detail each, which may name up to two
  documentation files ("README.md, DESIGN.md +1"), the handoff file, a check's outcome ("Tests
  passed"), and the milestone under way then (its subject, as the run's plan already holds it);
  the background tasks it left running (their id, description of at most 120 characters, class, and
  their end once reported; at most 8).
- In a run record, `evidence` (1.7.0): for each milestone under way, when it began and the paths of
  the files its work changed (at most 12) and outputs Claude named (at most 10); for each completed
  milestone (at most 30), its subject, when and in which session it was verified, the checks that
  passed during its work (their kind and command line, at most 160 characters, at most 6), each
  file's path, Git blob id, size and modification time, the commit id HEAD pointed at, and the
  last comparison's verdict (which files changed, by which milestone, since when).

- `migrated.v1`: when it looked for the store it kept as Control Room, which file it read, and
  how many keys it copied. That old file (`control-room_<source>-<id>.json`) stays as it was;
  delete it once you no longer want Control Room's copy.

Beyond that objective, the task subjects, those award lines, those handoff details, the operations
you gave it (your queued words, decision questions and your answers, watcher labels) and the
milestone evidence (file paths and the command lines of passing checks), no prompt text, answer
text, tool input, diff or file content is persisted. `/cr reset confirm` clears the
settings; deleting the store file removes everything; uninstalling the plugin removes the plugin
itself.

## Reporting a vulnerability

Please report security issues privately with GitHub's *Report a vulnerability* (the repository's
Security tab), not in a public issue. Include the Claude Code version (`claude --version`), your
platform, and steps to reproduce. You will get an acknowledgement, and a fix or mitigation plan
will be tracked in the advisory.
