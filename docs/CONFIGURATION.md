# Configuration

Everything in Project Sentinel is configured from the Control Room panel (`/cr`) or with `/cr`
sub-commands. Settings
apply immediately, are saved within a couple of seconds, and are used by every later session.
Claude is told about material changes mid-session (Frontier Max, Release check, the subagent policy,
machine load). The updated policy reaches the system prompt from its next request.

## Where settings live

Claude Code gives every plugin its own store, a JSON file under `~/.claude/plugins/store/`.
Project Sentinel keeps `settings.v1` (settings and custom profiles), its run records and what it
learned about the prompt cache (`cache.v1`) there, in `project-sentinel_<source>-<id>.json`. The
store is validated on load: unknown values fall back to defaults, numbers are clamped to the
ranges below, and a permission saved as `allow` (a state removed in 1.4.0) reads as `default`.
Hand-editing is possible but not needed. `/cr reset confirm` restores the defaults (Normal) and
keeps custom profiles. A fresh install also keeps `onboarding.v1`: when the first-run card first
showed, and when you dismissed it.

**Fresh installs and updates** (1.7.0). The defaults in the tables below are a fresh install's, the
**Normal** profile. Settings are saved with a `defaults` marker, the generation of defaults they
were saved under (2 since 1.7.0; absent before it, read as 1). At the first load after an update:

| What the store holds | What happens |
| --- | --- |
| no `settings.v1`, and nothing else of Project Sentinel's (no run, run counter, cache memory or Quest log) | a fresh install: the 1.7.0 defaults are saved (Normal, so the panel never reads "Normal · edited"), the first-run card shows in Overview until *Got it*, and one toast says what is on |
| no `settings.v1`, but runs, a run counter, cache memory or a Quest log | an install used before that never changed a setting (settings are saved only when one changes): **Classic** is saved, so its behaviour is unchanged and no card shows |
| `settings.v1` without a `defaults` marker (saved before 1.7.0) | every value is kept, read against Classic so a group an older version never saved is not switched on by the new defaults; a profile named Normal is relabelled **Classic** (the values were Normal's before 1.7.0, so it does not read "edited" against the new Normal); then the marker is saved |
| `settings.v1` with the marker | read as it is |

Settings carried over from Control Room's store (below) win over a fresh install's defaults
written moments earlier at the same first load: that install is not new, so no card shows.

**Classic**, an install from before 1.7.0, differs from Normal in two places: Autopilot is off
(`autopilot.enabled`), and Frontier Max is off with its effort at Maximum (`frontier.enabled`,
`frontier.effort`). The permission defaults are the same in both, and were not changed (see
Permissions).

**Coming from Control Room.** Before 1.4.0 the plugin was called Control Room, and Claude Code
keeps a plugin's store under its name. When Project Sentinel first loads after the rename, before
it reads a setting, it reads the store it kept as Control Room (`control-room_<source>-<id>.json`;
where Claude Code kept more than one, the one written last) once and copies the settings, the runs,
the Quest log and the cache's memory into its own store, never over what its own store already
holds. The old file is left as it was. A session that was open during the update keeps Control
Room until it restarts: Project Sentinel stands by in it.

The settings are global to your user account, not per project. Run records note the project
they ran in.

## Reference

### Autopilot (`autopilot`)

In the panel: **Context**.

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | on / off | on (Classic: off) | `/cr autopilot on\|off` |
| `thresholdMode` | `percent` / `tokens` | `percent` | |
| `thresholdPercent` | 10–95 | 70 | Percent of the live context window |
| `thresholdTokens` | 10,000–10,000,000 | 700,000 | `/cr autopilot 700k` |
| `continuation` | `clear` / `compact` / `manual` | `clear` | `clear` is preferred. `manual` writes the handoff and waits for **Start fresh context** (`/cr fresh`). |
| `fallbackToCompact` | on / off | on | Compact only if `/clear` is refused |
| `autoContinue` | on / off | on | Submit the continuation prompt automatically in the fresh context |
| `handoffFile` | a relative path inside the project | `NEXT_SESSION_PROMPT.md` | Paths that would leave the project are rejected |
| `waitMinutes` | 0–240 | 20 | How long a written handoff waits for finite background work (tests, builds, renders, agents) before it goes on and leaves that work running for the fresh context (0: never waits). Servers and watchers are never waited for. Context → Autopilot → *Wait for background work*. `/cr handoff wait [30m]` gives a waiting handoff longer once. |

The effective threshold is capped at 97% of the window. It is also kept below Claude Code's own
auto-compact point (minus 5% of the window), so the handoff runs before Claude Code would
compact. The Context section says when this clamp applies.

### Frontier Max (`frontier`)

In the panel: **Behavior**.

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | on / off | on (Classic: off) | `/cr frontier on\|off`. Since 1.7.0 it no longer turns the lazy-exit guard on; the Frontier Max profile still sets both. |
| `effort` | `max` / `xhigh` / `high` / `keep` | `xhigh`, *Extra High* (Classic: `max`) | Sent only to models that take an effort setting. `keep` leaves the session's effort alone and applies only the policy. |
| `subagentEffort` | on / off | off | Also raise subagents' effort (costs more) |

Frontier Max adds Project Sentinel's strongest engineering policy (finish the work, verify it,
report what was and was not verified) to Claude's system prompt, and asks for the chosen effort on
each request where the model has an effort setting. It never changes the model. Behavior → *This
context* shows whether and how it reached Claude: in the system prompt, as a note while a warm cache
holds the earlier prompt, or with a prompt where the system prompt's hook is not reached.

