# Project Sentinel

Mission control for long Claude Code runs: context, run progress and the prompt cache at a
glance, Autopilot handoffs before the context fills up, guardrails, and a calm view of what Claude
did. For the terminal CLI and for local sessions in Claude Desktop's Code tab.

Project Sentinel was called **Control Room** until 1.4.0; its panel still is, and `/cr` still
opens it. An existing install moves over by itself (see [Coming from Control Room](#coming-from-control-room)).

[![Check](https://github.com/Arjun0014/project-sentinel/actions/workflows/check.yml/badge.svg)](https://github.com/Arjun0014/project-sentinel/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Claude Code 2.1.289 or newer](https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.289-d97757)

<p align="center">
  <img src="docs/images/desktop-overview.png" width="460" alt="The Control Room panel's Overview in Claude Desktop's Code tab: the context meter with its handoff tick, cost, CPU and memory, the profile, then one card per section with each system's switch">
</p>

One plugin gives you:

- a calm **status bar** above the prompt, a mission HUD: what the run is doing or waiting for,
  in words, and only what needs a look; below it the run's instruments (work, context, the prompt
  cache, the plan's five-hour usage), each its own shape; above it, while subagents run, one line per
  agent
- the **Control Room** panel, docked beside the conversation
- **Autopilot** (Context Autopilot): Claude writes handoff notes, the context is cleared, and Claude
  carries on in a fresh one, before this one fills up; then Project Sentinel checks what the handoff
  left and what the fresh context picked up
- **Cache Guardian**: the prompt cache in view, why each rebuild happened and how to avoid the
  next, model switches confirmed before they throw a large cache away, and *Keep warm*, which
  holds the cache while you are away
- **run progress** that survives those handoffs, with **evidence** for each verified milestone (it
  says when a later change made a verification stale), and an **Activity** view that leads with what
  needs a look, with its own views: Summary, Operations, Agents and Tool calls
- **Operations**, the run over time: work you queue for Claude for later, decisions Claude leaves
  for you instead of stopping, **watchers** that park the run until a result is due and then wake
  it, a **Cold Resume Guard** that asks before a large conversation whose cache has lapsed is
  re-read, the agents actually running, and an optional run budget
- **answer styles**: brief, Simplified Technical English, mission-control status calls, or a quest
  log with XP for verified progress
- policies for effort, finishing the job, models, subagents, machine load and risky actions, with
  **profiles** that set everything at once. A fresh install starts opinionated (Autopilot at 70%,
  Frontier Max at Extra High) and says so once; an existing install keeps exactly what it had
- **Kit**, if you like: a small Claude-orange creature above the status bar that shows what Claude
  is doing, and answers a click

> **Status: 1.7.0.** Project Sentinel is built on Claude Code's function-hooks plugin API ("mods"),
> which is still early access and may change between Claude Code releases. It is verified on
> Claude Code **2.1.289** (the minimum), **2.1.293**, **2.1.295** and **2.1.296** (the CLI) on
> Windows 11. See [Compatibility](#compatibility).

<p align="center">
  <img src="docs/images/cli-status-bar.png" alt="The status bar in a 150-column terminal, mid-turn. Kit, a small orange creature, works away on the bar's top edge. The headline reads Documenting the helpers, step 4 of 4, with a red Lint failing chip and the Control Room button on the right. Below: WORK, a track of four milestones with three done and the fourth under way, 3/4; CONTEXT, a green bar at 48% with an orange notch at the 80% handoff point; CACHE rebuilt 446k in amber after a model switch; RUN $0.00+ on the right">
</p>

---

## Contents

- [Screenshots](#screenshots)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Using Project Sentinel](#using-project-sentinel)
- [Profiles](#profiles)
- [How the systems interact](#how-the-systems-interact)
- [Security and privacy](#security-and-privacy)
- [Compatibility](#compatibility)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

Further reading: [Configuration](docs/CONFIGURATION.md) ·
[Troubleshooting](docs/TROUBLESHOOTING.md) · [Design](docs/DESIGN.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) ·
[Contributing](CONTRIBUTING.md)

## Screenshots

### In the terminal

<table>
  <tr>
    <td width="50%"><img src="docs/images/cli-overview.png" alt="Overview in the terminal: Run 29, Session 2 and the objective; a Work card with all four milestones done on a track; a Context card at 51% with the handoff tick at 800k and Autopilot on; a Cache card, warm with 506k tokens cached and 86% read from the cache, rebuilt 446k, with Keep warm on; and Now, with the turn's summary and lint failing"></td>
    <td width="50%"><img src="docs/images/cli-activity.png" alt="Activity: run progress with all four milestones done on a track, This turn as a strip colored by read, edit, check and failed calls with its legend, five counted lines, and Attention naming a lint script that is missing and a test failure that a later run fixed"></td>
  </tr>
  <tr>
    <td>Overview: the run, then its three lifecycles (work, context and the prompt cache), each with how it starts over.</td>
    <td>Activity leads with the run: its milestones, where the turn's time went, and what needs a look, with the line of output that says why.</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/cli-context.png" alt="Context in the terminal: the context meter at 51% with the handoff tick at 70%, the handoff in three numbered steps with a Hand off now button, and Autopilot's settings"></td>
    <td width="50%"><img src="docs/images/cli-cache.png" alt="Context's Cache card: warm, 506k tokens cached over 9 requests, 86% read from the cache, Keep warm on with its next refresh due to learn the cache's lifetime, Stop after 2 hours idle, Ask before a model switch on, Keep policies stable on. Below, Cache health: one rebuild, a model change from sonnet-5-5 to opus-5-5 that re-cached 446k tokens, preventable, with what would have avoided it"></td>
  </tr>
  <tr>
    <td>Context: when Claude hands off, and what happens when it does.</td>
    <td>Further down Context, the prompt cache: what it holds and for how long, Keep warm, and each rebuild with what would have avoided it.</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/cli-activity-checks.png" alt="Activity, further down: Validation with tests passing after one failure (a red dot, then two green) and lint failing, then Changes grouped as code, tests and docs, each file with five diffstat squares"></td>
    <td width="50%"><img src="docs/images/cli-answer-style.png" alt="Behavior's Answer style card with its choices open in place: Standard, Brief, Plain technical (Simplified Technical English), Mission control (status calls GO, NO-GO, HOLD) and Quest log (XP and levels for verified progress)"><br><img src="docs/images/cli-quest.png" alt="The Quest card in Activity: Level 4 with its progress line, 340 XP to level 5, the run's awards (full clear 100 XP, three milestones at 50 XP, a comeback at 30 XP), and the achievements First green, Comeback and Full clear earned"></td>
  </tr>
  <tr>
    <td>Further down Activity: each check's runs as dots, and every changed file by kind with its diffstat, each opening its diff in place.</td>
    <td>Answer styles: how Claude writes to you, each with a line on what it means. The Quest log: XP only for progress Project Sentinel can count, never for lines or tool calls.</td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/cli-status-bar-done.png" alt="The status bar after the turn: All 4 milestones done, Changed 4 files, Ran tests 3 times, passing after a fix, lint once, failing; a red Lint failing chip and the Control Room button; below, WORK 4/4 in green, CONTEXT at 51% with the handoff notch, CACHE rebuilt 446k and RUN $0.00. Kit, startled by the failing check, with a bead of sweat">
</p>

<sub>Control Room 1.3.0 in a 150-column Windows console (Claude Code 2.1.293), with the panel
docked beside the conversation (the Answer style and Quest cards are from 1.1.0; they did not
change). The work is a scripted turn played by the development-only
[demo driver](tools/demo/README.md): Claude Code ran every tool call in it for real (a test that
fails and is fixed, new code with its test, a lint script that does not exist), but no model wrote
the words, and the token counts are scripted, a model switch halfway through included. Claude
Code reports no cost for them, so the cost reads $0.00 (with a `+` after a cleared session whose
cost was not reported).</sub>

### In Claude Desktop

<table>
  <tr>
    <td width="33%"><img src="docs/images/desktop-context.png" alt="Context in Claude Desktop: the context meter at 23% with the handoff tick at 80%, the handoff steps, Autopilot's settings as native buttons, and a run of two sessions with one handoff"></td>
    <td width="33%"><img src="docs/images/desktop-behavior.png" alt="Behavior in Claude Desktop: Frontier Max at extra-high effort, the lazy-exit guard with its strictness and limits, Release check and the model router"></td>
    <td width="33%"><img src="docs/images/desktop-setup.png" alt="Setup in Claude Desktop: the profiles with Normal in use and edited, and the list of what changed from Normal"></td>
  </tr>
  <tr>
    <td>Context, mid-run: one handoff behind it, $115.93 so far.</td>
    <td>Behavior: each system on its own card.</td>
    <td>Setup: exactly what changed since the profile.</td>
  </tr>
</table>

<sub>Control Room 1.0.1 in Claude Desktop's Code tab, from real sessions. On Desktop the controls
are native buttons and popups and the meters are drawn as graphics. What came after (the
two-line status bar, Activity's charts, the answer styles, the Cache card and Kit) has not been
photographed on Desktop yet.</sub>

### Operations

<table>
  <tr>
    <td width="50%"><img src="docs/images/cli-operations.png" alt="Activity, Operations in the terminal: Needs review with nothing waiting and the switch that offers Claude the decision tool; the Mission Queue with its field, Deliver at the next safe boundary, and two items, each reading Goes into W-1's fresh wake (17:41), with move, Edit, Deliver now and Delete; Watchers with W-1 for the S-002 result at 17:41, in 1h 55m, Fresh, with Wake now, Edit, Pause, Write notes first and Delete"></td>
    <td width="50%"><img src="docs/images/desktop-operations-preview.png" alt="Activity, Operations as the desktop preview draws it: a decision Claude left, Postgres or SQLite for the cache store, with a button for each option, a field for your own words and Not needed; the Mission Queue with two items for after the handoff; the watcher form with quick times and the Smart strategy; Agents with Claude ready; a run budget at $1.25 of $30"></td>
  </tr>
  <tr>
    <td>In the terminal: two items queued for the fresh context that watcher W-1 will start when it wakes the run at 17:41.</td>
    <td>On Desktop, in the preview: a decision Claude left for you, a button per option and a field for your own words; below it the queue, the watcher form, the agents and a run budget.</td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/cli-status-bar-sleeping.png" alt="The terminal status bar while the watcher parks the run: Kit curled up asleep with zZ above it; the headline reads Sleeping until 17:41, S-002 result, fresh wake, no keep-alive; below, WATCHER with a clock and 1h 55m, and RUN $0.00"><br>
  <img src="docs/images/desktop-status-bar-review.png" alt="The Desktop status bar after a turn, as the preview draws it, with a Review 1 chip and its amber mark beside Lint failing and the Control Room button"><br>
  <img src="docs/images/desktop-status-bar-sleeping.png" alt="The Desktop status bar while a watcher holds the cache, as the preview draws it: Sleeping until 17:34, S-002 result, cache held warm; the Cache cell reads held warm, 240k, and the fourth cell is the Watcher, 2h, 17:34">
</p>

<sub>Project Sentinel 1.6.0. The terminal images are captures of Claude Code 2.1.295 in a 150-column
Windows console, set up with `/cr` commands alone (`/cr queue --handoff`, `/cr watch in 2h … --fresh`,
`/cr budget $30`), so no model turn ran. The Desktop images are drawn by
[tools/desktop-preview](tools/desktop-preview/README.md) from the trees the plugin draws on the
`desktop` surface, with the app's own layout rules; its font and colors are close guesses, and
Operations has not been photographed in the app yet.</sub>

## Features

| System | What it does | Default |
| --- | --- | --- |
| **Status bar** | A mission HUD above the prompt. The headline says what the run is doing in words, with a mark for its state: working, thinking, running a check, waiting for you, waiting for a result that comes by itself (a background job, a scheduled wake-up), blocked, handing off, done. On its right, only what needs a look (a failing check, issues, a busy machine, agents), then the Control Room button. Below, the instruments, each its own shape: Work (a track of milestones), Context (a bar with Autopilot's handoff notch), Cache (a clock face, only while it matters) and **5H**, the plan's five-hour usage as Claude Code reports it (a thin bar, the percentage, the time to the window's reset). A handoff that needs you takes a line of its own above, with its buttons, and while subagents run the **agent band** sits above everything: a line per agent saying what it is doing, opening Activity → Agents. On Desktop the readings sit in a grid of cells and always keep their places. | On |
| **Control Room panel** | Six sections: Overview, Context, Behavior, Guardrails, Activity, Setup. A section with several views (Activity) has a second level that never looks like a setting: `Activity › Summary` over `View  [ Summary ]  Operations  Agents (2)  Tool calls` (a bordered group of buttons on Desktop). Color means something: green verified, amber waiting for you or worth a look, red a failure or a blocker, blue what is current or under way, gray the rest. In the terminal: switches, segmented choices, choices that open in place, and − / + steppers. Every control works with a click or with Tab and Enter, and there are no popups to get stuck in. On Desktop: native buttons and popups, plus graphical meters. | `/cr` opens it |
| **Autopilot** (Context Autopilot) | At a threshold (a % of the window, or tokens), Claude finishes the step it is on. Then it runs a handoff: it records the run's milestones, updates the project's docs, keeps CLAUDE.md for durable instructions only, runs a minimal validation and writes `NEXT_SESSION_PROMPT.md` in its own words. Project Sentinel then runs `/clear`, seeds the fresh context with the run's milestones and objective, and Claude continues on its own. Every step moves on when its turn starts or ends, never on a timer. A handoff turn that ends while finite background work it started still runs (a render, a test run) waits for that work as Claude Code reports it (20 minutes at most by default), takes its result into the notes, then clears and continues by itself; a server or watcher is never waited for, and work left running is handed to the fresh context, which is told. A fresh context that starts close to the threshold gets room to work before it may hand off again. Compaction is a choice, or the fallback when clearing is refused (in Desktop and other SDK sessions it runs as `/compact`). A reload of the plugin mid-handoff carries the handoff on; it never starts a second one. | On, at 70% (Classic: Off) |
| **Handoff Supervisor** | Looks at a handoff under way every 30 seconds, with no model call and nothing added to the transcript: how long its step has stood and what holds it (finite work worth waiting for, work that outlasted its wait, a server beside it, a question open to you, a step whose event never came). It shows in Context and on the line above the status bar with the ways out: *Hand off now* (leave the work running for the fresh context), *Stop & hand off*, *Keep waiting*, *Call off*; the same as `/cr handoff now\|stop\|wait\|cancel`, and typing "handoff now" or "don't wait for the server" works too. Only a task nothing recognises is asked about, once, by a small isolated classifier (its command and description only). | With Autopilot |
| **Handoff Health and Continuity** | After each handoff, Context → *Last handoff* shows what it left for the fresh context (run state saved, the milestone under way, the notes, docs updated, validation recorded, whether the verified milestones' evidence is current, what it left running) and, once the fresh context's first turn ends, what it picked up (notes read, run state restored, milestone picked up, docs read, work resumed). Counted from tool calls, never from what Claude says. | With Autopilot |
| **Run progress** | The run's objective and milestones, done of total, counted from Claude's own task list and carried across handoffs, so the work meter keeps climbing while the context meter starts over. A milestone may also be *verifying* (with its evidence) or *blocked* (with what it waits for). Where Claude Code offers no task list (its task tools are off by default in 2.1.29x), Project Sentinel gives Claude a small `milestones` tool to keep one. | On |
| **Milestone evidence** | When a milestone is completed, what it stood on is kept: the checks green during its work, the files its work changed (and outputs Claude names) with Git's blob id of each, and HEAD. Never the whole repository. Later, a changed file makes that verification *stale* (never "wrong"), with what changed and which checks to rerun, in Run progress, Attention, Last handoff and Ready to resume; Claude is told at a handoff and in the fresh context. A later milestone changing the same file is quiet while under way and re-verifies it when its checks pass; a change made outside Claude's tools clears once the checks pass again, or when you accept it (`/cr evidence accept`). | On |
| **Cache Guardian** | The main conversation's prompt cache, from the token counts Claude Code reports for each request: how much is cached, how long it stays warm (the cache's lifetime is learned), the share read from the cache, and why each rebuild happened (a model or effort switch, the model router, changed policies, a new tool, compaction, idling past the lifetime), with what would avoid the next. A model switch that would re-send 100k+ warm tokens is confirmed first; the model router no longer downgrades a conversation whose cache is warm (from 20k tokens); while it is warm, setting changes reach Claude as notes instead of rewriting the cached system prompt. | On |
| **Keep warm** | Refreshes the prompt cache shortly before it lapses while you are away, by re-sending the last request once (the transcript never sees it), for up to an idle limit you set. Each refresh costs tokens, mostly cheap cache reads. The refreshes are then checked against the conversation's own next request: *VERIFIED* when it read the cache after an expiry they replaced, *FAILED* (and Keep warm pauses) when it rebuilt with nothing changed. A refresh Claude Code had to retry through a network blip, answered only after the expiry, is not counted against it. `/cr cache` lists them. | Off |
| **Mission Queue** | Work you give Claude for later without interrupting it: from Activity → Operations (*Add work for later*, with when it goes) or `/cr queue <text>`. Each item goes only at a boundary: the next safe one (the milestone under way completes or the turn ends), after this turn, after the current milestone, or into the next fresh context. Never into a turn's reasoning: an item due mid-turn goes with the next batch of tool results, otherwise as a prompt of its own when the turn ends. Edit, reorder, deliver now or delete; kept with the run across `/clear`, handoffs, reloads and resumed sessions, delivered once. | On |
| **Decision Inbox** | Claude is offered one tool, `decision_request`, for a choice that is yours and need not stop the work (which approach, whether to delete generated files, whether to publish once CI passes). It waits in Activity → Operations → *Needs review* with its options and a field for your own words; `/cr decisions` lists them, `/cr decide D-2` asks in Claude Code's own dialog. The answer reaches Claude with its next tool results while it works, as a prompt of its own when the run waits on it, else with your next message. Claude Code's permission prompts and confirmations are never deferred here. | On |
| **Watchers** | Park the run until a time, then wake Claude to check what it was waiting for: Operations → *Watchers* or `/cr watch in 2h S-002 result` (`at 14:00`, `tomorrow at 9am`; an ambiguous `at 2:30` is asked, never guessed). *Keep warm* holds the conversation's cache to the wake, *Fresh* spends nothing and wakes in a fresh context from the handoff notes, *Smart* chooses and says why. A watcher never clears a run that moved since it was armed: it says *Watcher due* and offers Check now, Reschedule or Dismiss. A fresh wake needs healthy resume state. Watchers run while Claude Code runs (no daemon is installed); one due while it was closed waits for you when the session is open again. The *Scout* suggests one when Claude says it will check back at a time (Off, Suggest, or Arm explicit waits). | On (Scout: Suggest) |
| **Cold Resume Guard** | Before a message is sent into a large context (100k tokens by default) whose prompt cache has surely lapsed, Claude Code's own dialog asks first: *Continue full session*, *Start fresh from resume state* (only when Context → *Ready to resume* is ready), *Compact first* (it reads the context once more, then sends the message into the compacted one), or *Cancel* (the message comes back to the prompt box). It says why the cache lapsed and how many tokens would be reprocessed; a price only as Claude Code's own estimate for the model, as a floor (*at least ~$0.46*). It uses the cache lifetime Claude Code is configured for, and counts Claude Code's own requests while you are away (its away summary) as keeping the cache warm. The message goes once: the copy Claude Code puts back in the prompt box is cleared. | On |
| **Agents** | Activity → Agents, while agents run or ran lately: each agent under its parent (a workflow's under its run), with its type, model, status, time, what it is doing now (its latest call), its calls, its own plan as a track when it keeps one (never a made-up percent), and its result or failure. An agent shows from its spawn, before Claude Code lists it; workflow agents, which Claude Code never lists, show from their own loop. *Stop* and *Message* are Claude Code's own `TaskStop` and `SendMessage`, offered only for agents that take them. The agent band above the status bar shows the same at a glance. | Always |
| **Plan usage** (5H) | The plan's five-hour window as Claude Code reports it (`$.session.usage().rateLimits`): `5H 63% · 2h14m` on the status bar, amber from 80%, `limit` in red at 100% or when a request is refused on the rate limit, `reset · new window` once the window resets until a response reads the new one, `—` before the first reading; nothing on an account with no five-hour window. Context → Run spells out the five-hour and seven-day windows. Never estimated. | On |
| **Run Budget** | Optional limits on the run's cost (as Claude Code reports it), wall-clock time and handoffs. Said once at 80%; at a limit: notify only, ask before Project Sentinel starts more work by itself, or have Claude finish the milestone and pause. Nothing stops a tool call or a turn under way. | Off |
| **Activity** | The run's milestones, then where this turn's time went (a strip colored by reading, editing, running and checking) and a few counted lines. What needs a look comes next: failures nothing has fixed (with the line of output that says why), refusals, slow calls. Then the checks (tests, build, type-check, lint), each run a dot, and every changed file grouped as code, tests, docs and config, each with its diffstat and its diff. Every tool call is the secondary view. | `/cr`, Activity |
| **Session chain** | Follows a run across context resets: sessions, times, peak context, cost per session as Claude Code reports it, total cost, handoffs. | On |
| **Frontier Max** | Senior-engineer standards in the system prompt (investigate, finish, verify, report honestly), plus the reasoning effort you choose (Extra High by default, Maximum one pick away) on each request where the model has an effort setting. It never changes the model, and no longer turns the lazy-exit guard on by itself. Models without an effort setting get none, never a fake one. It is in the first request of a session, after a `/clear` or a compaction, and when turned on mid-session (a note while the cached system prompt is held). Behavior → Frontier Max says how it reached Claude and at what effort; `/cr diagnostics` shows it request by request (fingerprints only). | On, Extra High (Classic: Off) |
| **Lazy-exit guard** (No-Lazy-Exit Guard) | Continues the turn when Claude stops before the job is done: work handed back to you, "next steps" it could have taken, unverified claims. It leaves genuinely finished work, real blockers, your decisions and optional ideas alone. It has per-turn and per-session caps and stands down during a handoff. | Off |
| **Release check** | A verification-first policy: test before calling work done, and say plainly what was not checked. | Off |
| **Answer styles** | How Claude writes its messages to you: Standard; Brief (the answer first); Plain technical (Simplified Technical English, after the writing rules of ASD-STE100); Mission control (GO, NO-GO and HOLD calls, GO only for what was verified); Quest log. Never code, files or commit messages. A Claude Code output style you chose outranks them. | Standard |
| **Quest log** | A light game layer for the Quest log style: XP only for outcomes Project Sentinel counts (milestones done, checks turning green, finished plans, verified handoffs), never for lines or tool calls, with levels, achievements and the level in the status bar. Claude is told never to state points itself. | With the style |
| **Model router** | Balanced, Performance, Economy or Custom model choices, for subagents and per turn for the main conversation. It never downgrades under Frontier Max, and no model ids are hard-coded. | Off |
| **Subagents** | No limit, up to *N* at once, ask each time, or off. Live counts are shown. | No limit |
| **Focus view** | Presentation only. Tool calls become one compact line each, results and inline diffs are hidden, and the spinner reads `Working · 27 tools · 6 files changed · tests running`. Activity keeps every call and every diff. Claude still reads everything. | On |
| **Machine load** (Resource Governor) | Advisory CPU and memory ceilings (Low, Medium, High or Custom), from a lightweight machine-wide sampler. Claude is told about pressure mid-task, extra heavy jobs can be held back, and only Claude-started background jobs can be stopped. It is not an OS quota. | Off |
| **Permissions** (Permission Policy) | Default, Ask or Deny per category: package installs, network, downloads, project edits, edits outside the project, deleting files, commits, push, force push and resets, deploy and publish, and dangerous commands. *Ask* always asks you first, in Claude Code's own dialogs, even in a permission mode that would not ask; *Deny* refuses. It never answers a permission prompt for you, and never loosens a deny, plan mode or your organisation's settings. Each value says what it means and whether it is the default ("Asks you first · default"). | 2 Deny, 6 Ask |
| **Profiles** | Normal (the fresh-install defaults), Frontier Max, Low Resource, Release / QA, Classic (Normal as it was before 1.7) and your own. Setup shows exactly what changed since you applied one. | Normal |
| **Kit** (the companion) | A small Claude-orange creature in a lane above the status bar, in the terminal and on Desktop, that shows what Claude is doing: pacing while it thinks, typing while it works, reading in round glasses while it searches, watching a check, a dance with confetti at a green finish, a facepalm at a failure, a question mark when the run needs you, fanning itself on a busy processor, tending a small fire while Keep warm holds the cache (or a watcher holds it to its wake), curled up asleep while a watcher parks the run, dozing as the cache nears its expiry, carrying the notes off at a handoff and walking back in, curled up asleep when nothing happens. What it does comes in short episodes picked at random per mood, never the same twice running, and it walks to where it has not been lately, so it uses the whole status bar. A touch reacts by where it lands: a pat on the head, a boop on the nose, a tail flick, a pet on its body (a purr, a roll for a belly rub, a blush…); a few in a row make it giggle, then dizzy. It never jumps: it walks, turns and sits down. Calm by design; *Reduce motion* holds it still. | Off |
| **Git** (terminal) | The branch, how far it is ahead of or behind its upstream, and the uncommitted files, in Overview and `/cr status`, from one read-only `git status` after a turn. Desktop's Git strip is the app's own; plugins cannot draw, hide or move it. | In a repository |

Cost is shown only as Claude Code reports it, and "—" means it was not reported. Progress is
milestones done of the total Claude listed. The cache's expiry, hit ratio and causes are derived
from the token counts Claude Code reports, and the panel says so. Nothing is estimated.

## Requirements

- Claude Code **2.1.289 or newer** with function-hooks plugins (mods). Check with `claude --version`.
- The terminal CLI, or Claude Desktop's Code tab for **local** sessions.
- Nothing else. Project Sentinel has no runtime dependencies and no build step, because Claude
  Code loads its TypeScript directly.

## Install

### Install it (terminal and Desktop)

Add the repository as a marketplace, then install:

```bash
claude plugin marketplace add Arjun0014/project-sentinel
```

```bash
claude plugin install project-sentinel@control-room
```

The marketplace keeps its name, `control-room`; the plugin in it is `project-sentinel`. Or do
both from inside a session (Claude Code 2.1.275 or newer):
`/plugin install project-sentinel --marketplace Arjun0014/project-sentinel`.

A local clone works too: `claude plugin marketplace add /path/to/project-sentinel`. The terminal
reads an installed folder marketplace straight from the folder, so after you pull changes, run
`/reload-plugins` in a session. Desktop's Code tab may load the copy Claude Code made when you
installed, so it needs `claude plugin update project-sentinel@control-room` after a new version,
then a new session.

### Coming from Control Room

Installed as `control-room@control-room` before 1.4.0? Update the marketplace:

```bash
claude plugin marketplace update control-room
```

The marketplace maps the old name to the new one, so the update moves your install to
`project-sentinel@control-room` (your `enabledPlugins` entry included), and the next session
loads Project Sentinel. When it first loads it reads the store it kept as Control Room once (the
one written last, where Claude Code kept more than one) and copies your settings, runs, Quest log
and what it learned about the prompt cache into its own store; the old file is left as it was.
Sessions that were open during the update keep Control Room until they restart; Project Sentinel
stands by in them, so the two never act at once. Two things changed in behaviour: the *Allow* permission
state is gone (a saved Allow reads as *Default*: in Bypass permissions mode nothing changes,
otherwise prompts it answered come back unless your Claude Code allow rules cover them), and a
click on Kit no longer opens the panel (the status bar's button does).

### Update

Each release raises the version, and Claude Code installs it when you ask:

```bash
claude plugin update project-sentinel@control-room
```

To get releases automatically, open **Marketplaces** in `/plugin`, select `control-room` and
choose **Enable auto-update**. It is off by default for marketplaces you add yourself.

### Try it for one session

```bash
claude --plugin-dir /path/to/project-sentinel/plugins/project-sentinel
```

Nothing is installed. The plugin loads from that folder for that session, and edits to it reload live.

### Claude Desktop (Code tab)

Desktop's local sessions run the same Claude Code engine and load the plugins installed above.
To load a working copy without installing it, name the folder in the `env` block of
`~/.claude/settings.json`. Claude Code reads `CLAUDE_CODE_PLUGIN_DIRS` there for sessions that
the Desktop app starts:

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/project-sentinel/plugins/project-sentinel" }
}
```

Use your platform's path-list separator (`;` on Windows, `:` elsewhere) for several folders.
Remote (cloud) sessions have not been tested.

### Uninstall

```bash
claude plugin uninstall project-sentinel@control-room
```

Settings and run history live in Claude Code's per-plugin store (see [Configuration](docs/CONFIGURATION.md#where-settings-live)).
Use `/cr reset confirm` first if you also want the settings cleared.

## Using Project Sentinel

### The status bar

A mission HUD above the prompt: what is happening on top, the run's instruments below. Settings
live in the panel.

```
◎ Linting · step 3 of 4                                                ▲ RAM 83%    ◆ Control Room
  WORK ●━●━◎─○ 2/4    CONTEXT ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇█▇▇▇▇▇ 47% · hands off 80%    CACHE ● rebuilt 446k      5H ▂▂▂▂▂▂ 63% · 2h14m
```

| Item | Meaning |
| --- | --- |
| `◎ Linting · step 3 of 4` | **The headline**: what the run is doing, with a mark for its state. While a turn runs: the milestone under way in Claude's words, else the running call, else `Thinking`; a check running or a milestone being verified is `◎`; a call past 20 seconds adds its time; `◆ Waiting for you to approve: git push` while a call set to *Ask* waits for your answer. Between turns, what the run waits for comes first: `◷ Waiting for the test run` (a background job), `◷ Waiting to check back · wakes at 06:12` (a scheduled wake-up), `⊘ Blocked: …` (something only you can give), `◆ Waiting for your answer` (Claude asked you something). `◆ Needs you · 1 decision` (a decision Claude left blocks the run), `◆ Watcher due: S-002 result` (a watcher waits for you), `◷ Sleeping until 14:00 · S-002 result` (a watcher parks the run, with whether the cache is held warm or the wake is fresh). Otherwise what the last turn did in counted words (`✓ Changed 4 files · Ran tests 3×, passing after a fix`), `✓ All 6 milestones done`, or before the first turn the run's objective (`○ Ready` without one). A handoff under way reads `↻ Writing the handoff notes`; one whose turn ended while background work still runs reads `↻ Handoff written · waiting for background work` with the task and that it runs (`Render the 16:9 master · running`), then `Handoff complete · checking the notes` and `Handoff complete · starting the fresh context`. |
| `▲ RAM 83%` | **Chips**: only what needs a look, the most pressing first. `✗ Lint failing` (a check failing, by name), `▲ 2 issues` (calls that need a look), `Kept going ×1` (the lazy-exit guard continued the turn), `▲ CPU 91%` or `▲ RAM 92%` near or over a ceiling (the terminal; Desktop has a Machine cell), `2 agents`, `★ Lv 4` with the Quest log style. The orchestration layer's chips are buttons that open Activity → Operations at their own card, the mark in its color: `▲ Review 2` (an amber mark: decisions waiting for you), `◷ Watcher 1h 42m` (a watcher armed while the run is not asleep), `● Queued 3` (queued work due when the turn ends), `▲ Cost $25.00 of $30` (the run budget near or at a limit). None shows while there is nothing to say. |
| `◆ Control Room` | Opens or closes the panel: a filled button, in Claude orange while the panel is open (`◆ Open` or `◆ Close` when the bar is narrow). |
| `WORK ●━●━◎─○ 2/4` | The run's milestones, done of total, from Claude's own task list: `●` done, `◉` under way, `◎` being verified, `◌` waiting or blocked (amber), `○` to come. It carries across handoffs, so it keeps climbing while Context starts over. |
| `CONTEXT ▇▇▇▇█▇▇ 47% · hands off 80%` | How much of the context window is in use: a solid bar, green, amber near the handoff point and red past it (with Autopilot off, against 90% of the window), and the handoff point as an orange notch. It starts over after a handoff, and a handoff under way says so beside it (`Handoff soon`, `Writing the handoff`, `Waiting for background work`, `Checking the notes`, `Starting fresh`, `Resuming`, `Waiting for you`). |
| `CACHE ● rebuilt 446k` | The prompt cache, only while it can matter: when you are away, a clock face emptying as its lifetime runs out and the time left (`◕ 42m left`; `lapsed?` when it may have lapsed), amber near the expiry with no refresh coming; and for a few minutes after a costly rebuild, `rebuilt 446k`. While Claude works its requests keep the cache warm, so the terminal leaves it out (Desktop keeps its cell: `warm · 345k`), and it never reads `lapsed?` during a turn. |
| `5H ▂▂▂▂▂▂ 63% · 2h14m` | The plan's five-hour window, as Claude Code reports it: a thin bar (blue, amber from 80%), the percentage and the time to the window's reset, redrawn each minute while it counts down. `5H —` before the first reading; `5H reset · new window` once the reset time passes, until a response reads the new window; `5H limit · 1h30m` in red at 100% or when Claude Code ends a request on the rate limit (`Rate limited` when no window reads full), until a turn is answered again or the window resets. Nothing on an account with no five-hour window (an API key). The run's cost is in Overview, Context → Run, `/cr status` and the Run Budget. |
| `WATCHER ◷ 1h 42m` | Only while a watcher parks the run: the time to its wake. On Desktop it takes the Machine cell's place (nothing runs, so the machine is not the story). |

Width decides the detail. The names (`WORK`, `CONTEXT`, `CACHE`) show from 72 columns (`5H` names itself at every width), docked
beside the panel included; the meter and the track shorten before the least important reading
drops. The empty part of the meter and the HUD's top edge are drawn in the theme's quietest gray,
the same in every terminal.

On Desktop the same readings sit in a row of five cells: Work, Context, Cache, **Machine** (CPU and
memory as slim level bars with their percentages, amber near a ceiling and red at it) and the
plan's **5-hour usage** at the right edge (`Plan usage —` on an account with no five-hour window), each a quiet caption over its graphic and value, the button native.
The columns are weighted by what they hold (Work and Context wider), and the five always keep
their places, a dim word standing in for one with nothing yet (`No milestones yet`, `—`). Width
decides the detail: the labels and what the cache holds in a wide band, `CPU · RAM` in a narrower
one, the bars alone in a compact one. The graphics (the state's mark, the track, the meter, the
level bars, the clock, Kit) are drawn as images.

```
(▸) Running tests · step 3 of 10                                           ✗ Lint failing   [ ◆ Control Room ]
Work                       Context · hands off at 70%    Cache              Machine                   5-hour usage
●━●━◉─○─○─○  2 of 10       ▬▬▬▬▬▬▬▬▬┃▬▬▬  24%             ◔ warm · 345k      CPU ▮ 34%  RAM ▮ 85%      ▂▂▂ 63% · 2h14m
```

When a handoff is about to happen, a line above offers **Hand off now** and **Later**; if a
handoff ever waits for you, it offers **Start fresh**. A written handoff waiting for background
work offers **Hand off now** (the work keeps running for the fresh context), **Stop & hand off**,
**Keep waiting** (near the end of its wait, or once it stalled) and **Call off**; one the Handoff
Supervisor finds stuck says what holds it and offers what fits. The same line asks about a watcher that waits
for you (**Check now**, **Start fresh** when that is safe, **In 30m**, **Dismiss**), a message the
Cold Resume Guard kept (**Put back**, **Send now**, **Discard**), the run budget holding automation
(**Continue anyway**, **Budget ›**), and the Scout's suggestion (*Claude seems to be waiting for a
future result. Check the leaderboard again in two hours?* **Create watcher**, **Change time**,
**Ignore**). While subagents run, the **agent band** sits above all of it: a line per agent (up
to three; more are counted by what they do, `5 agents · 2 reading · 2 editing · 1 checking`), each
opening Activity → Agents, and gone when none runs. With the companion on (Setup →
*Companion*, `/cr companion on`), Kit lives in a lane above the headline: in the terminal it
stands on the status bar's top edge, on Desktop it is drawn in finer pixels. Give it a click.

Claude Desktop's Git strip is the app's own: plugins can neither draw, hide nor move it, so
Project Sentinel shows no Git UI on Desktop. In the terminal, Overview and `/cr status` carry the
branch and the uncommitted files.

### The Control Room panel

`/cr` (or `/control-room`) opens or closes it, and so does the status bar's button. In the
fullscreen terminal from 110 columns it docks beside the conversation; otherwise it opens in a
frame above the prompt. A wide frame (a wide terminal, or a Desktop pane at full size) keeps the
page to 80 columns, centred. Opened by you, it seats at any width. If it opens on its own (*Open
at session start*), it waits for 144 columns.

Click anything, or move with **Tab**, choose with **Enter**, and return to the prompt with **Esc**.
Choosing a section starts its page at the top, and every page ends with **↑ Sections**.

| Section | Answers |
| --- | --- |
| **Overview** | How is this run doing? Anything that needs you sits on top (and, once after a fresh install, a short *Sentinel is on* card). Then the run (its number, the session, its cost and objective; in the terminal, the Git branch) with what is happening now right under it, an **Operations** card only while something is in it (Review 2 · Watcher · wakes in 1h 42m · Queued 3 · Agents 2 active · Budget), the three lifecycles as cards, Work, Context and Cache, each with how it starts over, and one card per section with its systems, each with its switch and one line of state (Setup's holds the profile). |
| **Context** | When does Claude hand off, and what does the cache hold? The Autopilot's state, meter and settings; the prompt cache (Cache, then Cache health with the recent rebuilds); the **Cold Resume Guard** (its switch, the size it asks above, whether it would ask now and why); **Ready to resume** (what a fresh context would get: the run, its milestones, what it reads, what it carries, the next action, a milestone whose verification is stale, or why a fresh start is not offered; quiet unless a fresh start is in play); the last handoff (what it left, what the fresh context picked up); then the run (its plan usage, its sessions) and earlier runs. |
| **Behavior** | How does Claude work? The answer style (with a line written in it), Frontier Max (what it does in plain words, its effort, and whether it reached Claude in this context), Release check, the lazy-exit guard, the model router and run progress. Finer settings appear only while a system is on. |
| **Guardrails** | What may Claude do, and how hard may it push the machine? Permissions (each value with its meaning and whether it is the default), subagents, machine load with live meters, and Claude's background jobs. |
| **Activity** | How far is the run, and what needs a look? *Summary*: the Quest card with the Quest log style, run progress (objective, milestones, now and next, checks), this turn as a time strip and a few counted lines, Attention, Validation with each check's runs, and the changed files by kind, each with its diffstat and diff. *Operations*: Needs review, Mission Queue, Watchers and Run budget (see [Features](#features)), and a line to Agents. *Agents* (while agents run or ran lately): each agent with its parent, model, status, what it is doing and its result. *Tool calls*: every call, and Focus view's switches. |
| **Setup** | Profiles (Normal, Frontier Max, Low Resource, Release / QA, Classic, your own; with exactly what changed), display (the status bar, live CPU and memory, notifications, the companion, reduce motion, open at start), and about. |

### Commands

Every control is also a command. This is handy over Remote Control, for muscle memory, and on
surfaces without the panel.

| Command | Effect |
| --- | --- |
| `/cr` | Open or close Control Room |
| `/cr status` | Everything at a glance |
| `/cr help` | Command list |
| `/cr profile [name]` | List profiles, or switch (`normal`, `frontier`, `low-resource`, `release-qa`, `classic`, or a custom name) |
| `/cr autopilot on\|off\|70%\|700k` | Turn Autopilot on or off, or set its threshold (`%` of the window, or tokens with `k`/`m`) |
| `/cr handoff` | Hand off now: notes and `NEXT_SESSION_PROMPT.md`, then continue in a fresh context. During a handoff it says what the handoff is doing instead (writing, waiting for named background work, checking the notes, starting fresh) |
| `/cr handoff now` · `/cr handoff wait [30m]` · `/cr handoff stop [id\|all]` · `/cr handoff cancel` | A waiting handoff's ways out: go on now and leave background work running for the fresh context; wait longer; stop the work it waits for, then go on; call it off. Typing "handoff now", "don't wait for the background process", "start the fresh session now", "keep waiting" or "cancel the handoff" while a handoff is under way does the same and never reaches the old context |
| `/cr fresh` | Start the fresh context of a written handoff: waiting for you, or one no event moves on. It checks first that the notes were written for this handoff; a server or watcher still running never holds it (it keeps running for the fresh context); finite work does, and it says so |
| `/cr fresh now` | The same, past work that still runs: it keeps running, and its result reaches the fresh context |
| `/cr evidence` · `/cr evidence check` · `/cr evidence accept [n\|all]` | What each verified milestone stood on; compare with the workspace now; accept a stale one's files as they are |
| `/cr frontier on\|off` | Frontier Max (the guard is its own switch) |
| `/cr guard on\|off` · `/cr qa on\|off` · `/cr focus on\|off` | Lazy-exit guard, Release check, Focus view |
| `/cr style standard\|brief\|ste\|mission\|quest` | How Claude writes to you (no argument lists them) |
| `/cr resources off\|low\|medium\|high\|<cpu>/<ram>` | Machine load level, or custom ceilings such as `60/80` |
| `/cr agents` | What is running now (Activity → Agents) |
| `/cr agents unlimited\|off\|ask\|<n>` | What Claude may start: subagents |
| `/cr queue <text>` | Work for later, at the next safe boundary; `--turn`, `--milestone` or `--handoff` first chooses another. Typed while Claude works, it runs when the turn ends and never enters it |
| `/cr queue` · `/cr queue list` · `/cr queue now\|cancel <id>` | Open the queue to type in · list it · deliver one now or delete it |
| `/cr watch in 2h <what>` · `/cr watch at 14:00 <what>` | Park the run until then and wake Claude to check (`--warm` or `--fresh`; Smart by default). An ambiguous time is asked |
| `/cr watchers` · `/cr watch now\|pause\|resume\|cancel <id>` | The watchers, and each one's controls |
| `/cr decisions` · `/cr decide <id> [answer]` | What Claude left for you to decide; answer one (in Claude Code's dialog when no answer is typed; an option's number or words pick it) |
| `/cr budget [$30] [6h] [handoffs 5] [notify\|ask\|finish]` · `/cr budget off\|continue` | The run budget: set, show, remove, or let the run go on past a limit |
| `/cr resume` | What a fresh context would get now, and whether a fresh start is offered |
| `/cr router off\|balanced\|performance\|economy\|custom` | Model router |
| `/cr cache` | The prompt cache in words: its state and lifetime, what it holds, Keep warm, and the recent rebuilds with what would have avoided them |
| `/cr cache keep on\|off` · `/cr cache idle 2h` | Keep warm, and how long it holds the cache while you are idle (`45m`, `2h`) |
| `/cr cache guard on\|off` · `/cr cache stable on\|off` | Ask before a model switch; Keep policies stable |
| `/cr diagnostics` | Evidence that the settings reached Claude: each request of this context (the policy section's fingerprint, whether Frontier Max was in it and how it travelled, model and effort), the notes delivered, Keep warm's refreshes and their checks. Fingerprints and counts only, never prompt text |
| `/cr hud band\|status\|both\|off` | Where the status bar draws: above the prompt, in Claude Code's status line, both, or neither |
| `/cr companion on\|off` · `/cr motion on\|off` | Kit, the companion; animation (`off` is Reduce motion) |
| `/cr reset confirm` | All settings back to Normal, the fresh-install defaults (custom profiles are kept) |

`/cr` is registered only if no other command already uses the name. `/control-room` always works.

## Profiles

| Profile | What it sets |
| --- | --- |
| **Normal** | The fresh-install defaults: Autopilot on, handing off at 70% into a fresh context that carries on by itself (compacting if the clear fails); Frontier Max at Extra High effort; the Decision Inbox, Watchers and run milestones on; Focus view's quieter transcript; the safe permission defaults (2 Deny, 6 Ask). The lazy-exit guard is off. |
| **Frontier Max** | Frontier Max at maximum effort, guard on (standard), Autopilot at 70%, machine load Medium. |
| **Low Resource** | As Classic, with machine load Low (CPU 50%, memory 75%, hold all heavy jobs) and at most 1 subagent. |
| **Release / QA** | As Classic, with Release check on, a strict guard (3 continuations per turn), Autopilot at 70%, at most 2 subagents, inline diffs shown, machine load Medium and commits set to Ask. |
| **Classic** | Normal as it was before 1.7: Autopilot and Frontier Max off (its effort Maximum when turned on), everything else as Normal. |

A profile sets everything at once. Change anything afterwards and the profile reads
`Normal · edited`, and Setup lists each change (`Machine load  Off › Medium`). Save any setup as
a profile of your own, or go back to the profile in one click.

**New installs and updates.** Only a fresh install gets the opinionated defaults (and one short
*Sentinel is on* card, until *Got it*). An install that saved settings before 1.7 keeps every value;
if it was on Normal, it now reads **Classic**, so it is not "edited" against the new Normal. An
install that used Project Sentinel without ever changing a setting (settings are saved only when
one changes; its runs, cache memory or Quest log show it is not new) is saved as Classic, so nothing
changes for it either.

## How the systems interact

Conflicts are resolved in a fixed order (higher wins):

1. **Organisation and engine safety**: managed settings, deny rules, plan mode. Never loosened.
2. **Permissions**: apply to everything, including work the Autopilot or the guard asked for.
3. **Your live actions**: an interrupt cancels pending automation. A prompt you type while a
   handoff is pending is honoured, with a reminder. While a handoff is under way, an instruction about
   it ("handoff now", "keep waiting", "cancel the handoff") is acted on and never sent into the old
   context; any other message while a written handoff waits is asked about: hand off and give it to
   the fresh context, send it here, or keep it in the prompt box.
4. **Autopilot**: once a handoff is pending, the guard stands down, and no new large work is
   encouraged. Keep warm stands down only once the old context is about to be cleared (a waiting or stuck handoff keeps the cache warm). Queued work,
   answers and watcher wakes wait until the handoff is done (work queued for after the handoff
   rides the fresh context's first message).
5. **Operations**: Project Sentinel starts a turn of its own (queued work, an answer, a watcher's
   wake) only at a boundary, one at a time, and never while a turn runs, a handoff is under way, a
   question is open or background work will bring the turn back. A watcher never clears a run that
   moved since it was armed. At a run budget limit set to Ask or Finish, none of this (nor
   Autopilot's continuation) starts without your yes.
6. **Machine load**: constrains *how* (parallelism, heavy jobs), never *whether*. It applies
   under Frontier Max too.
7. **Subagents**: hard limits that Frontier Max and the router cannot exceed.
8. **Frontier Max**: vetoes router downgrades of the main conversation (unless the router is Custom).
9. **Lazy-exit guard**: subordinate to everything above and to its own caps.
10. **Model router**: acts only where nothing above constrains it, and never downgrades the main
   conversation while a prompt cache of 20k tokens or more is warm.
11. **Focus view**: presentation only. It never changes what Claude reads.

Overview shows each system's *effective* state, for example "Lazy-exit guard ● On  Paused
during the handoff".

## Security and privacy

Project Sentinel runs entirely inside Claude Code. It makes **no network requests** of its own,
sends **no telemetry**, and nothing leaves your machine through it. It observes session figures
(context, cost, each request's token counts), tool calls as they happen, and machine-wide CPU and
memory totals (while the status bar shows them or a machine-load limit is on), and the plan's
rate-limit windows Claude Code reports. In the terminal it runs one read-only `git status` after a
turn and keeps only the branch and counts. When a milestone is completed it runs `git hash-object
--no-filters` on the files that milestone's work changed (no filters, so no command a repository
configures runs) and `git rev-parse HEAD`, and keeps only the blob ids, sizes and times. It writes only
its own plugin store, and once, after the rename, reads the store it kept as Control Room to
carry your settings over (it reads `CLAUDE_CONFIG_DIR`, `USERPROFILE` and `HOME` only to find it). Claude, not the plugin, writes the handoff file. Where Claude Code has
no task list of its own, Project Sentinel offers Claude one small tool, `milestones`, whose answer
only records the list for run progress; with the Decision Inbox on (the default) it offers
`decision_request`, whose answer only records the question for you. It never answers a permission
prompt for you.

The orchestration layer keeps what you give it with the run, in the same store: queued work in your
words, Claude's decision questions and your answers, watcher labels and times, the run budget, and
Claude Code's own cache-write price per model (for the Cold Resume Guard's figure). It submits
prompts only of fixed kinds, at a boundary: your queued words, your answers, a watcher's wake, the
first prompt of a fresh context it started. When you press them, *Stop* and *Message* on an agent
use Claude Code's own `TaskStop` and `SendMessage`, and the Cold Resume Guard's *Cancel* puts your
message back in the prompt box (Claude Code's `$.prompt.fill`); a message it could not put back is
kept in memory only, never stored.

Three features send requests to your configured model through Claude Code's own client, as every
turn does: the guard's optional smart check (the last request and answer); the Handoff Supervisor's
one question about a background task it cannot recognise (that task's command and description
only, never the conversation); and **Keep warm**,
which is off by default and, when you turn it on, re-sends the conversation's last request with a
one-word reply asked for, so the prompt cache stays warm. Each refresh costs tokens, mostly cache
reads at a tenth of the input price.

What it observes, what it can change and what it never does is listed in [SECURITY.md](SECURITY.md);
the plugin folder's [README](plugins/project-sentinel/README.md) says it in brief, as Anthropic's
directory shows it.

## Compatibility

| | Status |
| --- | --- |
| Claude Code 2.1.293, terminal CLI (Windows 11) | Verified live with real models (Sonnet 5.5, Opus 5.5): Autopilot end to end (four runs: threshold crossed mid-turn, the handoff turn, notes verified, `/clear`, the fresh session, the continuation, milestones and objective carried, one handoff where a low threshold used to loop); Keep warm on the 1-hour and the 5-minute cache, its self-check verified, its figures identical to Claude Code's own `prompt_cache`; a model switch confirmed first and its rebuild named as Claude Code names it; policy and effort changes while warm. The 1.3.0 status bar with Kit and every panel section in a real console at 80, 100 and 150 columns during a scripted turn from the demo driver. 1.4.0 (Haiku 5.5, a frozen test copy): a live Autopilot handoff whose fresh context received its notes as a context block and finished the task; Kit through a scripted demo turn and answering clicks in a real console; the cache at the plan's one-hour default from the first request. |
| Claude Code 2.1.295, CLI (Windows 11) | 1.5.0 verified live with Sonnet 5.5 through a recording proxy (fingerprints and token counts only): Keep warm on the 5-minute and the 1-hour cache, each refresh then VERIFIED by the conversation's own request, and a control without it rebuilding; Frontier Max with its effort in the first request of a session, turned on and off mid-session, after `/clear`, after a compaction and across a reload; the Autopilot chain with `/clear` and with compaction, a prompt queued mid-handoff, a reload mid-handoff and the guard standing down. A clean install into a throwaway configuration; the update from 1.4.1 and a fresh terminal session as a user (panel, status bar, Kit off and on, a head pat, the model switch asking first). |
| Claude Code 2.1.295, CLI (Windows 11): 1.6.0 and 1.6.1 | The orchestration layer verified live with Sonnet 5.5 through the recording proxy, on a renamed test copy. Mission Queue: `/cr queue` while idle went as a turn of its own; typed during a turn, Claude Code ran the command when the turn ended and the item went once, after it. Decision Inbox: Claude left a blocking decision with `decision_request`, `/cr decisions` listed it, `/cr decide D-1 Spaces` answered it and Claude acted on the answer. Watchers: one woke the run in its context at its minute; one stood down because a turn ran after it was armed (*nothing sent, nothing cleared*); one due while Claude Code was closed waited for the person when the session was resumed; a Fresh wake ran `/clear` and the fresh context, given the run's milestones and notes, finished the check. Cold Resume Guard, in a real console on a resumed 90k-token session whose cache had lapsed: Claude Code's dialog asked before anything was sent; *Cancel* put the message back in the prompt box and no request went; *Continue* sent it. |
| Claude Code 2.1.295, CLI (Windows 11): 1.6.2 | A live pass over each orchestration system with Sonnet 5.5 through the recording proxy, on a renamed test copy, fixing what it found (see the [changelog](CHANGELOG.md)). Cold Resume Guard on a resumed 185k-token session past its 5-minute cache: *Start fresh* sent one fresh request (2 messages) carrying the message once, and the fresh context continued the milestones with the queued work; *Compact first* compacted 185k to 2.9k tokens, then sent the message once. Agents: *Message* reached one background agent and not the other, *Stop* stopped one, and both survived a reload of the plugin. Run budget: *Notify*, *Ask* (queued work held until `/cr budget continue`) and *Finish* (Claude finished the milestone under way and stopped). Watchers: Keep warm held a 145k cache for 12 minutes and the wake read it all from the cache; with the refresh refused by the API, Smart woke fresh and Keep warm waited for the person. One integrated run with all of them, 5 of 5 milestones across a fresh wake. |
| Claude Code 2.1.295, headless `stream-json` (Windows 11): 1.6.3 | A handoff whose turn ended while a background render still ran, driven live with Sonnet 5.5 beside an event probe: 1.6.2 stayed in *writing the handoff* after the render's notification turn ended (reproduced); 1.6.3 waited for the render, took its result into the notes, then checked them, cleared and continued in session 2 by itself, one handoff prompt, one `/clear`, one continuation. `/cr handoff` and `/cr fresh` said what was true at each point. |
| Claude Code 2.1.296, CLI and headless `stream-json` (Windows 11): 1.7.0 | Driven live with Sonnet 5.5 on renamed test copies: a server and a 10-minute render behind a written handoff on a 5-minute cache (the server not waited for, Keep warm refreshing through the wait and verified by the render's turn, standing down only at the notes check); a build past its wait left running and its result recorded in the fresh context; "handoff now" typed while waiting; an unrecognised task sent once to the isolated classifier; a milestone's evidence going stale and re-verified; background agents, a workflow's agents and a reload mid-agent in a real terminal with the band and Activity › Agents; a fresh install's first run; five-hour readings from 46% to 59%. The Desktop app itself was checked through `tools/desktop-preview` only. |
| Claude Code 2.1.289 and 2.1.292 | Verified: the test suite run on their engines, type-checked against their declarations, live headless runs in the Desktop host protocol (1.2.0 and earlier) |
| Continuous integration | On every push and pull request: type-check, strict validation of the plugin and the marketplace, the source rules Anthropic's directory reads, and the tests, on Linux, Windows and macOS with the latest Claude Code, and on Linux with 2.1.289 |
| Claude Desktop Code tab, visual | 1.0.1 and 1.0.2 reviewed in the app (the screenshots above are 1.0.1); 1.2.0's status bar seen in the app (its white bar and overflow are what 1.3.0 fixes). 1.3.0 seen in the app (Claude Desktop 2.26454): the person's review of a release candidate, then the status bar's four cells, Kit and Overview captured read-only from the app's window. 1.4.0's release candidates installed in the person's app (Claude Desktop 2.26454, Claude Code 2.1.293) and captured read-only: the update from Control Room (a session open during it keeps Control Room while Project Sentinel stands by; a fresh session runs Project Sentinel alone, with the settings, runs and cache memory carried over and its run continued), Kit animating through a turn, and the five cells with the Machine cell at two widths. Kit's touch was not tried in the app (the app's window is never clicked). Every layout is also checked on the `desktop` surface in the harness and with [tools/desktop-preview](tools/desktop-preview/README.md), which renders with the app's own layout rules. 1.5.0's Kit was refused by the app's page (seen in the app: its image gave no width, which the page requires of a surface module); 1.5.1's Kit trees pass the page's own check, run from the app's bundle. 1.6.0's Operations, its chips and the sleeping status bar are checked on the `desktop` surface and in the preview; they have not been seen in the app yet (1.6.2's live pass could not look at the app either). |
| The `milestones` tool with a real model | Verified live: Sonnet 5.5 kept outcome-level milestones ("Temperature module", "Index re-exports and README") and carried them, with the objective, across handoffs. Answer styles are tested through the engine only. |
| macOS and Linux machine-load sampling | Implemented and unit-tested against real `top`, `sysctl` and `/proc` output. Not yet run live. |
| Mobile and VS Code surfaces | Draw (mobile opens choices in place, as in the terminal; VS Code shows Kit's pose still). Not reviewed visually. |
| Older Claude Code | Loads with a notice below 2.1.289. Features may not work. |

## Limitations

- **Advisory machine load.** Project Sentinel informs Claude and holds back additional heavy commands.
  It does not and cannot enforce an OS-level CPU or memory quota, and it never stops or changes
  other programs.
- **Pattern-based shell classification.** Permissions narrow what Claude may do. They are not a sandbox.
- **Run progress counts what Claude lists.** With no task list (or Behavior → *Run progress* off)
  there is no work meter. A check passed when its command did; a command sent to the background has
  no outcome Project Sentinel can see, and says so.
- **Model router, main conversation.** Claude Code rejects a bare alias such as `haiku` on a model
  request. So the main conversation is only routed to a model whose full id Claude Code has
  already reported answering in this session (for example, after an Explore subagent ran on
  Haiku). Subagents take aliases, which Claude Code resolves.
- **Headless runs.** With no one to answer, a call set to **Ask** is refused. In CI or `claude -p`,
  set categories you need to *Default*. A plugin command such as `claude -p "/cr status"` given as
  the *initial* prompt goes to the model, because plugin commands register as the session starts.
  Use an interactive session, stream-json input, or the panel.
- **Managed machines.** Where your organisation seats Claude Code's managed policy guard,
  Project Sentinel's system-prompt section can be skipped. It detects this and delivers its
  policies as prompt context instead.
- **No global sidebar and no pinned header.** There is no API to change the Desktop application's
  own sidebar, or to pin a region inside a pane. The docked panel is the supported equivalent, and
  `↑ Sections` brings the section bar back from the end of a page.
- **The prompt cache is read, not reported.** Claude Code reports how many tokens each request read
  from the cache and wrote to it, but no expiry, hit ratio or miss cause. Project Sentinel derives
  them: the expiry from the last request and the lifetime (as Claude Code is configured, by
  `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `promptCacheTtl` or
  `ENABLE_PROMPT_CACHING_1H`; as it reports it at a model switch; or learned; a claude.ai plan
  otherwise starts at its one-hour default), the cause from the change it
  saw before a rebuild, said as proven, likely or unknown. A rebuild with nothing seen before it reads
  *cause unknown*, never put on the server without evidence. Only the main conversation's cache is
  watched; subagents start their own.
- **Git in the terminal only.** Desktop shows Git beside the session, and no plugin API reaches that
  strip, so Project Sentinel does not repeat it there.
- **Watchers live in Claude Code's process.** A watcher is a timer in the running Claude Code: closed
  (or the machine asleep), nothing wakes. It is kept with the run, and when that session is open
  again an overdue watcher waits for you (*Watcher was due 43 minutes ago*, **Wake now**); it does
  not wake by itself then. Project Sentinel installs no daemon, service or scheduled task. Claude
  Code's own `CronCreate` and `ScheduleWakeup` are session-only too; its cloud routines start other
  sessions, not this one.
- **The Cold Resume Guard asks in Claude Code's dialog.** Where no one can be asked (a headless run),
  it does not ask and the message goes. It knows a cache has lapsed from the lifetime it learned, an
  hour of quiet (longer than any lifetime), or Claude Code's own word at a resumed session; a cache
  that may still be warm (Claude Code's own requests while you are away count) is never called
  cold. It leads with tokens; a dollar figure is only Claude Code's estimate for that model (seen at
  a model switch or a resume), said as a floor: the reprocessing has cost more than the estimate.
- **Background work across `/clear`.** Claude Code keeps a background task running across `/clear`
  and hands its result to the fresh context (verified live), so a handoff never waits on a server
  and waits on finite work only so long (20 minutes by default). It cannot know what an unrecognised
  task is: it waits for it, asks a small classifier once, and you can always hand off now.
- **Five-hour usage is Claude Code's last reading.** It moves when a response brings a new one (and
  is read again each minute while a window counts down). Usage from other sessions or devices shows
  only when a response of this one reports it.
- **Milestone evidence watches a milestone's own files.** The files its work changed and the outputs
  Claude named; a file its checks depend on but its work never touched is not watched (that would mean
  hashing the repository). A file changed by a command whose changes Claude Code does not report counts
  as changed outside Claude's tools.
- **Agents as Claude Code reports them.** No cost per agent (Claude Code reports none); *Stop* and
  *Message* only where Claude Code's `TaskStop` and `SendMessage` take the agent (background agents
  and teammates). Decisions from subagents are not taken: the inbox is the main conversation's.

## Development

```
plugins/project-sentinel/       the plugin, and only the plugin (Anthropic's directory reads every file in it)
  .claude-plugin/plugin.json   manifest; icon.png beside it
  README.md, LICENSE           the directory's listing and disclosure; MIT
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           the Host adapter and every hook registration (the only file that touches `$`)
  hooks/kit.client.tsx         Kit's surface module, drawn in the terminal and on Desktop
  hooks/app/                   Runtime (composition root), views and status wording, publisher, commands, persistence,
                               monitor, cacheGuardian (the prompt cache and Keep warm), formerStore (the rename)
  hooks/core/                  settings schema and defaults, profiles, policy, answer styles, formatting
  hooks/features/              autopilot, background (what a background task is), supervisor (the Handoff
                               Supervisor), intent (handoff-control words), chain, guard, router, subagents,
                               agents (the agent ledger), activity, plan (run progress), evidence (milestone
                               evidence), planUsage (the five-hour window), validation (checks), digest
                               (Activity's signal), quest (the Quest log), cache (the cache model), handoff
                               (Handoff Health, Continuity), companion (Kit), git, prompts, permissions/, resources/
  hooks/ui/                    design system (primitives, theme), status bar, Focus view rows, panel sections
  types/index.d.ts             the plugin's $.state contract
tests/                         claude plugin test suites (run on .build/mod: the plugin with tests/ beside hooks/)
tools/
  test/                        mod.mjs (assemble, type-check, test), source.mjs (the directory's source rules),
                               snapshot.mjs (a frozen cr-test copy for live tests)
  desktop-preview/             the status bar and the panel as Desktop lays them out, rendered as HTML
  console/                     Windows only: drive Claude Code in a real console, read the screen, save a PNG
  demo/                        development only: a scripted turn of real tool calls, no model, for screenshots
```

```bash
npm install
```

```bash
npm run check
```

`npm run check` runs `tsc`, `claude plugin validate --strict` (plugin and marketplace), the source
rules and the test suites; [CI](.github/workflows/check.yml) runs the same on Linux, Windows and
macOS. Claude Code writes the engine's type declarations into
`plugins/project-sentinel/.claude-plugin/types/` whenever a session loads the folder. Load it once
(`claude --plugin-dir plugins/project-sentinel`, then `/exit`) before running `tsc`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules the code follows and
[docs/DESIGN.md](docs/DESIGN.md) for the design system. On Windows,
[tools/console](tools/console/README.md) runs a session in a real console of a given width and
reads the screen back, for checking the terminal UI.

This repository is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, named
`control-room`). The plugin folder is laid out for Anthropic's plugin directory (its listing text,
licence and icon inside it); a submission is the maintainer's to make.

## License

[MIT](LICENSE)
