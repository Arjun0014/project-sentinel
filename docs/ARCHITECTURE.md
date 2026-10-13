# Project Sentinel — Architecture & Implementation Plan

Status: implemented (see `CHANGELOG.md`). This document is the design record:
what the platform verifiably supports, how Project Sentinel (called Control
Room until 1.4.0; its panel still is) is built on it, and why each decision was
made. Written before implementation, kept current.

Target platform: Claude Code function-hooks plugins ("mods"), verified on
**2.1.289** (the minimum), **2.1.292**, **2.1.293** and **2.1.296** (the CLI on
this machine for the 1.7.0 hardening pass). The mods API is early access; the
generated declarations (`.claude-plugin/types/claude-code/index.d.ts`) are the
authority.

---

## 1. Verified capabilities (evidence, not assumptions)

Every mechanism below was exercised in throwaway headless stream-json
sessions (the same host protocol the Desktop app uses) on both engine
versions, with a prototype mod. Log excerpts are in the development notes.

| Need | Mechanism | Result |
| --- | --- | --- |
| Automatic `/clear` | `$.command.run({ command: 'clear' })` from a `$.clock.after` timer after `turn.complete` | ✅ Host protocol (Desktop): `session.end{reason:'clear'}` → new session id → `classic.SessionStart{source:'clear'}` → promise resolves; the stream emits `conversation_reset`. ⚠ Interactive terminal: the promise resolves *first* and the reset follows. Project Sentinel therefore waits for `classic.SessionStart{clear}` (up to 15 s, else a changed session id) before it continues. |
| Inject context into the fresh window | `prompt.context` answering `{ blocks: [...e.blocks, { name: 'contextAutopilot', text }] }` for the fresh context's first message, once; after its own `/clear` the plugin calls `$.ui.invalidate('prompt.context')` so the engine asks again | ✅ live on 2.1.293 (Haiku 5.5, a terminal session handing off at 62k): the fresh context's first message carried the block as a context section, with the run and session numbers, the notes' path, the objective and all five milestones, and the fresh context finished the task; and in the engine harness. (Until 1.3.0: `classic.SessionStart` answering `additionalContext`, verified live; Anthropic's directory cannot read that answer as leaving the session's start alone, so `classic.SessionStart` now passes `next(e)` on unchanged.) |
| Resume autonomously | `$.prompt.submit({ text })` after the clear resolves | ✅ turn starts by itself, framed as "The control-room plugin sent a message" (now "The project-sentinel plugin …") |
| `$.state` across `/clear` | — | ⚠ **reset** by `/clear` (version back to 0). Module memory survives `/clear`; `$.store` survives everything. |
| Mid-turn notes for Claude (no user prompt) | `classic.PostToolBatch` answering `additionalContext` with what waits (app/notes.ts); between turns, the next prompt's `prompt.submit` context | ✅ (1.5.0) filed with the batch of tool results, read on the next request, and every later request extends it (recording proxy). ⚠ Until 1.5.0: `$.session.append` mid-turn, read on the next request but kept in the transcript where it was appended, so the next turn's conversation differed and the cache was rebuilt from that point (301k and 451k tokens on a real 1-hour session; Claude Code's `thinking_drop`, `prefix_mismatch`). **Never append to the transcript while a turn runs.** |
| Continue a premature stop | `classic.Stop` answering `{ block }` | ✅ model continued in the same turn; 2nd Stop carries `stop_hook_active: true` |
| Subagent enforcement | `agent.spawn` answering `{ deny }` | ✅ model receives "Subagent spawn denied by a plugin: …" |
| Ask before a call | In `tool.call`, before `next`: `$.tool.check({ tool, input })` reads Claude Code's own verdict (it runs nothing); where Claude Code would not ask (allow, no verdict, auto mode), `$.ui.ask(question, { options: ['Run it', "Don't run it"], header: 'Approve' })` asks in Claude Code's question dialog; a decline answers `{ deny }` | ✅ in the engine harness; the dialog is Claude Code's own. There is no `tool.check` hook: the directory refuses one that reads what `next` answered, and answering a permission check is what the removed *Allow* did. (Until 1.3.0: `tool.check` answering `{ decision: 'ask' }`, which held in `bypassPermissions` mode.) |
| Per-request effort | `turn.step` → `next({ ...e, effort: 'max' })` | ✅ accepted (Sonnet 5.5 default `medium` → sent `max`); `e.effort` is absent for models without effort (Haiku) |
| Live context / cost | `session.measure` (pushed after every main turn) + `$.session.usage()` | ✅ `context.tokens/window/percent`, `cost.usd`, `rateLimits` |
| Host CPU/RAM | `$.process.spawn` of one long-lived sampler, by name with fixed arguments (no shell) | ✅ Windows `typeperf` (1.4.2): ~0.3 s CPU / 30 s, ~9 MB, plus `systeminfo` once (~2.6 s) for the total memory; read live on 2.1.293 against Windows' own figure (84% vs 85%). Until 1.4.1 a PowerShell P/Invoke script (~0.5 s / 30 s, ~80 MB), which the directory blocks: it reads a shell running an inline script as a program it cannot pin. One-shot probes cost ~2.4 s each (rejected). |
| Model per request | `turn.step` → `next({ ...e, model })` | ⚠ **full ids only**: a bare alias (`haiku`) fails the turn on 2.1.292 (`unrecognized_model` → `model_fallback` → an error answer). Ids reported in `usage.model` (main and subagent steps) work. Subagent spawns *do* resolve aliases. |
| Store scope | `$.store` | One store per plugin name and source (`~/.claude/plugins/store/<name>_<source>-<hash>.json`, the hash the first 12 hex digits of the SHA-256 of `<name>@<source>`; the source `inline` for a folder or a directory marketplace loaded in place); every `--plugin-dir` load of `project-sentinel` shares one. |
| A renamed plugin and its store | the marketplace's `renames` (`{ "control-room": "project-sentinel" }`); `$.fs.read` of the former store's file once | ✅ in an isolated configuration (2.1.293): `claude plugin marketplace update` rewrote `enabledPlugins` to the new name, the next session installed and loaded it, and the carry-over (`app/formerStore.ts`: at the first load, before a setting is read, the configuration folder from `CLAUDE_CONFIG_DIR`, `USERPROFILE` or `HOME`, else the session's transcript path at its start; of the candidate files, the one written last) copied the settings, the cache memory, the Quest log and a run, renumbering the new one. The old file is only read. |
| Two copies in one session | Claude Desktop hands a Code tab session its plugins once, when its process starts (the SDK's `plugins`, loaded as `<name>@inline` from the paths in `installed_plugins.json`); when that file changes it sends `reload_plugins` to every live session (idle ones at once, busy ones when their turn ends), which keeps those and adds what `enabledPlugins` names | ✅ seen live (1.4.0-rc.1, Claude 2.26454, Claude Code 2.1.293): after `claude plugin marketplace update control-room` the idle sessions ran Control Room 1.3.0 and Project Sentinel side by side, Project Sentinel on its defaults. Since rc.2 Project Sentinel reads Control Room's `hud` in `$.state` when it loads and, if Control Room published one, stands by: every hook passes its event on until the session restarts. |
| The cache's lifetime on a plan | `$.session.usage().rateLimits` naming `five_hour` or `seven_day` windows | Read as a claude.ai plan, whose default prompt-cache lifetime is one hour: used below anything learned or reported, never stored, corrected by a miss after five idle minutes. |
| Prompt cache figures | `turn.step` answer `usage` (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `model`) for each main-thread request | ✅ in the engine harness and live. ⚠ Claude Code keeps its own tracker (expiry, hit ratio, misses and their causes), but hands it only to the **status line** (`prompt_cache` in its input), never to a mod: `$.session.usage()` has context, rate limits and cost only. So Project Sentinel derives the same figures from the usage and names them as derived. Checked live against the status line's `prompt_cache` (1-hour cache, Sonnet 5.5): the derived expiry within a second of the engine's, the hit ratio identical (0.62185) once Keep warm's refreshes are left out of it, as the engine leaves them. |
| Cache lifetime and a confirmed model switch | `classic.PreModelSwitch` (`prompt_cache_warm`, `cache_ttl`, `context_tokens`, `estimated_cache_write_usd`) answering `permissionDecision: 'ask'` with a reason; `classic.PostModelSwitch` (`from_model`, `to_model`, `cache_ttl`, `source`) | ✅ live on 2.1.293 (143k warm, Sonnet → Opus): Claude Code asks "Switch model?" with the hook's reason and Yes / No; declining keeps the model and the cache. ⚠ The reason is drawn on one line and cut at the terminal's width, so it is kept short. After the switch, the lifetime as Claude Code reports it, and the rebuild named as Claude Code names it (model and effort changed, 143k re-cached). |
| Keep the cache warm | `$.model.fork({ prompt })` from a `$.clock.after` timer | ✅ live on 2.1.293 (Sonnet 5.5, 1-hour cache): a fork re-sends the main thread's last request plus one user message, never added to the transcript (0 rows), and returns the request's usage. The engine counts a fork that reads the cache as a *touch*, not a request: its own expiry moved 05:38 → 05:44 → 06:34 with each refresh (requests stayed 2). A real prompt 66 minutes after the last one, past the expiry the refreshes replaced, read the cache (0 misses), and Keep warm marked itself verified. Each refresh of an 87k context cost about $0.02. On a 5-minute cache too: the probe learned the lifetime (it found the cache gone, as a probe past five minutes must), refreshes every four minutes read the whole 141k, and a prompt after a replaced expiry hit. ⚠ Claude Code's own tracker touches the expiry only for a fork that *reads* the cache, so after a probe that rebuilt it the status line says cold while the cache is warm (the next refresh read all of it). `nothing-to-fork` before the first response. |
| A drawing with its own clock | a `Client` element naming a surface module, written `<ui.Client module="./kit.client.tsx" />` with `const ui = $.ui.resolve(e)` (the directory reads a `Client` taken out of the table as one with no fixed path); the module gets `surface.every`, `setState`, `onPointer`, `post`; `ui.message` carries its posts to the hooks module | ✅ terminal, live in a real console (Kit through a demo turn, clicks). Desktop runs the module in its own page (a frame with Claude Code's runtime): pointer events in cells of 1ch × 1lh, its local state kept across redraws under one key; a hand-made `{ type: 'Svg', props }` element is accepted in its tree (at most 2000 nodes, depth 32, scalar props; an `Svg` source up to 131072 characters). Chromium decodes a fresh data-URL image before its first paint (60 of 60), and Desktop replaces the region's DOM per render, so an image per frame does not flicker. No `ui.fault` hook: it is not on the directory's list of events; a module that cannot draw posts `{ fault }` instead. |
| Graphics on Desktop | `Svg` with `source`, `alt`, `width`, `height`; `isInteractive` draws it in a script-less sandboxed frame instead of an image | ⚠ A frame with no `width` takes the browser's default (300 px), and a frame whose color scheme differs from the page's is painted opaque: 1.2.0's animated work track showed as a white bar on Desktop. So Project Sentinel draws every graphic as an image and never asks for a frame: with an explicit size. Kit's lane asks for a width half as wide again as its region (at most 4096 px), so the image's `max-width: 100%` makes its box the region's width, and stretches its drawing to that box (a region is counted in cells of 1ch, whose size a module never learns). ⚠ A surface module's tree is checked by Desktop's page more strictly than a hooks module's: there an `Svg` needs both `width` and `height` (positive, at most 4096 px), and only `Box`, `Text`, `div`, `span`, `b`, `Svg`, `Button`, `Input` and `Select`, with scalar props, at most 2000 nodes, 32 deep, 262144 characters as JSON; a tree that fails it is not drawn at all ("returned a tree the page cannot draw"). 1.5.0's lane gave no width and was refused in the app; `tests/fixtures/desktop.ts` holds the page's check, and every Kit frame in the tests passes it. (SMIL animates inside a plain image too, but an image that animates itself restarts from its own beginning whenever it is replaced: 1.3.0's Kit teleported back at each mood change. Kit is now an image per frame from its surface module.) |
| How Desktop lays a tree out | the app's own renderer (Claude Desktop 2.26454, read from its bundle) | A `Box` is a flex `div`: `width`, `minWidth`, `columnGap` and horizontal margin and padding in `ch`; `height` and `minHeight` in `lh`; `rowGap` and vertical margin and padding in half lines (`--engine-row-unit`, `.5lh`); a bordered box gets the app's border, radius and padding. A `Text` is a `span` that wraps (`pre-wrap`) unless it truncates. A row box that sets no `alignItems` centers its texts, buttons, images and pickers on the row (so a mark beside two lines sits between them). `Select` is the app's combobox: a button `width: fit-content`, no width prop, so pickers are as wide as their value. An `Svg` without `isInteractive` is an `img` (`display: block`, `max-width: 100%`, its width and height in px). `tools/desktop-preview` renders with these rules. |
| A trace nobody sees | `$.ui.log(text, { to: 'debug' })` | ✅ lines appear in Claude Code's debug log (`--debug`, `--debug-file`) under the plugin's name, never on screen. Autopilot traces each step and turn there. |
| What a stopped turn leaves running | `classic.Stop` input `background_tasks` (id, type, description) and `session_crons` (schedule, recurring) | ✅ in the engine harness (2.1.293): the status bar says *Waiting for …* instead of *done* while a job or a wake-up will bring the turn back. |
| The project's Git state | `$.session.repo()` (the repository root, or null) and `$.process.run(['git', 'status', '--porcelain=v1', '--branch', ...], { timeoutMs: 10_000 })` | ✅ live in a real console: `master · clean`, then `master · 4 uncommitted` after a turn that changed four files. |
| The plan's usage windows | `$.session.usage().rateLimits` and `session.measure`'s `rateLimits`: `{ kind, percentUsed, resetsAt? }` per window (`five_hour`, `seven_day`, a gateway's `spend_limit`); `changed` names `'rateLimits'` when a window moves a whole point, appears or leaves; `classic.StopFailure` `error` (`rate_limit`, Claude Code's word for a request it ended on the limit) | ✅ live on 2.1.296 (a headless probe, and a real interactive terminal): `[]` before a headless session's first response (an interactive one had a reading at its start), then `five_hour` 47% resetting 04:20Z and `seven_day` 17%; `session.measure` fired with `'rateLimits'` in `changed` as the window moved; readings carry across `/clear`; empty off a subscription. ⚠ Pull-only between responses: nothing fires when a window's reset time passes, so the countdown is drawn from `resetsAt` on a one-minute tick while a window counts down. `StopFailure` `rate_limit` is declared since 2.1.289 and handled; no limit was reached live. |
| Background work across `/clear` | `classic.Stop` `background_tasks` (`id`, `type`, `status`, `description`, `command`); the end of each task as a `prompt.submit` with origin `task-notification` | ✅ live on 2.1.296: shells started before `/clear` are listed by the fresh context's Stop, and a task's `<task-notification>` arrives in the fresh context and starts a turn there; a background agent resumed there. A server started with no timeout ran about 25 minutes across `/clear`, with no notification (nothing bounds it); one started with a 45 s timeout was killed at 45 s and reported `killed`. A headless session's exit does not stop its background shells. |
| Agents as Claude Code lists them | `$.agent.list()` (`AgentInfo`: id, status, parent, name, type, teammate address); `agent.spawn` (type, description, model, background, fork, `parentAgentId`, `workflow`); the agent loop's `tool.call`, `turn.step` and `turn.complete` carrying its `agentId` | ✅ live on 2.1.296: a background agent and a foreground one are listed as soon as the spawn's `next` resolves; a child names its parent (the parent reads `waiting` meanwhile); ended agents stay listed `completed` for a while, then go. ⚠ A workflow's agents (`workflow-subagent`, `workflow: { runId, agentIndex }`; 2.1.289's declarations have no `workflow`, so it is read through a cast) are **never** listed: only their loop's events and their `turn.complete` show them, and the Workflow run itself is a background task of type `workflow`. |
| A small question of a separate model | `$.model.classify(text, labels)`: one isolated request that sees only `text`, answered with one of `labels` | ✅ live on 2.1.296: asked once, after a minute of waiting, about `python ingest_daemon.py` (a listener no rule recognises), with its command and Claude Code's description only (never the conversation); it answered `persistent_service` and the handoff went on. In the engine harness too; a failure or an unclear answer leaves the task waited for. |
| A milestone's file evidence | `$.fs.stat` per file; `$.process.run(['git', 'hash-object', '--no-filters', '--', ...paths])` (Git's blob id of each file, at most 50 a call, 10 s) and `['git', 'rev-parse', '--verify', '-q', 'HEAD']` (5 s) | ✅ in the engine harness (a modeled workspace and Git's answers). Only blob ids come back; Project Sentinel never reads a file's content. `git hash-object` hashes outside a repository too (checked by hand); HEAD is then left out. |

Platform constraints discovered and designed around:

* `claude plugin validate` statically tracks `$`: it must always be spelled
  `$.noun.method(...)` and may only be passed to a function declared at the
  top level of the same file. → one **Host adapter** (`hostOf($)`) in
  `register.tsx`; every feature module works against the `Host` interface.
  This is also the pattern of Anthropic's own `diff` mod, and it makes the
  core unit-testable.
* `$.state` refs need literal `plugin`/`key` at the call site → state atoms
  are top-level consts read with `read($, atom)` inside render hooks.
* Hooks have a 10 s *own-time* budget (`$` calls and `next` don't count).
  Long work runs from timers, never inside a dispatch.
* `session.start` does **not** fire after `/clear`; re-initialisation runs
  from `session.end{clear}` / `classic.SessionStart{clear}`.
* `$.ui.invalidate('ui.render')` redraws *every* instance a plugin's render
  matchers select (all transcript tool rows once Focus View hooks them). →
  rendering is driven by `$.state` subscriptions so only readers redraw.
* `prompt.compose` is continued past the user tier by Anthropic's
  `sec-default` guard on managed machines. → Frontier/Resource policies fall
  back to `prompt.submit` context automatically when the compose hook is not
  reached (detected, not guessed).
* A mod may turn an engine `ask` into `allow`, but **must never loosen a
  `deny`**; `sec-default` enforces this where seated and Project Sentinel
  enforces it everywhere as an invariant.

## 2. Product surface

| Surface element | Mechanism | Terminal | Desktop |
| --- | --- | --- | --- |
| **Status bar** (persistent) | `ui.render` `AbovePrompt` band, yields to surveys; or `$.ui.status`. Two lines: what Claude is doing with the plan's five-hour usage (`5H ▂▂▂▂▂▂ 63% · 2h14m`; the run's cost moved to Overview, Context and `/cr status`) and the panel button, then the three lifecycles (Context, Work, Cache) and the checks; graphics as glyphs, SVG on Desktop | ✅ | ✅ |
| **Agent band** (temporary) | the same band, above the status bar, only while subagents run: a line per agent (at most three, then counted by what they do), each opening Activity → Agents; gone when none run | ✅ | ✅ |
| **Alert line** (temporary) | the same band, above the status bar, while something needs the person: a handoff due, waiting for background work (Hand off now, Stop & hand off, Keep waiting once stalled or in the wait's last five minutes, Call off) or stuck (the supervisor's ways out), a watcher due, a held message, the budget | ✅ | ✅ |
| **Kit** (optional) | a row under the status bar: a `Client` surface module in the terminal, a self-animating SVG on Desktop | ✅ | ✅ (SVG) |
| **Launcher / sidebar** | `Pane` `control-room`: docked beside the transcript in the fullscreen TUI, inline otherwise; placed by Desktop | ✅ | ✅ |
| **Control Room panel** | the same pane: six sections drawn by the design system (`ui/primitives.tsx`) | ✅ | ✅ (native controls, SVG meters) |
| Activity line | `Spinner` `message` rewrite while a turn runs | ✅ | ✅ |
| Focus View | `ToolUse` / `ToolResult` / `ToolGroup` render hooks | ✅ | ✅ |
| Alerts | `$.ui.toast`, `$.ui.status` (only on state changes) | ✅ | ✅ |
| Commands | `/control-room [sub-command]` (`/cr` when free) | ✅ | ✅ |

No API exists to modify the Desktop application's global sidebar; the
docked Pane is the supported "sidebar-like" mechanism.

## 3. Module layout

```
plugins/project-sentinel/
  .claude-plugin/plugin.json      manifest (types → ./types/index.d.ts; icon and listing links for the directory)
  .claude-plugin/icon.png         the directory's icon: Kit, 1024 × 1024
  README.md, LICENSE              the directory's listing text and disclosure; MIT
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              Host adapter (hostOf) + every on(...) registration (thin)
  hooks/kit.client.tsx            Kit's surface module (terminal and Desktop): behaviour model, art, glue
  hooks/host.ts                   Host interface (the only door to the engine)
  hooks/constants.ts              ids, store keys, limits
  hooks/app/
    runtime.ts                    composition root: wires features, owns the live model, performs effects
    views.ts                      projections (HUD, pane, resources, chain, activity, permissions, focus, spinner)
                                  and the plain-language status every surface shares
    headline.ts                   the status bar's headline (what the run is doing or waiting for, in words,
                                  with its state) and its chips (what needs a look)
    publisher.ts                  coalesced, diffed writes of those projections to $.state (+ status line)
    commands.ts / actions.ts      /cr sub-commands; the panel's actions
    opsCommands.ts                /cr queue, watch, watchers, decisions, decide, budget, resume, agents
    operations.ts                 the orchestration layer at work (§10): boundaries, deliveries, timers,
                                  the Cold Resume Guard, the budget gate, agents' controls, its views
    persist.ts                    store reads/writes (settings, runs, index), debouncing, pruning; whether an
                                  install without saved settings was used before (`hasPriorUse`); the
                                  first-run card's record (`onboarding.v1`)
    notes.ts                      what Claude is told outside the system prompt, riding the next tool results
                                  or the next prompt (never appended to the transcript)
    ledger.ts                     the policy ledger: per request, whether and how the policies reached Claude
    monitor.ts                    resource sampler lifecycle (spawn, parse, restart, stop)
    cacheGuardian.ts              Cache Guardian: request telemetry, Keep warm's timer and fork, its
                                  self-check, stable policies, the countdown, the cache's views
    formerStore.ts                the one-time carry-over from the store kept as Control Room; standby beside it
  hooks/core/
    settings.ts                   schema, defaults (`defaultSystems`: a fresh install's; `classicSystems`: those
                                  before 1.7.0), the `defaults` generation, normalisation (clamps, a saved allow
                                  → default; a stored record read against Classic)
    profiles.ts                   built-in (Normal, Classic, Frontier Max, Low Resource, Release / QA) + custom
                                  profiles, labelled diffs
    policy.ts                     effective() snapshot (the priority system) + system-prompt sections
    answers.ts                    answer styles in the panel's words: labels, hints, sample lines, notes
    format.ts / text.ts / version.ts
  hooks/features/
    autopilot.ts                  threshold maths + pure state machine (events → model + effects)
    background.ts                 each background task's class (persistent, finite, agent, unknown) and why,
                                  from Claude Code's own words for it; the isolated classifier's labels
    supervisor.ts                 the Handoff Supervisor: a handoff's diagnosis (status, what holds it, the ways
                                  out), the step due at a wait's end, the tasks to ask the classifier about
    intent.ts                     handoff-control words in a short message ("handoff now", "keep waiting")
    planUsage.ts                  the plan's five-hour and seven-day windows from Claude Code's readings: reset,
                                  limit, absent; the status bar's and Context's view of them
    evidence.ts                   milestone evidence: the files and green checks a verified milestone stood on,
                                  the comparison with the workspace (current, changing, stale, re-baselined)
    chain.ts                      run + session records, totals (reported costs only)
    guard.ts                      premature-exit heuristics, thresholds, repeat detection
    router.ts                     task classes, tables, main/subagent routing, model families
    subagents.ts                  spawn decisions, live counts
    activity.ts                   tool-call tracker, changed files and hunks, refusals and reasons, summary line
    plan.ts                       the run plan from Claude's task tools (TodoWrite, TaskCreate/Update/List), progress
    validation.ts                 checks recognised by their runner (tests, build, type-check, lint, checks, simulation)
    digest.ts                     signal: change groups, Attention, the turn in counted lines, what Claude is doing now
    quest.ts                      Quest log: XP table, levels, achievements, validation of the stored quest
    cache.ts                      the prompt cache model: observeRequest, miss causes and kinds, the TTL
                                  learned, nextRefresh (Keep warm's schedule), the stored cache.v1
    handoff.ts                    Handoff Health and Continuity: healthOf, continuityOf, the stored record
    companion.ts                  Kit: its mood from the status bar's state, and the props for its module
    git.ts                        `git status --porcelain=v1 --branch` parsed into a line
    prompts.ts                    every text Project Sentinel gives Claude (answer-style policies included)
    ops.ts                        the orchestration layer's model (pure): queue, decisions, watchers and
                                  their checkpoints, Smart's choice, the budget, the stored record
    when.ts                       the watcher time grammar (`in 2h`, `at 14:00`, ambiguity), countdowns
    resume.ts                     resume health and the Resume Preview
    scout.ts                      the Watcher Scout (an explicit wait read from milestones or Claude's words)
    agents.ts                     the agent ledger: each agent from its spawn, reconciled with Claude Code's list,
                                  fed by its loop's calls, steps, plan and end; rows, the hierarchy, the band
    permissions/                  shell tokenizer, category classifier, decisions + invariants
    resources/                    samplers + parsers (Windows/macOS/Linux), pressure, heavy commands
  hooks/ui/                       design system (primitives.tsx, theme.ts, kit.ts: the view kit, not
                                  the companion; `subNav`, the second level of navigation), status bar
                                  (hud.tsx: the agent band, the alert line, the five-hour segment), Focus view
                                  rows, pane/ (frame + overview with the first-run card, context with cache,
                                  Cold Resume Guard and handoff with Ready to resume, behavior, guardrails,
                                  activity with its views: summary, operations, agents (agents.tsx), tool
                                  calls; setup)
  types/index.d.ts                settings schema + PluginState contract (render view models)

tests/                            claude plugin test suites + fixtures (fake host, engine world),
                                  outside the plugin folder; tools/test/mod.mjs runs them on .build/mod
```

Data flow: engine event → `register.tsx` hook → `Runtime` method (pure
decisions in feature modules, effects through `Host`) → model mutation →
**publisher** projects view models into `$.state` atoms → subscribed render
sites redraw. No feature module touches `$`.

## 4. State model

| Layer | Holder | Survives | Contents |
| --- | --- | --- | --- |
| Settings | `$.store` `settings.v1` (normalised on load) + module memory | everything | active profile, per-system settings, custom profiles; `defaults`, the generation of defaults the record was saved under (absent before 1.7.0, read as 1; 2 now), which keeps an upgrade from reading an older record against the new defaults |
| First run | `$.store` `onboarding.v1` | everything | written only on a fresh install: when the first-run card first showed, and when the person dismissed it (*Got it*) |
| Run / chain | `$.store` `run.v1.<id>` + `runs.index.v1` + `runs.counter.v1` | `/clear`, reload, restart | run id, sessions (ids, times, peak context, cost, turns, model, end reason, transitions); 30 runs × 60 sessions kept |
| Run plan and objective | inside the run record (`plan`, `objective`) | `/clear`, reload, restart | Claude's milestones as its task tools left them; the objective as Claude stated it, else the person's latest substantial request |
| Milestone evidence | inside the run record (`evidence`, validated by `evidenceOf` whenever the run is read from the store) | `/clear`, reload, restart | `work`: per milestone under way, when it began and the files its work changed (at most 12) and the outputs Claude named (at most 10); `snapshots` (at most 30): per completed milestone, when and in which session it was verified, its green checks (kind, label, command, when; at most 6), its files (path, Git blob id, size, modification time, whether it is documentation), HEAD, later changes seen (at most 24), the last comparison's status and changes, what re-baselined it. Never file contents. |
| Quest log | `$.store` `quest.v1`, and the run record's `quest` | everything | lifetime XP, achievements with when each was earned, the last 8 awards; per run, its XP and the milestones already paid for |
| Prompt cache memory | `$.store` `cache.v1` | everything | the cache lifetime learned (`5m` or `1h`) and how; Keep warm's verdict on itself and when; the short model names on which an effort change was seen to rebuild the cache (at most 12) |
| Run operations | the run record's `ops` (1.6.0) | `/clear`, handoffs, reload, restart, a resumed session | the Mission Queue, the Decision Inbox, watchers with their checkpoints, the run budget, the layer's log (§10) |
| Cache memo | `$.state` `cacheMemo` | hot reload only | the cache's last request (when, its size, model, lifetime), so a reload keeps knowing when it lapses |
| Last handoff | the run record's `lastHandoff` | `/clear`, reload, restart | when, from and to which session, how (clear, compact, manual), Handoff Health's checks (with *Verification current* and the work left running), the milestone under way then, the plan's count, the tasks left running (each one's end, once its notification reached the fresh context), and Continuity's checks once the fresh context's first turn ended |
| Handoff in flight | `$.state` `autopilot` (`{ record }`) | hot reload only (gone after restart or `/clear`) | the Autopilot step under way, when it began (`stateSince`), retries, a snooze; the background tasks waited for with their class, the wait's bounds (`waitSince`, `waitUntil`), `skipWait`, the work left running: what a reload needs to carry the handoff on instead of starting a second one |
| Agent ledger | `$.state` `agents` | hot reload only | each agent seen this session: its spawn's facts, status, parent, workflow run, calls, latest activity, plan, end |
| Live session | module memory (`Runtime`) | `/clear` (module stays loaded) | context, cost, the plan's usage windows (re-read from `$.session.usage()` at load), autopilot machine and the supervisor's last diagnosis, guard counters, activity, changes, resources, agents, learned model ids; this context's cache state (requests, misses, Keep warm's refreshes; reset at a fresh context); the Git state |
| View models | `$.state` atoms `hud`, `pane`, `resources`, `chain`, `activity`, `permissions`, `focus`, `spinner`, `ops` | hot reload (re-published after `/clear`) | render-ready projections only |