### Release check (`qa`)

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | on / off | off | A verification-first policy: test before claiming, report what was and was not verified |

### Lazy-exit guard (`guard`)

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | on / off | off | |
| `strictness` | `lenient` / `standard` / `strict` | `standard` | How much evidence of a premature stop is needed |
| `maxPerTurn` | 1–5 | 2 | Continuations within one turn |
| `maxPerSession` | 1–50 | 12 | Continuations per session |
| `modelCheck` | on / off | on | *Smart check*: one small classification through Claude Code's client, only when the heuristics are unsure |

The guard only judges turns you started (and Autopilot continuations). It stands down during a
handoff, in plan mode, while background work Claude started is still running, and when Claude
repeats the answer it was just continued from.

### Model router (`router`)

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `strategy` | `off` / `balanced` / `performance` / `economy` / `custom` | `off` | |
| `mainLoop` | on / off | on | Route the main conversation per turn (see below) |
| `subagents` | on / off | on | Route subagents by type |
| `custom.*` | `session` / `haiku` / `sonnet` / `opus` / `fable` per class | see below | `trivial`, `simple`, `standard`, `hard`, `explore`, `plan`, `general` |

Built-in tables:

| Class | Balanced | Performance | Economy |
| --- | --- | --- | --- |
| trivial (acknowledgements) | haiku | sonnet | haiku |
| simple (lookups, short questions) | sonnet | session | haiku |
| standard (implementation) | session | session | sonnet |
| hard (design, debugging, analysis) | session | fable | session |
| Explore subagents | haiku | sonnet | haiku |
| Plan subagents | session | opus | sonnet |
| other subagents | sonnet | opus | haiku |

Rules:

- The main conversation is routed once per turn, never mid-turn. It is routed only while the
  context is small (60k tokens or less), except for upgrades on hard work. A smaller-window model
  is only chosen under 150k tokens.
- It is routed only to a model whose full id Claude Code has reported answering in this session.
  Claude Code rejects a bare alias on a model request.
- Frontier Max vetoes downgrades unless the strategy is Custom. Subagents never go below Sonnet
  under Frontier Max.
- A model that Claude Code refuses is not chosen again in that session.
- Forks inherit the parent's model, and a model Claude chose explicitly for a subagent is respected.

### Run progress (`progress`)

In the panel: **Behavior → Run progress**.

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `milestones` | on / off | on | Where Claude Code offers no task list of its own, give Claude a small `milestones` tool and ask it to record the run's steps, so Activity and the status bar can count them |

