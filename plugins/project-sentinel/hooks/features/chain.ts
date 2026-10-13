/**
 * Session Chain: sequential contexts of one piece of work, kept as one run.
 *
 * A run starts with a fresh `claude` process (or continues when a session
 * that belongs to a stored run is resumed). Each /clear — the autopilot's or
 * the person's — ends the current session entry and opens the next one;
 * compactions are recorded as transitions inside a session (the session id
 * does not change). Pure data functions; persistence is the runtime's.
 */

import { LIMITS } from '../constants'
import type { HandoffRecord } from './handoff'
import type { EvidenceStore } from './evidence'
import { type RunOps, emptyOps } from './ops'
import { type Plan, emptyPlan } from './plan'
import type { RunQuest } from './quest'

export type SessionStart = 'startup' | 'resume' | 'clear' | 'handoff'

export type SessionEnd = 'handoff' | 'clear' | 'exit' | 'resume' | 'logout' | 'other'

export type Transition = {
  kind: 'compact' | 'auto-compact' | 'handoff-compact'
  at: number
  tokensBefore: number | null
  tokensAfter: number | null
}

export type SessionEntry = {
  id: string
  index: number
  startedAt: number
  endedAt: number | null
  start: SessionStart
  end: SessionEnd | null
  /** Highest context fill seen (tokens), the figure the chain shows. */
  peakTokens: number
  lastTokens: number
  window: number | null
  /** Cost as Claude Code reported it for this session; null when not exposed. */
  costUsd: number | null
  turns: number
  model: string | null
  /** Why the session ended, in words (e.g. "context reached 702k"). */
  endNote: string | null
  transitions: Transition[]
}

export type Run = {
  v: 1
  id: string
  number: number
  startedAt: number
  updatedAt: number
  root: string
  profile: string
  status: 'active' | 'ended'
  sessions: SessionEntry[]
  /** Claude's milestones for the run (its task list), carried across handoffs. Absent in runs before 1.0.2. */
  plan?: Plan
  /**
   * The run's objective: Claude's statement of it with its milestones when it gives one, else the
   * person's latest substantial request, in their words.
   */
  objective?: string | null
  /** Who stated the objective: Claude with its milestones, or the person's request. Absent before 1.3.0 (the person's). */
  objectiveBy?: 'claude' | 'person'
  /** Quest log: the run's XP and the milestones already paid for. Absent until it earns any. */
  quest?: RunQuest
  /** The latest handoff: its health when the notes were checked, and the fresh context's continuity. Absent before 1.2.0. */
  lastHandoff?: HandoffRecord | null
  /**
   * The run over time (features/ops.ts): the Mission Queue, the Decision Inbox, Watchers, the Run
   * Budget. Kept with the run, so it survives /clear, handoffs, reloads and a resumed session.
   * Absent before 1.6.0; read through `opsOf`, which validates it.
   */
  ops?: RunOps
  /**
   * Milestone evidence (features/evidence.ts): the files each milestone's work changed while under way,
   * and a snapshot of what each completed milestone stood on (its green checks, its files' blob ids),
   * compared with the workspace later. Absent before 1.7.0; read through `evidenceOf`.
   */
  evidence?: EvidenceStore
}

export function newSession(id: string, index: number, start: SessionStart, now: number): SessionEntry {
  return {
    id,
    index,
    startedAt: now,
    endedAt: null,
    start,
    end: null,
    peakTokens: 0,
    lastTokens: 0,
    window: null,
    costUsd: null,
    turns: 0,
    model: null,
    endNote: null,
    transitions: [],
  }
}

export function newRun(input: {
  id: string
  number: number
  sessionId: string
  root: string
  profile: string
  start: SessionStart
  now: number
}): Run {
  return {
    v: 1,
    id: input.id,
    number: input.number,
    startedAt: input.now,
    updatedAt: input.now,
    root: input.root,
    profile: input.profile,
    status: 'active',
    sessions: [newSession(input.sessionId, 1, input.start, input.now)],
    plan: emptyPlan(),
    objective: null,
    ops: emptyOps(),
  }
}