On hot reload `session.start` fires again: settings and run are re-read from
`$.store`, live figures from `$.session.usage()`; nothing important lives
only in a render projection. Settings writes are whole-object, debounced;
run writes are per-run keys (no cross-session clobbering of the index's
contents beyond the id list). A run written at once (`persistRun(true)`: every change of its
operations) drops a debounced write still waiting with an older copy of it, which would otherwise
put that copy back (found in 1.6.0's tests: a watcher armed just after a turn was lost to the turn's
later write).

## 5. Explicit priority system

Conflicts are resolved by one `effective()` snapshot (`core/policy.ts`),
computed from settings + live state, in this order (higher wins):

1. **Organisation & engine safety** — managed settings, deny rules, plan
   mode. Never loosened (hard invariant in code).
2. **Permission Policy** — deny > ask > allow; applies to every action,
   including work the autopilot or guard asked for.
3. **The person's live actions** — Esc/abort cancels pending automation; a
   prompt typed while a handoff is due is honoured (with a handoff reminder);
   a handoff-control message ("handoff now", "keep waiting", "cancel the
   handoff") is acted on at any step; any other message once the handoff is
   written or being written is the person's to place (the fresh context, here,
   or back to the box), never sent into the old context unasked.
4. **Context Autopilot** — once pending, the guard is suspended for the
   boundary and the handoff turn; no new large work is encouraged.
