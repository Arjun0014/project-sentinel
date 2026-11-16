/**
 * Context epochs: which context a usage reading belongs to.
 *
 * RUN state carries across contexts (the objective, the milestones, the evidence, decisions, queued
 * work, watchers, the background work left running). CONTEXT usage does not: the tokens in this
 * conversation, its percentage, the handoff threshold's verdict on it. Each real context boundary
 * (`/clear` by Sentinel or the person, a compaction, a resume, a fresh start) opens a new epoch, and
 * a new epoch's usage is UNKNOWN until a reading that can only belong to it arrives.
 *
 * Seen in a real run: right after an automatic handoff, the fresh context was told it had hit its
 * handoff threshold at ~701k tokens, the old context's size. Claude Code documents no promise that
 * the session's context figures reset at `/clear` (only cost does), a `session.measure` may come
 * late, and a request made before the boundary may answer after it. So readings are judged by where
 * they came from, never by when they arrived:
 *
 *   a main-loop request (`turn.step`)   proven when the request was made in this epoch (its step is
 *                                        stamped with the epoch at `turn.step`'s start)
 *   a compaction's own count            proven: the engine counted the compacted context
 *   a session-level reading             (`session.measure`, `$.session.usage()`) never proves an epoch
 *                                        and never changes a proven one: it reports the session's last
 *                                        response, which is either this context's own request (already
 *                                        counted) or a figure from before (stale, higher or lower). Before
 *                                        an epoch is proven it is held aside (`provisional`, shown only
 *                                        after a reload, never acted on); one equal to the previous
 *                                        epoch's last reading is that epoch's echo
 *
 * Context Autopilot acts only on `trustedTokens` (null while unresolved), so an old context's size can
 * never hand a fresh context off. A fresh context that really grows large (it read a huge file) is
 * measured by its own requests, so it still hands off at the right point.
 *
 * The window sanity check lives here too: a model switch that suddenly reports a far smaller window
 * (a host that takes a 1M model for a 200k one) must not hand off at once, and then again and again.
 *
 * Pure: the Runtime stamps the steps and feeds the readings.
 */

/** What opened a context: a boundary Claude Code reported, or a reload of the plugin within one. */
export type EpochSource = 'startup' | 'resume' | 'fork' | 'clear' | 'handoff' | 'fresh' | 'compact' | 'reload'

export type ReadingVia = 'step' | 'compaction' | 'resume' | 'session'

export type Reading = { tokens: number; at: number; via: ReadingVia }

export type ContextEpoch = {
  /** The generation: one more at each boundary, never reused in a runtime. */
  id: number
  source: EpochSource
  startedAt: number
  /** True once a reading that can only belong to this context arrived. */
  isResolved: boolean
  /** The first proven reading: where this context started. */
  baseline: number | null
  /** The latest proven reading. */
  current: Reading | null
  /** A session-level reading not proven to be this context's: after a reload it is shown (marked), never acted on. */
  provisional: Reading | null
  /** The context window as the host last reported it: a fact of the model, carried across boundaries. */
  window: number | null
  /** Main-conversation turns that ended in this context, and requests answered in it. */
  turns: number
  steps: number
  /** The context before this one as it ended: a reading equal to its end is that context's, not this one's. */
  previous: { id: number; source: EpochSource; tokens: number | null; endedAt: number } | null
  /** Readings set aside as not this context's, and the last reason (the trace and the panel say it). */
  rejected: number
  lastRejected: string | null
}

export type Verdict = { epoch: ContextEpoch; accepted: boolean; why: string }

/** How close a reading must be to the previous context's last one to be taken as its echo. */
const ECHO_TOLERANCE = (tokens: number): number => Math.max(2_000, Math.round(tokens * 0.01))

/**
 * How far from this context's last proven request a session-level reading may stand before it is counted
 * as a foreign figure (for the trace and the panel); it never changes the proven figure either way.
 */
const SESSION_SLACK = (tokens: number): number => Math.max(50_000, Math.round(tokens * 0.25))