export const currentSession = (run: Run): SessionEntry | undefined => run.sessions.at(-1)

function withCurrent(run: Run, now: number, change: (s: SessionEntry) => SessionEntry): Run {
  const last = currentSession(run)
  if (!last) return run
  return { ...run, updatedAt: now, sessions: [...run.sessions.slice(0, -1), change(last)] }
}

/** Live figures after a turn (from `session.measure` / `$.session.usage()`). */
export function measure(
  run: Run,
  input: { tokens: number | undefined; window: number | undefined; costUsd: number | undefined; model?: string },
  now: number,
): Run {
  return withCurrent(run, now, s => ({
    ...s,
    lastTokens: input.tokens ?? s.lastTokens,
    peakTokens: Math.max(s.peakTokens, input.tokens ?? 0),
    window: input.window ?? s.window,
    costUsd: input.costUsd ?? s.costUsd,
    model: input.model ?? s.model,
  }))
}

export function countTurn(run: Run, now: number): Run {
  return withCurrent(run, now, s => ({ ...s, turns: s.turns + 1 }))
}

export function recordTransition(run: Run, transition: Transition): Run {
  return withCurrent(run, transition.at, s => ({ ...s, transitions: [...s.transitions, transition].slice(-20) }))
}

/** Ends the current session and opens the next one under `nextId`. */
export function rollOver(
  run: Run,
  input: { end: SessionEnd; endNote: string | null; nextId: string; nextStart: SessionStart; now: number },
): Run {
  const ended = withCurrent(run, input.now, s => ({ ...s, endedAt: input.now, end: input.end, endNote: input.endNote }))
  if (ended.sessions.some(s => s.id === input.nextId)) return ended
  const index = (currentSession(ended)?.index ?? 0) + 1
  const sessions = [...ended.sessions, newSession(input.nextId, index, input.nextStart, input.now)].slice(-LIMITS.sessionsPerRun)
  return { ...ended, sessions, status: 'active' }
}

export function endRun(run: Run, end: SessionEnd, now: number): Run {
  const ended = withCurrent(run, now, s => (s.endedAt === null ? { ...s, endedAt: now, end } : s))
  return { ...ended, status: 'ended' }
}

export type RunTotals = {
  sessions: number
  costUsd: number | null
  /** True when some session's cost was not exposed, so the total is partial. */
  isCostPartial: boolean
  turns: number
  peakTokens: number
  handoffs: number
  durationMs: number
}

export function totals(run: Run, now: number): RunTotals {
  let cost = 0
  let known = 0
  let turns = 0
  let peak = 0
  let handoffs = 0
  for (const s of run.sessions) {
    if (s.costUsd !== null) {
      cost += s.costUsd
      known += 1
    }
    turns += s.turns
    peak = Math.max(peak, s.peakTokens)
    if (s.end === 'handoff') handoffs += 1
  }
  const last = currentSession(run)
  const end = run.status === 'ended' ? (last?.endedAt ?? run.updatedAt) : now
  return {
    sessions: run.sessions.length,
    costUsd: known === 0 ? null : cost,
    isCostPartial: known > 0 && known < run.sessions.length,
    turns,
    peakTokens: peak,
    handoffs,
    durationMs: Math.max(0, end - run.startedAt),
  }
}

/** A short run id: time-ordered, unique enough for one machine's history. */
export function runIdOf(now: number, random: number): string {
  return `${now.toString(36)}-${Math.floor(random * 0xffffff).toString(36)}`
}

/** Keeps the newest ids, most recent first, without duplicates. */
export function updateIndex(index: readonly string[], id: string): { index: string[]; dropped: string[] } {
  const next = [id, ...index.filter(x => x !== id)]
  return { index: next.slice(0, LIMITS.runsKept), dropped: next.slice(LIMITS.runsKept) }
}

export function isRun(v: unknown): v is Run {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Partial<Run>
  return r.v === 1 && typeof r.id === 'string' && typeof r.number === 'number' && Array.isArray(r.sessions)
}