5. **Resource Governor** — constrains *how* (parallelism, heavy jobs), never
   *whether*; applies under Frontier Max too.
6. **Subagent Control** — hard spawn limits; Frontier/Router cannot exceed.
7. **Frontier Max** — behaviour + max effort; vetoes Router economy
   downgrades of the main loop (unless the person customises the router).
8. **No-Lazy-Exit Guard** — subordinate to 3–6 and to its own loop limits.
9. **Model Router** — acts only where nothing above constrains.
10. **Focus View** — presentation only; never changes what Claude reads.

Overview shows each system's *effective* state with the reason when it
differs from its setting (e.g. "Lazy-exit guard ● On  Paused during the handoff").
The UI's design decisions are recorded in [DESIGN.md](DESIGN.md).

## 6. Context Autopilot state machine

```
off ─enable→ armed ─(context ≥ threshold: mid-turn from turn.step usage, or after the turn)→
pending ─(main turn completes, not aborted)→ requested ─($.prompt.submit handoff prompt)→
handoff ─(handoff turn completes, its Stop lists nothing in flight)→ verifying ─(NEXT_SESSION_PROMPT.md freshly written)→
clearing ─($.command.run clear; classic.SessionStart{clear}, before or after it resolves; prompt.context seeds the fresh context)→
resuming ─(continuation prompt submitted, turn starts)→ armed (new session, same run)

handoff ─(handoff turn completes, its Stop lists blocking work in flight)→ waiting-background
handoff ─(… only servers/watchers in flight, or the person said not to wait, or waitMinutes = 0)→ verifying (left running)
waiting-background ─(a task's notification: prompt.submit origin task-notification)→ waiting-background (that task struck off)
waiting-background ─(any turn completes, its Stop lists no blocking work)→ verifying (servers left running)
waiting-background ─(any turn completes with blocking work still in flight)→ waiting-background (Claude Code's list replaces it)
waiting-background ─(the turn that took the result in was interrupted)→ awaiting
waiting-background ─(supervisor: past waitUntil; under a turn: skipWait, then that turn's end)→ verifying (work left running)
waiting-background ─(supervisor: nothing blocking left, session quiet 30 s)→ verifying (unblocked)
waiting-background ─(the person: Hand off now / "handoff now" / /cr handoff now)→ verifying (work left running)
pending / requested / handoff / waiting-background / awaiting ─(the person: Call off)→ armed (snoozed)

clearing ✗ (refused, or no fresh session in 15 s) → compacting (if allowed) → resuming
                                               → else awaiting [Start fresh context · /cr fresh]
verifying ✗ (file not written)        → one corrective prompt, then awaiting (no clear)
continuation = manual                 → awaiting after a verified handoff
aborted by the person                 → stays pending (no auto action) + HUD actions
handoff / waiting-background / awaiting, nothing moving it → /cr fresh: checked, then clearing (or why not)
```