Run progress is counted from Claude's task list: TodoWrite or the Task tools where Claude Code
offers them, else Project Sentinel's `milestones` tool. Where a task list exists, nothing is added
and Behavior reads *Automatic*. Off, Claude is offered no tool and no progress is shown.
Switched on mid-session, the tool is offered at once. Switched off mid-session, the policy goes
and Claude is told; a tool already offered stays until the session ends, and answers that
tracking is off. Progress is milestones done of the total Claude listed, never an estimate, and
it carries across handoffs.

### Answer style (`answers`)

In the panel: **Behavior → Answer style**.

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `style` | `standard` / `brief` / `ste` / `mission` / `quest` | `standard` | How Claude writes its messages to you. `/cr style <name>` |

| Style | In the panel | What Claude is asked to do |
| --- | --- | --- |
| `standard` | Standard | Nothing: Claude Code's own way |
| `brief` | Brief | The bottom line first, then only what you need to act on it. Code, commands, paths and error text stay exact; failures and anything unverified are still said. |
| `ste` | Plain technical | Simplified Technical English, after the writing rules of ASD-STE100: one instruction per sentence of at most 20 words, descriptions of at most 25, active voice, simple tenses, one word for one meaning. It does not check the STE dictionary. |
| `mission` | Mission control | A status call first (GO, NO-GO or HOLD, with its reason), a short board of the areas touched, then `NEXT:` with the next action and its owner. GO only for what was verified. |
| `quest` | Quest log | Short log entries (the step, the obstacle, the outcome) and the next quest step. Project Sentinel keeps the XP, levels and achievements; Claude is told never to state them. |

A style governs Claude's messages only, never code, commands, file contents or commit messages.
`/cr style` also takes `default`, `short`, `plain` and `game`. The style is part of a profile; the
built-in profiles use Standard. Changed mid-session, Claude is told at its next request.

When you have chosen one of Claude Code's own output styles (`/config`), that style is in charge:
Project Sentinel adds no answer-style rules, and Behavior reads *Paused* until you set it back to
Default.

**Quest log XP.** Only outcomes Project Sentinel counts itself earn XP: a milestone Claude marked done
(50, once per run), a check's first pass in a turn (10), a check passing again after failing (30),
every milestone of a plan of three or more done (100), and an Autopilot handoff with verified notes
(40). Level *n* starts at 50·*n*·(*n*−1) XP: 0, 100, 300, 600, 1,000. Achievements: *First green*,
*Comeback*, *Full clear*, *Clean handoff*, *Relay* (one run across three contexts) and *Long haul*
(ten milestones in one run). XP and achievements are kept across sessions in the plugin store
(`quest.v1`) and are earned only while the Quest log style is chosen.

### Prompt cache (`cache`)

In the panel: **Context → Cache**. `/cr cache` shows it in words.

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `keepWarm` | on / off | off | *Keep warm while you are away*: refresh the cache shortly before it lapses by re-sending the last request (see below). `/cr cache keep on\|off` |
| `maxIdleMinutes` | 15–480 | 120 | *Stop after*: how long Keep warm holds the cache while you have not come back. The panel steps through 15, 30, 45 minutes, 1, 1.5, 2, 3 … 8 hours; `/cr cache idle 45m` or `idle 2h` takes any value in range. The five-minute cache stops at 45 minutes whatever is set: past that, refreshing it costs more than one rebuild. |
| `minTokens` | 5,000–1,000,000 | 20,000 | Keep warm leaves a smaller context alone (starting it cold costs little), and *Keep policies stable* holds only a cache at least this large. Not in the panel. |
| `guardModelSwitch` | on / off | on | *Ask before a model switch*: a switch you make (`/model`, the model picker) that would re-send 100k or more warm tokens is confirmed first, with Claude Code's own estimate of what it costs. `/cr cache guard on\|off` |
| `stablePolicies` | on / off | on | *Keep policies stable*: while the cache is warm, a setting you change reaches Claude as a note, and the system prompt keeps the policies it was cached with until the cache lapses or the context starts fresh. Off, every change rewrites the system prompt, which rebuilds the whole cache. `/cr cache stable on\|off` |
| `coldResume` | on / off | on | *Ask before a cold resume* (Context → **Cold Resume Guard**): before a message is sent into a context whose prompt cache has surely lapsed, Claude Code's question dialog asks first: *Continue full session*, *Start fresh from resume state* (only while Context → *Ready to resume* reads Ready), *Compact first* (compaction reads the context once, then it is smaller), or *Cancel* (the message comes back to the prompt box). Never for a prompt typed while Claude works, never where no one can be asked. |
| `coldResumeTokens` | 20,000–2,000,000 | 100,000 | *Warn above*: the context, in tokens, from which a cold resume is asked about. The panel steps through 20k, 50k, 100k, 150k, 200k, 300k, 400k, 500k, 750k, 1M, 1.5M and 2M. |

