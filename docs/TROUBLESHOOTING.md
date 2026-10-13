# Troubleshooting

Start with `/cr status`, which prints every system's state on one screen. For anything deeper,
run Claude Code with `claude --debug` (or `--debug-file <path>`). The debug log names every Project
Sentinel hook that ran, anything the engine refused, and why. Project Sentinel's own lines start
with what they are about: `autopilot:` (each handoff step), `supervisor:` (what holds a handoff),
`background:` (each background task: waited for or not, its end), `handoff guard:` (a message typed
while a handoff is under way), `agents:`, `evidence:` (milestone evidence verdicts), `plan usage:`
(five-hour readings), `settings:` (fresh install or update), `policy:` (what reached Claude, per
request), `ops:`, `cold resume:` and `keep warm:`. They are never shown on screen.

## Project Sentinel doesn't load

- **Check the version.** Run `claude --version`; 2.1.289 or newer is needed.
- **Validate the folder.** `claude plugin validate /path/to/plugins/project-sentinel` reports what
  the engine would refuse.
- **Installed via a marketplace:** `claude plugin list` should show
  `project-sentinel@control-room` as enabled, with `Read from:` naming your folder. After you pull
  changes, run `/reload-plugins` in the session.
- **Still `control-room@control-room` after 1.4.0** (the plugin was renamed): run
  `claude plugin marketplace update control-room`. The marketplace maps the old name to the new
  one, so the update moves your install over (your `enabledPlugins` entry included), and the next
  session loads Project Sentinel and copies your settings and run history over once.
- **An open session still shows Control Room after the update:** Claude Desktop hands a session
  its plugins when the session starts, so a session open during the update keeps Control Room.
  Project Sentinel stands by in it (one note: *Project Sentinel is installed. Control Room keeps
  this session until it restarts.*) and takes over in the next session.
