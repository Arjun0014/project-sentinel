/**
 * Names and limits shared across Control Room. Everything here is plain data.
 */

/** The plugin's manifest name; `$.state` contracts are keyed by it. */
export const PLUGIN = 'project-sentinel'

/** The Control Centre pane's id (also its `ui.render` requestId). */
export const PANE_ID = 'control-room'

export const PANE_TITLE = 'Control Room'

/** The slash command the person types: `/control-room`. */
export const COMMAND = 'control-room'

/** A short alias, registered only when no other command already uses it. */
export const SHORT_COMMAND = 'cr'

/** The names of the entries in the plugin's `$.store` (one JSON file per plugin, shared by all sessions). */
export const STORE_ENTRIES = {
  settings: 'settings.v1',
  runsIndex: 'runs.index.v1',
  runCounter: 'runs.counter.v1',
  runPrefix: 'run.v1.',
  /** Quest log: lifetime XP, achievements and the latest awards. */
  quest: 'quest.v1',
  /** The prompt cache: the lifetime learned and Keep warm's verdict on itself. */
  cache: 'cache.v1',
  /** A fresh install's first-run card (1.7.0): when it was shown, and when the person dismissed it. */
  onboarding: 'onboarding.v1',
} as const

/** The handoff file Context Autopilot asks Claude to create or update. */
export const DEFAULT_HANDOFF_FILE = 'NEXT_SESSION_PROMPT.md'

export const LIMITS = {
  /** Recent tool calls kept for the Activity tab. */
  activityItems: 300,
  /** Files tracked in the Changes tab. */
  changedFiles: 200,
  /** Hunk text kept per changed file (Code elements cap at 10 000 chars). */
  hunkChars: 6000,
  /** Runs kept in the Session Chain history. */
  runsKept: 30,
  /** Sessions kept per run. */
  sessionsPerRun: 60,
  /** Custom profiles a person may save. */
  customProfiles: 12,
  /** Debounce for settings and run writes to `$.store`. */
  persistDebounceMs: 1500,
  /** Coalescing window for view-model publication. */
  publishCoalesceMs: 120,
  /** How often Activity's running times refresh while a tool call runs. */
  runningTickMs: 5000,
  /** Minimum gap between two resource pressure notices sent to Claude. */
  pressureNoticeGapMs: 45_000,
  /** How long a sample may be stale before monitoring reads as unavailable. */
  sampleStaleMs: 30_000,
  /** Delay between the handoff turn ending and the automatic /clear. */
  clearDelayMs: 1200,
  /** How long the handoff waits for its /compact command's compaction (a long context takes a while) before it gives up. */
  compactByCommandMs: 10 * 60_000,
  /**
   * How long Control Room waits for the fresh session after its /clear
   * resolves. The interactive terminal finishes the reset after the command
   * returns; the Desktop host protocol before it.
   */
  clearSettleMs: 15_000,
  /** Characters of the person's request and Claude's answer the guard reads. */
  guardTextChars: 6000,
  /** Model classification timeout for the guard and router. */
  classifyTimeoutMs: 12_000,
  /** From this much warm cached context, a model switch the person makes is confirmed first. */
  guardSwitchTokens: 100_000,
} as const

/** The plugin's version, as in its manifest (kept in step on release). */
export const VERSION = '1.7.0'

/** Version floor this release was verified on (Desktop 2.1.289, CLI 2.1.292). */
export const MIN_ENGINE = '2.1.289'