Claude Code reports how many tokens each request read from the cache and wrote to it. From those
Project Sentinel derives the rest: a request that read less than half of what the one before it sent
missed the cache, and the change it saw before it is the cause (a model or effort switch, the
model router's switch, changed policies, the output style, a new tool, compaction), else idling
past the cache's lifetime, else *unexplained*. The lifetime is the one Claude Code reports at a
model switch, or learned: a request that still read the cache after more than five idle minutes
proves the one-hour cache, and that is remembered across sessions. Where Claude Code is told which
lifetime to use, that is the lifetime (*as Claude Code is configured*), read in Claude Code's own
order: `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting,
`ENABLE_PROMPT_CACHING_1H`. Otherwise, until it is learned, a session on a claude.ai plan (Claude
Code reports the plan's rate-limit windows) starts at the one-hour cache, named as the plan's
default; a miss after five idle minutes corrects it to five. While a turn is
running (a long command, a long answer) the cache counts as warm unless a five-minute lifetime is
known: Claude Code's own requests keep it warm, so the panel never says it may have lapsed then.

**Keep warm** refreshes only while you are away (no turn running), the context is at least
`minTokens`, no handoff is about to clear the context, and the idle limit has not passed. It
refreshes a sixth of the lifetime before the expiry (ten minutes ahead for the one-hour cache, one
minute for the five-minute one); with the lifetime unknown, one refresh six minutes after the
last request learns it. A refresh asks Claude Code to re-send the last request with a one-word
reply asked for; the transcript never sees it, and it costs tokens (mostly cache reads at a tenth
of the input price, plus the short reply). It checks itself: the first request after an expiry it
replaced must still read the cache. If refreshes do not hold the cache, it says so and stops;
turning it on again lets it try afresh.

*Surely lapsed* means one of: the cache's lifetime is known and its expiry passed; more than an
hour passed since the last request (longer than any lifetime); or Claude Code said so when the
session was resumed (`prompt_cache_likely_expired`). A cache that may still be warm is never called
cold: a request Claude Code sends of its own while you are away (its away summary, its prompt
suggestion; the session's cost grows with no turn running) reads the conversation from the cache,
so the expiry counts from that too. The Cold Resume Guard leads with the tokens to reprocess, says
why the cache lapsed (idle past the lifetime, Keep warm off or paused, its idle limit, a handoff),
and gives a price only as Claude Code's estimate of re-caching for that model, as a floor (*at
least ~$0.46*: seen at a model switch or a resume, priced from your managed pricing or the list
price, at most 30 days old); otherwise it says tokens.

### Operations (`ops`)

In the panel: **Activity → Operations**. See [ORCHESTRATION.md](ORCHESTRATION.md) for how the
layer works.

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `decisions` | on / off | on | *Let Claude leave decisions here* (Needs review): Claude is offered the `decision_request` tool for a choice that is yours and need not stop the work. Off, Claude asks you directly. Turned off mid-session, the tool stays offered until the session ends and answers that the inbox is off. |
| `watchers` | on / off | on | *Watchers*: park the run until a time, then wake Claude. Off, nothing parks or wakes the run (`/cr watch` says so). |
| `scout` | `off` / `suggest` / `auto` | `suggest` | *Suggestions* (the Watcher Scout): after a turn in which Claude evidently waits for a future result (a milestone marked waiting, or a sentence of its own pairing a check with a time), `suggest` offers a watcher on the status bar's alert line; `auto` (*Arm explicit waits*) arms one when the time is explicit and unambiguous, and suggests the rest; `off` never does. No model is asked. |

What the person sets up in Operations is kept with the run, not in the settings: the Mission
Queue, the decisions and their answers, the watchers and the **run budget**. A run budget is set in
Operations → *Run budget* or with `/cr budget`, and is off until you set one:

| Limit | Values | Notes |
| --- | --- | --- |
| Cost | US dollars | The run's cost as Claude Code reports it, summed over its sessions (`+` where a session's was not reported) |
| Time | a duration (`6h`, `90m`) | Wall-clock time since the run began |
| Handoffs | 1–50 | Autopilot handoffs in the run |
| At a limit | *Notify only* / *Ask before continuing* (default) / *Finish the milestone, then pause* | Said once at 80% and once at the limit. *Ask*: Project Sentinel starts no turn by itself (queued work, a wake, an Autopilot continuation, the lazy-exit guard) without your yes, and asks once before your next message. *Finish*: as *Ask*, and Claude is told with its next tool results to finish the milestone it is on and stop there. Nothing stops a tool call or a turn under way. |

### Subagents (`subagents`)

In the panel: **Guardrails**.

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `mode` | `unrestricted` / `limit` / `ask` / `block` | `unrestricted` | *Allowed*: No limit, Up to a number, Ask each time, None. `block` (None) hides the agent types and refuses spawns. `ask` asks you each time (and refuses in headless runs). `limit` refuses a spawn while the limit is running, and Claude waits or does the work itself. |
| `limit` | 1–16 | 2 | For `limit`: the maximum running at once |
| `countTeammates` | on / off | on | Count agent-team teammates against the limit |

### Focus view (`focus`)

In the panel: **Activity**.

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | on / off | on | Presentation only |
| `tools` | `compact` / `hidden` | `compact` | One line per tool call, or hidden (the activity line still counts them) |
| `results` | on / off | off | Show tool results under the rows |
| `diffs` | on / off | off | Show inline file diffs for edits |
| `spinner` | on / off | on | Activity summary in the spinner: `Working · 27 tools · 6 files changed · tests running` |

A compact row expands in place (`▸`). Errors are always shown.

### Machine load (`resources`)

In the panel: **Guardrails**.

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `level` | `off` / `low` / `medium` / `high` / `custom` | `off` | |
| `cpu`, `ram` | 10–100 (%) | 70, 85 | Used by `custom` |
| `intervalSec` | 2–60 | 3 | Seconds between readings, for the status bar's live CPU and memory and for the ceilings |
| `enforcement` | `inform` / `limit` / `strict` | `limit` | *When over*. `inform` (Just tell Claude): notices only. `limit` (Hold extra heavy jobs): also hold back *additional* heavy jobs over a ceiling. `strict` (Hold all heavy jobs): hold back every new heavy job while over a ceiling. |

| Level | CPU ceiling | RAM ceiling | Heavy jobs at once (over a ceiling) |
| --- | --- | --- | --- |
| Low | 50% | 75% | 1 |
| Medium | 70% | 85% | 2 |
| High | 90% | 92% | 3 |
| Custom | yours | yours | 1–3, from the CPU ceiling |

Heavy jobs are recognised by command: test runners, builds, package installs, containers,
compilers, benchmarks and dev servers. Pressure levels are *ok*, *elevated* (near a ceiling),
*high* (over a ceiling for two samples in a row) and *critical* (10 points over, or RAM at 95% or
more). Claude is told when pressure starts and ends. The ceilings are machine-wide and advisory;
see [SECURITY.md](../SECURITY.md#what-it-observes) for how they are measured.

### Permissions (`permissions`)

In the panel: **Guardrails**.

Each category is `default` (shown as *Default*: Claude Code decides), `ask` or `deny`. Guardrails
says each one's value in words and whether it is the default ("Asks you first · default"); a changed
one is amber and names its default. 1.7.0 changed none of these defaults: making the categories
Default would remove two Deny and six Ask protections and hand those calls back to Claude Code's
own rules.

| Category | Examples | Default |
| --- | --- | --- |
| `install`: package installs | `npm install zod`, `pip install requests` | ask |
| `network`: internet and network access | `curl https://…`, `git pull` | Default |
| `download`: downloading files | `wget https://…/model.bin` | ask |
| `edit`: project edits | Edit `src/app.ts` | Default |
| `editOutside`: changes outside the project | Write `~/.bashrc` | ask |
| `delete`: deleting files | `rm -rf dist` | ask |
| `commit`: Git commits | `git commit -m "…"` | Default |
| `push`: Git push | `git push origin main` | ask |
| `gitDestructive`: force push and resets | `git push --force`, `git reset --hard` | deny |
| `deploy`: deploy and publish | `npm publish`, `terraform apply` | ask |
| `dangerous`: dangerous system commands | `rm -rf ~`, `curl … \| sh` | deny |

- **Deny** refuses before any dialog, in every permission mode, for Claude and its subagents.
- **Ask** always asks you first. Where Claude Code would ask anyway, its own permission prompt
  does. Where it would not (an allow rule, auto mode, Bypass permissions), Project Sentinel asks in
  Claude Code's question dialog (*Run it* / *Don't run it*) and passes the call on only after a yes,
  so your rules and other hooks still apply; the status bar reads *Waiting for you to approve* while
  it waits. A *Don't run it* refuses the call with a reason Claude can read.
