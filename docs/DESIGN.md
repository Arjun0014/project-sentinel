# Design

Project Sentinel sits beside someone's work, all day. It has to be glanceable, quiet and obvious.
This page records the decisions behind the UI, so later changes keep it that way.

## Principles

1. **Calm by default.** Show what is happening, not every switch. The status bar carries the run
   at a glance and states only while they matter; settings live in the panel. Color appears only
   when something needs a look, and always means the same thing: green verified, amber waiting for
   the person or worth a look, red a failure or a blocker, blue what is current or under way, gray
   the default, the inactive and the past. Never a rainbow: structure (card titles) is gray.
2. **Attention, then now, then controls, then history.** Each page leads with what needs the
   person, then what is happening, then its settings, then what already happened. A state that is
   simply how things begin ("not ready yet", "nothing yet") stays quiet.
3. **Plain words.** "Hands off at 70%", "Watching for early stops", "Memory 91%". No internal
   names, codes or all-caps labels in the UI. The same helpers (`app/views.ts`) give the status
   bar, the panel, the status line and `/cr status` one voice.
4. **One question per section.** Overview: how is this session doing? Context: when does Claude
   hand off? Behavior: how does Claude work? Guardrails: what may it do? Activity: how far is the
   run, and what needs a look? Setup: profiles, display, about.
5. **Progressive disclosure.** A system is one switch; its finer settings appear only while it is
   on. A choice shows its value, and its options open in place, each with one line on what it means.
6. **Direct manipulation.** Every control takes one click or one Enter. There are no popups in the
   terminal: Claude Code's terminal Select cannot be picked or closed with the pointer, so choices
   open in place instead.
7. **Same tree, native look.** One element tree per view. The design system draws it natively on
   each surface.
