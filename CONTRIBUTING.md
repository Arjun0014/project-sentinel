# Contributing

Thanks for helping. Project Sentinel (called Control Room until 1.4.0; its panel still is) is a
privileged plugin, so changes are held to a few firm rules.
This page lists them and how to check your work.

## Setup

1. Install Claude Code 2.1.289 or newer, and Node.js (only for TypeScript).
2. Install the dev dependency:

   ```bash
   npm install
   ```

3. Load the plugin once so Claude Code writes the engine's type declarations next to it
   (`plugins/project-sentinel/.claude-plugin/types/` and `plugins/project-sentinel/tsconfig.json`,
   both git-ignored and rewritten for each Claude Code build):

   ```bash
   claude --plugin-dir plugins/project-sentinel
   ```

   Then `/exit`. While that session is open, every save reloads the plugin live.

4. Run every check:

   ```bash
   npm run check
   ```

   That is the type-check, the validation (`npm run validate`), the source rules (`npm run source`)
   and the tests. The type-check and the tests run on `.build/mod`, a scratch copy of the plugin
   folder with the repository's `tests/` beside its `hooks/` (`tools/test/mod.mjs` assembles it),
   because the plugin folder ships only the plugin.

   `npm run validate` (`tools/test/validate.mjs`) runs `claude plugin validate --strict` on
   `.build/validate`, a copy of the plugin folder without the declarations step 3 laid
   (`.claude-plugin/types/` and `tsconfig.json`: git-ignored, so the marketplace never serves
   them), then `claude plugin validate .` (the marketplace). With the declarations in place, the
   validator's own type-check of the hooks takes in the engine's full declarations and, on Claude
   Code 2.1.325, runs past its 2048 MiB limit, which `--strict` reports as a failure that says
   nothing about the plugin. The plugin's own type-check against those declarations is
   `npm run typecheck`.

## Rules the code follows

- **Only `hooks/register.tsx` touches `$`.** It builds the `Host` adapter (`hostOf($)`) and
  registers every hook, and nothing else. Every other module works against `hooks/host.ts`, which
  keeps the core testable with a fake host and makes every engine call reviewable in one place.
  `claude plugin validate` lists those calls. A new engine call needs a reason in the PR
  description and an entry in [SECURITY.md](SECURITY.md).
- **Decisions are pure; effects go through the Runtime.** Feature modules (`hooks/features/`)
  are pure functions or small classes without I/O. `hooks/app/runtime.ts` wires them together and
  performs effects.
- **No network, no telemetry, no secrets.** Don't add HTTP calls, telemetry hooks, environment
  reads or project-file reads. File access is limited to `stat` of the handoff notes (in each place
  they may be) and of edited paths, `/proc` on Linux, and the one-time read of the store the plugin
  kept as Control Room.
- **Never loosen safety.** A deny stays a deny, plan mode stays plan mode, and managed settings
  win. Fallbacks (`.catch`) must be at least as strict as Claude Code without the plugin.
- **No invented numbers.** Show cost, context and effort only as Claude Code reports them;
  otherwise show "—".
- **The main conversation's model is the person's.** Nothing sets it on a request; Claude Code's
  `/model` runs only when the person presses *Switch back* (or runs `/cr window back`). A
  subagent's model is set only at its spawn, only with the Agent Model Policy on.
- **Presentation never changes behaviour.** Focus view and the status bar only draw.
- **Hooks stay fast.** A hook has a 10-second own-time budget, so long work runs from timers.
  Don't block `session.end`.
- **Same tree everywhere, through the design system.** Pages are built only from the components in
  `hooks/ui/primitives.tsx`, which draw natively per surface. Decide capabilities by surface
  (`uiOf`), not by whether an element exists in the table. Never use the terminal's `Select`: its
  options cannot be picked or closed with the pointer. Read [docs/DESIGN.md](docs/DESIGN.md) first.
