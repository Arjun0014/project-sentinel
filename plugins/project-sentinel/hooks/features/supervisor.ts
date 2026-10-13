/**
 * The Handoff Supervisor: a watchdog over Context Autopilot's handoff.
 *
 * Every step of a handoff moves on an event (features/autopilot.ts), never a timer. The supervisor
 * does not move steps: it looks, deterministically and without a model call, at how long the
 * handoff has stood in its step and at the facts that explain it (the background work in flight
 * and what each task is, a question open to the person, the notes on disk, whether a turn runs),
 * and says what holds it: work worth waiting for, a server that never ends, a decision only the
 * person can make, a step whose event never came. The one thing it acts on by itself is the end
 * of a wait's patience (the machine's `waitExpired`): past it the handoff goes on and leaves the
 * work running for the fresh context, which Claude Code delivers its result to (seen live).
 *
 * Pure: the Runtime gathers the facts at its tick and acts on the diagnosis.
 */

import type { AutopilotState, BackgroundTask } from './autopilot'
import { blockingOf, classOf } from './autopilot'

export type SupervisorStatus = 'idle' | 'moving' | 'waiting' | 'stalled' | 'needs-you'

export type BlockerKind =
  /** Infrastructure (a server, a watcher): never holds a handoff, said so the person knows it keeps running. */
  | 'persistent'
  /** Finite work whose result may belong in the notes. */
  | 'finite'
  /** Finite work that outlasted the patience: the handoff goes on and leaves it running. */
  | 'long-finite'
  /** A task nothing recognises: waited for, and asked about once. */
  | 'unknown'
  /** Claude waits for the person's answer (a permission prompt, a question): the turn cannot end without it. */
  | 'decision-blocking'
  /** A choice that is the person's, that holds nothing up (Wait for me, an interrupted step). */
  | 'decision'
  /** A step whose turn never started or whose end was never seen. */
  | 'turn'
  /** The notes check, the clear or the compaction never finished. */
  | 'step'

export type SupervisorAction = 'handoff-now' | 'stop-and-handoff' | 'keep-waiting' | 'cancel' | 'start-fresh' | 'hand-off' | 'later'

export type Diagnosis = {
  status: SupervisorStatus
  /** The step, in words ("Waiting for background work"). */
  phase: string
  /** How long the handoff has stood in this step. */
  forMs: number
  blocker: { kind: BlockerKind; text: string } | null
  /** When the wait's patience ends (the handoff then goes on by itself), while it waits. */
  goesOnAt: number | null
  /** What the person can do now, most useful first. */
  actions: SupervisorAction[]
}

export type SupervisorInput = {
  now: number
  state: AutopilotState
  stateSince: number | null
  isTurnRunning: boolean
  /** The turn running is the handoff's own (its prompt, a retry). */
  isHandoffTurn: boolean
  background: readonly BackgroundTask[]
  waitSince: number | null
  waitUntil: number | null
  /** The person (or the patience) said not to wait: the handoff goes on when the turn running ends. */
  skipWait: boolean
  notesWritten: boolean | null
  /** Questions open to the person: Sentinel's Ask approvals, a running AskUserQuestion. */
  questionsOpen: number
  /**
   * How long the main conversation has shown no activity (no prompt, step, call or turn end); null when
   * not known. A turn whose start a reload hid still shows itself by its calls.
   */
  quietMs: number | null
  lastError: string | null
  continuation: 'clear' | 'compact' | 'manual'
}

/** How long each step may stand before the supervisor calls it stalled. */
export const STALL_MS = {
  requested: 2 * 60_000,
  verifying: 60_000,
  clearing: 60_000,
  resuming: 2 * 60_000,
  compacting: 11 * 60_000,
} as const

/**
 * How long the session must have been quiet (no prompt, step, call or turn end) before the supervisor
 * trusts that no turn runs unseen: a wait holding nothing is moved on, a handoff turn called stalled.
 */
export const QUIET_MS = 30_000

/** How long an unrecognised task is waited for before the isolated classifier is asked about it, once. */
export const CLASSIFY_AFTER_MS = 60_000

const PHASE: Record<AutopilotState, string> = {
  off: 'Off',
  armed: 'Watching the context',
  pending: 'Handoff due',
  requested: 'Starting the handoff',
  handoff: 'Claude is writing the notes',
  'waiting-background': 'Waiting for background work',
  verifying: 'Checking the notes',
  clearing: 'Starting the fresh context',
  compacting: 'Compacting the context',
  resuming: 'Resuming in the fresh context',
  awaiting: 'Waiting for you',
}

const names = (tasks: readonly BackgroundTask[]): string => {
  const shown = tasks.slice(0, 2).map(t => t.description)
  return `${shown.join('; ')}${tasks.length > 2 ? ` and ${tasks.length - 2} more` : ''}`
}

