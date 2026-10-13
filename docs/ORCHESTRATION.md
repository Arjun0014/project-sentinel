# Orchestration (1.6.0)

> **Status: released in 1.6.1** (1.6.0 was pushed, not tagged); **1.6.2** drove each part live and
> fixed what that found. Built as described here, tested over the in-memory host and the engine
> (`tests/ops.test.ts`, `tests/operations.test.ts`, `tests/opsui.test.ts`) and live with a real
> model (the changelog's *Verified live* lists what was proven, and how). **1.7.0**
> moved the agents to a view of their own (Activity → Agents, and a band above the status bar while
> they run), and gave the Mission Queue a third way in: a message typed while a written handoff
> waits, which the person sends on to the fresh context.

How Project Sentinel orchestrates a long run over time: work queued for later, decisions Claude
leaves for the person, runs parked until a result is due, the cost of coming back to a cold cache,
the agents actually running, and an optional budget. This page is the design record of that layer:
what each part is, where it lives, what it may do by itself and what it never does. The UI decisions
are summarised in [DESIGN.md](DESIGN.md#operations), the mechanisms in
[ARCHITECTURE.md](ARCHITECTURE.md#10-the-orchestration-layer).

## One layer, not seven features

Everything here answers one question: **what happens next in this run, and who is it waiting
for?** So it is one layer with one home.

```
Activity › Operations
  View  Summary  [ Operations ]  Agents (2)  Tool calls

  Operations
    NEEDS REVIEW      what waits for the person: Claude's decisions, a watcher that needs a choice,
                      a message held back by the Cold Resume Guard
    MISSION QUEUE     work the person gave Claude for later (person → Claude)
    WATCHERS          the run parked until a time, then woken (and Claude Code's own wake-ups, read only)
    2 agents running  one line, leading to Activity › Agents
    RUN BUDGET        optional limits on the run's cost, time and handoffs

  Agents              (a view of its own while agents run or ran in the last ten minutes)
    RUNNING NOW       each agent under its parent, a workflow's agents under their run: what it is
                      doing, its calls, its model, its own plan when it keeps one, Stop and Message
    EARLIER           agents that ended lately: their result, or why they stopped

Context
  Autopilot · Cache (with the Cold Resume Guard) · Ready to resume · Last handoff · Run

Overview
  OPERATIONS          one card, only while something is in it: Review 2 · Queued 3 ·
                      Watcher 1 · wakes in 1h 42m · Agents 2 active · Budget $16 of $30
```

The status bar stays a HUD: it shows this layer only when it matters (`Review 2`, the run
sleeping until a watcher wakes it, a decision blocking the run), never as a row of counters. While
subagents run, a band above it gives each one a line (what it is doing, for how long), or past three
one line counting them by what they do; pressed, it opens Activity → Agents. With no agent running
the band is gone.

## What belongs to what

| Belongs to | Survives | Holds |
| --- | --- | --- |
| **The run** (its record in the plugin store) | `/clear`, Autopilot handoffs, a reload of the plugin, a resumed session, a watcher's sleep and wake | Mission Queue, Decision Inbox, Watchers, Run Budget, run progress |
| **The context** (module memory, reset at a fresh context) | a reload (through `$.state`, as 1.5.0 kept the policy section) | context use, the prompt cache, what this context was told |
| **The process** (Claude Code's own agent list, and Project Sentinel's agent ledger beside it) | the ledger survives a reload (through `$.state`); the list is read again | the agents running, and those that ended in the last ten minutes |

A run is the work of one `claude` process, or of a session resumed into it (1.0's rule). An
**ended run keeps its operations inert**: no timer of an ended run fires, and its queue, decisions and
watchers never leak into a new run. When a new session starts in the same project while an ended run
still has open operations, Operations says so once (*Run 41 left 1 watcher (due 43 minutes ago)
and 2 queued items*), and offers **Bring them here**; nothing moves without that press. Resuming the
session itself (Desktop: open it; terminal: `claude --continue`) continues that run, operations
included.

## Event boundaries

Nothing here acts on a timer inside a turn, and nothing is appended to the transcript while Claude
works (1.5.0's rule). Every delivery happens at one of these boundaries:

| Boundary | What it is | What may go out |
| --- | --- | --- |
| **Turn end** | Claude's turn ended cleanly (not aborted, nothing still running that brings it back: a server or a watcher Claude left running is not such work, 1.7.0) | a queued item, a decision's answer, a due watcher, as a prompt of its own |
| **Milestone done** | a milestone that was under way is marked completed, mid-turn | a queued item set *After the current milestone*, as a note with the next batch of tool results |
| **Fresh context** | the first message of a context after Project Sentinel's own `/clear` | items set *After the handoff*, inside that context's first message |
| **Prompt** | the person sends a message | answers to non-blocking decisions, as that prompt's context |

At most one of Project Sentinel's own prompts goes out per boundary, in this order: a watcher's
wake, then a blocking decision's answer, then queued items (oldest first, in the order the person
put them), then the rest. Each starts its turn; the next waits for that turn's end.

A prompt is marked delivered when Claude Code says it entered the session (`$.prompt.submit`
resolves without a drop). One that was on its way when the plugin reloaded is never sent again by
itself: it reads *Sent before a reload, check the transcript* with **Send again**.

## Mission Queue (person → Claude)

Two ways in, one store: **Add work for later** in Operations, which takes work at any moment and
adds nothing to the conversation, and `/cr queue <text>` from the prompt box. A slash command's
echo and output are part of the conversation (seen live: the next request carries
`<command-name>` and `<local-command-stdout>`), so `/cr` is not a mid-turn command: typed while
Claude works, Claude Code runs it when the turn ends, and the item never reaches the running turn.
`/cr queue` alone opens Operations with the field focused. When to deliver:

| Choice | Due when |
| --- | --- |
| Next safe boundary (default) | the current milestone completes or the turn ends, whichever comes first; with no milestone under way, the turn's end; at once when nothing runs |
| After this turn | the running turn ends (at once when nothing runs) |
| After the current milestone | the milestone under way when it was added is completed (if none is, as the next safe boundary) |
| After the handoff | the next fresh context Project Sentinel starts (Autopilot, a fresh wake, a fresh resume) |

There is no "at 14:00" for queued work: a time is a watcher. Items can be edited, reordered,
delivered now or deleted. A sleeping run keeps its queue; at the wake, due items follow the
watcher's check in order.

**A third way in: a message typed while a handoff is under way** (1.7.0). Once Autopilot's handoff
is written or being written, a message the person sends is not let into the old context unasked.
Claude Code's question dialog offers *Hand off now, then give it to the fresh context* (while the
handoff waits for background work; *Give it to the fresh context* while Claude writes the notes;
*Start fresh now, then …* while it waits for the person), *Send it here (this context)* and *Back to
the prompt box*. Given on, it waits in the Mission Queue *After the handoff* (at the next boundary
instead when the handoff compacts) and goes into the fresh context's first message; Operations shows
it meanwhile, and it can still be changed. While the fresh context is already starting (the notes
being checked, the clear) it is carried there without asking. A message with attachments cannot be
carried, so only *Send it here* and *Back to the prompt box* are offered for it. Short
handoff-control words ("handoff now", "keep waiting", "cancel the handoff") are acted on instead, and
never queued.

## Decision Inbox (Claude → person)

Claude is offered one tool, `decision_request` (with Behavior → *Decisions* on, the default),
for a decision that genuinely belongs to the person and need not interrupt the work now: a
question, why it matters, up to four options, whether free text is welcome, whether it blocks the
current milestone. Its description tells Claude what it is not for: status updates, choices Claude
can make itself, and anything Claude Code asks permission for. The answer it gets back: recorded as
`D-2`; carry on with other work (non-blocking), or finish what you can and end your turn (blocking).

The person answers in **Needs review** (a button per option, a field for free text) or with
`/cr decide D-2`, which asks in Claude Code's own question dialog. The answer is kept with the run,
linked to its question and milestone, and goes to Claude at the next boundary: with the next batch
of tool results while Claude works, as a prompt of its own when the run waits on it, else with the
person's next message (**Send now** sends it at once).

**Never deferred:** Claude Code's permission prompts, Project Sentinel's own *Ask* approvals, and
any confirmation Claude Code requires. The inbox has no part in them, and nothing in it answers or
bypasses them.

## Watchers (park the run until a time)

A watcher does not watch anything. It parks the run until a time, then wakes Claude to continue;
Claude knows what it was waiting for from the run's milestones, the handoff notes and the docs.
Each watcher has an id, its run, what it waits for in words, when it was made, when it wakes, its
strategy, its status, the milestone under way when it was armed, and a **checkpoint**: the run's
fingerprint when it parked (its turns, its milestones, its context).

**Making one:** **Add watcher** in Operations (what it waits for; wake *in 2h* or *at 14:00*;
strategy), or `/cr watch in 2h S-002 result`, `/cr watch at 14:00 Check the score`. Times are read
by a small strict grammar (minutes and hours from now; a 24-hour clock time; a 12-hour time with am
or pm; `tomorrow`): `at 2:30` with no am or pm is ambiguous, and Project Sentinel asks which one
rather than choose. Every watcher shows its local time and a countdown. `/cr watchers` lists them
and opens Operations at the watchers.

**Strategies:**

| | While the run sleeps | At the wake |
| --- | --- | --- |
| **Keep warm** | Keep warm holds this conversation's cache until the wake (the person chose to pay for it) | Claude continues in this context, told what it was waiting for |
| **Fresh** | nothing is spent | if the run is still parked at its checkpoint and the resume state is healthy: `/clear`, the run state and notes into the fresh context, and Claude continues there |
| **Smart** (default) | chooses one of the two, and says why | the same, decided again at the wake |

Smart compares what holding costs (refreshes of this context, at cache-read prices) with what a
fresh start costs (one fresh context), and keeps the conversation when that is cheap or the fresh
resume is not ready. It never holds a five-minute cache past 45 minutes, and it does nothing at all
when the cache outlives the wait. Its choice and reason show in the watcher's details: *Smart
chose Fresh · 6h wait · 742k context · resume state ready*.

**Safety: a watcher never clears an active run.** At its time, a watcher wakes only a run still
parked at its checkpoint. If anything moved since (the person or Claude ran a turn, the milestones
changed, the context was cleared), it reads **Watcher due · this run changed since it was armed**
with **Check now** (a prompt in this context, never a clear), **Reschedule** and **Dismiss**. A
watcher due while Claude works is marked due and waits for the turn's end. A fresh wake whose
resume state is not ready asks instead of clearing. If Keep warm failed while a warm watcher slept,
the wake does not blindly re-read hundreds of thousands of tokens: a healthy fresh resume is used
when the watcher is Smart or Fresh; otherwise it asks.

**Process lifetime:** a watcher is a timer in Claude Code's own process (`$.clock`). It runs only
while Claude Code runs: closed, nothing wakes. Every watcher is saved with its run, and the next time
that run's session is open (resumed), an overdue one reads *Watcher was due 43 minutes ago* with
**Wake now**; it does not wake by itself then, because the person is there. Project Sentinel
installs no daemon, service or scheduled task. (Claude Code's `CronCreate` and `ScheduleWakeup` are
session-only too; its cloud routines start other sessions, not this one.)

**Watcher Scout:** after a turn, when Claude evidently waits for a future result, Project Sentinel
may suggest a watcher (*Claude appears to be waiting for a future result. Check S-002 again in 2
hours?* **Create watcher** · **Change time** · **Ignore**). It reads only what is explicit: a
milestone marked waiting, and a time or duration said beside a check (*check the leaderboard again
in two hours*). Settings: Off, **Suggest** (default), or *Auto-arm explicit waits* (a waiting
milestone or a sentence with an explicit time; vague waits are still only suggested). No model is
asked.

**Sleeping:** while a watcher holds the run, the status bar reads *Sleeping until 14:00 · S-002
result*, with the watcher's countdown, and whether the cache is held warm or the wake is fresh.
Kit curls up (or tends the fire while the cache is held), and wakes with the run.

## Cold Resume Guard

Before a message is sent into a context whose prompt cache has surely lapsed, and whose earlier
context is large (100k tokens by default), Project Sentinel asks first, in Claude Code's own
question dialog, and nothing has been sent yet:

> **Cache cold** · 616k tokens need to be reprocessed: the prompt cache expired, and continuing
> sends this session's earlier context again before the cache is warm. Claude Code currently
> estimates at least ~$4.62. Why: its last answer was 3 hours ago, longer than the cache lasts.
> Compact first reads it all once more to summarise it, then the context is smaller. Continue?
>
> **Continue full session** · **Start fresh from resume state** · **Compact first (reads it once)** · **Cancel**

*Surely lapsed*: the cache's lifetime is known and its expiry passed, or more than an hour passed
(longer than any lifetime), or Claude Code says so when a session is resumed
(`prompt_cache_likely_expired`). A cache that may be warm is never called cold: Claude Code's own
requests while the conversation idles (its away summary reads it all from the cache) count as
keeping it warm. Tokens come first; the dollar figure is a floor (*at least ~*), and is shown only
from Claude Code's own estimate (`estimated_cache_write_usd`, which it computes from the
managed `modelPricing` or the list price) for this model, at a model switch or a resume; otherwise
the dialog gives tokens only. Nothing is priced by Project Sentinel itself.

*Start fresh* is offered only when the resume state is healthy (below). *Compact first* says what
it is: compaction itself reads the old conversation once, and makes the context smaller after; it
starts once the held prompt is dropped, and the message goes once the compaction's own result is in
(Claude Code does not run a plugin's own `session.compact` hook for its own compaction). After
either, the copy Claude Code puts back in the prompt box is cleared, so the message goes once.
*Cancel* sends nothing and puts the message back in the prompt box (or, where the box cannot take
it, keeps it in Needs review with **Put back** and **Send now**). The guard is off for prompts typed
while Claude works (its requests keep the cache warm) and where no one can be asked (a headless
run).

## Resume state and Resume Preview

A fresh start is healthy when all hold: the run has structured run state (milestones); the work
under way is known (a milestone in progress, waiting or blocked, or all of them done); the handoff
notes (`NEXT_SESSION_PROMPT.md`) exist and were written after the run's milestones last changed;
and the last handoff's continuity check, if any, did not fail on the notes or the run state since.

The Resume Preview says what a fresh context will get, wherever one is about to start (the Cold
Resume Guard, a fresh wake, Autopilot's *Start fresh*): the run and its objective, the milestones
done and under way, what Claude will read (the run state, the notes, the docs the last handoff
updated), the queued items and open decisions it carries, and the next action. An automatic wake
does not stop for it: it is logged, and the wake stops for the person only when the resume state is
not healthy or the run changed.

## Agents (Activity → Agents)

What Claude Code lets Project Sentinel observe, nothing else. An agent exists from its spawn
(`agent.spawn`: its type, description, model, whether it runs in the background or is a fork, its
parent, a workflow run's id and place): it shows at once, *starting*, before Claude Code lists it.
Claude Code's list (`$.agent.list()`: status pending, running, waiting, idle, completed, failed,
killed; its parent; its name; a teammate's address) then reconciles it, read every two seconds from
any spawn while an agent is alive. An agent the list leaves out for a moment keeps its last status,
and reads *no longer listed* only after three looks over six seconds; an end seen first outranks a
list a moment behind. Its own loop says what it is doing (its latest tool call), how many calls, when
it last did anything and its model; a task list or milestones it keeps in its own loop are its
**plan**, drawn as a Work-style track. Its end (`turn.complete`) gives the first line of its answer,
or why it stopped. A workflow's agents are never in Claude Code's list (seen live): they show from
their spawn and their loop's events, grouped under their run, and end with it.

Shown: the hierarchy (children under their parent, a workflow's agents under their run), name and
type, model, status, elapsed time, current activity and when it last acted, calls, its plan, result
or failure. Controls: **Stop** (Claude Code's `TaskStop`, which takes background agents and
teammates by id) and **Message** (Claude Code's own `SendMessage` delivery, `$.session.send`, for
agents that take messages), only where Claude Code accepts them; its refusal is shown as it words
it. No percent complete made up from time or calls, no cost per agent (Claude Code reports none), no
invented status. The view is in Activity's second row only while agents run or ran in the last ten
minutes; Operations keeps one line leading to it, as do the agents chip, `/cr agents` and
Guardrails. After a reload the ledger is kept (`$.state`) and the list read again; an agent first
seen in the list after a reload shows with its start not known. Guardrails says what Claude may
start; Agents shows what runs.

## Run Budget

Optional and off. Limits only what Project Sentinel can measure: the run's cost as Claude Code
reports it (summed across its sessions; subagents and Keep warm's refreshes count as far as Claude
Code's own cost includes them), its wall-clock time since it began, and its handoffs. At 80% it
says so once. At a limit:

| At limit | What happens |
| --- | --- |
| Notify only | a toast and a chip; nothing else changes |
| Ask before continuing (default) | Project Sentinel starts no turn by itself (a queued item, a wake, an Autopilot continuation, the lazy-exit guard) without the person's yes, and asks once before the person's next message |
| Finish the milestone, then pause | as Ask, and Claude is told with its next tool results to finish the milestone it is on and stop there |

Nothing stops Claude in the middle of a tool call, and a turn under way is never cancelled.