- **Default** leaves the call to Claude Code and its rules.
- There is no **Allow** any more (1.4.0): answering prompts for you is Claude Code's job (its allow
  rules, its permission modes). A saved Allow reads as Default: a toast says so once, and Guardrails for that session. In
  Bypass permissions mode nothing changes; outside it, calls Allow used to answer are asked again
  unless your Claude Code allow rules cover them.

### Display (`ui`)

In the panel: **Setup**.

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `hud` | `band` / `status` / `both` / `off` | `band` | *Status bar*: above the prompt, in Claude Code's status line, both, or hidden |
| `toasts` | on / off | on | Brief notices on state changes |
| `liveLoad` | on / off | on | *Live CPU and memory*: machine-wide readings in the status bar and in Guardrails, sampled every `resources.intervalSec` seconds, even with no machine-load limit. Off stops the sampler unless a limit needs it. It is not sampled while the status bar is hidden. |
| `companion` | on / off | off | *Companion*: Kit, a small Claude-orange creature in a lane above the status bar, shows what Claude is doing, in the terminal and on Desktop (VS Code shows its pose, still). A click gets a reaction. `/cr companion on\|off` |
| `reducedMotion` | on / off | off | *Reduce motion*: still drawings instead of animation (Kit holds one pose for its mood, and the milestone under way on Desktop stops pulsing). `/cr motion off` turns it on. |
| `openOnStart` | on / off | off | Open the Control Room panel when a session starts. In the terminal it seats from 144 columns. |

