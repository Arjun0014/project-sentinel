# Project Sentinel

Project Sentinel keeps long Claude Code runs on track. It adds a calm status bar above the prompt
(what the run is doing, its milestones, how full the context is, the prompt cache, machine load
and the plan's five-hour usage, as Claude Code reports it), the **Control Room** panel beside the
conversation, and a set of switches: **Context Autopilot** hands a run over to a fresh context
before the current one fills up (on for a new install, at 70%), **Frontier Max** asks Claude for
its most thorough work at Extra High effort (on for a new install), **Cache Guardian** keeps the
prompt cache in view (and, if you ask, warm while you are away), **permission categories** ask
before or refuse risky kinds of calls, **Operations** orchestrates the run over time (work you
queue for later, decisions Claude leaves for you, **watchers** that park the run until a result is
due and wake it, a guard before a lapsed cache is re-read, an optional run budget), **Activity →
Agents** and a band above the status bar show the subagents running and what each is doing, and
**Kit** is an optional pixel companion that shows what Claude is doing. It works in the terminal
and in Claude Desktop's Code tab, needs Claude Code 2.1.289 or newer, and was called Control Room
before 1.4.0. An install from before 1.7.0 keeps its own settings.

Install it from a session: `/plugin install project-sentinel --marketplace Arjun0014/project-sentinel`.

Everything stays on your machine. Project Sentinel sends nothing anywhere itself; the only
requests that leave are Claude Code's own model requests, as listed under
[What it does on your machine](#what-it-does-on-your-machine).

## Examples

1. **See a long run at a glance.** Install it and start a session: the status bar shows the run's
   milestones as a track (`2 of 10`), the context as a bar, the cache's state and the plan's
   five-hour usage (`5H 63% · 2h14m`). Type `/cr` (or `/control-room`) to open the panel:
   Overview, Context, Behavior, Guardrails, Activity and Setup. A new install's Overview starts
   with a short card saying what is on and where things live. `/cr status` prints the same summary
   as text, the run's cost included.
2. **Let a run continue past a full context.** On a new install Autopilot is on (`/cr autopilot
   on|off`). When the context reaches the handoff point (70% by default), Project Sentinel asks
   Claude to write handoff notes to `NEXT_SESSION_PROMPT.md`, checks the file was written, runs
   `/clear`, and asks Claude in the fresh context to read the notes and carry on. The run's
   milestones and objective carry across. A dev server Claude left running never holds the
   handoff up; a build or test run is waited for, at most 20 minutes by default; typing "handoff
   now" (or `/cr handoff now`) hands off at once.
3. **Be asked before risky calls.** Out of the box, installs, downloads, deletions, edits outside
   the project, pushes and deploys are set to *Ask*, and force pushes, resets and dangerous
   commands to *Deny*. So before Claude runs `git push` you are asked, even in a permission mode
   that would not ask (Claude Code's question dialog: *Run it* / *Don't run it*), and
   `git push --force` is refused with a reason Claude can read. Change any category in
   Guardrails, which shows each value and whether it is the default; `/cr profile` switches
   everything at once (Normal, Classic, Frontier, Low resource, Release QA, or your own).
4. **Keep the cache warm while you step away** (optional, spends usage): `/cr cache keep on`.
   Shortly before the prompt cache would lapse, Project Sentinel re-sends the last request so the
   next one reads from the cache instead of rebuilding it. Off by default; it stops after two idle
   hours.
5. **Queue work, and let a run sleep until a result is due.** `/cr queue Update the README with the
   findings` gives Claude work for later: it goes when the current turn ends (or the milestone
   under way completes), never into the turn. `/cr watch in 2h S-002 result` parks the run and, two
   hours later, wakes Claude to check the result, in this context or in a fresh one from the
   handoff notes. If the run moved on meanwhile, the watcher only asks you. Claude can also leave
   you a decision (Activity → Operations → *Needs review*) and keep working; `/cr decide D-1`
   answers it.
6. **Meet Kit:** `/cr companion on`. Kit paces while Claude thinks, types while it works, reads
   while it searches, celebrates a green finish and walks off with the notes at a handoff, and
   wanders the whole status bar in between. Pat its head, boop its nose or pet it: it reacts to
   where you touch it. `/cr motion off` holds it still.

`/cr help` lists every command.

## What it does on your machine

Project Sentinel is a Claude Code plugin of function hooks. This is everything it does beyond
drawing its status bar and panel. Each part answers one question Anthropic's plugin directory asks
of a plugin like this one.

### Prompts it submits, and what is in them

Prompts go to the model your session already uses, each as if you had typed it, only when nothing
is running, one at a time. They carry the text below, your own words where named, and nothing read
from your files' contents; what they name from the session (milestone titles, file names, check
commands, background tasks) is listed with each.

Context Autopilot (on for a new install; off for an install from before 1.7.0 unless you turned it
on), at most three per handoff:

- **The handoff prompt.** How full the context is (tokens used of the window), the run and session
  numbers, and the request: verify the work; update the run's milestones (with its `milestones`
  tool or Claude Code's task list), the project's own documentation and, for durable instructions
  only, CLAUDE.md; write handoff notes to `NEXT_SESSION_PROMPT.md` at the project root; start no
  new work; name a server it left running in the notes so the next context reuses it. When a
  completed milestone's files changed since it was verified: those milestones' titles, the changed
  files' names and the checks to rerun (their command lines), asking Claude to rerun them or say
  in the notes that their verification is stale.
- **The retry prompt**, only when the notes file was not written: asks once more for it.
- **The continuation prompt**, in the fresh context after `/clear`: the notes file's path and the
  session number, asking Claude to read the notes and carry on. That first message also carries
  one context block, `contextAutopilot`: the run and session numbers, the notes file's path, the
  names of the policies that are on, the milestones' titles and states, the run's objective (in
  Claude's words, or your latest request's), the background tasks still running from the previous
  context (Claude Code's description and task id: reuse a server, record a result when it arrives),
  any milestones whose verification went stale (as above), and a message you typed while the
  handoff waited and chose to send to the fresh context (your words).

Operations, only for something you set up (work you queued, a decision you answered, a watcher you
or its Scout armed, a fresh start you chose):

- **Queued work** (*Mission Queue ·*): the words you queued, with when you queued them, at the
  boundary you chose.
- **Answers** (*Decision Inbox ·*): Claude's question and your answer, when the run waits on it or
  you press *Send now* (otherwise they ride your next message as context).
- **A watcher's wake** (*Project Sentinel watcher wake*): the watcher's id, what it waits for (its
  label), when it was armed, the milestone under way then, asking Claude to check and continue.
- **A fresh context's first prompt** (*Project Sentinel fresh resume*), after a `/clear` for a
  watcher's fresh wake or the Cold Resume Guard's *Start fresh*: why it is fresh, the notes file's
  path, what to do next (with *Start fresh*, your message, so it is not lost). Its first message
  carries the same `contextAutopilot` block, plus the watcher's wake, work queued for the fresh
  context and the decisions still open or answered.
- **Write notes first**, only when you press it on a watcher: asks Claude to record its milestones
  and update the notes before a fresh park.
- **Your own message, unchanged**, when the Cold Resume Guard compacted first or you pressed *Send
  now* on a message it kept.

It also adds short notes for Claude to read, with the next batch of tool results or your next
message (never appended to the transcript), each beginning *Control Room ·* or *Project Sentinel ·*:
that a handoff is near, that machine load is high (and later back to normal), that you changed a
setting, that a policy was held or restored, work you queued for after the milestone just completed,
your answers to its decisions, that a background task's result arrived while the handoff waits for
it (record it in the notes, then end the turn), and, with a run budget set to *Finish the
milestone*, that the budget is reached.

### Commands it runs

Only `/clear`, and Claude Code's compaction (`/compact` where a session compacts only inside a
turn): at a Context Autopilot handoff, once the notes file is written (compaction if you chose
it), including when you choose *Hand off now* or `/cr fresh now` while a handoff waits; at a
watcher's fresh wake, only while the run is still where the watcher left it and the handoff notes
are newer than its milestones; and when you choose *Start fresh* or *Compact first* in the Cold
Resume Guard. No other command.

### Tools it calls, and messages to agents

Only `TaskStop`, when you ask: **Stop** on a background job Claude started (Guardrails → Machine
load, or beside a task a handoff waits for in Context), **Stop & hand off** or `/cr handoff stop`
(only the work the handoff waits for, never a server; asked first when you type it), or **Stop**
on an agent (Activity → Agents). When you write to an agent there and press **Send**, the text goes
to that agent through Claude Code's own `SendMessage` delivery. No other tool.

### Dialogs and the prompt box

It asks in Claude Code's own question dialog: a call set to **Ask**; before a message re-reads a
large conversation whose prompt cache has lapsed (the Cold Resume Guard); before your next message
once a run budget set to *Ask* is reached; `/cr decide`; a watcher time that reads two ways; a
message you type while a written handoff waits (give it to the fresh context, send it here, or back
to the prompt box); and before stopping background work you asked it to stop by typing. Where no
one can be asked (a headless run) it does not ask. While a handoff is under way, a short message
about the handoff itself ("handoff now", "keep waiting", "cancel the handoff") is carried out
instead of being sent to Claude, and the reason shown says what was done. The Cold Resume Guard's *Cancel* puts
your message back in the prompt box (`$.prompt.fill`). After *Start fresh* or *Compact first*, which
send that message themselves, it reads the prompt box (`$.prompt.read`) and empties it only while
it holds just that message, which Claude Code put back there; a draft you typed is left alone.

### What its tool-call hook does with the calls it sees

Every tool call passes through one hook. It reads the tool's name and input, in memory, to sort
the call into the permission categories, to recognise a heavy job (a build, a test suite, an
install) for machine load, to place an edited path inside or outside the project, and to count
activity. Then it does one of three things:

- passes the call on unchanged, which is what happens to nearly every call;
- asks you first, in Claude Code's question dialog, when its category is set to **Ask** and Claude
  Code would not ask anyway (*Run it* / *Don't run it*), then passes it on unchanged;
- refuses it with a reason Claude reads: its category is set to **Deny**; it is a new heavy job
  while machine-load limits are on, the machine is at its ceiling and other heavy jobs are running;
  or, should its classifier fail, it is an obviously destructive command.

It never changes a call's input, never answers a permission check, never allows a call Claude Code
would not, and never loosens a deny. To tell whether Claude Code would ask, it queries Claude
Code's own verdict, a check that runs nothing. The command patterns in its source (a download
piped into a shell, a token sent to a remote host) are there to recognise such commands so it can
ask or refuse; it never runs them.

### The tools it answers itself

- `milestones` (`mcp__project-sentinel__milestones`), offered to Claude only where Claude Code has
  no task list of its own. Its hook answers the call by recording the run's milestones (their
  titles and states) in memory and in the plugin's store.