- **Desktop:** the Code tab's local sessions load installed plugins and folders named in
  `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Start a new session
  after changing either.
- **Desktop shows an older version** (for example the 0.1 status bar, `CTX … | AUTO 700k`): the
  Code tab loads the copy recorded in `~/.claude/plugins/installed_plugins.json`, not the folder.
  Run `claude plugin update project-sentinel@control-room`, then start a new session.
- **Organisation policy:** managed settings can disable plugins. Project Sentinel cannot and does
  not work around that.
- **Settings or runs missing after the rename:** they are carried over once, when Project Sentinel
  first loads outside a session that still runs Control Room, from the store written last in
  Claude Code's configuration folder (`CLAUDE_CONFIG_DIR`, else `.claude` in your home folder), and
  only into an empty store. The old file (`~/.claude/plugins/store/control-room_<source>-<id>.json`)
  is never changed, so nothing is lost; `claude --debug` names what was carried
  (`carried … keys over from control-room_…`).

## `/cr` does nothing, or goes to Claude

- `/cr` is only registered when no other command uses that name. `/control-room` always works.
- In `claude -p "/cr status"`, a plugin's command given as the *initial* prompt is sent to the
  model, because plugin commands register as the session starts. Use an interactive session,
  stream-json input, or the panel.

## The panel doesn't appear

- In the terminal, a pane that opens on its own (*Open at session start*) waits for at least
  144 columns. Type `/cr` and it opens at any width.
- On surfaces without a pane, `/cr` prints the status and points to the sub-commands.
- Pressing **Esc** returns the keyboard to the prompt. `/cr open` or a click focuses the panel again.

## The status bar is missing

- `/cr hud band` (or `both`). The band steps aside while Claude Code shows one of its own
  surveys there, and comes back afterwards.
- With `/cr hud status`, it is on Claude Code's status line instead.

## Work progress is missing, or reads oddly

- **No Work meter:** progress comes from Claude's own task list (TodoWrite or the Task tools).
  Until Claude keeps one for the run, there is nothing to count, so nothing is shown. Asking for a
  task list ("plan this as a checklist first") gives it one.
- **The total changed after a handoff:** the fresh context is handed the run's whole list and its
  objective and asked to carry them on under the same titles. If it still lists its open work
  differently, its list replaces the earlier context's open work; finished milestones always stay
  counted.
- **The headline names a milestone being verified:** only when none is in progress. The one in
  progress is the work under way.
- **CPU and RAM left the status bar:** calm readings stay in the panel (Overview, Guardrails).
  The status bar names them only near a ceiling.
- **The cost left the status bar** (1.7.0): its cell shows the plan's five-hour usage now (see
  [Five-hour usage](#five-hour-usage-5h)). The run's cost (the whole run's total, which a handoff
  never resets) is in Overview, `/cr status`, the Run Budget and Context → Run, which also has each
  session's own.
- **The names went from the readings:** below 72 columns the instruments stand alone, and the
  meter and the track shorten before a reading is dropped. Widen the terminal, or close the docked
  panel, to see them again. On Desktop each reading keeps its caption at every width.
- **The headline reads `Ready`, or the objective, dim:** no turn has run in this context yet. It
  says what Claude is doing once a turn starts.
- **The headline reads `Waiting for …` after the turn ended:** Claude left a background job
  running or scheduled a wake-up, so the run will come back by itself; or a milestone is marked
  waiting. `Waiting for your answer` means Claude's last message asked you something.
- **A white bar in the middle of the status bar on Desktop:** that was 1.2.0, whose animated work
  track Desktop drew in a frame of its own default size. 1.3.0 draws every graphic as an image.
  Update (`claude plugin update project-sentinel@control-room`) and start a new session.
- **No Cache reading:** it appears once Claude has answered in this context, and only for a prompt
  of 4,096 tokens or more.
- **Kit is missing:** see [Kit](#kit-the-companion).

## Five-hour usage (5H)

The status bar's `5H` cell is Claude Code's own reading of the plan's five-hour window
(`$.session.usage().rateLimits`), never an estimate. `claude --debug-file <path>` logs each new
reading (`plan usage: five-hour 32%, resets 2026-10-13T09:20:00.000Z`).

| What it shows | Why |
| --- | --- |
| `5H —` (Desktop: a dash) | No reading yet: Claude Code reports the windows with each API response, and a session (a headless one in particular) has none before its first. It fills in when Claude first answers. |
| Nothing at all in the terminal, *Plan usage —* on Desktop | Claude Code answered and reported no five-hour window: an API key or a provider other than a claude.ai plan has none (`plan usage: no five-hour window`). |
| `5H reset · new window`, with no number | The window's reset time has passed (or the window left the list at its reset). The old percentage says nothing about the new window, and Claude Code reports the new one only with the next response. |
| The countdown stands still between turns | It is redrawn once a minute, only while a window counts down. A reading itself changes only when Claude Code reports one (after a response). |
| `5H limit` in red | The window reads 100%, or Claude Code ended a request on the rate limit (`classic.StopFailure` `rate_limit`; *Rate limited* when no window reads full, as with the seven-day one). It clears when a turn is answered again, a reading under 100% comes, or the window resets. |
| Amber | 80% or more of the window is used. |
| The percentage differs from claude.ai's usage page by a point | Claude Code reports a window again only when it moves a whole point. Context → Run shows both windows (5-hour and 7-day) with their resets. |

## Milestone evidence

| Symptom | Cause and fix |
| --- | --- |
| *Verification stale* on a completed milestone (Run progress, Activity → Attention, Context → Last handoff, Ready to resume) | A file the milestone's work changed is different now from when it was verified, and no check of the kinds it had passed (Tests, Type-check, …) has passed since. It says which files and since when, and what to rerun. It never means the milestone is wrong. Fix: rerun those checks (the next comparison, at most a minute after a turn ends, re-baselines it: *re-verified by Tests at 14:05*), or, if the change is fine as it is, **Accept files as they are** in Activity or `/cr evidence accept [n\|all]`. |
| A later milestone changed the same file and nothing says stale | By design: while the later milestone is under way the earlier one reads *being changed by …* (quiet), and once the latest run of each kind of check the earlier milestone had passes after the change, it is re-baselined. Documentation, and milestones verified with no check, belong to the later milestone once that is completed. |
| Stale after I only opened or saved a file unchanged | A file whose size and time are unchanged is not even hashed; one saved again unchanged is hashed and its Git blob id is the same, so it stays current. Without Git (`git hash-object` cannot run), size and time stand in, and a save that changes only the time reads as a change (`evidence: git hash-object … size and time stand in`). |
| A milestone has no evidence | Only files edited through Claude's tools while it was under way (or outputs Claude named in the milestones tool) are its evidence; generated and temporary files and the handoff notes never are. A milestone with no files keeps its checks only. `/cr evidence` lists what each one stood on. |
| What does it run? | `git hash-object --no-filters -- <the milestone's files>` and `git rev-parse --verify -q HEAD`, at a milestone's completion and when comparing; only blob ids come back. See [SECURITY.md](../SECURITY.md). The debug log's `evidence:` lines say each verdict. |

## Fresh install and the update (1.7.0)

| Symptom | Cause and fix |
| --- | --- |
| Setup reads **Classic** after the update; I had Normal | Normal changed in 1.7.0 (Autopilot and Frontier Max on). Your saved Normal kept every value and is now called Classic, so it does not read "edited" against the new Normal. To take the new defaults, pick Normal in Setup (`/cr profile normal`). |
| Autopilot and Frontier Max are on, and I never turned them on | A fresh install (no settings and no runs in the store) starts on the new Normal. Turn either off in Context / Behavior, or pick **Classic**. |
| A card *Sentinel is on* at the top of Overview | A fresh install's one-time summary of what is on and where things live. **Got it** dismisses it for good (`onboarding.v1` in the store). An install that was used before never shows it. |
| An install that never changed a setting kept the old behaviour | Settings are saved only when one changes, so its store held runs but no settings: Project Sentinel saved Classic for it rather than treat it as new (`settings: none saved, earlier use found: Classic kept`). |
| Frontier Max no longer turns the lazy-exit guard on | Since 1.7.0 the switch does only what it says. The Frontier Max profile still sets both; or turn the guard on in Behavior. |
| My permissions were not changed to Default | On purpose: a fresh install keeps the protective defaults (force push, resets and dangerous commands Deny; installs, downloads, edits outside the project, deletes, push and deploy Ask). Guardrails shows each value and whether it is the default. |