8. **Counted, never guessed.** Progress is milestones done of the total Claude listed, cost is
   what Claude Code reports, a check passed when its command did. A fact that cannot be known (a
   background command's outcome, a diff no tool reported) says so in words. A figure derived from
   reported ones (the cache's expiry, its hit ratio, why it was rebuilt) is named as derived
   where it is shown.

## Hierarchy and rhythm

| Level | Terminal | Use |
| --- | --- | --- |
| Title | bold | the panel's name |
| Card title | bold small caps, gray | `NETWORK`, `HANDOFF`: structure, never a color |
| Value | default color | what a row says or is set to |
| Secondary | dim | details, footnotes, units |
| Brand | Claude orange | the brand mark, the Control Room button, the context meter's handoff point, the Quest log |
| Section accent | one theme key per section (`ui/theme.ts` `ACCENT`) | the current tab's underline and, inside a section with several views, the breadcrumb's section name and the current view's brackets; nothing else |
| Status | green verified, amber waiting for you / worth a look, red failure / blocker, blue current / under way | only state; gray for the rest |

A page is a stack of cards. A card is a small-caps title (with an optional aside or *Open ›* link),
a rounded box of rows, and at most a short footnote under it. Rows that need a group's name get a
card of their own (Guardrails' Project, Network, Git, External and Safety), never a heading inside
a box: on Desktop a heading among rows reads as one more row. What a run of such cards shares (an
action, a footnote) follows the last of them (`footnote`). A row reads like a settings list:
the label, with a one-line dim description under it, on the left; the control on the right edge,
at every width. A wide control (a segmented choice) moves under the label when it would take over
half the row, or when the label or description would no longer fit beside it, so text never wraps
into a narrow column. Switches, steppers and pickers always stay on the right. On Desktop rows are
spaced so native buttons never touch.

A row never repeats its card's title. The title names the system ("FRONTIER MAX"); the first row
says what it does ("Hold Claude to senior-engineer standards") and holds its switch. A card with
nothing in it yet (only an empty-state line: "Claude has not changed any files yet.") draws the
line alone, aligned with a box's inside, not a box around one line. Live readings are not rows: they are
fields, a dim label in a fixed column and the reading after it, so a block of them reads as one
calm table (the top of Overview).

In the terminal an action row (`[ Hand off now ]`) keeps a blank line above it, so it never sits
flush under text. A page is at most 80 columns wide: in a wider frame (the frame above the prompt
in a wide terminal, a Desktop pane at full size) it is centred, because a label and its control
drift apart past that. The frame above the prompt is short, so its tabs sit right under the
title.

Desktop lays the tree out in CSS (read from the app's own renderer): a `Box` is a flex box whose
widths, column gaps and horizontal spacing are `ch` and whose heights are `lh`, while row gaps and
vertical spacing count half lines; a `Text` wraps unless it truncates. A row box that sets no
alignment centers its texts, buttons and images on the row, so a mark beside a block of two lines
sits between them: a mark that belongs to the first line aligns its row to the top and is drawn
one line tall (`stateLine`). Its picker is the app's own, as wide as the value it shows, with no
width to set: pickers in a column line up on the right, as pop-up menus do in a settings list.

On Desktop a line that cuts short (a tool call, a file name, a card's aside) sits in a box allowed
to narrow below its text (`clip`). A browser keeps a flex item at least as wide as its content, so
without it the line pushes past its card instead of ending in an ellipsis. Native controls are
wider than their labels: a text field moves under its label sooner than the terminal's does.

Desktop draws a text in a monospace face, as if it were a table or a diagram, when its strings
hold box-drawing characters (U+2500 to U+259F), a rule such as `---`, two or more runs of two
spaces, or any run of three. So on Desktop the parts of one line are never set apart with
padding: `spaced()` joins them with three spaces in the terminal and ` · ` elsewhere, and layout
gaps come from boxes (`columnGap`), never from blanks inside a text. A test walks every page and
the status bar on the `desktop` surface and fails on any text that would trip the rule.

Section accents: Overview orange (`claude`), Context blue (`ide`), Behavior purple (`autoAccept`),
Guardrails teal (`planMode`), Activity periwinkle (`suggestion`), Setup gray (`inactive`). They mark
where you are (the tab's underline, a breadcrumb) and nothing else. Until 1.7.0 every card title
took its section's accent and Overview repeated them on its per-section cards: six hues on one
page, a rainbow that said nothing about state.

**Two levels of navigation never look alike.** The section bar is the first: six labels (native
buttons on Desktop) with the current one's accent underline. A section with several views
(Activity) has a second level, `subNav`: a breadcrumb in words (`Activity › Summary`) over a
captioned row (`View  [ Summary ]  Operations  Agents (2)  Tool calls`), the current view bracketed
in the section's accent and bright, the others dim until focused; on Desktop the breadcrumb over a
bordered group of the app's buttons, the current one primary. Until 1.7.0 the views were drawn
with `segmented`, the marks of a setting's choice (`● Summary  ○ Operations`), and read as random
buttons. A view switch is never a setting's control, and a setting is never drawn as navigation.

## Components (`hooks/ui/primitives.tsx`)

| Component | Terminal | Desktop / VS Code | Mobile |
| --- | --- | --- | --- |
| `switchControl` | `● On` / `○ Off` | native button, primary when on | native button |
| `segmented` | `● Standard  ○ Strict` | native buttons, the chosen one primary | native buttons |
| `picker` | `Ask ▾`, options open in place with hints | native popup (Select), as wide as its value | options open in place |
| `stepper` | `−  70%  +` | native − and + buttons | native buttons |
| `link` | `No limit ›`, goes to the section that owns it | native button | native button |
| `meterBar` | thin line `━━━━──┃──` with the threshold tick | SVG bar | SVG bar |
| `spark` | `▁▂▄▆█` | SVG area chart with a dashed ceiling | SVG |
| `subNav` | a breadcrumb (`Activity › Summary`) over `View  [ Summary ]  Operations  …`, the current view bracketed in the accent, the others dim | the breadcrumb over a bordered group of native buttons, the current one primary | same as Desktop |
| `navBar` | labels with the section's accent underline under the current one | native buttons in one row with an even gap when all fit; otherwise three equal cells per row, each button centred | same as Desktop |
| `workTrack` | a track of milestones, one stop each: `●` done (blue), `◉` the one under way (bold), `○` to come, joined by `─`; scaled past its width, with `4 of 7` beside it. A track of stops, never a filling bar, so it cannot be read as the context meter | SVG circles on a line, the current one pulsing unless *Reduce motion* is on | SVG |
| `cacheClock` | the prompt cache's state as a status line: a dot emptying as its time runs out (`●` `◕` `◑` `◔` `○`) in blue, and its words beside it | the same glyph, as Context's own status reads (a drawn clock face read as a selected radio button there) | same |
| `stateLine` | what the run is doing with its state's mark (the status bar's glyph), wrapping, a dim detail line under it | the status bar's 16-pixel icon, set on the first line | same as Desktop |
| `footnote` | what a run of cards shares, after the last of them: its actions, then a dim note | same, native buttons | same |
| `callout` | rounded border in the status color, title, line, actions | same, drawn natively | same |
| `gauge` | label and %, line meter with ceiling tick, sparkline | label and %, SVG bar | SVG bar |
| `steps` | numbered lines in the accent | same | same |
| `field` | dim label in a 10-cell column, the reading after it | same | same |
| `listItem` | glyph, text, a note at the right edge, and an optional dim second line (why it failed, which command ran) | same | same |
| `timelineStrip` | the turn across the row: `▅` per cell in the color of the kind of work (read, edit, run, check, web, agent), red where a call failed, `▁` where Claude was thinking | SVG strip | SVG strip |
| `legend` | a colored `■` and a dim word per kind, set apart by gaps | a square drawn in the exact color the strip uses (a theme key and an SVG fill are two palettes there) | same as Desktop |
| `columns` | one pair of block glyphs per value (a run's sessions, each its peak context), amber past the handoff line, the current one bright | SVG columns with a dashed handoff line | SVG |
| `diffSquares` | five squares per file, green for lines added and red for removed, dim for the rest | rounded SVG squares | SVG |
| `dots` | one `●` per run of a check, oldest first, in its outcome's color | same | same |
| `levelBadge` | `★ Level 3` | an SVG ring of the way to the next level, and the level | SVG |
| `apart` | a row set a blank line apart from the readings above it, so a switch never sits flush under a meter's figures | no gap (native rows are spaced already) | same as Desktop |
| `card`, `row`, `pair`, `note`, `textRuns`, `spaced` | layout | layout | layout |

The status bar draws its graphics from the same theme (`ui/theme.ts`): `meterCells` and
`svgContextMeter` for Context, `scaleTrack`, `STOP_LOOK` and `svgWorkTrack` for Work, `clockGlyph`
and `svgClock` for Cache, `STATE_MARK` and `svgStateIcon` for the headline's mark.

Every control has a stable `key`. A picker's options are keyed `<picker>:<value>`, a stepper's
buttons `<stepper>-dec` and `<stepper>-inc`. Tests press those keys on every surface.

## The status bar

A mission HUD: one line says what is happening, the line under it carries the run's instruments.

In the terminal (150 columns):

```
◎ Linting · step 3 of 4                                                ▲ RAM 83%    ◆ Control Room
  WORK ●━●━◎─○ 2/4    CONTEXT ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇█▇▇▇▇▇ 47% · hands off 80%    CACHE ● rebuilt 446k      5H ▂▂▂▂▂▂ 63% · 2h14m
```

On Desktop:

```
(▸) Running tests · step 3 of 10                                           ✗ Lint failing   [ ◆ Control Room ]
Work                       Context · hands off at 70%    Cache              Machine                   5-hour usage
●━●━◉─○─○─○  2 of 10       ▬▬▬▬▬▬▬▬▬┃▬▬▬  24%             ◔ warm · 345k      CPU ▮ 34%  RAM ▮ 85%      ▂▂▂ 63% · 2h14m
```

**The headline** says what the run is doing in words a person would use, with a mark for its
state (`app/headline.ts`), so it never says one thing while another is true:

| State | Mark | Says |
| --- | --- | --- |
| working | `▸` blue | the milestone under way in Claude's words (`Rewriting the scheduler · step 3 of 8`), else the call running; a call past 20 seconds adds its time |
| thinking | `◌` dim | `Thinking`: a turn runs and no call does |
| validating | `◎` blue | a check running (`Running tests`), or a milestone being verified |
| handoff | `↻` blue | Autopilot's step: writing the notes, waiting for background work, starting fresh, resuming |
| waiting for a result | `◷` blue | a background job, a scheduled wake-up, a milestone marked *waiting*: `Waiting for the test run · 2 more running`, `Waiting to check back · wakes at 06:12` |
| blocked | `⊘` red | `Blocked:` what only the person can give |
| waiting for you | `◆` amber | Claude asked something, a handoff waits to start fresh, a call set to *Ask* waits for your answer (`Waiting for you to approve: git push`, the command beside it), a decision Claude left blocks the run (`Needs you · 1 decision`, its question beside it), or a watcher waits for you (`Watcher due: S-002 result`, why beside it) |
| sleeping | `◷` blue, a crescent on Desktop | a watcher parks the run: `Sleeping until 14:00 · S-002 result`, with `cache held warm`, `fresh wake · no keep-alive` or `Smart decides at the wake` beside it |
| done, complete | `✓` green | what the last turn did in counted words; `All 6 milestones done` |
| failing | `✗` red | the same, after a turn that left a check failing; the words stay plain, the mark and a chip carry the color |
| ready | `○` dim | before the first turn: the run's objective as Claude stated it, else `Ready` |

The milestone under way is the one in progress; one being verified counts only when nothing is in
progress.

**On the right, only what needs a look**, as chips, the most pressing first: a failing check by
name (`✗ Lint failing`, red; not counted again as an issue), calls that need a look
(`▲ 2 issues`), the guard keeping Claude going, a busy machine in the terminal (`▲ RAM 92%`, amber
near a ceiling, red at it; Desktop has its Machine cell instead), running agents, the Quest log's
level. The orchestration layer adds four, each only while it has something to say, each a control
that opens Activity → Operations at its own card (the agents chip too, at Agents): its mark in its tone, then its words as the button's label (Claude
Code 2.1.289 takes a button's label only; a button with styled text inside is refused there, and the
whole status bar with it). `▲ Review 2` (an amber mark: decisions waiting for the person; when one
blocks the run the headline says it instead), the run budget near or at a limit, `◷ Watcher 1h 42m`
(a watcher armed while the run is not asleep: Claude works, or the person does), and `● Queued 3`
(queued work due when the turn ends, shown only while Claude works). There is no constant count:
an empty queue, no watcher and no budget draw nothing. Then the **Control Room** button: in the
terminal a filled chip in the theme's quiet gray, brand orange while the panel is open; on
Desktop the native primary button, the panel open or closed (the secondary one, gray on the bar's
gray, read as a tag rather than a button).

**The instruments**, each its own shape so they cannot be confused:

- **Work** is a track of milestones with `done/total`: `●` done, `◉` under way, `◎` being
  verified, `◌` waiting or blocked (amber), `○` to come. It carries across handoffs, so it keeps
  climbing while Context saws up and down.
- **Context** is a solid bar: cells filled in its tone (green, amber near the handoff point, red
  past it) over a track in the theme's quietest gray, and the handoff point as a full-height orange
  cell that stands a little proud of the bar. Then the percentage, and Autopilot's point or the
  step under way (`· hands off 80%`, `· Writing the handoff`).
- **Cache** is a clock face emptying as the prompt cache's lifetime runs out (`◕ 42m left`),
  shown in the terminal only while it can matter: when you are away, or for a few minutes after a
  costly rebuild (`● rebuilt 446k`, amber). While Claude works, its requests keep the cache warm.
  On Desktop it keeps its cell: `warm` while Claude works (with what it holds where there is room,
  `warm · 345k`), the time left while you are away, `—` before anything is cached. While a turn
  runs it never reads `lapsed?`: Claude Code's own requests keep it warm.
- **Machine** (Desktop) is CPU and memory as two slim level bars with their percentages
  (`CPU ▮ 34%  RAM ▮ 85%`), amber near a ceiling and red at it; in a narrower band the caption reads
  `CPU · RAM` and the labels go, and in a compact one the bars go too.
- **5H** is the plan's five-hour window on the right edge, as Claude Code reports it
  (`$.session.usage().rateLimits`, and `session.measure` when a window moves a point): a thin bar
  (`▂`, the used part blue, amber from 80%; on Desktop a 4-pixel bar), the percentage and the time to
  the window's reset (`5H ▂▂▂▂▂▂ 63% · 2h14m`), redrawn once a minute only while it counts down. Thin,
  so it never reads as the context meter, the work track or the cache's clock. `5H —` before the
  first reading; `5H reset · new window` once the reset time passes (or the window leaves the list)
  until a response reads the new window, never the old number; `5H limit · 1h30m` in red at 100% or
  when Claude Code ends a request on the rate limit, the one reading that never drops for room.
  Nothing in the terminal on an account with no five-hour window (Desktop: `Plan usage —`). It
  replaced the run's cost there (1.7.0): the cost is a history figure, kept in Overview, Context →
  Run and the Run Budget; the five-hour window is what decides whether the person can keep working.
- **Watcher**, only while a watcher parks the run: `WATCHER ◷ 1h 42m`, the time to its wake (the
  headline says until when, and why). On Desktop it takes the Machine cell's place, a crescent and
  `1h 42m · 14:00`: nothing runs, so the machine is not the story.

Settings (a profile, the threshold) are never shown. What needs the person takes a line of its own
above, one at a time, the most pressing first, with its buttons: a handoff (**Hand off now** and
**Later**, or **Start fresh**), the machine at its limit, a watcher that waits for the person
(**Check now**, **Start fresh** when that is safe, **In 30m**, **Dismiss**), a message the Cold
Resume Guard kept (**Put back**, **Send now**, **Discard**), the run budget holding automation
(**Continue anyway**, **Budget ›**), the Watcher Scout's suggestion (**Create watcher**, **Change
time**, **Ignore**), a written handoff waiting for background work (**Hand off now**, **Stop & hand
off**, **Keep waiting** near its end or once stalled, **Call off**), a handoff the supervisor found
stuck (what holds it, and what fits). None of them while a turn runs, except the handoff's.

**The agent band**, above all of it and only while subagents run: one line per agent (what it is
doing in a few words, for how long, its own plan's count when it keeps one), up to three; past
three, one line counting them by what they do (`5 agents · 2 reading · 2 editing · 1 checking`).
Each line is a control that opens Activity → Agents. It is gone the moment no agent runs.

**Quiet grays are theme colors, not dim text.** Terminals draw dim text very differently (one
draws it as plain gray), and a dim block reads as a slab. The empty part of a graphic and the
HUD's top edge use the theme's `subtle` gray, which every terminal draws as the same quiet color.

**Width decides the detail in the terminal.** The instruments take the richest tier that shows
every reading: names (`WORK`, `CONTEXT`, `CACHE`; `5H` names itself at every width) from 72 columns, so they do not come and go as
readings appear, the meter from 24 cells down to 6, the track from 16 stops down to 5 (scaled,
the count beside it exact), the notes only with room. Only then does the least important reading
drop. Docked beside the panel (about 80 columns) the whole line still fits.

**On Desktop the surface lays the row out, not counted cells.** Each reading is a column weighted
by what it holds (Work and Context 3, Cache and Machine 2, on a zero basis, so a column never
drifts as its value changes): a quiet caption over its graphic and value, the caption starting where
its reading starts. The five-hour reading takes what it needs at the right edge (its caption is not
pushed to the end: flush right, it sat apart from its wider reading, seen in the app). The five readings always keep their cells, a dim word standing in for
one with nothing yet (`No milestones yet`, `—`): a row that dropped them collapsed to two readings
with a wide empty middle (a release candidate of 1.3.0, seen in the app). Width decides the detail
in three tiers, each sized so every cell fits: wide from 110 columns, medium from 80, compact below
(fewer stops, a shorter meter, `2/10`, `None`). The track's stops and the meter take their size
from the band's width alone. So the row never overflows, nothing drifts and its rhythm holds, from
500 pixels to a full window. Every
graphic is an image of a fixed size (`Svg` with `width` and `height`), never an interactive
frame: Desktop sizes a frame on its own (300 pixels without a width) and may paint it opaque,
which drew 1.2.0's work track as a white bar.

**Git is Claude Desktop's own.** The Git strip on Desktop belongs to the app. The mod API's render
components (`AskUserQuestion`, `UserMessage`, `AssistantMessage`, `ToolUse`, `ToolResult`,
`ToolGroup`, `ToolProgress`, `CommandOutput`, `Spinner`, `TurnDuration`, `InfoNotice`,
`SessionMode`, `PromptHint`, `AbovePrompt`, `Pane`) include nothing for it, so a plugin can
neither hide nor move it. Project Sentinel draws no Git UI on Desktop; its Git line is
terminal-only (Overview and `/cr status`).

## Kit, the companion

Off by default: a status bar is calm first. Turned on (Setup → *Companion*), Kit, a small
Claude-orange creature with pointed ears, a tail, a cream belly and big eyes, shows by what it does
what the headline says in words. It never carries information the bar does not; it is company, not
a reading.

**What it does.** Fifteen moods, each a small program of acts Kit chooses among (never the same
twice running): sitting by and stretching, yawning, grooming, scratching an ear, swishing its
tail, looking around or down at the headline, now and then a short stroll, rarely a butterfly to
paw at, a leaf to pounce on, a sneeze (idle; more yawns at night); pacing with thought dots
(thinking); typing on a tiny keyboard, sparks now and then (working); reading a book in round
glasses, or walking with a magnifier (searching); sitting up, tail twitching, a spinner beside it
(a check running); a dance with confetti, then happy (a green finish); a start, then a facepalm and
sweat (a failure); facing you with a question mark (the run needs you); fanning itself (a busy
processor or a nearly full context); tending a small fire (Keep warm); dozing, faded (the cache
about to lapse); nodding off, then curled up asleep with rising Zzz and now and then a dream
bubble. Moments get their own act: a flag planted when a milestone is done, the dance at a green
finish (never beside a failing check), a facepalm when a check fails, a poke at the fire when Keep
warm refreshes. At a handoff it picks up the notes and carries them off to the right; when the
fresh context begins it walks back in from the left. It walks in once per context, never again on
a redraw.

**Episodes, not a loop.** In the moods it spends longest in (idle, thinking, working, searching, a
check running, waiting for you) Kit plays episodes: short runs of two to five acts that read as
one thing done (a stroll to somewhere it has not been, a look round, then a sit; typing, a look at
the notes, more typing; a dash across the lane to read there). They are picked at random by
weight, none comes again within its cooldown and none twice running, and its walks go where it has
been least lately, so over a few minutes it uses the whole lane and never settles into a pattern.
Every episode ends calm: a sit, a hold.

**Never a jump.** Kit's place changes only by walking, its facing only through a frame that faces
you, and it sits, stands and lies down only through a crouch or a lie-down frame; a mood change
starts from where Kit is. A new mood applies once it has held for 1.2 seconds, and a mood holds at
least 2.5 seconds, so a flicker between tool calls restarts nothing; a handoff, a finish, a
failure, a question and a fresh context apply at once. (Checked by a test that runs every mood at
random moments with touches, and by thousands of fuzzed runs.)

**A touch.** A click on Kit is a reaction to where it lands. On the head, a pat: it shuts its eyes,
lays its ears back and leans into it, hearts rising (a second pat soon after, a purr). On the nose
(the front of its face), a boop. On the tail, a flick and a look round. On the body, a pet: a purr
with hearts, a roll for a belly rub, a blush and a wiggle, a high five, a hop, a spin; every one
before any repeats, never the same twice in a row. At most one reaction in 0.9 seconds; three
clicks in a few seconds are a giggling twirl, five make it dizzy, and then it ignores clicks for
four seconds. Asleep, it is startled (and dozes off again); while Claude works, it only looks up
with a `!`. A click beside it while it idles turns its head there, and sometimes it walks over. Kit
never opens anything: the status bar's button does.

**Calm rules.** Most acts sit still and only blink, breathe or swish a tail; walks are slow. On a
busy processor it draws two frames a second at most and never walks, at the processor's limit one;
only *Reduce motion* holds one still pose for the mood, with at most one mark (a `?`, a `z`).
Switched on, it moves within a second whatever the load. Memory merely high changes nothing.

**How it is drawn.** One surface module, `hooks/kit.client.tsx`, plays Kit on the surface's own
clock in the terminal and on Desktop (the plugin does no work between frames; a frame that changes
nothing draws nothing). In the terminal Kit is 20 × 10 pixels in five rows of half blocks, standing
on the HUD's top edge, with glyphs every terminal font has (`♥ * ? z ♪`). On Desktop it is an image
per frame in a lane above the headline, as wide as the status bar and 84 pixels high: 40 × 24 art
pixels at 3 pixels each, shaded from the top left and outlined, one path per color, with crisp
edges so no seam shows at a display scale like 125%, a soft shadow under it, and its props and
particles in the same pixels. The image fills its region whatever size the app's cells are, so a
click lands where it looks. VS Code, which draws no surface module, shows the mood's still pose as an image. If its
module ever fails to draw, it says so and is left out until the plugin reloads; the status bar
draws without it.

## Overview

Overview reads in the order the eye needs it. What needs the person sits on top (a callout with
its buttons), and once after a fresh install a short **Sentinel is on** card: Autopilot protecting
the context at its point, Frontier Max at its effort, where Guardrails live, Activity's views, and
that Work carries across handoffs while Context starts over, each with a way there, until *Got
it*. Then the run: its number and session, its whole cost and its objective, and in the terminal
the Git branch with the uncommitted files (`main · 3 uncommitted · 2 ahead`; Desktop shows Git
itself), and right under it, unboxed, what is happening now (the status bar's headline in full,
with its state's mark, and a failing check or calls that need a look). An **Operations** card
only while something is in it (`Review 1` with whether it blocks the run, `Watcher · wakes in 1h
42m`, `Queued 2`, `Agents 1 active`, the budget), linking to Activity → Operations. Then the three
lifecycles as cards, in the order they last: **Work** (the track; carries across handoffs),
**Context** (the meter and Autopilot's switch; starts over at each handoff) and **Cache** (its
state after a dot that empties as its time runs out, what it holds and Keep warm's switch; starts
over with each fresh context and lapses when left idle). Each card's footnote says how it starts
over, which is the one thing that tells the three apart. Then one card per remaining section
(Behavior, Guardrails, Activity, Setup with the profile). Overview shows only live summaries:
nothing of the orchestration layer while it is empty.

## The prompt cache

Context's **Cache** card: the cache's state in words (`Warm · lapses in about 40 min`), a meter of
the time left, what it holds (`506k tokens cached · 9 requests`, the share read from the cache),
then Keep warm with its next refresh or why there is none, its idle limit, *Ask before a model
switch* and *Keep policies stable*. The lifetime sits in the card's aside, with where it came
from (`1-hour cache · as Claude Code reports it`, or `Lifetime not known yet`). The footnote says
that the expiry, the hit ratio and the causes are derived from the tokens Claude Code reports.

**Cache health** lists the recent rebuilds, one line each (what happened, tokens re-cached, when),
and under it, wrapping, its kind (*Preventable*, *Expected*, *Unexplained*) and what would avoid
the next one. Only a costly rebuild that could have been avoided, or one that keeps happening
with nothing changed, raises its voice (amber, and a toast); compaction is expected and dim.

**Cold Resume Guard** follows the cache: its switch with whether it would ask now and why
(`Armed: the cache lapsed over 616k tokens, so your next message is asked about first`), *Warn
above* as a stepper, why the cache lapsed, the price (Claude Code's own estimate, or `Tokens only`)
and the last answer. **Ready to resume** says what a fresh context would get (the run and its
objective, the milestones done and under way, what it reads with a `✓` or `✗` each, what it
carries, the next action) and, when it is not ready, why. While Autopilot waits for the person to
start the fresh context, it sits right under the handoff card, where that choice is made.

**Last handoff**, after one: what the handoff left for the fresh context and what the fresh
context picked up, each a `✓`, `✗` or a dim `○` (not needed), with a score (`5 of 6`), and below
them the verified milestones whose evidence is stale or being changed now. It is counted from tool
calls, never from what Claude said, and the footnote says so.

Context leads with the Autopilot's state and meter, then its **Handoff** card: while Autopilot is
off, the three numbered steps it would take (they teach); while it simply watches, one sentence
(`At 70% Claude finishes the step it is on and writes NEXT_SESSION_PROMPT.md. The context is
cleared, and Claude carries on by itself.`) and *Hand off now*, since the settings card under it
says the same; while a handoff is under way, the supervisor's line (what holds it, since when),
each background task with what it is and *Stop*, and the ways out. **Ready to resume** speaks up in
red and amber only while a fresh start is in play (a handoff under way, the Cold Resume Guard
armed, a watcher that may wake fresh); otherwise it reads *Not needed yet* in gray: a run that
keeps no notes yet is how a run begins, not a fault.

## Activity

Activity is the run in detail, signal before noise. Its summary reads top to bottom:

1. **Quest**, only with the Quest log answer style: the level and the way to the next, the run's
   latest awards with their XP, and the achievements.
2. **Run progress**: the objective (Claude's statement of it, else the person's latest substantial
   request), the milestone track and a window of milestones around the one under way (one being
   verified shows its evidence, a blocked one what it waits for, in red; a completed one whose
   verification went stale is amber, *verification stale*, with what changed and what to rerun,
   one being changed by later work says so quietly, one a later check re-verified says by what),
   then *Now*, *Next* and *Checks*. A stale milestone outside the window still gets its line.
3. **This turn**: where the turn's time went, as a strip across the turn colored by the kind of
   work (read, edit, run, check, web, agent; red where a call failed; blank where Claude was
   thinking) with its legend, then a few counted lines ("Changed 4 files · 3 in code, 1 in tests",
   "Ran tests twice, passing after a fix"). No model writes them.
4. **Attention**, only when something needs a look: verified milestones whose evidence went stale
   (with *Accept files as they are*), failures nothing has fixed (with the first line of the error
   and how many tries), refusals, calls the Resource Governor held back, long-running and unusually
   slow calls, then failures a later attempt recovered from, dimmed.
5. **Validation**: one row per kind of check (tests, build, type-check, lint, checks, simulation),
   the latest run deciding its state, with its command and duration, and its runs as dots when it
   ran more than once (`●●●`, red then green: passing after a fix).
6. **Changes**: code, tests, docs, config and other, each a short list of files that open their
   diff in place, with five diffstat squares and `+n −n`. Generated and temporary files (temp and
   build folders, `.claude`, the handoff notes, anything outside the project) fold into one row. A
   file with no reported diff says `diff unavailable`, never `+0 −0`.

Activity's views are a second level of navigation (`subNav`): *Summary · Operations · Agents ·
Tool calls*. **Operations** (its label carries a count while something waits for the person) is
the run over time, leading with what needs the person:

1. Callouts, only while they apply: an ended run of this project that left open work (**Bring them
   here**, **Not now**), a message the Cold Resume Guard kept, the Scout's suggestion, a watcher that
   waits for the person.
2. **Needs review**: each decision with its id, milestone and whether it blocks; its context; a
   button per option and a field for free text; **Not needed**. An answered one says how it will
   reach Claude (`Goes with Claude's next tool results`, `Goes with your next message (or Send
   now)`, `Goes with W-1's wake (19:35), or with your next message` while a watcher parks the run). Its footnote says permission prompts stay Claude Code's own.
3. **Mission Queue**: *Add work for later* (one field, under its label at every width: the terminal
   draws a field as wide as its text, which beside the label squeezed it into a column of single
   words) and *Deliver* (next safe boundary, after this
   turn, after the current milestone, after the handoff), then the items in order with when each
   goes, ↑ ↓, **Edit**, **Deliver now**, **Delete**; the last few delivered.
4. **Watchers**: each with its local time and countdown and how it resumes, in a few words (*Keep
   warm · cache held to the wake*, *Fresh · nothing spent while it sleeps*, *Smart · wakes fresh*);
   *Details* (Smart's reason, the checkpoint, where it came from), **Wake now**, **Edit**
   (reschedule, strategy), **Pause**, **Delete**; Claude Code's own wake-ups beside them, dim and
   read only. Then the form: *Waiting for*, *Wake* (`in 2h`, `at 14:00`, or **In 30m** · **1h** ·
   **2h** · **4h**; an ambiguous time offers both readings), *Resume* (Smart, Keep warm, Fresh); the
   switches; the footnote that watchers live in Claude Code's process.
5. **Agents**: one line leading to Activity → Agents, its own view while agents run or ran in the
   last ten minutes: the main conversation first, then each agent under its parent (a workflow's
   under its run) with its type, model, status and elapsed time, what it is doing now (its latest
   call, and when it last acted), its calls, its own plan as a work track when it keeps a task list
   or milestones (never a percent made up from time or calls), its result or failure, **Stop** and
   **Message** only where Claude Code takes them. An agent shows from its spawn (*starting* until
   Claude Code lists it); one missing from the list for a moment keeps its status. *What Claude may
   start ›* goes to Guardrails, whose Subagents card links back.
6. **Run budget**: one quiet row (*No budget for this run · Set a budget ›*) until one is set; then
   a meter per limit, the limits' fields and stepper, *At a limit*, **Continue anyway** at a limit.
7. **Recent operations**: one dim line of the last few steps (queued, delivered, armed, woke,
   stopped), set apart from the Run budget card above it: beside it, it read as the budget's history.

A status bar chip, `/cr agents` and `/cr decisions` open Operations at their card, scrolled to its
top once the panel has drawn it; `/cr queue` and `/cr watch` alone focus the field to type in.
An empty card is one line; a row's details open in place; every form field is one line.

Every tool call, newest first, is the last view (*Tool calls*).

Context draws the run's sessions as columns, each its peak context against the handoff line, once
a run has two or more: the sawtooth of a long run, at a glance.

## Answer styles

Behavior's first card sets how Claude writes to the person: *Standard* (Claude Code's own way),
*Brief* (the answer first), *Plain technical* (after the writing rules of ASD-STE100), *Mission
control* (GO, NO-GO and HOLD calls) and *Quest log*. Each option says in one line what it means,
and the card shows a line written in the chosen style ("GO · tests pass, 3 of 3"), so the choice
is made by example. A style governs Claude's messages only, never code, files or commit
messages. Claude Code's own output style, when the person chose one, outranks it: the card then
reads *Paused* and says why.

The Quest log is a game layer kept honest. XP comes only from outcomes Project Sentinel counts itself
(a milestone done, once per run; a check's first pass in a turn, or passing again after failing;
a plan of three or more finished; a handoff with verified notes), never from lines, files or tool
calls, which would reward churn, and never from what Claude says. Claude is told never to state
points itself. Levels need more XP each time (50·n·(n−1)), so they mark real runs, not single
edits.

## Moving around

The section bar sits at the top of the pane, which scrolls as one. Choosing a section starts the
new page at its top, and every page ends with a quiet `↑ Sections` that brings the bar back. A
section's views sit right under the bar, as the second level (see Hierarchy and rhythm); Tab walks
the section bar, then the views, then the page's controls. The
mod API has no pinned region inside a pane; drawing one over the scroll position would fight the
engine's own scrolling and keyboard focus, so it is not done.

## Copy

Sentence case. Verbs for actions ("Hand off now", "Start fresh context", "Restore safe
defaults"). Footnotes say what a system does for you, not how it is built, in one or two lines.
Numbers carry units ("700k", "70%", "$4.18"); unknowns read "—". Nothing is estimated.

## Checking a change

Unit tests check that every section draws on every surface, and that controls change settings.
They cannot judge looks. Before shipping a UI change, open it in a real terminal at 80, 120 and
150+ columns, use it with the mouse and the keyboard, and look at Desktop. On Windows,
[tools/console](../tools/console/README.md) runs a session in a real console of a given width,
reads the screen back as text (`-Attrs` shows where the focus ring is) and saves a PNG of it;
[tools/desktop-preview](../tools/desktop-preview/README.md) renders the Desktop trees with the
app's layout rules when the app itself cannot be driven.