### Nothing to set

Some 1.7.0 features have no setting, because they only report what Claude Code and the workspace
say:

- **Five-hour plan usage** on the status bar (`5H 63% · 2h14m`) is Claude Code's own reading of the
  plan's windows. With no five-hour window (an API key) the terminal shows nothing there and
  Desktop *Plan usage —*. The status bar as a whole follows `ui.hud`.
- **Milestone evidence** is kept for every completed milestone while `progress.milestones` (or
  Claude Code's own task list) gives Project Sentinel milestones to keep it for. It runs `git
  hash-object` and `git rev-parse` only for a completed milestone's own files (see
  [SECURITY.md](../SECURITY.md)). `/cr evidence` lists it; `/cr evidence accept` takes stale files as
  they are.
- **The agent band** shows while subagents run and is gone when none do.
- **The Handoff Supervisor** runs while a handoff is under way; its one setting is
  `autopilot.waitMinutes`.

## Profiles

A profile is a complete set of the systems above (everything except Display). The built-in
profiles are Normal (a fresh install's defaults), Classic (Normal before 1.7.0: Autopilot and
Frontier Max off), Frontier Max, Low Resource and Release / QA; the last three are built on Classic,
as they always were, and are described in the [README](../README.md#profiles). Custom profiles are saved from
Setup with a name. Saving a name again replaces that profile, and custom profiles can be
deleted there. `profile` records which profile was applied last. When the current settings differ from it, the
panel reads "Normal · edited" and Setup lists each change in the panel's own words
(`Effort  Maximum › High`), with *Back to Normal* and *Keep as a profile*.