The reducer (`features/autopilot.ts`) is pure: `step(model, event, cfg)`
returns the next model and a list of effects (append a notice, submit a
prompt, verify the file, clear, compact, notify), which the Runtime performs.

**Driven by events, never by timers.** Each step moves on when the turn it
is about starts or ends, never when a prompt was sent or a delay passed. A
turn is recognised as one of Project Sentinel's own (handoff, retry,
continuation) by the text it starts with (`prompts.ownPromptKind`), so a
prompt the person queued in between is never taken for it, and a reload
cannot confuse the two. Claude Code starts a plugin's prompt framed ("The
control-room plugin sent a message:" and a line break); the match looks
past that frame and accepts the prompt at the start of any of the first
three lines. (A live run found this: matching only at the very start left
the handoff waiting forever after its turn ended. Engine-driven tests now
start those turns with the framed text.) The `/clear` waits while any turn
runs, so a prompt the person queued behind the handoff finishes first. Every
step and every turn's start and end is written to Claude Code's debug log
(`$.ui.log` with `to: 'debug'`; `claude --debug-file <path>`), never on
screen.

**A handoff turn that stops under background work** (1.6.3). The notes are
not checked, and nothing is cleared, while work the handoff turn left running
(a render, a test run) may still change what they should say. The machine
waits in `waiting-background` with the tasks Claude Code listed in flight at
the handoff turn's Stop (`classic.Stop` `background_tasks`). Claude Code
reports each task's end itself: a notification it submits as a prompt with
the origin `task-notification` (`prompt.submit`; seen live on 2.1.295), with
no `turnId` when the session is idle, so the notification starts a turn of
its own whose text is the engine's `<task-notification>` report, or with the
running turn's `turnId` when it is delivered into one. That task is struck off
the list (`backgroundEnded`), and the notification carries a note asking
Claude to record the result in the notes and end its turn. The wait ends at
the first turn's end, whoever's turn it was, at which Claude Code's Stop lists
nothing in flight: then the notes are checked and the context cleared. A
person's turn that ends with the work still running never ends it, and new
work started meanwhile is waited for too. The turn a notification begins is
recognised by that origin (`notification`), never by its text: 1.6.2 counted
it as the person's (its text is not empty) and waited forever for "the handoff
turn" to end again (seen in an 801k-token run, and reproduced live). The
status bar says *Handoff written · waiting for background work* with the task
and that it runs; Context lists each task with **Stop**.

**Not every background task blocks** (1.7.0). Each task a Stop lists is
classified (`features/background.ts`, kept on the task as `class`/`why`/`by`):
`persistent` (dev, preview and API servers, watchers, tunnels, log followers,
Monitors) is never waited for; `finite` (tests, builds, renders, installs,
transfers, sleeps), `agent` and `unknown` are. An `unknown` task waited for a
minute is asked about once by an isolated classifier (`$.model.classify`: its
command and description only). The wait is bounded: `waitUntil` = the turn's
end + `autopilot.waitMinutes` (default 20). Work still running when the
handoff goes on is `leftRunning`: Claude Code keeps background work across
`/clear` and delivers its notification to the fresh context (seen live on
2.1.296: a server started with no timeout ran 25 minutes across `/clear` with
no notification at all), so the fresh context's block says what still runs
(servers: reuse them; results: they arrive here), and the run's
`lastHandoff.leftRunning` records each task's end when its notification comes.

**The Handoff Supervisor** (`features/supervisor.ts`, `Runtime.supervise`).
Every 30 s while the machine is anywhere but off or armed, and at once on each
state change, the Runtime diagnoses the handoff from its facts (the state and
how long it has stood, `stateSince`; the tasks and their classes; the wait's
end; a question open to the person; the notes; whether a turn runs; how long
the session has been quiet): status `moving`, `waiting`, `stalled` or
`needs-you`, what holds it, and the ways out. No model call, nothing added to
the transcript; each change goes to the debug log (`supervisor: …`), Context
and a line above the status bar. It moves a step itself only at a wait's end
(`waitExpired`; under a running turn it sets `skipWait` and that turn's end
moves it) and when a wait holds nothing blocking in a quiet session
(`unblocked`): never as proof that a turn ended.