## Answer styles and the Quest log

- **Claude doesn't write in the chosen style:** one of Claude Code's own output styles (`/config`)
  is in charge, and Behavior reads *Paused*. Set it back to Default. A change mid-session reaches
  Claude at its next request.
- **No XP:** XP is earned only while the Quest log style is chosen, and only for outcomes Control
  Room can count: a milestone done (Claude must keep a task list), a check passing, a finished plan,
  a verified handoff. Each milestone pays once per run, and a check's first pass once per turn.
- **Claude names points or levels:** it is asked not to. The numbers in Activity and the status bar
  are Project Sentinel's own.

## The prompt cache

Claude Code reports how many tokens each request read from the cache and wrote to it. The rest
(the expiry, the hit ratio, why it was rebuilt) is derived from those, and the panel says so.

- **"as Claude Code is configured"**: Claude Code is told which lifetime to use, and Project
  Sentinel reads the same settings in Claude Code's order: `FORCE_PROMPT_CACHING_5M`, then
  `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m` or `1h`), then the `promptCacheTtl` setting, then
  `ENABLE_PROMPT_CACHING_1H`. Before 1.6.2 a claude.ai plan was taken for the one-hour cache even
  under such a setting.
- **"Lifetime not known yet"**: Claude Code reports the cache's lifetime only at a model switch.
  Otherwise Project Sentinel learns it: a request that still reads the cache after more than five
  idle minutes proves the one-hour cache, and with Keep warm on, one refresh six minutes after the
  last request tells. On a claude.ai plan it starts at the one-hour cache (*1-hour cache, the
  plan's default*) until a request shows otherwise. Until it is known the status bar reads `warm`,
  then `lapsed?` once you have been away five minutes; never while Claude is working. Once learned,
  it is remembered across sessions.
- **It said `lapsed?` while a long command ran** (before 1.4.0): Claude Code's own requests keep
  the cache warm during a turn, so now it stays `warm` until the turn ends, unless the five-minute
  lifetime is known.
- **"Cache rebuilt: 446k tokens · Model changed"**: the request after a change had to write the
  conversation to the cache again, at a higher price than reading it. Context → Cache health says
  what happened and what would avoid it. The usual causes: switching models or effort in the
  middle of a context, the model router switching models, a setting changed with *Keep policies
  stable* off, an MCP server or plugin connected mid-session, or a long break. Compaction always
  rebuilds it, and reads *Expected*.
- **How sure a cause is**: each rebuild says *Proven cause* (Claude Code reported it, or the request
  shows it), *Likely cause* (a change seen that usually rebuilds) or *Cause unknown*. A *partial*
  rebuild still read part of the conversation (something changed part-way); a *full* one read only
  the system prompt and tools (something changed near the start, or the cache had lapsed).
- **"Earlier conversation changed"** (proven): Claude Code reported that the API found the earlier
  conversation different from what it had cached, and dropped the thinking made over it. Something
  rewrote earlier messages: a plugin adding hidden notes while Claude works, a rewind, Claude Code
  clearing old tool results. Before 1.5.0 Project Sentinel's own notes did this (the 300k–450k
  rebuilds once called "probably evicted by the server"); it no longer appends anything.
- **"Cause unknown"**: no model, effort, tool, policy, style or history change was seen. It is not
  put on the server without evidence. If it repeats, look for another plugin or hook that changes
  requests, or a proxy or gateway, and compare with `/cr diagnostics`.
- **A model switch asks first**: *Ask before a model switch* (on by default) confirms a switch that
  would re-send 100k or more warm tokens. Switch at the start of a fresh context instead, or turn it
  off (`/cr cache guard off`).
- **"Effort changes rebuild the prompt cache on …"**: Project Sentinel saw an effort change rebuild the
  cache on that model before, so it says so before the next request.

### Keep warm