export function diagnose(i: SupervisorInput): Diagnosis {
  const forMs = i.stateSince === null ? 0 : Math.max(0, i.now - i.stateSince)
  const base = { phase: PHASE[i.state], forMs, goesOnAt: null as number | null }
  const result = (status: SupervisorStatus, blocker: Diagnosis['blocker'], actions: SupervisorAction[], goesOnAt: number | null = null): Diagnosis => ({ ...base, status, blocker, actions, goesOnAt })
  // A question to the person holds any turn, the handoff's included: only they can end it.
  if (i.isTurnRunning && i.questionsOpen > 0 && i.state !== 'off' && i.state !== 'armed') {
    return result('needs-you', { kind: 'decision-blocking', text: 'Claude is waiting for your answer before the turn can end' }, [])
  }
  switch (i.state) {
    case 'off':
    case 'armed':
      return result('idle', null, [])
    case 'pending':
      return i.isTurnRunning
        ? result('moving', null, ['hand-off'])
        : result('needs-you', { kind: 'decision', text: 'The step that reached the handoff point was interrupted: hand off when you are ready' }, ['hand-off', 'later'])
    case 'requested':
      return forMs >= STALL_MS.requested && !i.isTurnRunning
        ? result('stalled', { kind: 'turn', text: 'The handoff prompt has not started a turn' }, ['hand-off', 'cancel'])
        : result('moving', null, [])
    case 'handoff':
      // A turn running, or one a reload hid that still shows itself: Claude is writing the notes.
      if (i.isTurnRunning || i.quietMs === null || i.quietMs < QUIET_MS) return result('moving', null, ['handoff-now'])
      return result('stalled', { kind: 'turn', text: 'The handoff turn ended without Sentinel seeing it end' }, ['start-fresh', 'hand-off', 'cancel'])
    case 'waiting-background': {
      const blocking = blockingOf(i.background)
      const persistent = i.background.filter(t => classOf(t) === 'persistent')
      const keeps = persistent.length === 0 ? null : { kind: 'persistent' as const, text: `${names(persistent)} ${persistent.length === 1 ? 'keeps' : 'keep'} running and ${persistent.length === 1 ? 'is' : 'are'} not waited for` }
      if (blocking.length === 0) return result('moving', keeps, [])
      if (i.skipWait) return result('moving', { kind: 'turn', text: 'Not waiting for the background work: the handoff goes on when this turn ends' }, ['cancel'])
      const unknown = blocking.filter(t => classOf(t) === 'unknown')
      const isOver = i.waitUntil !== null && i.now >= i.waitUntil
      const kind: BlockerKind = isOver ? 'long-finite' : unknown.length === blocking.length ? 'unknown' : 'finite'
      const left = isOver ? ', past its wait: the handoff goes on and leaves it running' : ''
      const text = `${i.notesWritten === false ? 'Notes not written yet; ' : ''}waiting for ${names(blocking)}${left}`
      // Past the patience with no turn running the Runtime moves it on at once; a long wait is the person's to cut short.
      const status: SupervisorStatus = isOver ? 'stalled' : 'waiting'
      return result(status, { kind, text }, ['handoff-now', 'stop-and-handoff', 'keep-waiting', 'cancel'], i.waitUntil)
    }
    case 'verifying':
      return forMs >= STALL_MS.verifying ? result('stalled', { kind: 'step', text: 'The notes check has not finished' }, ['start-fresh', 'hand-off']) : result('moving', null, [])
    case 'clearing':
      if (i.isTurnRunning) return result('moving', { kind: 'turn', text: 'A turn you queued runs first; the context is cleared when it ends' }, [])
      return forMs >= STALL_MS.clearing ? result('stalled', { kind: 'step', text: 'The fresh context has not started' }, ['start-fresh']) : result('moving', null, [])
    case 'compacting':
      return forMs >= STALL_MS.compacting ? result('stalled', { kind: 'step', text: 'The compaction has not finished' }, ['start-fresh']) : result('moving', null, [])
    case 'resuming':
      return forMs >= STALL_MS.resuming && !i.isTurnRunning ? result('stalled', { kind: 'turn', text: 'The fresh context has not taken up the work' }, []) : result('moving', null, [])
    case 'awaiting':
      return result(
        'needs-you',
        {
          kind: 'decision',
          text: i.lastError === null ? (i.continuation === 'manual' ? 'The notes are written: start the fresh context when you are ready' : 'The handoff waits for you to start the fresh context') : `The handoff stopped: ${i.lastError}`,
        },
        ['start-fresh', 'later', 'cancel'],
      )
  }
}

/**
 * The one step the supervisor takes by itself, if any: a wait past its patience goes on (`waitExpired`;
 * under a running turn it goes on when that turn ends), and a wait that holds nothing any more, in a
 * quiet session, goes on (`unblocked`: no turn's end would come to move it). Never a judgement that a
 * turn ended: the turn's own end does that. Null when nothing is due.
 */
export function dueStep(i: Pick<SupervisorInput, 'now' | 'state' | 'isTurnRunning' | 'background' | 'waitUntil' | 'skipWait' | 'quietMs'>): 'waitExpired' | 'unblocked' | null {
  if (i.state !== 'waiting-background') return null
  const blocking = blockingOf(i.background)
  if (blocking.length > 0) return !i.skipWait && i.waitUntil !== null && i.now >= i.waitUntil ? 'waitExpired' : null
  if (i.isTurnRunning || i.quietMs === null || i.quietMs < QUIET_MS) return null
  return 'unblocked'
}

/** The tasks the isolated classifier should be asked about now: unrecognised, waited for at least a minute, not asked yet. */
export function toClassify(i: { now: number; waitSince: number | null; background: readonly BackgroundTask[]; asked: ReadonlySet<string> }): BackgroundTask[] {
  if (i.waitSince === null || i.now - i.waitSince < CLASSIFY_AFTER_MS) return []
  return i.background.filter(t => classOf(t) === 'unknown' && t.by !== 'classifier' && t.by !== 'person' && !i.asked.has(t.id))
}

/** One line for the debug trace: the diagnosis as it changed. */
export function traceLine(d: Diagnosis): string {
  const time = d.forMs >= 60_000 ? `${Math.round(d.forMs / 60_000)}m` : `${Math.round(d.forMs / 1000)}s`
  return `supervisor: ${d.phase} for ${time} · ${d.status}${d.blocker === null ? '' : ` · ${d.blocker.kind}: ${d.blocker.text}`}`
}