export function firstEpoch(source: EpochSource, at: number): ContextEpoch {
  return { id: 1, source, startedAt: at, isResolved: false, baseline: null, current: null, provisional: null, window: null, turns: 0, steps: 0, previous: null, rejected: 0, lastRejected: null }
}

/** The last figure known for this context, proven or not: what the next epoch must not take for its own. */
export function lastKnown(ep: ContextEpoch): number | null {
  return ep.current?.tokens ?? ep.provisional?.tokens ?? null
}

/**
 * A boundary: a new context, its usage unknown. The engine's own count of the new context proves its
 * size at once (a compaction's `tokensAfter`, a resumed transcript's `context_tokens`); every other
 * boundary waits for a request made in it. The window is the model's and carries over.
 */
export function nextEpoch(ep: ContextEpoch, source: EpochSource, at: number, opts: { tokens?: number | null; via?: 'compaction' | 'resume' } = {}): ContextEpoch {
  const after = opts.tokens ?? null
  const proven = after !== null && Number.isFinite(after) && after > 0
  return {
    id: ep.id + 1,
    source,
    startedAt: at,
    isResolved: proven,
    baseline: proven ? after : null,
    current: proven ? { tokens: after, at, via: opts.via ?? 'compaction' } : null,
    provisional: null,
    window: ep.window,
    turns: 0,
    steps: 0,
    previous: { id: ep.id, source: ep.source, tokens: lastKnown(ep), endedAt: at },
    rejected: 0,
    lastRejected: null,
  }
}

const reject = (ep: ContextEpoch, why: string): Verdict => ({ epoch: { ...ep, rejected: ep.rejected + 1, lastRejected: why }, accepted: false, why })

/**
 * A main-loop request answered. `epochId` is the epoch its request was made in (stamped at the step's
 * start); null when this runtime never saw it start (a reload mid-turn: a reload is no boundary, so the
 * request is this context's unless a boundary came since).
 */
export function stepReading(ep: ContextEpoch, input: { epochId: number | null; tokens: number; at: number }): Verdict {
  if (!Number.isFinite(input.tokens) || input.tokens < 0) return reject(ep, 'not a token count')
  const isOwn = input.epochId === ep.id || (input.epochId === null && ep.source === 'reload')
  if (!isOwn) return reject(ep, input.epochId === null ? 'a request whose start was never seen, after a boundary' : `a request made in context ${input.epochId}, answered after the boundary`)
  const reading: Reading = { tokens: input.tokens, at: input.at, via: 'step' }
  return {
    epoch: { ...ep, isResolved: true, baseline: ep.baseline ?? input.tokens, current: reading, provisional: null, steps: ep.steps + 1 },
    accepted: true,
    why: ep.isResolved ? 'a request made in this context' : 'the first request made in this context: its baseline',
  }
}

/**
 * A session-level reading (`session.measure`, `$.session.usage()`): the window always counts (a model's
 * fact); the token figure proves nothing on its own (see the module's comment).
 */
export function sessionReading(ep: ContextEpoch, input: { tokens: number | undefined; window: number | undefined; at: number }): Verdict {
  const withWindow = input.window !== undefined && Number.isFinite(input.window) && input.window > 0 ? { ...ep, window: input.window } : ep
  const tokens = input.tokens
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return { epoch: withWindow, accepted: false, why: 'no token figure' }
  const prev = ep.previous?.tokens ?? null
  if (!ep.isResolved) {
    if (prev !== null && Math.abs(tokens - prev) <= ECHO_TOLERANCE(prev)) return reject(withWindow, `the previous context's last reading (${prev}), not this context's`)
    return { epoch: { ...withWindow, provisional: { tokens, at: input.at, via: 'session' } }, accepted: false, why: 'not proven to belong to this context yet' }
  }
  const last = ep.current?.tokens ?? 0
  if (Math.abs(tokens - last) > SESSION_SLACK(last)) return reject(withWindow, `far from this context's last request (${last}): not this context's`)
  // This context is measured by its own requests: the session's echo of the last one adds nothing, and an older one must not lower it.
  return { epoch: withWindow, accepted: false, why: "this context's own requests measure it" }
}

/** A main-conversation turn ended in this context. */
export function turnEnded(ep: ContextEpoch): ContextEpoch {
  return { ...ep, turns: ep.turns + 1 }
}