- **It does not refresh**: the line under *Keep warm while you are away* says why. It refreshes
  only while you are away (Claude's own requests keep the cache warm while it works), while the
  context holds at least 20k tokens, while no handoff is about to clear the context, and until the
  idle limit (*Stop after*; 45 minutes at most for the five-minute cache, past which refreshing
  costs more than a rebuild). If the machine slept past the expiry, the cache lapsed and the next
  request rebuilds it.
- **It stood down during a handoff**: since 1.7.0 only once the old context is about to be
  discarded: while the notes are checked before the clear, during the clear, and while the fresh
  context resumes (*The handoff notes are being checked before the clear, so this cache is about to
  be discarded*). A handoff that is due, being written, waiting for background work or for you, or
  stuck keeps the cache warm, since each of those reads the old context again. (1.6.3 stood down for
  all of them, and a handoff held by a preview server let a 775k-token cache lapse.) A handoff that
  compacts keeps it throughout.
- **"Retrying in 2 min"**: a refresh failed (the API refused it, or no reply came). It tries again
  while the cache can still be saved.
- **Fork HIT, Main cache AWAITING VERIFICATION / VERIFIED / FAILED**: a refresh is a fork of the
  conversation's last request; HIT means it read the conversation from the cache. That alone proves
  nothing for the conversation: its own next request does. VERIFIED: it read the cache after the
  expiry the refresh replaced, or after the expiry the first of a chain of refreshes replaced (a
  watcher's wake just after the newest refresh of a long hold). *Read it*: you came back before
  that expiry, no proof yet. NOT
  TESTED: something changed first (it names what). FAILED: it rebuilt before the refreshed expiry
  with nothing changed, and Keep warm pauses itself with that reason. `/cr cache` lists each
  refresh with both expiries and what the next request read.
- **"Paused: its last check failed"**: a refresh did not hold the cache for the conversation, or
  two refreshes sent in time found it gone. Turn Keep warm off and on again to let it try afresh.
- **What it costs**: each refresh re-sends the conversation as cache reads (a tenth of the input
  price) plus a one-word reply. Context → Cache counts the refreshes.
- **Does a refresh really keep the conversation's own cache?** Measured through a recording proxy
  (1.5.0, Claude Code 2.1.295, Sonnet 5.5). The fork re-sends the conversation's last request
  exactly: the same system prompt, tools and messages, then the last answer and its own one-line
  prompt. On the five-minute cache, two refreshes four minutes apart both read the conversation from
  the cache (47,130 and 47,156 tokens), and the conversation's next request, five and a half minutes
  after the expiry the first refresh replaced, read 47,156 tokens: VERIFIED. The same session
  without Keep warm rebuilt all of it (47.2k written, nothing read) after the same pause. On the
  one-hour cache with Frontier Max on, the refresh fifty minutes in read 89,817 of 89,819 tokens
  and moved the expiry an hour on; the conversation's request five minutes after the old expiry
  read 89,817: VERIFIED. That refresh went at the session's effort (`medium`) while the
  conversation's requests went at Frontier Max's (`xhigh`): on Sonnet 5.5 effort is not part of
  what the cache keys on. Under a Keep warm watcher (1.6.2, five-minute cache, 145k tokens): three
  refreshes four minutes apart each read about 144,960 tokens and wrote at most 5, and the wake
  twelve minutes after the conversation's last request read 144,965 from the cache: VERIFIED, by
  the chain.

## Kit, the companion

- **Kit doesn't appear**: it is off by default (Setup → *Companion*, or `/cr companion on`). It
  lives in a lane above the status bar, so not with `/cr hud status`, and not on mobile. VS Code
  shows it still, in its mood's pose.
- **Kit appeared, then went away**: its drawing failed on this surface, so Project Sentinel left it
  out and the status bar draws without it. `/reload-plugins` tries again; `claude --debug` names
  the reason.
- **It moves too much**: Setup → *Reduce motion* (or `/cr motion off`) holds it in one pose. On a
  busy machine (the processor near its ceiling) it draws two frames a second and stops walking; at
  the processor's limit, one a second. It never freezes: switched on, it moves within a second
  whatever the load (before 1.5.0 it could sit frozen on a machine at its memory ceiling).
- **It is tired all the time**: the processor is near the ceiling set in Guardrails → Machine load,
  memory is at its ceiling, or the context is nearly full. Memory only tires it: it never slows it.
- **It stays on the left / does the same thing over and over** (before 1.5.0): it now plays short
  episodes per mood, picked at random by weight, none repeated straight away, and walks to where it
  has been least, so over a few minutes it uses the whole status bar (on Desktop the lane is as wide
  as the status bar).
- **What a touch does**: it depends on where it lands. A pat on the head (it leans into it; a
  second one, a purr), a boop on the nose, a touch on the tail (it flicks it and looks round), a pet
  on its body (a purr, a roll for a belly rub, a blush, a high five, a hop, a spin). Three touches in
  a few seconds are a giggle, five make it dizzy and it ignores touches for a few seconds. While
  Claude works it only looks up; asleep, it is startled. It never opens anything: the status bar's
  *Control Room* button opens the panel.
- **It walked off and did not come back**: it carries the notes off at a handoff and stays away
  until the handoff ends; then it walks back in from the left.

## Git

The Git line (Overview's run header and `/cr status`) is terminal only: Desktop shows Git beside
the session. It needs a Git repository and `git` on the `PATH`, and it is read at session start and
after each turn, at most every 15 seconds, so a change you make by hand shows after the next turn.

## Context Autopilot

| Symptom | Cause and fix |
| --- | --- |
| Threshold reached but nothing happens | The handoff starts when the current turn ends. Claude is first asked to finish the step it is on (**Handoff soon**). **Hand off now** starts it at once; **Later** postpones it. |
| "Handoff notes were not written, so the context was not cleared" | Project Sentinel only clears after `NEXT_SESSION_PROMPT.md` (or your configured file) was written during the handoff. Claude gets one reminder; after that it waits for you. Check that Claude may write files in the project (permission mode, Permission Policy *Project file changes*). Then run `/cr handoff` again, or `/cr fresh` once the file exists. |
| Waiting for you | `/clear` was refused and compaction was not allowed or also failed, the continuation is `manual`, or the turn that took in a background result was interrupted. Press **Start fresh context** (or `/cr fresh`): it checks the notes first. |
| The threshold is lower than I set | It is kept below Claude Code's own auto-compact point, so the handoff runs first. The Context section shows the clamp. |
| The fresh context didn't continue by itself | *Auto-continue* is off, or the session was waiting on an approval. Ask Claude to continue from `NEXT_SESSION_PROMPT.md`. Your policies and profile are already active. |
| "This fresh context started working at 66k, close to the 64k handoff point, so it hands off at 86k" | A context after a handoff starts with the system prompt and tools, then reads the notes, the docs and the code before it works. With a threshold close to that, every context would hand off after a step or less. So it gets room to work from where it started working (20k, or a tenth of the threshold). Raise the handoff point (Context → *Hands off at*) so each context has room. |
| "The fresh context filled up before work began" (waiting for you) | It passed the handoff point and its room while still reading itself in: handing off again would only repeat that. Raise the handoff point, then **Start fresh** or carry on. |
| The handoff seems stuck at "Handing off" | Every step moves on when its turn starts or ends. `claude --debug-file <path>` traces each step (`autopilot: … → …`, `turn … started (handoff)`) to see where it stopped. A turn you queued runs first; the `/clear` waits for it. |
| *Handoff written · waiting for background work* | The handoff turn ended while finite work it left running (a render, a build, a test run) was still in flight, as Claude Code's Stop listed it. The fresh context starts by itself once that work ends (its notification starts a turn, Claude records the result, the notes are checked), or when the wait's limit passes (Context → Autopilot → *Wait for background work*, 20 minutes by default): then the work keeps running and its result reaches the fresh context, which is told. A server or watcher (a Vite preview, a `--watch`) is never waited for (1.7.0). To end the wait now: **Hand off now** (Context or the status bar), type "handoff now", or `/cr handoff now`; **Stop & hand off** or `/cr handoff stop`; **Keep waiting** or `/cr handoff wait 30m`; **Call off** or `/cr handoff cancel`. The debug log says `background: not waited for (…)`, `supervisor: …`, `autopilot: turnComplete · handoff → waiting-background`, then `→ verifying`. |
| Stuck at "Claude is writing the handoff" after the handoff turn ended (1.6.2) | 1.6.2 counted the turn a background task's notification starts as yours, so a handoff that waited for background work never moved on, `/cr fresh` said *No written handoff is waiting* and `/cr handoff` said *Handing off* without doing anything. Fixed in 1.6.3. A session left in that state by 1.6.2 recovers after the update with `/cr fresh` (or **Start fresh context** in Context): it checks that the notes were written for this handoff and that nothing is in flight, then clears and continues as a handoff would. |
| `/cr fresh` keeps the context | It says why: finite background work still running (it names it; `/cr fresh now` starts the fresh context anyway and leaves that work running, its result arriving there), `NEXT_SESSION_PROMPT.md` missing, empty or not written since this handoff began (run `/cr handoff`), no handoff under way (run `/cr handoff`), or a handoff already finishing by itself (checking the notes, starting the fresh context). A server alone never keeps it: the fresh context starts and is told the server runs. It never clears a context whose notes it could not verify. |
| A server I started (Vite, `npm run dev`, `--watch`) and a handoff | Since 1.7.0 a server, watcher, tunnel or log follower is never waited for: the handoff goes on, the server keeps running (Claude Code keeps background work across `/clear`), and the fresh context's first message says it runs, so Claude reuses it instead of starting another. The debug log says `background: not waited for (b7x: a preview server …)`. |
| Something I typed while the handoff waited was not sent | While a handoff is under way, a short instruction about it is acted on and not sent: "handoff now", "don't wait for the background process", "start the fresh session now", "keep waiting", "stop the server and hand off", "cancel the handoff" (the debug log: `handoff guard: "…" read as "…"`). Any other message, once the handoff is written or being written, is asked about: give it to the fresh context (it waits in the Mission Queue, Activity → Operations, and goes first thing), send it here, or back to the prompt box. A longer sentence of work is never taken for an instruction. |
| The alert line reads *Handoff: The handoff turn ended without Sentinel seeing it end* (or Context → Autopilot names what holds the handoff, and for how long) | The Handoff Supervisor looks every 30 s at a handoff under way and says what holds it: finite work within its wait, work that outlasted the wait (it goes on by itself), a task nothing recognises (after a minute a small isolated classifier is asked once what it is, from its command and description only), a question waiting for you, or a step whose event never came (each with its ways out). It never moves a step on a timer except at the wait's end, and never under a running turn. The debug log has one `supervisor: <step> for 12m · stalled · …` line per change. |
| *Last handoff* shows items missing | It counts what it saw in tool calls: *Project docs updated* needs a documentation file edited in the handoff turn, *Validation recorded* a check run in that context, and *Project docs read* a documentation file opened by the fresh context. `○` marks an item that was not needed (no milestones to save, CLAUDE.md left alone). The handoff itself went ahead; the list says what the fresh context may lack. |
| "Compaction failed: … not available in a headless (-p / SDK) session" (before 1.5.0) | Desktop and other SDK sessions compact only inside a turn, so the *Compact* continuation (and the fallback when `/clear` is refused) stopped there. Autopilot now runs `/compact` as a command in those sessions and carries on when Claude Code has compacted; the debug log says `autopilot: this session compacts only inside a turn: running /compact`. If nothing compacts within ten minutes it waits for you. |
| "Control Room reloaded in the middle of a handoff" | The plugin was reloaded (`/reload-plugins`, an update) while a handoff was under way. Autopilot picks up where it was; only when it cannot tell whether a step already happened (the handoff prompt was about to go out, or a compaction) does it wait for you, so nothing runs twice. Press **Hand off now** or **Start fresh**. |

## Operations

Activity → Operations, `/cr queue list`, `/cr watchers`, `/cr decisions` and `/cr budget` show
the layer in words; `claude --debug-file <path>` traces each step (`ops: Q-1 queued`, `ops: W-1
due`, `ops: W-1 wakes the run in this context`, `cold resume: asking …`).

| Symptom | Cause and fix |
| --- | --- |
| A queued item was not delivered | It goes only at its boundary, and only while the session is free: no turn running, no handoff under way, no approval or question waiting for you, no background job that will bring the turn back. While a watcher parks the run, the queue waits for the wake (**Deliver now** sends it at once). At a run budget limit set to *Ask*, it waits for your yes. *After the handoff* waits for the next fresh context Project Sentinel starts. |
| "Sent before a reload: check the transcript" | The plugin reloaded while the prompt was on its way, so Project Sentinel cannot tell whether it entered. It never sends it again by itself: look at the transcript, then **Send again** or **Delete**. |
| `/cr queue` typed while Claude works did nothing yet | `/cr` runs when the turn ends, by design: a slash command and its reply become part of the conversation, and the item must not enter the turn under way. To queue mid-turn without that, use *Add work for later* in Operations. |
| Claude never uses the Decision Inbox | Behavior is up to Claude: the tool is for choices that are yours and need not stop the work. Check that Operations → Needs review → *Let Claude leave decisions here* is on (it is offered from the next session start after turning it on, or at once in a new session). Permission prompts never go there. |
| An answer did not reach Claude | A non-blocking answer rides your next message (or **Send now**); while Claude works it goes with the next tool results. A blocking one goes as a prompt of its own once the session is free. |
| "Watcher due · this run changed since it was armed" | A turn ran (yours, or one you pushed with *Deliver now*), the milestones changed, or the context was cleared after the watcher was armed. It never wakes, let alone clears, a run that moved: **Check now** sends the wake into this context, **In 30m** re-arms it from here, **Dismiss** drops it. |
| "A fresh wake is not safe now" | A Fresh (or Smart → fresh) wake needs healthy resume state: the run's milestones, and `NEXT_SESSION_PROMPT.md` of 200 bytes or more written after the milestones last changed. Context → *Ready to resume* says what is missing. **Write notes first** on the watcher asks Claude to write them; **Check now** wakes it in this context instead. |
| "The cache went cold before the wake" | Keep warm did not hold the cache to the wake (it paused itself, or the five-minute cache was past its cap). Waking here would re-read the whole context, so it asks; a Smart watcher with healthy resume state wakes fresh instead. |
| A watcher did not wake while I was away | Watchers are timers in Claude Code's running process: closed, or the machine asleep, nothing wakes. When the session is open again, an overdue watcher reads *Watcher was due 43 minutes ago* and waits for **Wake now**. No daemon or scheduled task is installed. |
| "Which one?" for a watcher time | `at 2:30` could be 02:30 or 14:30: pick one, or type `2:30pm` or `14:30`. Times are local, at least a minute and at most a week ahead. |
| The Cold Resume Guard did not ask | It asks only when the cache has surely lapsed (its known lifetime passed, an hour of quiet, or Claude Code's word at a resume) and the context is at least *Warn above* (100k by default); never for a prompt typed while Claude works, never in a headless run. A cache that may still be warm is never called cold: Claude Code's own requests while you are away (its away summary reads the whole conversation from the cache) keep it warm, so the guard waits until those have lapsed too. |
| The Cold Resume Guard shows tokens, not dollars | It prices only from Claude Code's own estimate for that model, which comes with a model switch or a resumed session. Until one is seen (or after 30 days) it says tokens. |
| Continuing cost more than the Cold Resume Guard said | The figure is Claude Code's own estimate, of the context it reports at a resume, and the question says *at least*. The request that follows re-writes the whole prompt, which can be larger: seen live, the estimate was $0.36 for 90k tokens, and the request re-wrote 129k tokens, adding $0.52 to the cost Claude Code reports. The token count comes first in the question for that reason. |
| *Compact first* put my message back | Before 1.6.2 it always did: the compaction was asked for from inside the held prompt, where Claude Code refuses it. Now it compacts once the prompt is dropped, then sends the message once. If it still says *The compaction did not run (…)*, the words in brackets are Claude Code's reason. Compacting reads the whole conversation once (seen live: 112k uncached plus 72k from the cache for a 185k context), then the context is small. |
| After *Start fresh* or *Compact first* my message was still in the prompt box | Claude Code puts a dropped prompt's text back in the box. Since 1.6.2 Project Sentinel clears it while it holds just that message, because the message goes on by itself; a draft you typed since is left alone. Do not send it again: it reaches Claude once. |
| *Start fresh from resume state* is missing from its question | The resume state is not healthy; the question says why. Context → *Ready to resume* shows the same. |
| My message was not sent and is not in the prompt box | Where the box cannot take text back (some Desktop hosts), the message is kept in Operations (and the status bar's alert line): **Put back**, **Send now** or **Discard**. It is kept in memory only, so a restart loses it. |
| An agent has no Stop or Message | Claude Code's `TaskStop` and `SendMessage` take background agents and teammates only; a foreground agent ends with its turn, and a workflow's agents end with their run. Since 1.6.2 a reload of the plugin keeps what the session saw of its agents (before, a running background agent lost both after a reload). |
| Claude Code shows agents running, but Project Sentinel said none (before 1.7.0) | Project Sentinel used to show only what Claude Code's agent list named, read before a spawn and polled only once it already showed a running agent: a foreground agent stayed invisible until its call returned, and a workflow's agents (which the list never names) never showed. Since 1.7.0 an agent shows from its spawn (*starting* until listed), the list is read every 2 s from any spawn while one is alive, and a workflow's agents are followed through their own calls. The debug log has `agents: <id> started (<type>: <description>…)` per spawn. |
| An agent reads *no longer listed* | Claude Code's list stopped naming it for three looks over six seconds without Project Sentinel seeing it end. A brief gap keeps the last status; one that lasts reads so rather than inventing an end. |
| No Agents view in Activity, or no band above the status bar | Both show only while subagents run (the view also for ten minutes after the last one ended, and while it is open). No percent is shown for an agent unless it keeps its own task list or milestones: then its plan is drawn as a track. |
| Claude says it does not know who stopped an agent | Claude Code tells the conversation that an agent was *stopped by Claude* even when you pressed **Stop**. Since 1.6.2 Claude is told, with its next tool results or your next message, what you did from the Agents panel. |
| A chip or `/cr watchers` opened Operations, but not at its card | Since 1.6.2 it scrolls to the card once the panel has drawn it, trying again for about two seconds; a card near the end of Operations shows where the panel's end allows. If it stays at the top, `claude --debug-file <path>` says why: `ops: scroll to card-ops-watchers refused (try 1): …` with Claude Code's reason. (`/cr agents` and the agents chip open Activity → Agents since 1.7.0.) |
| `/cr queue` opened Operations, but typing went to the prompt box | Before 1.6.2, with the panel already open, the prompt box kept the keyboard and Claude Code refused to focus the field. Now the panel asks for the keyboard first; Claude Code gives it only while the prompt box is empty. The trace says so if it is refused: `ops: focus ops-queue-input refused (try 1): …`. |
| "Run 41 left open work" | An ended run of this project left watchers, queued work or open decisions. Nothing moves by itself: resume that session to carry it on there, or **Bring them here**. |

## Permission Policy

- **"Control Room Permission Policy: … is set to Deny"**: change that category in Guardrails →
  Permissions. Deny categories are refused before any dialog, in every permission mode.
- **A question "Run it / Don't run it" in bypass or auto mode:** a category set to **Ask** asks
  you even where the mode would allow the call: Project Sentinel asks in Claude Code's question
  dialog, and the status bar reads *Waiting for you to approve*. Set the category to *Default* to
  leave it to Claude Code's own behaviour.
- **Headless runs (`claude -p`, CI) failing on installs, deletes or pushes:** with no one to
  answer, a call set to Ask is refused. Set those categories to *Default* for headless use.
- **A server check like `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/` was asked
  about as a download (before 1.7.0):** output sent to `/dev/null`, `NUL` or stdout keeps no file, so
  since 1.7.0 it is *Network* (Default) only. A fetch that names a file (`-o page.html`, `-O`,
  `> page.html`) is still *Downloading files*.
- **Allow is gone (1.4.0):** answering permission prompts is left to Claude Code: add an allow
  rule (`/permissions`) or use one of its permission modes. A saved Allow reads as *Default*; a toast
  says so once, and Guardrails for that session. In Bypass permissions mode nothing changes.

## Machine load

- **"Load unavailable" / "Readings unavailable"**: the sampler could not start or stopped. It restarts up to twice.
  On Windows it uses `typeperf` (and `systeminfo` once, for the total memory). On macOS it uses
  `top` and `sysctl`. On Linux it reads `/proc`. Policies that block these programs stop the
  readings, and the static policy still applies. On a Windows installed in a language other than
  English, `typeperf` knows its counters by other names and finds none, so the readings stay
  unavailable there; Guardrails → Machine load shows the reason (`the sampler exited: Error: No
  valid counters.` or its translation).
- **Readings look high:** they are machine-wide totals, including other programs. That is
  intended, because the goal is to keep the machine responsive. Project Sentinel never stops or
  changes other programs.
- **A heavy command was "held back":** over a ceiling, Project Sentinel refuses *additional* heavy
  jobs (tests, builds, installs…). Claude is told why and can wait or run fewer at once. Set
  *When over* to *Just tell Claude* to only notify, or raise the level.

## Frontier Max

- **Claude Code's effort indicator says `medium`**: it shows the session's own setting (`/effort`).
  Frontier Max sets the effort of each request as it goes out, so the indicator does not change.
  Behavior → Frontier Max → *This context* says the effort sent, and `/cr diagnostics` lists it
  request by request (seen live: `xhigh` on every request while the indicator read `medium`).
- **Is it really in force?** *This context* says how it reached Claude: in the system prompt, as a
  note beside a held system prompt (turned on while the cache was warm), or with the prompt where the
  system prompt's hook is not reached. It is there from the first request of a session, after a
  `/clear` or a compaction, and across a reload of the plugin. *Missing* means requests went out
  without it: `/cr diagnostics` shows which, and `claude --debug` logs a `policy:` line per request.
- **Keep warm's refreshes go at the session's effort**, not Frontier Max's (a refresh is Claude
  Code's own fork, and takes none). On Sonnet 5.5 the refresh read the whole conversation from the
  cache all the same; if a model ever rebuilt for it, the refresh would read *MISS*, the next request
  would show it, and Keep warm would pause itself.

## Model router

- **"not seen answering yet this session"**: the main conversation is only routed to a model id
  Claude Code has already reported in this session (it rejects bare aliases on requests). For
  example, once an Explore subagent has run on Haiku, Economy can route quick turns to Haiku.
- **"was refused — the session model is kept"**: that model isn't available to you (plan,
  organisation allowlist, provider). The Router won't choose it again this session.

## Lazy-exit guard

- **It continued when the work was done:** use strictness *lenient*, or end the work with the
  verification evidence (tests run, results). The guard credits completion evidence.
- **It never triggers:** it only judges turns you started, stands down during handoffs, in plan
  mode and while Claude's finite background work runs (a server or watcher does not count, since
  1.7.0), and has per-turn and per-session caps (Behavior).
- **It came on with Frontier Max before, and does not now:** since 1.7.0 the Frontier Max switch no
  longer turns it on. The Frontier Max profile still sets both.

## Focus view

It changes presentation only. Press `▸` on a row to expand it, or see everything in Activity
(the summary, or *Tool calls*). `/cr focus off` restores Claude Code's own rows.

## Activity

- **A check is not under Validation:** checks are recognised by their runner (`npm test`, `pytest`,
  `cargo build`, `tsc`, `eslint`, `npm run check`, a script named for a simulation, …). A custom
  script with another name shows under *Tool calls* only.
- **"in the background"**: a check sent to the background has no outcome Project Sentinel can see.
- **"diff unavailable"**: no tool reported the lines (a file a shell command created, or a diff
  Claude Code skipped). Project Sentinel never shows `+0 −0` for an unknown change.
- **A file I care about is under "Generated and temporary"**: files in temp, cache and build
  folders (`dist`, `target`, `coverage`, …), in `.claude`, outside the project, and the handoff
  notes are grouped there. Press the row to open it.

## Cost shows "—"

Claude Code didn't report a cost for that session (some hosts or providers don't). Project Sentinel
never estimates. A run total with `+` includes sessions whose cost was not reported.

## Resetting

`/cr reset confirm` restores every setting to the Normal profile and keeps custom profiles. To
start from nothing, uninstall the plugin and delete its store file under
`~/.claude/plugins/store/` (named after the plugin).