- `decision_request` (`mcp__project-sentinel__decision_request`), offered while the Decision Inbox
  is on (the default). Its hook answers the call by recording Claude's question (with its context,
  up to four options, whether it blocks, its milestone) for you, and tells Claude to carry on. Its
  description tells Claude not to use it for status updates, for choices Claude can make itself, or
  for permission, safety or destructive-action confirmations, which stay Claude Code's own.

It answers no other tool in that tool's place.

### Subagents

Its hook on starting a subagent does one of three things. With subagent limits on (off by default)
it refuses a new subagent while subagents are turned off, past your limit, or when you decline it
in the **Ask** dialog. With the model router's subagent routing on (the router is off by default)
it changes the **model** of the subagent being started, and nothing else. Otherwise it passes the
start on unchanged. It never changes a subagent's permission mode, tools, prompt or description,
and never starts one itself.

### Programs it runs

No shell. Each is one program, named with fixed arguments written out where it is started;
nothing from your session is passed to it except, to `git hash-object`, the paths of a completed
milestone's own files. What it prints stays in memory, except those blob ids:

- **Windows:** `typeperf "\Processor(_Total)\% Processor Time" "\Memory\Available Bytes" -si 2`
  (Windows' own performance-counter reader, one process while live load is on) and, once,
  `systeminfo /fo csv /nh` for the machine's total memory.
- **macOS:** `top -l 0 -s 2 -n 0` (one process while live load is on) and
  `sysctl -n kern.memorystatus_level` at each reading.
- **Linux:** no program; it reads `/proc/stat` and `/proc/meminfo`.
- **In the terminal only:** `git status --porcelain=v1 --branch --untracked-files=normal` in the
  project, for the branch and the count of uncommitted files.
- **For milestone evidence, on every surface:** `git hash-object --no-filters -- <files>` (read-only:
  it prints each file's Git blob id and writes nothing) for the files a completed milestone's work
  changed, and `git rev-parse --verify -q HEAD` for the commit. Run when a milestone is completed,
  then to compare (at a handoff, a session's start, and at most once a minute after a turn), and only
  for files whose size or time moved. Never the whole repository. The ids are kept in the run
  record, to say later that a milestone's verification is stale, never that it is wrong.

Live load (machine-wide CPU and memory, every few seconds) is on by default; Setup turns it off.
On a Windows installed in a language other than English the counters have other names, so
`typeperf` finds none and the readings show as unavailable.

### What it reads

The session's usage and model from Claude Code, including the plan's rate-limit windows (percent
used and reset time of the five-hour and seven-day windows) and whether a request ended on the rate
limit; your prompts and tool calls in memory, to show activity and progress (and, while a handoff
is under way, whether a short message is about the handoff); file status (never contents) of the
handoff notes, of paths Claude edits, to place them inside or outside the project, and of a
completed milestone's files, to tell whether they changed; Claude Code's managed policy settings,
to know whether its policy section can be added; Claude Code's list of the session's agents (id,
type, description, status, parent, name), each agent's start (its type, description, model,
parent, a workflow run) and its own tool calls, task list and end; the background tasks Claude
Code lists when a turn stops (their description and command), to tell a server from work worth
waiting for; what Claude Code says of a resumed session's cache (seconds
since the last answer, context size, whether the cache likely expired, its own estimate of
re-caching) and its estimate at a model switch; the cache lifetime Claude Code is set to use (the
environment variables `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL` and
`ENABLE_PROMPT_CACHING_1H`, and the `promptCacheTtl` setting); Claude's last message as a turn ends, in memory,
for the Watcher Scout to see whether Claude said it will check back at a time; and the output of
the programs above. In a session that
still runs Control Room it reads Control Room's status bar, and stands by until the session
restarts.

### Credentials

It reads no credentials: no API keys, tokens, passwords or login files. Once, after its rename,
it reads the store it kept when it was called Control Room (its own settings and run records, a
JSON file in Claude Code's plugin store) and copies them into its new store; it never writes,
moves or deletes that file. The environment variables `CLAUDE_CONFIG_DIR`, `USERPROFILE` and `HOME`
are read only to find it.

### What it sends, and where

Nothing it reads leaves your machine through the plugin. It makes no network requests of its own,
the programs above get only their fixed arguments, and its records stay in Claude Code's plugin
store on this machine. What leaves goes through Claude Code's own model requests, to the model
your session uses:

- the prompts and notes above;
- **Keep warm** (off by default; it spends usage): shortly before the prompt cache would lapse
  while you are away, one request of the conversation so far plus a *keep-alive* line asking for a
  one-word reply, so Anthropic's prompt cache stays warm; it stops after two idle hours (by default);
- the **lazy-exit guard** (off by default): when Claude stops with work plainly unfinished it asks
  Claude to continue, at most twice a turn; with its model check on, it first asks Claude Code's
  small model whether the stop was premature, sending your request and the end of Claude's answer;
- the **Handoff Supervisor** (with Autopilot): when a written handoff has waited a minute for a
  background task that fixed patterns do not recognise, it asks Claude Code's small model once
  whether that task is a server or a job that ends, sending only the task's command and Claude
  Code's description of it (never the conversation).

### What it adds to Claude's instructions

A section of plain-language policies for the features you turned on (Frontier Max, answer styles,
subagent limits, machine load, milestones), readable in the panel. It never hides instructions.
The model router (off by default) picks a model and effort per step; Frontier Max (on for a new
install, at Extra High) raises effort where the model has an effort setting, and never changes the
model.

### What it stores

In Claude Code's own plugin store on your machine: your settings, run records (the objective, in
Claude's words or your latest request's, milestone titles and states, session and handoff counts,
token and cost totals, the project folder) and, with them, the run's operations: work you queued
(in your words), Claude's decision questions with their context and options and your answers,
watchers (what each waits for, when it wakes, its strategy, and the run's fingerprint when it was
armed: a turn count and a digest of the milestones), the run budget, and a short log of what the
layer did; each completed milestone's evidence (its files' paths, Git blob ids, sizes and times,
the commit, and the checks that passed with their command lines); the background tasks a handoff
left running (description, task id); the Quest log's XP; the cache's lifetime once learned, and
Claude Code's own cache-write price per model from its estimates; on a new install, when its
first-run card was shown and dismissed. In the session's own state (gone when the session ends):
when the cache was last written, a handoff under way, and the agents seen. Delete the store file to
remove them.

### Files it ships

Its hooks as readable TypeScript, its type declarations, this README, `LICENSE`, and
`.claude-plugin/icon.png`, the directory listing's icon: no code reads, loads or runs that image.

**Privacy.** No telemetry, no analytics, no network calls of its own. Nothing leaves your machine
except through Claude Code's own model requests named above.

## More

Full documentation, configuration, troubleshooting and the source:
[github.com/Arjun0014/project-sentinel](https://github.com/Arjun0014/project-sentinel). MIT
licensed (see `LICENSE`). The engine's function-hooks API ("mods") is early access and may change
between Claude Code releases.