- **Surface modules stand alone.** A `Client` surface module (Kit's `hooks/kit.client.tsx`) runs on
  the surface's drawing thread (in Desktop's own page on Desktop): it never touches `$`, imports
  nothing from the plugin but types, takes everything it draws from its props, and posts only plain
  data. `register.tsx` names it in the element itself, `<ui.Client module="./kit.client.tsx" />`
  with `const ui = $.ui.resolve(e)`: never take `Client` out of the table into a name of its own
  (Anthropic's directory reads that as a Client with no fixed path).
- **Write what Anthropic's directory can read.** `npm run source` (`tools/test/source.mjs`) checks
  the rules its scanner holds a plugin to: no local `h` or `Fragment` in a `.tsx` file (JSX compiles
  to them; a local of that name shadows the environment's factory), no call like `name('!', VALUE)`
  (read as a hook on a pattern: pass an object), no `get`/`set` accessors (use methods), no tests or
  system files in the plugin folder, and every `Client` named with a fixed path in its element.
  Gating hooks decide before `next(e)` or pass it on; nothing answers a permission check.
- **Every SVG goes through `svgDoc` (`ui/theme.ts`)** or carries its root style: Desktop draws an
  interactive SVG in a sandboxed frame, and without `color-scheme: light dark` the frame is
  painted with an opaque (white) canvas on a dark page.
- **One clock per subsystem.** Cache figures are timed by `Runtime.clock()` (the fake host's clock
  in tests), Activity by `Date.now()`, Autopilot by `host.now()`. Mixing them makes tests disagree
  with the views.

## Tests

Tests live in the repository's `tests/` folder, written as if they sat beside `hooks/`
(`import … from '../hooks/…'`), and run with `npm test`, which assembles `.build/mod` and runs
`claude plugin test` on it:

- **Pure logic:** settings, profiles, permissions classifier, guard heuristics, Autopilot reducer
  (and its recovery after a reload), context epochs, the handoff notes' verdict and the loop
  breaker (`epoch.test.ts`), the Agent Model Policy and the subagent choices a 1.7
  store carries into it (`agentmodels.test.ts`), chain, run plan, validation and Activity's signal
  (`signal.test.ts`), activity, resource parsers, answer styles (`answers.test.ts`), the Quest
  log (`quest.test.ts`), the prompt cache model (`cache.test.ts`), Kit's moods, its behaviour model
  (never a jump, moods that settle, reactions, calm) and both renderers (`companion.test.ts`), the
  former store's carry-over (`formerstore.test.ts`) and Git's status parser (`git.test.ts`).
- **Runtime:** `runtime.test.ts`, with the in-memory host in `tests/fixtures/fake-host.ts` (a manual
  clock and recorded effects); Cache Guardian and Keep warm (`guardian.test.ts`); Keep warm's two
  clocks (`keepwarm.test.ts`); the model and effort cache guard and `/cr models` (`models.test.ts`);
  agents through SubagentStart/Stop, their compactions, Resume, and the Advisor
  (`agentsplus.test.ts`); the handoff's background work across contexts, the supervisor and the
  ways out (`supervisor.test.ts`); Handoff Health and Continuity, through a whole handoff
  (`handoff.test.ts`); one run across three fresh contexts with everything at once
  (`chaos.test.ts`, see its header); and replays of real long-run failures, each failing on 1.7.0
  but a positive control (`repro.test.ts`).
- **Engine-driven:** `register.test.ts` and `ui.test.ts`, using the real engine with the world
  answered beneath the plugin by `tests/fixtures/world.ts`, and UI mounted on the `terminal`,
  `desktop` and `mobile` surfaces.

Add a test with every behaviour change. For UI, loop the test over the surfaces rather than
assuming one.

### Continuous integration

`.github/workflows/check.yml` runs on every push to `main` and every pull request: the type-check,
validation of the plugin (as it ships, `npm run validate`) and the marketplace, the source rules and the tests, on Linux, Windows and macOS
with the latest Claude Code from npm, and on Linux with the oldest supported engine (2.1.289). The
engine's type declarations are laid by loading the plugin once in a headless session, which stops
at "Not logged in" before any model call; no step signs in. CI does not run the live machine-load
sampler, a real Autopilot handoff, or Desktop's rendering. Those are checked by hand (below).

## Checking it live

Unit tests don't paint. Before a release:

- Run the plugin in a real terminal at a few widths (80, 120, 150+ columns). Look at the status bar
  and every panel section, and use them with the mouse and the keyboard. On Windows,
  [`tools/console`](tools/console/README.md) runs a session in a console of a given size and reads
  the screen back as text. [`tools/demo`](tools/demo/README.md) plays a scripted turn of real tool
  calls without a model, so the status bar's top line, This turn, the prompt cache and the Quest
  log have something to show (`/demo miss` adds a model switch that rebuilds the cache). Load it
  with `console.ps1 launch … -Also tools\demo`, so its hooks sit beneath Project Sentinel's. With
  Kit on (`/cr companion on`), watch it through the turn and give it a click.
- Run one Autopilot chain end to end, both in the interactive terminal and in the Desktop host
  protocol (stream-json): they order the `/clear` differently. With a cheap model, set the
  threshold a little above the session's base context (`/cr autopilot 64k` against a 45k base),
  then a small multi-step task, and start Claude Code with `--debug-file <path>`: every Autopilot
  step and turn is traced there (`autopilot: … → …`, `turn … started (handoff)`).
- Keep live tests away from your own settings. Every session that loads the plugin from a folder
  shares one plugin store, your own working session included, so a threshold set in a test would
  reach it. Load a frozen copy renamed `cr-test` instead (`npm run snapshot -- <folder>`, then
  `console.ps1 launch … -Plugin <folder>` or `claude --plugin-dir <folder>`): its store, tool and
  policy section are its own, it never carries a former store over, and saving the working copy
  does not reload it mid-test. Disable the installed copy in the test project's
  `.claude/settings.local.json` (`"enabledPlugins": { "project-sentinel@control-room": false }`).
  Claude Code's `/effort` and `/model` save your default for new sessions: pass `--model` instead,
  or put it back after a test. `/cr advisor <model>` runs Claude Code's `/advisor`, which saves
  `advisorModel` in your user settings: put that back too.
- Desktop first through [`tools/desktop-preview`](tools/desktop-preview/README.md): it renders
  the status bar's and the panel's `desktop` element trees as HTML with the CSS the app's own
  renderer gives them (units, row alignment, the picker), so layout and graphics are faithful; the
  font, the design tokens and the colors are close guesses. Then the app itself, which has the last
  word: install the build (bump the pre-release number, `claude plugin update`), start a fresh
  session so it loads it, and look: Kit walks, takes a click and never jumps; the status bar keeps
  its five cells at a narrow and at a wide window. The Code tab hands a session its plugins when the
  session's process starts and reloads open sessions when `installed_plugins.json` changes (a settings
  edit alone reloads nothing), so check an update both ways: a session open during it, and a new one.
  Never drive Claude's own window with simulated input; a read-only capture of it is fine when the
  person agrees.
- On macOS and Linux, turn machine load on and confirm `/cr status` shows live CPU and memory.

## Releases

1. Update `version` in `plugins/project-sentinel/.claude-plugin/plugin.json`, in
   `.claude-plugin/marketplace.json` **and** `VERSION` in `plugins/project-sentinel/hooks/constants.ts`.
   The workspace `package.json` is private and carries no version of its own.
2. Move the `Unreleased` notes in `CHANGELOG.md` under the new version.
3. Run `npm run check`.
4. Push `main`, then run `claude plugin tag plugins/project-sentinel` to create the
   `project-sentinel--v<version>` tag (it checks that the manifest and the marketplace entry
   agree), and push the tag. Never move a tag once it is pushed.
5. For Anthropic's directory, submit the plugin path `plugins/project-sentinel` at that tag. The
   listing text is the plugin folder's `README.md`; its icon is `.claude-plugin/icon.png`.