/** What Autopilot may act on: this context's proven size, or null while it is not proven. */
export function trustedTokens(ep: ContextEpoch): number | null {
  return ep.isResolved && ep.current !== null ? ep.current.tokens : null
}

/**
 * What the status bar shows: the proven size; after a reload (no boundary, the figure is very likely
 * this context's) the unproven one, marked; after a boundary nothing until it is proven.
 */
export function shownTokens(ep: ContextEpoch): { tokens: number | null; isProvisional: boolean } {
  const trusted = trustedTokens(ep)
  if (trusted !== null) return { tokens: trusted, isProvisional: false }
  if (ep.source === 'reload' && ep.provisional !== null) return { tokens: ep.provisional.tokens, isProvisional: true }
  return { tokens: null, isProvisional: false }
}

/** How much this context grew from where it started (null while unproven). */
export function growthOf(ep: ContextEpoch): number | null {
  const t = trustedTokens(ep)
  return t === null || ep.baseline === null ? null : t - ep.baseline
}

/** A context Sentinel's own handoff or fresh start opened. */
export const isAfterHandoff = (ep: ContextEpoch): boolean => ep.source === 'handoff' || ep.source === 'fresh'

/** One line for the debug trace. */
export function epochLine(ep: ContextEpoch): string {
  const size = ep.isResolved ? `${ep.current?.tokens ?? '?'} tokens (baseline ${ep.baseline ?? '?'}, ${ep.current?.via ?? '?'})` : `unresolved${ep.provisional === null ? '' : ` (provisional ${ep.provisional.tokens})`}`
  return `context ${ep.id} (${ep.source}): ${size}; ${ep.turns} turns, ${ep.steps} requests${ep.previous === null ? '' : `; previous context ${ep.previous.id} ended at ${ep.previous.tokens ?? '?'}`}`
}

// ---------------------------------------------------------------------------
// The context window's sanity

/**
 * The window changed in a way no boundary explains and that would make Autopilot act at once: a
 * switch to a model the host reports with a far smaller window while this context already holds more
 * than that window's handoff point, or a context larger than its window (impossible as reported).
 */
export type WindowAnomaly = {
  at: number
  why: 'shrank' | 'over'
  fromWindow: number | null
  toWindow: number
  fromModel: string | null
  toModel: string | null
  tokens: number | null
  hostVersion: string | null
}

/** How much smaller a window must report to be a discontinuity (a fifth smaller is a different class of model). */
export const WINDOW_SHRINK = 0.75

export function windowAnomaly(input: {
  before: number | null
  after: number
  modelBefore: string | null
  modelAfter: string | null
  tokens: number | null
  /** The handoff point at the new window (null when unknown). */
  threshold: number | null
  /** The context began at or after the change (a boundary explains it). */
  isNewContext: boolean
  at: number
  hostVersion: string | null
}): WindowAnomaly | null {
  const base = { at: input.at, fromWindow: input.before, toWindow: input.after, fromModel: input.modelBefore, toModel: input.modelAfter, tokens: input.tokens, hostVersion: input.hostVersion }
  if (input.tokens !== null && input.after > 0 && input.tokens > input.after * 1.01) return { ...base, why: 'over' }
  if (input.isNewContext || input.before === null || input.after >= input.before * WINDOW_SHRINK) return null
  if (input.tokens === null || input.threshold === null || input.tokens < input.threshold) return null
  return { ...base, why: 'shrank' }
}

/** The anomaly in words, for the alert and the trace. */
export function anomalyText(a: WindowAnomaly): string {
  const k = (n: number | null) => (n === null ? '?' : n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`)
  const model = a.toModel === null ? '' : ` for ${a.toModel}`
  if (a.why === 'over') return `Claude Code reports a ${k(a.toWindow)} window${model} under a ${k(a.tokens)} context: the figures cannot both be right`
  return `The context window changed from ${k(a.fromWindow)}${a.fromModel === null ? '' : ` (${a.fromModel})`} to ${k(a.toWindow)}${model} with ${k(a.tokens)} in this context`
}