**The person's way out** (`Runtime.handoffGuard`, before the Cold Resume Guard
in `prompt.submit`). While a handoff is under way, a short handoff-control
message (`features/intent.ts`: "handoff now", "don't wait for the background
process", "start the fresh session now", "keep waiting", "stop the server and
hand off", "cancel the handoff") is acted on and dropped, never sent into the
old context. Any other message is not let in unasked: while a written handoff
waits, or Claude writes the notes, Claude Code's question dialog offers hand
off and give it to the fresh context (it waits in the Mission Queue, target
`fresh`), send it here, or back to the prompt box; while the fresh context is
already starting it is carried there. Commands and buttons do the same
(`/cr handoff now|wait|stop|cancel`, `/cr fresh now`).

**Finishing a handoff by hand.** `/cr handoff` and `/cr fresh` (and their
buttons) decide from the facts (`handoffVerdict`, `freshVerdict`): whether a
turn runs, the background work Claude Code last listed in flight, and the
notes on disk against this handoff. Each answers what really happened: a
handoff begun, a fresh context started, or why not (already writing, waiting
for named work, checking, starting fresh). `/cr fresh` recovers a handoff
no event will move on (`handoff` after its turn ended unseen, `waiting-background`
with nothing left in flight, `awaiting`) through the same verified clear
path, never blindly: work in flight, or notes not written since the handoff
began, keep the context, and the words say which.

**A reload mid-handoff.** A hot reload or `/reload-plugins` starts a fresh
Runtime, whose module memory is empty. Every step of the machine is
therefore mirrored into `$.state` (`recordOf`), which outlives a reload but
not a restart or `/clear`, so a record can only ever apply to the context it
was written in. At session start a fresh Runtime replays it (`recover`):
`pending`, `handoff` and `awaiting` resume as they were and the turn under
way moves them on; `waiting-background` resumes with the tasks it waits for
(the record carries them) and looks at the notes again; an owed check or `/clear` is carried out; a step that may
or may not have happened (`requested`: the handoff prompt about to go out;
`compacting`) waits for the person instead of being repeated. The context
crossing the threshold again never starts a second handoff.

* Threshold: exact tokens or % of the live window; clamped below Claude
  Code's own auto-compact threshold (warned in the UI).
* **Room for a fresh context** (`handoffPoint`, `roomOf`). A context after
  a handoff or a clear is *orienting* until it starts working: Project Sentinel
  sees it record its milestones or task list, edit a file or start an agent,
  or end a turn (`oriented`, with the context's size then). While orienting
  it hands off only past the threshold plus a room of 20k tokens or a tenth
  of the threshold; from where it started working it gets at least that
  room, with one notice when that moves the point. A context that fills past
  the point before any work began goes to `awaiting` instead of handing off
  again: a low threshold can never loop. Live, with a 64k threshold, a fresh
  context's first request was 44k and reading in took another 20k; without
  this, five contexts in a row did one roadmap step each.
* The pending notice goes with the next batch of tool results (`classic.PostToolBatch`,
  app/notes.ts; finish the current logical unit; do not begin another large task).
* The handoff prompt asks Claude to verify state, run minimum validation and
  leave the work in four places, each for what it is for: the run's
  milestones (the canonical run state, which Project Sentinel hands to the fresh
  context), the project's own documentation, CLAUDE.md (durable
  instructions only, never a progress log) and `NEXT_SESSION_PROMPT.md`
  (the prompt Claude would want to receive) — **without prescribing its
  contents**.
* **Handoff Health** is read when the notes are verified, from what Control
  Room counted in the handoff turn: run state saved, the milestone under way
  captured, notes written, docs updated, validation recorded, CLAUDE.md.
  **Continuity** is read when the fresh context's first turn ends: notes
  read, run state restored, the milestone picked up, docs read, work
  resumed; a toast says how it went. Both are pure (`features/handoff.ts`),
  counted from tool calls only, kept in the run record (`lastHandoff`) and
  shown in Context → *Last handoff*.
* Keep warm stands down only once the old context is about to be discarded
  (`keepWarmStandDown`): the notes check before a clear, the clear itself,
  the fresh context resuming. A handoff that is due, under way, waiting for
  background work or for the person, or a context past the threshold keeps
  the cache warm: each of those still reads the old context again (1.6.3 stood
  down for them, and a stuck handoff let a 775k cache lapse). A handoff that
  compacts keeps it throughout.
* After `/clear`: `classic.SessionStart{clear}` marks the fresh context
  (and is passed on unchanged); the plugin invalidates `prompt.context`, and
  the fresh context's first message carries one block, `contextAutopilot`,
  once: the run and session numbers, where the handoff file is, and the run
  plan's milestones and objective, so the fresh context rebuilds its task
  list and work progress carries on (the policies are in the system prompt);
  the continuation prompt asks Claude to read project docs +
  `NEXT_SESSION_PROMPT.md` and continue; ask the person only for decisions
  the handoff marks as theirs.
* `/compact` is used only when `/clear` fails (and the fallback is allowed).

## 7. Feature mechanisms (summary)

* **Session Chain** — run record updated on `session.measure`, transitions
  and exit; per-session cost from `$.session.usage().cost` (resets per
  session), cumulative = Σ. Unavailable figures render as "—", never guessed.
* **Run progress** — the run plan (`features/plan.ts`) is read from Claude's
  own task list as its tools report it: TodoWrite's whole list, or
  TaskCreate / TaskUpdate / TaskList, read at `tool.call` as each call
  succeeds (a subagent's list is its own). Claude Code
  2.1.29x offers neither by default, so at session start, when
  `$.tool.list()` shows no task tool and `progress.milestones` is on,
  Project Sentinel registers `milestones` (`$.tool.register`, offered as
  `mcp__project-sentinel__milestones`) and adds a short "Run progress" policy
  section; a `tool.call` hook registered before the general one answers it
  (`fromMilestones`, the whole list each time). The plan and the objective
  (the first sentence of the person's latest substantial request) live in
  the run record, so they survive `/clear`, reloads and restarts; after a
  handoff the continuation context names the open milestones so the fresh
  context records them again. Progress is done of total, never estimated.
  `validation.ts` and `digest.ts` turn the same tool calls into Activity's
  checks, Attention, change groups and the "now" line.
* **Answer styles** — `answers.style` adds one policy section
  (`prompts.answerStylePolicy`) to the same `prompt.compose` section as the
  other policies: Brief, Simplified Technical English (after ASD-STE100's
  writing rules), Mission control or Quest log, each scoped to Claude's
  messages, never code, files or commit messages. `prompt.compose` carries
  the session's Claude Code output style (`e.outputStyle`); when the person
  chose one, `policySections(…, { nativeOutputStyle })` leaves the answer
  style out and the panel reads *Paused*. A change mid-session reaches
  Claude as a hidden note, like the other policies.
* **Quest log** — only while the style is `quest`. `features/quest.ts` is
  pure (XP per outcome, levels at 50·n·(n−1), achievements); the Runtime
  decides when an outcome happened: a milestone newly marked done (paid
  once per run, keyed by its subject), a whole plan of three or more done,
  a check's first pass per kind per turn or a pass after a failure
  (`questForCheck`), and a handoff whose notes were verified. Nothing is
  paid for activity (lines, files, tool calls) or for Claude's words.
  Toasts announce achievements and level ups; Activity draws the Quest
  card and the status bar the level.
* **Frontier Max** — `prompt.compose` session section (stable text → one
  cache miss per toggle, none while *Keep policies stable* holds a warm
  cache) with automatic `prompt.submit` context fallback;
  `turn.step` effort (`frontier.effort`, Extra High on a fresh install) where
  the step carries an effort (never invented for models without one); never
  changes the model. Since 1.7.0 the switch no longer turns the lazy-exit guard
  on (the Frontier Max profile still bundles both). Behavior's *This context*
  reads the policy ledger (`app/ledger.ts`): whether and how the section
  reached Claude, request by request.
* **No-Lazy-Exit Guard** — `classic.Stop`: heuristic scoring of the last
  message against the last request; optional low-effort model classification
  (`complete / blocked / needs_user / optional_only / premature`) only when
  heuristics are unsure; `{ block }` with the specific unfinished items;
  per-turn and per-session caps, `stop_hook_active` respected, suspended by
  autopilot handoff, aborts, plan mode, background work in flight.
* **Model Router** — off by default. Subagent model selection via
  `agent.spawn` (cache-neutral; aliases, which the engine resolves);
  main-loop routing decided once per turn (never per step), only while the
  switch is cheap (≤ 60k context unless upgrading hard work), a small-window
  model only under 150k, never downgrading under Frontier Max, and only to a
  full model id the engine has reported answering in this session (`usage.model`
  of any main or subagent step), because a request with a bare alias fails.
  A refused model's family is disabled for the session.
* **Subagent Control** — off by default; Off (offer hidden + spawn denied),
  Ask (`$.ui.ask`, fails closed headless), Max N (the agent ledger's alive
  agents, plus a slot held from each spawn's decision until it settles, so two
  spawns at once cannot both pass a limit of one; a workflow's agents are not
  counted), Unlimited.
* **Agents** (`features/agents.ts`, kept by `app/operations.ts`) — a ledger,
  not a copy of Claude Code's list. `agent.spawn` adds the agent (status
  `starting`) before Claude Code lists it, and from any spawn the list is read
  every 2 s while an agent in the ledger or the list is alive (until 1.7.0 it
  was read before the spawn, and polled only once it showed a running agent:
  a foreground agent stayed invisible until its call returned). The list
  reconciles status, parent, name and the teammate address; an agent it
  leaves out keeps its status until three looks over 6 s have missed it
  (*no longer listed*); an end the ledger saw outranks a list a moment behind.
  The agent's own loop feeds it (`tool.call`, `turn.step` and `turn.complete`
  with its `agentId`): its calls and latest activity, its model, a task list
  or milestones it keeps (its plan, drawn as a track), its answer or failure.
  A workflow's agents, which the list never names, live by those events alone,
  grouped by `workflow.runId`, and end with the run's notification
  (`<tool-use-id>`). Ended agents show for ten minutes. Activity → Agents
  (`ui/pane/agents.tsx`, `hierarchyOf`) draws them under their parents; the
  agent band (`bandOf`) draws up to three lines above the status bar, more
  counted by what they do. No percent and no cost per agent: neither is
  observable.
* **Focus View** — compact one-line tool rows, hidden results and inline
  diffs by default when on; reveal per Focus toggle, the Activity tab and
  Activity → Changes (per-file hunks from `structuredPatch`, `<Code format="diff">`).
  Spinner shows `Working · 27 tools · 6 files changed · tests running`.
* **Resource Governor** — one sampler process per platform, each a program
  by name with fixed arguments (Windows `typeperf` + `systeminfo` once for the
  total memory, macOS `top` + `sysctl kern.memorystatus_level`, Linux `/proc`
  reads, no process). Pressure from a sliding window; policy section
  per level; a note when the load goes high and when it is back, with the next tool results or prompt (hysteresis: high ends 3 points under the ceiling);
  heavy-command classifier on shell tools denies *additional* heavy jobs
  under pressure; lists only Claude-launched background tasks (stop on the
  person's press via `TaskStop`). No OS-level quotas are claimed.
* **Permission Policy** — categories (install, network, download, edit,
  outside-project edit, delete, commit, push, destructive git, deploy/publish,
  catastrophic commands); states Default / Ask / Deny (Allow removed in
  1.4.0; a saved Allow reads as Default). Both decided in `tool.call` before
  `next`: Deny answers `{ deny }`; Ask reads Claude Code's own verdict
  (`$.tool.check`) and, where Claude Code would not ask, asks in its
  question dialog (`$.ui.ask`) and passes the call on after a yes. Nothing
  answers a permission check. Shell commands are tokenized and every segment
  classified; the strictest wins.
* **Profiles** — Normal, Classic, Frontier Max, Low Resource, Release/QA +
  custom; shown as an explicit diff; individual overrides mark the profile
  modified. Normal is a fresh install's defaults (`defaultSystems`), Classic
  the defaults before 1.7.0 (`classicSystems`); Frontier Max, Low Resource
  and Release/QA are built on Classic, as they always were.
* **Fresh-install defaults and the upgrade** (`Runtime.settleDefaults`, at the
  first load, after the former store's carry-over is looked for). No
  `settings.v1` and no sign of earlier use (`hasPriorUse`: a run counter, a
  run index, the cache's memory or the Quest log in the store; `migrated.v1`
  proves nothing, it is written at every first load): a fresh install, so the
  new defaults are saved with `defaults: 2`, `onboarding.v1` is written,
  Overview shows the first-run card until *Got it*, and one toast says what is
  on. No `settings.v1` but earlier use (an install that never changed a
  setting): Classic is saved, so nothing changes. A `settings.v1` without
  `defaults` (saved before 1.7.0): read against Classic (`normalizeSettings`,
  so a group an older version never saved is not switched on), a profile
  `normal` relabelled `classic`, every value untouched, `defaults: 2` saved.
  Control Room's store, carried over at the same first load, still wins over
  the fresh-install defaults written moments before (`isFreshDefaults`): that
  install is not fresh, so its card and record are removed. The permission
  defaults did not change (2 Deny, 6 Ask, the rest Default); Guardrails
  shows each value with "· default" or, changed, in amber with its default.
* **Five-hour plan usage** (`features/planUsage.ts`) — the status bar's cell
  that held the run's cost. Readings come from `session.measure`'s
  `rateLimits` (pushed when a window moves a point) and
  `$.session.usage().rateLimits` (at load, and after each turn, which marks a
  turn answered); `classic.StopFailure` with `rate_limit` marks the limit
  reached. A one-minute tick (`usageTicker`) runs only while a five-hour
  window counts down, to redraw the countdown and read again. The view is
  `pending` (no window yet: `5H —`), `reading` (percent and time to reset,
  amber from 80%), `reset` (the reset time passed, or the window left the
  list after it: no number until a response reads the new window), `limited`
  (100%, or `rate_limit`, until a turn is answered again, a reading under 100%
  comes or the window resets) and `absent` (the list stays empty after a
  response: an API key; nothing in the terminal, *Plan usage —* on Desktop).
  Nothing is estimated or stored: a reload reads `usage()` again. Context →
  Run spells out both windows; cost stays in Overview, Context → Run,
  `/cr status`, history and the Run Budget.
* **Milestone evidence** (`features/evidence.ts`, the run record's
  `evidence`) — files edited through Claude's tools (main conversation,
  successful calls, generated and temporary files left out) belong to the
  milestone under way then; Claude may also name `outputs` in the milestones
  tool. When a milestone is completed (`snapshotMilestone`), Project
  Sentinel keeps the checks that passed during its work (Activity's
  validation runs, by kind), each file's `stat` and Git blob id (`git
  hash-object --no-filters`, files up to 8 MiB; size and time stand in when
  Git cannot run) and HEAD. `checkEvidence` compares at a handoff's verify
  step (the handoff prompt, Handoff Health and the fresh context's block read
  that), at a session's start or reload, at each completion, and at a turn's
  end at most once a minute, and only while snapshots exist: a `stat` per
  file, and a hash only where size or time moved, so a file only touched (or
  changed back) stays current. Changes are weighed by who made them: a later
  milestone still under way → `changing` (quiet); after the change, the
  latest run of every kind of check the milestone had passed → re-baselined
  ("re-verified by Tests at 14:05"); documentation, or a milestone verified
  with no check, changed by a later milestone since completed → re-baselined
  by it; anything else, a change outside Claude's tools included (counted
  from when a comparison found it) → `stale`, with the files, since when and
  which checks to rerun. Never "wrong". The person can accept the files as
  they are (`acceptEvidence`). Stale shows in Run progress, Activity's
  Attention, Context's Last handoff and Ready to resume.
* **Two levels of navigation** — the six sections stay the first level (the
  section bar). A section with views of its own (Activity: Summary,
  Operations, Agents while relevant, Tool calls) draws `subNav`
  (`ui/primitives.tsx`): a breadcrumb (`Activity › Summary`) over a captioned
  row (`View  [ Summary ]  Operations  Agents (2)  Tool calls`), the current
  view bracketed in the section's accent and the others plain and dim; on
  Desktop the breadcrumb over a bordered group of buttons. Keys `sub:<view>`.
  Tones are semantic (`theme.ts`): `good` verified, `warn` waiting for the
  person or worth a look, `bad` a failure or a blocker, `info` what is under
  way, plain gray the default and the past; the brand's orange only for its
  mark, the panel button, the handoff point and the Quest log. Card titles
  are bold and dim; a card holding only an empty state draws without a
  border.
* **Cache Guardian** — `turn.step` hands each main-thread request's usage to
  `CacheGuardian` (`app/cacheGuardian.ts`), and `features/cache.ts` decides
  what it means: a request that reads less than half of the prompt the one
  before it sent missed the cache (prompts under 4,096 tokens are ignored).
  The cause is the change seen before it, in order: compaction (expected),
  a model switch (by the person, the engine, or the router), changed
  policies, the output style, the tools offered (`$.tool.list` at each turn
  start), an effort change; else idling past the lifetime; else
  *unexplained*. A change made after the cache had surely lapsed is not
  blamed. The lifetime is the engine's (PreModelSwitch / PostModelSwitch
  report it), else observed: a hit after more than five idle minutes proves
  the hour, a lapse inside the hour with nothing else to blame points to
  five minutes. Every cache figure is timed by `Runtime.clock()`.
  **Keep warm** (off by default) plans one refresh at a time
  (`nextRefresh`): a sixth of the lifetime before the expiry, between one
  and ten minutes; with the lifetime unknown, one probe at six idle
  minutes. It refreshes only while the person is away (no turn running),
  the context is worth keeping (`cache.minTokens`, 20k), no handoff is about
  to clear it, and the idle limit is not reached (`cache.maxIdleMinutes`,
  capped at 45 for the five-minute cache, past which refreshing costs more
  than one rebuild). A refresh is `$.model.fork` with a one-word answer
  asked for. It checks itself: the first request after the expiry a
  refresh replaced must still read the cache; if it does, Keep warm is
  verified, and if it does not, Keep warm stops, as it does after two
  refreshes sent in time that found the cache gone. The verdict is kept in
  `cache.v1` until the person turns Keep warm on again. *Ask before a model
  switch* answers PreModelSwitch with `ask` when a switch the person makes
  would re-send 100k or more warm tokens. *Keep policies stable* holds
  Project Sentinel's system-prompt section while the cache is warm and sends a
  setting change as a hidden note instead (and a second note when the
  settings go back). An effort change on a model where one was seen to
  rebuild the cache is announced. The router does not downgrade the main
  conversation while 20k or more tokens are warm.
* **Kit** — `features/companion.ts` is pure: a mood from the status bar's
  state and the time (`moodOf`) and the props for Kit's module
  (`companionView`: the mood and its caption, the calm switches, whether a
  turn runs, the local hour, the context's start and whether it is fresh,
  and four signals the module compares with what it last saw: milestones
  done, a green finish, failed checks, a Keep warm refresh). In the terminal
  and on Desktop `register.tsx` draws `<ui.Client key="kit"
  module="./kit.client.tsx" />` with those props and the surface.
  `hooks/kit.client.tsx` holds a behaviour model of pure functions
  (`createKit`, `stepKit`, `touchKit`, `resizeKit`, `drawableOf`): the act
  under way, a queue planned with transitions (a cursor of posture, facing
  and place, so stand ⇄ sit ⇄ down and every turn get their frames), a
  settled mood (1.2 s to settle, 2.5 s to hold, priority moods at once), a
  seeded generator, the reactions left in this round, the touches. What it
  does next comes from `EPISODES`: per mood (idle and a fresh context,
  think, work, search, test, waiting) a set of episodes, each a weight
  (or a function of the hour), a cooldown, whether it walks, and a plan of
  two to five acts. `episode` picks by weight among those off cooldown,
  never the last one (each set has two with no cooldown and no walk, so one
  is always free; walks are left out on a busy processor); `spot` and
  `nearby` send walks where `visits` (time per fifth of the lane, halved
  every 45 s) is lowest. The other moods play one act at a time. A touch
  (`touchKit(x, y)`) is placed on Kit by `partAt` (head, nose, tail, body,
  from the pose's facing and the height as a share of its ear tips,
  Desktop's drawing a fifth taller); three touches within 5 s are a giggle,
  five dizzy, then 4 s of rest; asleep, a startle. Its renderers:
  `terminalSprite` + `terminalLane` (20 × 10 letters, five rows of half
  blocks, glyphs beside Kit on empty cells only) and `desktopSprite` +
  `desktopLane` + `desktopSvg` (a rig of ellipses and triangles rasterized
  to 40 × 24 art pixels, shaded from the top left and outlined between
  layers, props and particles as bitmaps, one path per color; the grid
  covers only the stretch with something in it). On Desktop the image has
  a `width` half as wide again as the lane (`desktopFillSize`, at most
  4096 px, which the page requires of a module's image), drawn
  `max-width: 100%`, and stretches to its box
  (`preserveAspectRatio="none"`), so it fills Kit's region
  whatever a Desktop cell measures (1ch of the app's font, which the
  module never learns; `D_CELL_PX`, 8.08 px, only sets how finely the lane
  is divided), and `pointerAt` places a touch by its share of the region.
  The glue ticks the model on the surface's clock (100 ms on Desktop,
  200 ms in the terminal), redraws only when the drawn frame's key changes
  (at most every 500 ms on a busy processor, every second on a strained
  one, never limited in a new Kit's first second), remembers per surface
  where the last Kit stood (a new instance appears there) and which
  contexts it has walked into (an entrance plays once), and posts
  `{ fault }` if anything throws (`ui.message` → Kit left out until the
  plugin reloads). VS Code, which draws no `Client`, shows `kitStillSvg`.
  While Kit is on, a one-minute tick lets its mood move on with time.
  Measured (`node tools/test/kitbench.mjs`, a ten-minute seeded run of every
  mood): 5.6 µs a step, 0.33 ms a drawn Desktop frame, 0.17 ms a terminal
  one; about 3.3 ms of processor a second on Desktop.
* **Git** — terminal only (Desktop shows Git natively): `$.session.repo()`
  once, then `git status --porcelain=v1 --branch` at session start and after
  each turn, at most every 15 s, read-only, with a 10 s timeout;
  `features/git.ts` keeps the branch, ahead and behind, and the counts of
  changed and untracked files (no paths). Overview's run header and
  `/cr status` show it.

## 8. Failure handling

Every gating hook has a `.catch` that falls back to the engine's own
behaviour (never looser than without Project Sentinel). Store corruption →
defaults with a one-time notice. Sampler failure → monitoring "unavailable"
while the static policy still applies. Clear failure → compact fallback or
the START FRESH CONTEXT action. Model classification failure → heuristics
only. Unknown future events/props → passed through untouched.

## 9. Testing strategy

* `claude plugin test` (576 tests in 33 files, run on 2.1.296 and on 2.1.289, and in CI on the latest
  Claude Code for Linux, Windows and macOS and on 2.1.289 for Linux). The
  tests live in the repository's `tests/`, outside the plugin folder (which
  Anthropic's directory scans, and which ships only the plugin);
  `tools/test/mod.mjs` copies the plugin and `tests/` into `.build/mod` and
  runs `tsc` and `claude plugin test` there. Suites:
  pure-logic suites (settings, profiles, permissions classifier, guard
  heuristics, resource parsers, Autopilot reducer, router, chain, activity,
  the cache model, handoff health and continuity, the former store's
  carry-over, Kit's moods, its behaviour model and both renderers, Git's
  parser),
  Cache Guardian over the in-memory host (`guardian.test.ts`: Keep warm's
  schedule, refresh, self-check and stand-down),
  a Runtime suite over an in-memory host with a manual clock, and
  engine-driven suites (`$.session.start`, `$.tool.call` (Ask's question and Deny),
  `$.agent.spawn`, `$.classic.Stop`, `$.prompt.compose`, `$.turn.step`, the
  Autopilot `/clear` in both orderings, and `$.ui.mount` on `terminal`,
  `desktop` and `mobile`, including the rule that a row never repeats its
  card's title) with the world answered beneath the mod. Engine-driven tests
  start Project Sentinel's own turns with the text framed as Claude Code frames a
  plugin's prompt, since the test kit passes the bare text.
* `tsc` against the engine-written declarations of 2.1.293 (and earlier of
  2.1.292 and 2.1.289).
* `claude plugin validate --strict` (plugin) and `claude plugin validate .`
  (marketplace), and `tools/test/source.mjs`: the source rules Anthropic's
  directory reads (no local `h`/`Fragment`, no `name('!', VALUE)` calls, no
  accessors, no tests in the plugin folder, every `Client` with a fixed
  path).
* Live headless stream-json runs (the Desktop host protocol) of the final
  plugin: the full Autopilot chain on 2.1.292 and 2.1.289; Permission Deny,
  subagent block, Router learning and routing, and the Windows sampler on
  2.1.292; a live resource-pressure notice that Claude acted on (2.1.289).
* Terminal UI in a real console (Windows conhost at 150, 120 and 100
  columns, docked and in the frame above the prompt): the status bar and
  every panel section read back from the screen buffer, driven with injected
  keyboard and mouse input (Tab order, focus ring, Enter, Esc, in-place
  pickers, saving and deleting a profile), including hot reload. The full
  Autopilot chain ran in the interactive terminal on 2.1.292: mid-turn
  crossing, handoff notes, *Wait for me*, Start fresh, continuation.
* Install from the folder marketplace into an isolated Claude Code config,
  and a session loading the installed copy.
* The 1.1.0 status bar (both lines, 150 columns and docked at 78), Activity's
  charts, the answer style picker and the Quest log in a real console, during
  a turn from `tools/demo`: its `turn.step` hook answers each model step from a
  script, so Claude Code runs every tool call inside a genuine turn (the
  `milestones` tool included) without a model or a login.
* 1.2.0 in a real console (150 columns, docked and full width): the status
  bar with Kit, Overview's lifecycle cards, Context's Cache card and Cache
  health, `/cr cache` and Activity, during the demo driver's turn with a
  scripted model switch (`/demo miss`); the Git line in a throwaway
  repository, before and after a turn.
* 1.3.0 live on 2.1.293 with real models (Sonnet 5.5, Opus 5.5), in
  consoles, each test session loading a renamed copy of the plugin
  (`cr-test`) so its settings live in a store of its own: Autopilot end to
  end in four runs, traced step by step with `--debug-file` (two bugs found
  and fixed: the framed handoff prompt, and a fresh context handing off
  after every step); Keep warm on the 1-hour cache (two refreshes moved the
  engine's expiry; a prompt 66 minutes after the last one hit) and on the
  5-minute cache (the probe learned it; refreshes every four minutes; a
  prompt after a replaced expiry hit), each verified by its own self-check;
  Project Sentinel's derived figures against the status line's `prompt_cache`;
  a model switch confirmed first and declined, then made; policy and effort
  changes while warm. The 1.3.0 status bar and every panel section in a real
  console at 80, 100 and 150 columns during the demo driver's turn.
* The Desktop layout through `tools/desktop-preview`: the status bar's and
  the panel's `desktop` element trees rendered as HTML with the CSS the
  app's own renderer gives them, the bar at 512 to 960 pixels.
* 1.3.0 inside the Claude Desktop app (2.26454): the person's review of
  rc.5 (screenshots), then rc.6 installed and loaded by a fresh session,
  captured read-only from the app's window (`PrintWindow`, no input sent):
  the status bar's four cells while Claude works and after the turn, Kit
  at its new size, and Overview with the cache's dot and Now's mark on its
  first line. Kit's seams at a 125% display scale were reproduced in
  headless Chrome and fixed there.
* 1.5.0 live on 2.1.295 with Sonnet 5.5, each session headless over
  stream-json (the Desktop host protocol) through a recording proxy that
  keeps, per request, only fingerprints (hashes of the system prompt's
  blocks, the tools and each message), the model, effort and thinking, and
  the cache's token counts: never text, headers or credentials. Test
  copies renamed `ps-test` and `ps-test2` keep their own stores. Proven:
  the two "unexplained" 301k and 451k rebuilds of a real session were
  Project Sentinel's own notes appended mid-request (reproduced, then gone
  with the notes riding tool results); Keep warm on the five-minute cache
  (two fork HITs, the conversation VERIFIED after the replaced expiry, a
  control without it rebuilding 47.2k) and on the one-hour cache with
  Frontier Max on; Frontier Max in the first request of a session, turned
  on and off mid-session, after Autopilot's `/clear`, after a compaction
  and across a reload mid-turn, each with its effort; the Autopilot chain
  with a prompt queued during the handoff, a reload of the plugin
  mid-handoff, the compaction continuation (which found the SDK
  compaction refusal, now run as `/compact`) and the lazy-exit guard
  standing down; the run's cost kept across the `/clear`. Kit through
  `tools/desktop-preview` at 64 to 175 columns (its image fills the band)
  and measured with `tools/test/kitbench.mjs`. A clean install from the
  directory marketplace into a throwaway configuration.
* 1.6.0's orchestration layer: pure suites (`ops.test.ts`: the time
  grammar, the queue's boundaries, decisions, watchers and checkpoints,
  Smart, the budget, the stored record, resume health and the preview, the
  Scout, the agent rows), a Runtime suite over the in-memory host with its
  manual clock (`operations.test.ts`: queue, decisions, watchers including
  stale protection, fresh wakes, a cold cache before a warm wake, reloads
  and restarts, the Cold Resume Guard's every choice, agents, the budget,
  ended runs), and engine-driven suites (`opsui.test.ts`: Operations on
  `terminal`, `desktop` and `mobile` with its controls pressed, Overview's
  card, Context's cards, the chips and the sleeping status bar, Kit's
  Client tree through the Desktop page's check, every `/cr` command, the
  `prompt.submit` drop and the decision tool). Live results are in the
  changelog.
* 1.7.0's hardening pass, a regression test for each failure found:
  `background.test.ts` and `blockers.test.ts` (each task's class from Claude
  Code's words, the isolated classifier's labels, the supervisor's every
  diagnosis, handoff-control words), `handoffwait.test.ts` (the Runtime and
  the engine: the Vite preview server that held a written handoff for good,
  mixed servers and finite work, long finite work past its patience, a
  reload mid-wait, a 1.6.3 record stuck on a server, the classifier, every
  `/cr handoff` and `/cr fresh` form, the words typed while a handoff waits,
  Keep warm on through the wait), `guardian.test.ts` (Keep warm stands down
  only at the verify step, the clear and the resume), `agents.test.ts` (a spawn shown at once,
  two spawns against a limit of one, workflow agents, parent and child, a
  reload, an end while the panel is open, failures, Stop, Message, an agent
  left out of the list for a moment, the band and the view on each surface),
  `planusage.test.ts` (no reading, reset, the limit, the window that leaves
  the list, a reload, an API key; terminal and Desktop), `evidence.test.ts`
  (the rules for later milestones, a change outside the tools, re-baselining,
  a handoff, a session's start, accept, the surfaces) and `defaults.test.ts`
  (a fresh install, an install used before, a stored Normal, the carry-over
  from Control Room's store against fresh defaults, the first-run card).
  Tests that drive the engine for more than a second and a half have a
  30-second budget: the kit's 5 s default timed out on a machine shared with
  other sessions. Unit harnesses that predate 1.7.0 start from
  `classicSettings()`, the defaults they were written against.
* Not yet done: the answer styles with a real model, and live sampling on
  macOS and Linux.

## 10. The orchestration layer

The design record is [ORCHESTRATION.md](ORCHESTRATION.md): what each part is and what it may do by
itself. This section is how it is built.

**Where it lives.** `features/ops.ts` is the model, plain data kept in the run record (`run.ops`,
validated by `opsOf` on every read, so a hand-edited or older record never breaks a load).
`app/operations.ts` (`Operations`, `rt.ops`) moves it: the Runtime calls it at each boundary and it
asks the Runtime for the run, the context and the engine. Its views are `view()` (the `ops` atom,
Activity → Operations, Overview's card, Context's two cards) and `hud()` (the status bar's slice:
review, blocking, queued, due, the holding watcher, sleeping, agents, budget; null while empty, so
the bar draws nothing of it).

**Boundaries.** Nothing is delivered on a timer inside a turn, and nothing is appended to the
transcript (1.5.0's rule):

| Boundary | Hook | What goes |
| --- | --- | --- |
| a turn ends | `turn.complete` → `onTurnEnd` | one prompt of Project Sentinel's own: a due watcher's wake, else answers the run waits on, else due queued work (in order); 700 ms later, through `deliverNext` |
| a milestone completes mid-turn | the milestones tool or task list → `setPlan` → `onPlanChanged` | queued work for after it (and for the next safe boundary), as a note with the next batch of tool results (`classic.PostToolBatch`) |
| an answer while Claude works | `answer` | the answers, as a note with the next batch of tool results |
| a fresh context Project Sentinel started | `classic.SessionStart{clear}` → `onFreshContext` | work queued for after the handoff, answers and open decisions, and a watcher's reason, in the `contextAutopilot` block of its first message |
| the person's prompt | `prompt.submit` → `onPromptSubmit` | answers that did not block, as that prompt's context |
| a watcher's time | `$.clock.after` (and a 30 s tick) → `onTime` | the watcher is marked due; it acts at the next boundary when the session is free |

*Free* (`isFree`) means: no turn running, Autopilot idle or armed, no prompt of its own in flight
(one whose turn never began stops blocking after two minutes), no approval waiting
(`pendingApprovals`), no background work that brings the turn back, no fresh start or compaction
under way. A prompt is marked delivered when `$.prompt.submit` resolves without a drop; a drop puts
it back to due and logs why; one in flight when the runtime ends reads `unsure` at the next load and
is never sent again by itself.

**Checkpoints.** A watcher keeps the run's fingerprint when it parked it: the session id, a count of
the person's turns (`personTurns`, counted at each turn's end: the person's own, and Project
Sentinel's when the person forced them with *Deliver now* or *Send now*) and a digest of the
milestones' keys and states (`planKey`). Armed mid-turn, it takes the checkpoint at that turn's end.
After a turn of Project Sentinel's own with no turn of the person's since, the checkpoint is taken
again (the run is parked where that turn left it). At the wake, `changedSince` compares: any
difference makes it `stale`, and only the person moves it on (Check now sends the wake into this
context; nothing clears).

**Wakes.** A warm wake submits the wake prompt. A fresh wake needs healthy resume state
(`features/resume.ts`: milestones, notes of 200 bytes or more written no earlier than ten minutes
before the milestones last changed, no failed pickup since) and goes through `Runtime.freshStart`:
the same `/clear` as a handoff (`clearOwn`, which waits for the fresh session's start or a changed
session id and fails without either), the run rolled over with the purpose's end note, the fresh
context's block, then the fresh resume prompt. Smart (`smartChoice`) decides at arming (shown) and
again at the wake; a warm hold makes Keep warm refresh past its idle limit and the five-minute cap
to the wake (`nextRefresh`'s `holdUntil`). A warm wake over a cache that went cold asks, unless
Smart and healthy resume state allow a fresh wake.

**The Cold Resume Guard** runs first in `prompt.submit`, before the budget's question and before
any context is added. It returns `{ drop }` for every choice but *Continue*, so nothing has entered
when it asks; *Cancel* (and a dismissed dialog) puts the text back with `$.prompt.fill` after
400 ms, or keeps it in memory where the host has no box. *Start fresh* and *Compact first* carry the
message into the fresh or compacted context (`freshStart`'s prompt; `submitAsUser` once
`$.session.compact` resolves, 600 ms after the drop: asked inside the held prompt's dispatch,
Claude Code refuses it as a turn under way, and it never runs the caller's own `session.compact`
hook for it), then clear the copy of the message Claude Code restores to the box (`$.prompt.read`,
`$.prompt.fill('')`, only while the box holds just that text). Its state (`coldState`) is cold
only when the cache's expiry is known and passed, an hour passed with no known lifetime, or Claude
Code's resume facts say so, and no request of Claude Code's own (a `session.measure` whose cost
grew with no turn running) came within the lifetime since; its price is
`cache.v1`'s `writeRates` (Claude Code's `estimated_cache_write_usd ÷ context_tokens` per model and
lifetime, `configured` or `catalog` pricing only).

**The budget** (`checkBudget`) reads the run's totals (cost as reported, wall-clock time by the
runtime's clock, handoffs) after each turn and each tick, and, while a cost limit is set, after
main-thread steps (`$.session.usage()`, at most every five seconds: Claude Code raises
`session.measure` after the turn, not after each step). `mayAutomate` gates every turn Project
Sentinel would start by itself; `budgetGuard` asks once before the person's message; `Finish the
milestone` adds a note with the next tool results. It never cancels anything.

**Agents** (`features/agents.ts`, the ledger described in §7) start at `agent.spawn` (shown at once,
`starting`) and are reconciled with Claude Code's list (`$.agent.list`, read at load, before a spawn's limit is
decided and after the spawn settles, at an agent's end, at a Stop, when a control opens one of
Activity's views, and every 2 s from any spawn while an agent is alive); the agent's own loop (`tool.call`, `turn.step`, `turn.complete` with
its `agentId`) feeds its activity, model, plan and end. The ledger is mirrored in `$.state` `agents`,
so a reload keeps it. Stop is `$.tool.call({ tool: 'TaskStop', task_id })`, Message is
`$.session.send({ to: { agentId } })`; both offered only for background agents and teammates.

**Ended runs.** A run ended by `session.end` keeps its operations inert: its timers stopped with the
process, and a new run never reads them. `findForeign` offers the newest ended run of the same
project root that left open operations; `bringForeign` copies them (watchers re-armed from now,
overdue ones due) and marks the originals moved, so they are offered once.
