/**
 * Context Autopilot as a pure state machine: `step(model, event, config)`
 * returns the next model and the effects the runtime must carry out
 * (append a notice, submit the handoff prompt, run /clear, ...). Keeping the
 * transitions pure makes every path unit-testable without an engine.
 *
 *   off → armed → pending → requested → handoff → verifying → clearing → resuming → armed
 *                                          ↘ waiting-background ↗   ↘ compacting ↗
 *   any failure that cannot be recovered automatically → awaiting (START FRESH CONTEXT)
 *
 * Every step is moved on by an event, never by a timer: the turn that crossed
 * the threshold ending, the handoff turn starting (recognised by its prompt)
 * and ending, the notes checked on disk, the fresh session reported, the
 * continuation turn starting. A turn that is not Control Room's own (a prompt
 * the person queued) never moves a handoff step on.
 *
 * A handoff turn that stops while background work still runs (a render, a
 * test run) waits in `waiting-background`. Claude Code says what is in flight
 * at every turn's Stop and reports each task's end with a notification (a
 * prompt whose origin is `task-notification`, starting a turn of its own when
 * the session is idle). The wait ends at the first turn's end, whoever's turn
 * it was, at which Claude Code lists no blocking work in flight: the notes
 * are then checked and the context cleared. The turn's text never decides it.
 *
 * Not every task blocks (features/background.ts): a dev or preview server, a
 * watcher, a tunnel never ends by itself, so it is never waited for. Claude
 * Code keeps background work across `/clear` and delivers its notification to
 * the fresh context (seen live, 2.1.296), so a wait is also bounded: past the
 * patience (`waitMs`, Context → Autopilot) the Handoff Supervisor hands off and
 * leaves the work running for the fresh context, which is told what still runs.
 * The person can end the wait at any time (`skipWait`), keep waiting
 * (`keepWaiting`) or call the handoff off (`cancelHandoff`).
 */

import type { ContinuationMethod } from '../core/settings'
import { type ClassBy, type TaskClass, classifyTask, isBlocking } from './background'

export type AutopilotState =
  | 'off'
  | 'armed'
  | 'pending'
  | 'requested'
  | 'handoff'
  | 'waiting-background'
  | 'verifying'
  | 'clearing'
  | 'compacting'
  | 'resuming'
  | 'awaiting'

/**
 * One task of background work Claude Code reports in flight (a shell, an agent, a monitor): its id,
 * what it is, and whether it holds the handoff back (features/background.ts). A task without a class
 * (a record written before 1.7.0) is `unknown`, which blocks, as every task did then.
 */
export type BackgroundTask = { id: string; description: string; class?: TaskClass; why?: string; by?: ClassBy; command?: string }

/** A task's class, `unknown` when none was given. */
export const classOf = (t: BackgroundTask): TaskClass => t.class ?? 'unknown'

/** The tasks that hold a written handoff back: everything but infrastructure. */
export const blockingOf = (tasks: readonly BackgroundTask[]): BackgroundTask[] => tasks.filter(t => isBlocking(classOf(t)))

/** How long a written handoff waits for blocking background work by default before it hands off and leaves it running. */
export const DEFAULT_WAIT_MS = 20 * 60_000

export type Autopilot = {
  state: AutopilotState
  /** The effective threshold in tokens, or null while the window is unknown. */
  threshold: number | null
  /** True when the threshold was lowered under Claude Code's own auto-compact point. */
  isClamped: boolean
  triggeredTokens: number | null
  triggeredAt: number | null
  /** When the handoff prompt was submitted: the handoff file must be newer. */
  handoffSince: number | null
  /** The handoff turn's id (the first one, not a retry's), once it began. */
  handoffTurnId: string | null
  /**
   * The background work a handoff waits for, as Claude Code reports it: what its Stop listed in
   * flight as the handoff turn ended, less each task a notification (or a TaskStop) reported
   * ended, replaced by every later turn's Stop. Empty outside `waiting-background`.
   */
  background: BackgroundTask[]
  /** How many background tasks this handoff waited for (0 when it waited for none). */
  waitedFor: number
  /** When the last of that work was reported ended: the notes can be compared with it. */
  backgroundEndedAt: number | null
  /** While the handoff waits: whether the notes were on disk, written for this handoff, at the last look (null before one). */
  notesWritten: boolean | null
  /** When the wait for background work began, and until when it waits before it hands off and leaves the work running. */
  waitSince: number | null
  waitUntil: number | null
  /** The person said not to wait: the handoff goes on with background work left running. */
  skipWait: boolean
  /** Work still running as the handoff went on (servers, or work it stopped waiting for): the fresh context is told. */
  leftRunning: BackgroundTask[]
  /** When the machine entered its current state (the Runtime stamps it): how long a step has been stuck. */
  stateSince: number | null
  retries: number
  /** Do not trigger again until the context passes this many tokens. */
  snoozeUntil: number | null
  /**
   * A fresh context (after a handoff or a clear) still reading itself in: the notes, the docs,
   * the code. It has started no work yet, so it must not hand off yet.
   */
  isFreshContext: boolean
  /** The context's size when the fresh context started working: it gets room to work from there. */
  freshStart: number | null
  /** Handoffs completed in this process (each one a new session in the chain). */
  completed: number
  /** One human-readable line describing what the autopilot is doing. */
  note: string
  lastError: string | null
}

/**
 * Whose turn it is: the person's, Control Room's own handoff, retry or
 * continuation, one a background task's notification began (Claude Code
 * submits it with the origin `task-notification` when the task ends while the
 * session is idle), another (no typed prompt), or unknown (it began before a
 * reload of the plugin, so its start was never seen).
 */
export type TurnKind = 'person' | 'handoff' | 'retry' | 'continuation' | 'notification' | 'other' | 'unknown' | OpsTurnKind

/**
 * Project Sentinel's own turns outside a handoff (app/operations.ts): a watcher's wake, a fresh
 * resume's first turn, queued work or answers it delivered, the turn that writes notes before a
 * fresh park. Autopilot moves on none of them.
 */
export type OpsTurnKind = 'wake' | 'resume' | 'queued' | 'answer' | 'park'

/** A turn that may be the handoff's: its own, or one whose start a reload hid (the handoff carried on across it). */
const isHandoffTurn = (turn: TurnKind): boolean => turn === 'handoff' || turn === 'retry' || turn === 'unknown'

export type AutopilotConfig = {
  continuation: ContinuationMethod
  fallbackToCompact: boolean
  autoContinue: boolean
  /**
   * How long a written handoff waits for blocking background work before it hands off and leaves the
   * work running for the fresh context (0: never waits). DEFAULT_WAIT_MS when absent.
   */
  waitMs?: number
}

export type AutopilotEvent =
  | { kind: 'configure'; enabled: boolean; threshold: number | null; isClamped: boolean }
  | { kind: 'context'; tokens: number; window: number | undefined; isInTurn: boolean; now: number }
  | {
      kind: 'turnComplete'
      reason: 'answer' | 'aborted' | 'refusal' | 'error'
      turn: TurnKind
      now: number
      /** The background work Claude Code listed in flight at this turn's Stop; null or absent when no Stop was seen (an interrupt). */
      background?: readonly BackgroundTask[] | null
    }
  /** The handoff prompt's turn began (recognised by its text at turn.start). */
  | { kind: 'handoffStarted'; now: number; turnId?: string }
  /** Claude Code reported a background task ended: its notification (completed, failed, killed), or a TaskStop that stopped it. */
  | { kind: 'backgroundEnded'; id: string; status: string | null; now: number }
  /** The notes, as last looked at while the handoff waits: written for this handoff, or not (yet). */
  | { kind: 'notesSeen'; isWritten: boolean }
  /** The person started a turn of their own while the fresh context waited for the continuation. */
  | { kind: 'personTookOver'; now: number }
  | { kind: 'handoffVerified'; isOk: boolean; now: number }
  | { kind: 'clearDone'; now: number }
  | { kind: 'clearFailed'; error: string }
  | { kind: 'compactDone'; now: number }
  | { kind: 'compactFailed'; error: string }
  | { kind: 'submitFailed'; error: string }
  | { kind: 'continuationStarted'; now: number }
  /** A fresh context started working (its first milestones, edit or agent), or ended a turn without: its size then. */
  | { kind: 'oriented'; tokens: number }
  | { kind: 'engineCompacted' }
  /** `/cr handoff` or Hand off now. `isRestart`: a handoff whose turn ended unseen and left no notes is begun again (handoffVerdict). */
  | { kind: 'manualHandoff'; now: number; isRestart?: boolean; skipWait?: boolean }
  /**
   * `/cr fresh` or Start fresh context, once freshVerdict found it safe: the notes written, nothing it
   * must wait for in flight (or the person chose not to wait), no turn running. `left`: what Claude
   * Code last listed running, which keeps running into the fresh context (it is told).
   */
  | { kind: 'manualFresh'; now: number; left?: readonly BackgroundTask[] }
  | { kind: 'snooze'; tokens: number; window: number | undefined }
  | { kind: 'externalClear' }
  /** A task's class changed (the isolated classifier, or the person): a wait held only by it may end. */
  | { kind: 'reclassified'; id: string; class: TaskClass; why: string; by: ClassBy; isTurnRunning: boolean }
  /** The person: do not wait for background work (it keeps running for the fresh context). */
  | { kind: 'skipWait'; now: number; isTurnRunning: boolean }
  /**
   * The Handoff Supervisor: the wait's patience is over, so the handoff goes on and leaves the work
   * running. With a turn running (Claude recording a result), it goes on when that turn ends.
   */
  | { kind: 'waitExpired'; now: number; isTurnRunning?: boolean }
  /**
   * The Handoff Supervisor: the wait holds nothing it must wait for any more (the last blocking task
   * was stopped or reclassified, or a reload found only servers left), no turn runs and none has shown
   * any activity for a while, so no turn's end will come to move it on.
   */
  | { kind: 'unblocked'; now: number }
  /** The person: wait longer for the background work. */
  | { kind: 'keepWaiting'; now: number; ms: number }
  /** The person called the handoff off: this context carries on; the notes stay on disk. */
  | { kind: 'cancelHandoff'; tokens: number; window: number | undefined }
  /** The fresh context was told what the old one left running. */
  | { kind: 'leftRunningTold' }

export type AutopilotEffect =
  | { kind: 'appendPending'; tokens: number; threshold: number; window: number | undefined }
  | { kind: 'submitHandoff' }
  | { kind: 'submitRetry' }
  | { kind: 'verifyHandoff' }
  /** Look at the notes (written for this handoff or not) while it waits for background work: the words shown depend on it. */
  | { kind: 'checkNotes' }
  | { kind: 'clear' }
  | { kind: 'compact' }
  | { kind: 'submitContinuation'; via: 'clear' | 'compact' }
  | { kind: 'notify'; text: string; level: 'info' | 'warn' | 'error' }

export type Step = { model: Autopilot; effects: AutopilotEffect[] }

export function initialAutopilot(): Autopilot {
  return {
    state: 'off',
    threshold: null,
    isClamped: false,
    triggeredTokens: null,
    triggeredAt: null,
    handoffSince: null,
    handoffTurnId: null,
    background: [],
    waitedFor: 0,
    backgroundEndedAt: null,
    notesWritten: null,
    waitSince: null,
    waitUntil: null,
    skipWait: false,
    leftRunning: [],
    stateSince: null,
    retries: 0,
    snoozeUntil: null,
    isFreshContext: false,
    freshStart: null,
    completed: 0,
    note: 'Off',
    lastError: null,
  }
}

/**
 * The room a fresh context gets to work before it may hand off again: at
 * least 20k tokens, or a tenth of the threshold. Without it, a context that
 * fills most of the way to the threshold just reading itself in (system
 * prompt, tools, the notes, the docs, the code) would hand off after a step
 * or less, each handoff costing a turn and a cache rebuild; with a threshold
 * set low enough, it would hand off before doing any work at all, forever.
 */
export const roomOf = (threshold: number): number => Math.max(20_000, Math.round(threshold * 0.1))

/**
 * Where this context hands off: the threshold, or for a fresh context the
 * point that leaves it room to work. While it is still reading itself in, the
 * threshold plus that room; once it starts working, at least room past where
 * it started.
 */
export function handoffPoint(model: Pick<Autopilot, 'threshold' | 'freshStart' | 'isFreshContext'>): number | null {
  if (model.threshold === null) return null
  const room = roomOf(model.threshold)
  if (model.isFreshContext) return model.threshold + room
  return model.freshStart === null ? model.threshold : Math.max(model.threshold, model.freshStart + room)
}

/** A fresh context began: its first reading will say where it starts. */
const fresh = { isFreshContext: true, freshStart: null } as const

/**
 * The effective threshold: tokens as set, or a percentage of the live
 * window; kept below Claude Code's auto-compact point when that is known,
 * so the handoff runs before the engine compacts on its own.
 */
export function resolveThreshold(input: {
  mode: 'tokens' | 'percent'
  tokens: number
  percent: number
  window: number | undefined
  autoCompactAt: number | undefined
}): { threshold: number | null; isClamped: boolean } {
  let threshold: number | null =
    input.mode === 'tokens'
      ? input.tokens
      : input.window === undefined
        ? null
        : Math.round((input.window * input.percent) / 100)
  if (threshold !== null && input.window !== undefined) threshold = Math.min(threshold, Math.round(input.window * 0.97))
  let isClamped = false
  if (threshold !== null && input.autoCompactAt !== undefined && input.autoCompactAt > 0) {
    const margin = input.window === undefined ? 20_000 : Math.round(input.window * 0.05)
    const ceiling = Math.max(10_000, input.autoCompactAt - margin)
    if (threshold > ceiling) {
      threshold = ceiling
      isClamped = true
    }
  }
  return { threshold, isClamped }
}

const BUSY: readonly AutopilotState[] = ['requested', 'handoff', 'waiting-background', 'verifying', 'clearing', 'compacting', 'resuming']

/** States in which the autopilot wants Claude to stop rather than continue. */
export const isHandoffActive = (state: AutopilotState): boolean =>
  state === 'pending' || BUSY.includes(state)

const set = (model: Autopilot, patch: Partial<Autopilot>): Autopilot => ({ ...model, ...patch })

/** Nothing of a handoff's background wait, as a handoff that is over (or never began) leaves it. */
const noWait: Pick<Autopilot, 'background' | 'waitedFor' | 'backgroundEndedAt' | 'notesWritten' | 'handoffTurnId' | 'waitSince' | 'waitUntil' | 'skipWait'> = {
  background: [],
  waitedFor: 0,
  backgroundEndedAt: null,
  notesWritten: null,
  handoffTurnId: null,
  waitSince: null,
  waitUntil: null,
  skipWait: false,
}

/** A handoff over for good: nothing of it is left to tell the fresh context either. */
const noHandoff = { ...noWait, leftRunning: [] as BackgroundTask[] }

/** "Render the 16:9 master", or "2 background tasks". */
export function backgroundWords(tasks: readonly BackgroundTask[]): string {
  const first = tasks[0]
  if (first === undefined) return 'no background work'
  return tasks.length === 1 ? first.description : `${tasks.length} background tasks`
}

/** The line Control Room shows while a handoff waits for background work: what it waits for, never what merely keeps running. */
function waitingNote(tasks: readonly BackgroundTask[], notesWritten: boolean | null): string {
  const lead = notesWritten === true ? 'Handoff written. ' : ''
  const blocking = blockingOf(tasks)
  if (blocking.length === 0) return `${lead}Background work finished. Claude records its result`
  return `${lead}Waiting for background work: ${backgroundWords(blocking)}`
}

/** The tasks Claude Code listed, as the model keeps them (a description cut to a line), each with its class. */
const tasksOf = (tasks: readonly BackgroundTask[]): BackgroundTask[] =>
  tasks
    .map(t => {
      const out: BackgroundTask = { id: t.id, description: t.description.slice(0, 120), class: classOf(t) }
      if (t.why !== undefined) out.why = t.why.slice(0, 80)
      if (t.by !== undefined) out.by = t.by
      if (t.command !== undefined) out.command = t.command.slice(0, 200)
      return out
    })
    .slice(0, 8)

/** The handoff goes on to check its notes, leaving whatever still runs for the fresh context. */
const goVerify = (model: Autopilot, still: readonly BackgroundTask[], patch: Partial<Autopilot>, note = 'Checking the handoff notes'): Step => ({
  model: set(model, { state: 'verifying', background: [], leftRunning: tasksOf(still), waitUntil: null, note, ...patch }),
  effects: [{ kind: 'verifyHandoff' }],
})

function proceedAfterHandoff(model: Autopilot, cfg: AutopilotConfig): Step {
  switch (cfg.continuation) {
    case 'clear':
      return { model: set(model, { state: 'clearing', note: 'Handoff written. Starting a fresh context' }), effects: [{ kind: 'clear' }] }
    case 'compact':
      return { model: set(model, { state: 'compacting', note: 'Handoff written. Compacting the context' }), effects: [{ kind: 'compact' }] }
    case 'manual':
      return {
        model: set(model, { state: 'awaiting', note: 'Handoff written. Start fresh when you’re ready' }),
        effects: [{ kind: 'notify', text: 'Handoff written. Start the fresh context from Control Room when you’re ready.', level: 'info' }],
      }
  }
}

// ---------------------------------------------------------------------------
// Surviving a reload

/** The handoff in flight, as `$.state` keeps it (see AutopilotRecord in the type contract). */
export type AutopilotRecord = {
  sessionId: string
  state: string
  triggeredTokens: number | null
  triggeredAt: number | null
  handoffSince: number | null
  retries: number
  snoozeUntil: number | null
  lastError: string | null
  note: string
  at: number
  /** 1.6.3: the handoff turn's id, and the background work the handoff waits for (absent in a record written before). */
  handoffTurnId?: string | null
  background?: BackgroundTask[]
  waitedFor?: number
  backgroundEndedAt?: number | null
  /** 1.7.0: the wait's window, the person's word not to wait, the work left running, and when the state began. */
  waitSince?: number | null
  waitUntil?: number | null
  skipWait?: boolean
  leftRunning?: BackgroundTask[]
  stateSince?: number | null
}

const STATES: readonly AutopilotState[] = ['off', 'armed', 'pending', 'requested', 'handoff', 'waiting-background', 'verifying', 'clearing', 'compacting', 'resuming', 'awaiting']

/**
 * What must outlive a reload: nothing while plainly watching, the handoff's
 * place while one is under way or waiting, a snooze while it holds.
 */
export function recordOf(model: Autopilot, sessionId: string | null, now: number): AutopilotRecord | null {
  if (sessionId === null || model.state === 'off') return null
  if (model.state === 'armed' && model.snoozeUntil === null) return null
  return {
    sessionId,
    state: model.state,
    triggeredTokens: model.triggeredTokens,
    triggeredAt: model.triggeredAt,
    handoffSince: model.handoffSince,
    retries: model.retries,
    snoozeUntil: model.snoozeUntil,
    lastError: model.lastError,
    note: model.note,
    at: now,
    handoffTurnId: model.handoffTurnId,
    background: model.background,
    waitedFor: model.waitedFor,
    backgroundEndedAt: model.backgroundEndedAt,
    waitSince: model.waitSince,
    waitUntil: model.waitUntil,
    skipWait: model.skipWait,
    leftRunning: model.leftRunning,
    stateSince: model.stateSince,
  }
}

const CLASSES: readonly TaskClass[] = ['persistent', 'finite', 'agent', 'unknown']
const BYS: readonly ClassBy[] = ['rule', 'classifier', 'person']

/**
 * A record's background list as written, or none: a record from before 1.6.3, or one changed by hand,
 * never throws. A task recorded without a class (1.6.3 kept none) is classified again by its words, so
 * a dev server a 1.6.3 handoff was stuck on stops holding it after the update.
 */
const recordedTasks = (value: unknown): BackgroundTask[] =>
  Array.isArray(value)
    ? tasksOf(
        value
          .filter((t): t is BackgroundTask => typeof t === 'object' && t !== null && typeof (t as BackgroundTask).id === 'string' && typeof (t as BackgroundTask).description === 'string')
          .map(t => {
            const command = typeof t.command === 'string' ? t.command : undefined
            const known = CLASSES.find(c => c === t.class)
            const verdict = known === undefined ? classifyTask({ id: t.id, type: '', description: t.description, ...(command === undefined ? {} : { command }) }) : null
            return {
              id: t.id,
              description: t.description,
              class: known ?? verdict?.class ?? 'unknown',
              ...(verdict !== null ? { why: verdict.why, by: verdict.by } : {}),
              ...(verdict === null && typeof t.why === 'string' ? { why: t.why } : {}),
              ...(verdict === null && BYS.includes(t.by as ClassBy) ? { by: t.by } : {}),
              ...(command === undefined ? {} : { command }),
            }
          }),
      )
    : []

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * A fresh runtime after a reload picks the handoff up where the record left
 * it, and never starts a second one. Where the record cannot tell whether a
 * step already happened (a prompt about to be sent, a compaction), it waits
 * for the person instead of repeating the step.
 *
 * `model` is the freshly configured machine (armed, or off when disabled). A wait recorded without an
 * end (1.6.3 kept none) is given one from when it began, so it is bounded after the update too.
 */
export function recover(model: Autopilot, record: AutopilotRecord, ctx: { sessionId: string | null; now?: number; waitMs?: number }): Step {
  const none: AutopilotEffect[] = []
  const state = STATES.find(s => s === record.state)
  if (model.state === 'off' || state === undefined || record.sessionId !== ctx.sessionId) return { model, effects: none }
  const kept = set(model, {
    triggeredTokens: record.triggeredTokens,
    triggeredAt: record.triggeredAt,
    handoffSince: record.handoffSince,
    handoffTurnId: typeof record.handoffTurnId === 'string' ? record.handoffTurnId : null,
    waitedFor: typeof record.waitedFor === 'number' ? record.waitedFor : 0,
    backgroundEndedAt: typeof record.backgroundEndedAt === 'number' ? record.backgroundEndedAt : null,
    waitSince: num(record.waitSince),
    waitUntil: num(record.waitUntil),
    skipWait: record.skipWait === true,
    leftRunning: recordedTasks(record.leftRunning),
    stateSince: num(record.stateSince),
    retries: record.retries,
    snoozeUntil: record.snoozeUntil,
    lastError: record.lastError,
  })
  switch (state) {
    case 'off':
      return { model, effects: none }
    case 'armed':
      return { model: set(kept, { state: 'armed', note: record.snoozeUntil === null ? model.note : 'Snoozed until the context grows further' }), effects: none }
    case 'pending':
    case 'handoff':
    case 'awaiting':
      // Nothing was left half-done: the turn under way (or the person) moves it on.
      return { model: set(kept, { state, note: record.note }), effects: none }
    case 'waiting-background': {
      // Still waiting: the next turn whose Stop lists no blocking work finishes the handoff, as before the reload.
      const background = recordedTasks(record.background)
      const since = kept.waitSince ?? (typeof record.at === 'number' ? record.at : (ctx.now ?? null))
      const waitMs = ctx.waitMs ?? DEFAULT_WAIT_MS
      const waitUntil = kept.waitUntil ?? (since === null || waitMs <= 0 ? null : since + waitMs)
      return {
        model: set(kept, { state, background, waitedFor: Math.max(kept.waitedFor, blockingOf(background).length), waitSince: since, waitUntil, note: waitingNote(background, null) }),
        effects: [{ kind: 'checkNotes' }],
      }
    }
    case 'verifying':
      return { model: set(kept, { state: 'verifying', note: 'Checking the handoff notes' }), effects: [{ kind: 'verifyHandoff' }] }
    case 'clearing':
      // The notes were verified and the context is still this session's: the clear is still owed.
      return { model: set(kept, { state: 'clearing', note: 'Handoff written. Starting a fresh context' }), effects: [{ kind: 'clear' }] }
    case 'requested':
    case 'compacting':
      return {
        model: set(kept, { state: 'awaiting', note: state === 'requested' ? 'A reload interrupted the handoff. Hand off when you’re ready' : 'A reload interrupted compaction. Start fresh when you’re ready' }),
        effects: [{ kind: 'notify', text: 'Control Room reloaded in the middle of a handoff, so Autopilot waits for you instead of repeating a step.', level: 'warn' }],
      }
    case 'resuming':
      return {
        model: set(kept, { state: 'armed', completed: model.completed + 1, triggeredTokens: null, triggeredAt: null, handoffSince: null, ...noHandoff, ...fresh, note: 'Watching the context' }),
        effects: [{ kind: 'notify', text: 'Control Room reloaded as the fresh context began. If Claude is idle, ask it to continue from the handoff notes.', level: 'info' }],
      }
  }
}

export function step(model: Autopilot, event: AutopilotEvent, cfg: AutopilotConfig): Step {
  const none: AutopilotEffect[] = []

  if (event.kind === 'configure') {
    if (!event.enabled) {
      return { model: set(initialAutopilot(), { completed: model.completed, note: 'Off' }), effects: none }
    }
    const next = set(model, { threshold: event.threshold, isClamped: event.isClamped })
    if (model.state === 'off') {
      return { model: set(next, { state: 'armed', note: 'Watching the context' }), effects: none }
    }
    return { model: next, effects: none }
  }

  if (model.state === 'off') return { model, effects: none }

  switch (event.kind) {
    case 'context': {
      const point = handoffPoint(model)
      if (model.state !== 'armed' || point === null) return { model, effects: none }
      if (model.snoozeUntil !== null && event.tokens < model.snoozeUntil) return { model, effects: none }
      if (event.tokens < point) return { model, effects: none }
      if (model.isFreshContext) {
        // Past the handoff point and its room before any work began: handing off again would loop.
        return {
          model: set(model, { state: 'awaiting', isFreshContext: false, freshStart: event.tokens, lastError: 'handoff point too low', note: 'The fresh context filled up before work began' }),
          effects: [
            {
              kind: 'notify',
              text: `This fresh context reached ${kTokens(event.tokens)} still reading itself in, past its ${kTokens(point)} handoff point, so Autopilot waits for you instead of handing off again. Raise the handoff point in Context.`,
              level: 'error',
            },
          ],
        }
      }
      const triggered = set(model, {
        triggeredTokens: event.tokens,
        triggeredAt: event.now,
        retries: 0,
        lastError: null,
        snoozeUntil: null,
      })
      if (event.isInTurn) {
        return {
          model: set(triggered, { state: 'pending', note: 'Finishing the current step, then handing off' }),
          effects: [
            { kind: 'appendPending', tokens: event.tokens, threshold: point, window: event.window },
            { kind: 'notify', text: 'Context reached the handoff point. Claude finishes the current step, then hands off.', level: 'warn' },
          ],
        }
      }
      return {
        model: set(triggered, { state: 'requested', note: 'Threshold reached. Starting the handoff' }),
        effects: [
          { kind: 'submitHandoff' },
          { kind: 'notify', text: 'Context reached the handoff point. Claude is writing the handoff notes.', level: 'warn' },
        ],
      }
    }

    case 'turnComplete': {
      if (model.state === 'pending') {
        if (event.reason === 'aborted') {
          return { model: set(model, { note: 'Interrupted. The handoff waits for the next finished turn' }), effects: none }
        }
        return { model: set(model, { state: 'requested', note: 'Step finished. Starting the handoff' }), effects: [{ kind: 'submitHandoff' }] }
      }
      // What Claude Code listed in flight as this turn stopped; unknown without a Stop (an interrupt).
      const inFlight = event.background === undefined || event.background === null ? null : tasksOf(event.background)
      // Only the handoff turn's own end moves the handoff on; a turn the person queued before it does not.
      if (model.state === 'handoff' && isHandoffTurn(event.turn)) {
        if (event.reason === 'aborted') {
          return {
            model: set(model, { state: 'awaiting', note: 'Handoff interrupted. Resume it when you’re ready' }),
            effects: [{ kind: 'notify', text: 'Handoff interrupted. Resume it from Control Room when you’re ready.', level: 'warn' }],
          }
        }
        const waitMs = cfg.waitMs ?? DEFAULT_WAIT_MS
        const blocking = inFlight === null ? [] : blockingOf(inFlight)
        if (inFlight !== null && blocking.length > 0 && !model.skipWait && waitMs > 0) {
          // The notes are not checked, and nothing is cleared, under work whose result may belong in them;
          // a server or a watcher in the list is not waited for, and the wait itself is bounded.
          return {
            model: set(model, {
              state: 'waiting-background',
              background: inFlight,
              waitedFor: blocking.length,
              backgroundEndedAt: null,
              notesWritten: null,
              waitSince: event.now,
              waitUntil: event.now + waitMs,
              note: waitingNote(inFlight, null),
            }),
            effects: [
              { kind: 'checkNotes' },
              { kind: 'notify', text: `The handoff waits for background work to finish (${backgroundWords(blocking)}), then checks the notes and starts the fresh context. It waits ${minutesWords(waitMs)} at most, then leaves the work running for the fresh context.`, level: 'info' },
            ],
          }
        }
        // Nothing to wait for (or the person said not to): what still runs is left running, and the fresh context is told.
        return goVerify(model, inFlight ?? [], {}, blocking.length > 0 ? 'Not waiting for background work. Checking the handoff notes' : 'Checking the handoff notes')
      }
      if (model.state === 'waiting-background') {
        // Whoever's turn this was (the one a task's notification began, the person's, an unseen one):
        // Claude Code's list at its Stop is what decides, never the turn's text.
        const still = inFlight ?? model.background
        const blocking = blockingOf(still)
        if (blocking.length > 0 && !model.skipWait) {
          const added = blocking.filter(t => !model.background.some(b => b.id === t.id)).length
          return { model: set(model, { background: still, waitedFor: model.waitedFor + added, note: waitingNote(still, model.notesWritten) }), effects: [{ kind: 'checkNotes' }] }
        }
        if (event.reason === 'aborted') {
          return {
            model: set(model, { state: 'awaiting', background: [], leftRunning: tasksOf(still), backgroundEndedAt: model.backgroundEndedAt ?? event.now, waitUntil: null, note: 'Handoff interrupted. Start fresh when you’re ready' }),
            effects: [{ kind: 'notify', text: 'The turn that took in the background result was interrupted, so the handoff waits for you: /cr fresh checks the notes and starts the fresh context.', level: 'warn' }],
          }
        }
        return goVerify(model, still, { backgroundEndedAt: model.backgroundEndedAt ?? event.now }, blocking.length > 0 ? 'Not waiting for background work. Checking the handoff notes' : 'Background work finished. Checking the handoff notes')
      }
      return { model, effects: none }
    }

    case 'backgroundEnded': {
      // Inside the handoff turn a task's end changes nothing: its Stop says what is still in flight.
      if (model.state !== 'waiting-background') return { model, effects: none }
      const left = model.background.filter(t => t.id !== event.id)
      if (left.length === model.background.length) return { model, effects: none }
      const isBlockingLeft = blockingOf(left).length > 0
      return {
        model: set(model, { background: left, backgroundEndedAt: isBlockingLeft ? model.backgroundEndedAt : event.now, note: waitingNote(left, model.notesWritten) }),
        effects: none,
      }
    }

    case 'reclassified': {
      const update = (tasks: readonly BackgroundTask[]) => tasks.map(t => (t.id === event.id ? { ...t, class: event.class, why: event.why, by: event.by } : t))
      if (model.state !== 'waiting-background') return { model, effects: none }
      const background = update(model.background)
      // A wait held only by a task that turns out to be a server ends now (no turn runs to end it otherwise).
      if (blockingOf(background).length === 0 && !event.isTurnRunning) {
        return goVerify(model, background, { backgroundEndedAt: model.backgroundEndedAt }, 'Only long-running services left: checking the handoff notes')
      }
      return { model: set(model, { background, note: waitingNote(background, model.notesWritten) }), effects: none }
    }

    case 'skipWait':
      // The person's escape route: the handoff goes on, background work left running for the fresh context.
      if (model.state === 'waiting-background') {
        if (event.isTurnRunning) return { model: set(model, { skipWait: true, note: 'Not waiting for background work: the handoff goes on when this turn ends' }), effects: none }
        return goVerify(model, model.background, {}, 'Not waiting for background work. Checking the handoff notes')
      }
      if (model.state === 'pending' || model.state === 'requested' || model.state === 'handoff') {
        return { model: set(model, { skipWait: true }), effects: none }
      }
      return { model, effects: none }

    case 'waitExpired':
      if (model.state !== 'waiting-background' || model.waitUntil === null || event.now < model.waitUntil || model.skipWait) return { model, effects: none }
      // Never under a running turn: the turn's end (its Stop the last word on what runs) moves it on.
      if (event.isTurnRunning === true) return { model: set(model, { skipWait: true, note: 'Waited long enough: the handoff goes on when this turn ends' }), effects: none }
      return goVerify(model, model.background, {}, 'Waited long enough: checking the handoff notes, leaving the work running')

    case 'unblocked': {
      if (model.state !== 'waiting-background' || blockingOf(model.background).length > 0) return { model, effects: none }
      const left = model.background
      return goVerify(model, left, { backgroundEndedAt: model.backgroundEndedAt ?? event.now }, left.length > 0 ? 'Only long-running services left: checking the handoff notes' : 'Background work finished. Checking the handoff notes')
    }

    case 'keepWaiting':
      if (model.state !== 'waiting-background') return { model, effects: none }
      return { model: set(model, { waitUntil: Math.max(model.waitUntil ?? event.now, event.now) + event.ms, skipWait: false }), effects: none }

    case 'cancelHandoff': {
      // Called off: this context carries on, and the context's growth decides the next handoff.
      const isCancellable = model.state === 'pending' || model.state === 'requested' || model.state === 'waiting-background' || model.state === 'awaiting' || model.state === 'handoff'
      if (!isCancellable) return { model, effects: none }
      const margin = event.window === undefined ? 50_000 : Math.round(event.window * 0.1)
      return {
        model: set(model, { state: 'armed', snoozeUntil: event.tokens + margin, triggeredTokens: null, triggeredAt: null, handoffSince: null, ...noHandoff, note: 'Handoff called off. Watching the context' }),
        effects: [{ kind: 'notify', text: 'Handoff called off: Claude carries on in this context. The notes stay on disk.', level: 'info' }],
      }
    }

    case 'leftRunningTold':
      return model.leftRunning.length === 0 ? { model, effects: none } : { model: set(model, { leftRunning: [] }), effects: none }

    case 'notesSeen':
      if (model.state !== 'waiting-background') return { model, effects: none }
      return { model: set(model, { notesWritten: event.isWritten, note: waitingNote(model.background, event.isWritten) }), effects: none }

    case 'oriented': {
      if (!model.isFreshContext) return { model, effects: none }
      const next = set(model, { isFreshContext: false, freshStart: event.tokens })
      const point = handoffPoint(next)
      if (model.threshold === null || point === null || point <= model.threshold) return { model: next, effects: none }
      return {
        model: set(next, { note: `Fresh context: hands off at ${kTokens(point)}` }),
        effects: [
          {
            kind: 'notify',
            text: `This fresh context started working at ${kTokens(event.tokens)}, close to the ${kTokens(model.threshold)} handoff point, so it hands off at ${kTokens(point)} to leave room for work. Raise the handoff point in Context to give each context more room.`,
            level: 'warn',
          },
        ],
      }
    }

    case 'handoffStarted':
      // From awaiting too: a reload left the handoff waiting, then its prompt's turn began after all.
      if (model.state !== 'requested' && model.state !== 'awaiting') return { model, effects: none }
      return {
        model: set(model, { state: 'handoff', handoffSince: event.now, ...noWait, skipWait: model.skipWait, leftRunning: [], handoffTurnId: event.turnId ?? null, lastError: null, note: 'Claude is writing the handoff' }),
        effects: none,
      }

    case 'personTookOver':
      if (model.state !== 'resuming') return { model, effects: none }
      return {
        model: set(model, { state: 'armed', completed: model.completed + 1, triggeredTokens: null, triggeredAt: null, handoffSince: null, ...noHandoff, ...fresh, note: 'Watching the context' }),
        effects: none,
      }

    case 'handoffVerified': {
      if (model.state !== 'verifying') return { model, effects: none }
      if (event.isOk) return proceedAfterHandoff(set(model, { retries: 0 }), cfg)
      if (model.retries < 1) {
        return {
          model: set(model, { state: 'handoff', retries: model.retries + 1, note: 'Notes missing. Asking Claude to write them' }),
          effects: [{ kind: 'submitRetry' }],
        }
      }
      return {
        model: set(model, {
          state: 'awaiting',
          lastError: 'handoff file not written',
          note: 'No handoff notes found, so the context was kept',
        }),
        effects: [{ kind: 'notify', text: 'No handoff notes were written, so the context was kept. Check the work and continue by hand.', level: 'error' }],
      }
    }

    case 'clearDone':
      if (model.state !== 'clearing') return { model, effects: none }
      if (!cfg.autoContinue) {
        return {
          model: set(model, { state: 'armed', completed: model.completed + 1, triggeredTokens: null, ...noWait, ...fresh, note: 'Fresh context ready. Continue when you are' }),
          effects: [{ kind: 'notify', text: 'Fresh context ready. Carry on by itself is off, so Claude waits for you.', level: 'info' }],
        }
      }
      return { model: set(model, { state: 'resuming', ...noWait, ...fresh, note: 'Continuing in the fresh context' }), effects: [{ kind: 'submitContinuation', via: 'clear' }] }

    case 'clearFailed':
      if (model.state !== 'clearing') return { model, effects: none }
      if (cfg.fallbackToCompact) {
        return {
          model: set(model, { state: 'compacting', lastError: event.error, note: 'Clearing was refused. Compacting instead' }),
          effects: [{ kind: 'compact' }, { kind: 'notify', text: `Clearing was refused (${event.error}), so the context is compacted instead.`, level: 'warn' }],
        }
      }
      return {
        model: set(model, { state: 'awaiting', lastError: event.error, note: 'Clearing was refused. Start fresh when you’re ready' }),
        effects: [{ kind: 'notify', text: `Clearing was refused: ${event.error}`, level: 'error' }],
      }

    case 'compactDone':
      if (model.state !== 'compacting') return { model, effects: none }
      if (!cfg.autoContinue) {
        return {
          model: set(model, { state: 'armed', completed: model.completed + 1, triggeredTokens: null, ...noWait, ...fresh, note: 'Context compacted. Continue when you are' }),
          effects: none,
        }
      }
      return { model: set(model, { state: 'resuming', ...noWait, ...fresh, note: 'Context compacted. Continuing the work' }), effects: [{ kind: 'submitContinuation', via: 'compact' }] }

    case 'compactFailed':
      if (model.state !== 'compacting') return { model, effects: none }
      return {
        model: set(model, { state: 'awaiting', lastError: event.error, note: 'Compaction failed. Start fresh when you’re ready' }),
        effects: [{ kind: 'notify', text: `Compaction failed: ${event.error}`, level: 'error' }],
      }

    case 'submitFailed':
      if (!BUSY.includes(model.state)) return { model, effects: none }
      return {
        model: set(model, { state: 'awaiting', lastError: event.error, note: 'Couldn’t continue automatically' }),
        effects: [{ kind: 'notify', text: `Autopilot could not continue: ${event.error}`, level: 'error' }],
      }

    case 'continuationStarted':
      if (model.state !== 'resuming') return { model, effects: none }
      return {
        model: set(model, {
          state: 'armed',
          completed: model.completed + 1,
          triggeredTokens: null,
          triggeredAt: null,
          handoffSince: null,
          ...noHandoff,
          note: 'Watching the context',
        }),
        effects: none,
      }

    case 'engineCompacted':
      if (model.state === 'pending' || model.state === 'requested') {
        return { model: set(model, { state: 'armed', note: 'Claude Code compacted first, so no handoff was needed' }), effects: none }
      }
      return { model, effects: none }

    case 'manualHandoff': {
      // A handoff under way is never asked for twice; one whose turn ended unseen without notes is begun again.
      const isRestart = event.isRestart === true && (model.state === 'handoff' || model.state === 'waiting-background')
      if (BUSY.includes(model.state) && !isRestart) return { model, effects: none }
      return {
        model: set(model, { state: 'requested', triggeredAt: event.now, retries: 0, lastError: null, ...noWait, skipWait: event.skipWait === true, note: 'Handoff requested' }),
        effects: [{ kind: 'submitHandoff' }],
      }
    }

    case 'manualFresh':
      // Only a handoff the person may finish: one waiting for them, or one whose end Claude Code's events left unseen.
      // freshVerdict decides whether that is safe (the notes written, nothing in flight, no turn running).
      if (model.state !== 'awaiting' && model.state !== 'handoff' && model.state !== 'waiting-background') return { model, effects: none }
      {
        const left: BackgroundTask[] = []
        for (const t of [...model.leftRunning, ...model.background, ...(event.left ?? [])]) if (!left.some(l => l.id === t.id)) left.push(t)
        return {
          model: set(model, { state: 'clearing', lastError: null, background: [], waitUntil: null, leftRunning: tasksOf(left), note: 'Starting a fresh context' }),
          effects: [{ kind: 'clear' }],
        }
      }

    case 'snooze': {
      const margin = event.window === undefined ? 50_000 : Math.round(event.window * 0.1)
      if (model.state !== 'pending' && model.state !== 'awaiting') return { model, effects: none }
      return {
        model: set(model, { state: 'armed', snoozeUntil: event.tokens + margin, ...noWait, note: 'Snoozed until the context grows further' }),
        effects: none,
      }
    }

    case 'externalClear':
      return {
        model: set(model, {
          state: 'armed',
          triggeredTokens: null,
          triggeredAt: null,
          handoffSince: null,
          snoozeUntil: null,
          retries: 0,
          ...noHandoff,
          ...fresh,
          note: 'Watching the context',
        }),
        effects: none,
      }
  }
}

// ---------------------------------------------------------------------------
// The person finishing a handoff: /cr handoff and /cr fresh

/**
 * What a look at the notes found: written since this handoff began, present but written before it,
 * present but empty, absent; `present` where no handoff began in this context (nothing to compare).
 */
export type NotesState = 'fresh' | 'stale' | 'empty' | 'missing' | 'present'

/** What the runtime knows when the person asks: everything a safe fresh start depends on. */
export type HandoffFacts = {
  isTurnRunning: boolean
  /**
   * Claude Code's background work in flight as it last reported it (the last turn's Stop, less what
   * a notification since said ended); null when no Stop was seen since the plugin loaded. While a
   * handoff waits for background work the machine's own list is used instead.
   */
  inFlight: readonly BackgroundTask[] | null
  notes: NotesState
  handoffFile: string
  /**
   * The person chose to leave running work running (`/cr fresh now`, Hand off now, "don't wait"):
   * background work no longer holds the fresh context back; the notes still must be current.
   */
  isForced?: boolean
}

/**
 * What a `/cr handoff` or `/cr fresh` does, and the words that say so: start a fresh context (the
 * verified clear path), hand off (the handoff prompt), or nothing. Never a success-looking word for
 * nothing: each says what is true now.
 */
export type Verdict = { action: 'start-fresh' | 'hand-off' | 'none'; text: string }

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const namesOf = (tasks: readonly BackgroundTask[]): string => `${tasks.slice(0, 3).map(t => t.description).join('; ')}${tasks.length > 3 ? '; …' : ''}`

const runningWords = (tasks: readonly BackgroundTask[]): string => `${plural(tasks.length, 'background task')} ${tasks.length === 1 ? 'is' : 'are'} still running (${namesOf(tasks)})`

/** "1 background task to finish before starting fresh (Render the 16:9 master)". */
const waitWords = (tasks: readonly BackgroundTask[]): string => `${plural(tasks.length, 'background task')} to finish before starting fresh (${namesOf(tasks)})`

/** The work Claude Code lists in flight, as a handoff counts it: the machine's own list while it waits, else the last Stop's. */
const inFlightOf = (model: Autopilot, facts: HandoffFacts): readonly BackgroundTask[] => (model.state === 'waiting-background' ? model.background : (facts.inFlight ?? []))

/** The work in flight that holds a fresh start back: blocking tasks only (a server never does), none when the person forced it. */
function blockingNow(model: Autopilot, facts: HandoffFacts): BackgroundTask[] {
  if (facts.isForced === true) return []
  return blockingOf(inFlightOf(model, facts))
}

/** " Left running for the fresh context: the Vite preview server." (empty with nothing running). */
export function leftWords(tasks: readonly BackgroundTask[]): string {
  if (tasks.length === 0) return ''
  return ` Left running for the fresh context, which is told: ${namesOf(tasks)}.`
}

/** What keeps a handoff the person asked to finish from starting the fresh context, or null when it is safe. */
function blockerOf(model: Autopilot, facts: HandoffFacts): string | null {
  const running = blockingNow(model, facts)
  if (running.length > 0) {
    const it = running.length === 1 ? 'it' : 'them'
    return `${runningWords(running)}. Fresh context was not started: the handoff finishes by itself when ${running.length === 1 ? 'it ends' : 'they end'}, or when its wait runs out (then ${running.length === 1 ? 'it keeps' : 'they keep'} running for the fresh context). /cr fresh now starts it at once and leaves ${it} running; /cr handoff stop stops ${it} first.`
  }
  const file = facts.handoffFile
  switch (facts.notes) {
    case 'fresh':
      return null
    case 'present':
      // No handoff began in this context (a reload stopped one before its turn, a fresh context that filled up first):
      // only the last case has notes to start from, the ones the fresh context was handed.
      return model.lastError === 'handoff point too low' ? null : `No handoff notes were written in this context, so it was kept. Run /cr handoff to have Claude write ${file}.`
    case 'missing':
      return `${file} was not found, so the context was kept. Run /cr handoff to have Claude write it.`
    case 'empty':
      return `${file} is empty, so the context was kept. Run /cr handoff to have Claude write it.`
    case 'stale':
      return `${file} has not been updated for this handoff, so the context was kept. Run /cr handoff to have Claude write it.`
  }
}

/** `/cr fresh` and Start fresh context: the fresh context, through the checks a handoff's own path makes. */
export function freshVerdict(model: Autopilot, facts: HandoffFacts): Verdict {
  const none = (text: string): Verdict => ({ action: 'none', text })
  switch (model.state) {
    case 'off':
      return none('Context Autopilot is off, so no handoff is waiting. Run /cr handoff (it turns Autopilot on, writes the notes, then continues fresh), or /clear to discard this context.')
    case 'armed':
      return none('No handoff is under way. Run /cr handoff first (it writes the notes, then continues fresh), or /clear to discard this context.')
    case 'pending':
      return none('A handoff is due: Claude finishes the current step, then writes the notes. Run /cr handoff to start it now.')
    case 'requested':
      return none('A handoff is starting: Claude writes the notes next, then the fresh context starts by itself.')
    case 'verifying':
      return none('Handoff is complete; Sentinel is checking the notes.')
    case 'clearing':
    case 'compacting':
      return none('Handoff is complete; Sentinel is starting the fresh context.')
    case 'resuming':
      return none('The fresh context has started; Claude is picking up the work from the notes.')
    case 'handoff':
      if (facts.isTurnRunning) return none('A handoff is in progress. Claude is writing the notes; the fresh context starts by itself once they are checked.')
      break
    case 'waiting-background':
      if (facts.isTurnRunning && blockingOf(model.background).length === 0) return none('The background work has finished and Claude is recording its result. The fresh context starts when this turn ends.')
      if (facts.isTurnRunning) return none('A turn is running (Claude is recording a background result). /cr handoff now hands off when it ends without waiting for the rest.')
      break
    case 'awaiting':
      if (facts.isTurnRunning) return none('A turn is running. Run /cr fresh again when it ends.')
      break
  }
  const blocker = blockerOf(model, facts)
  if (blocker !== null) return none(blocker)
  const running = inFlightOf(model, facts)
  const kept = leftWords(running)
  if (model.state === 'awaiting') return { action: 'start-fresh', text: `Handoff notes are valid. Starting the fresh context.${kept}` }
  if (model.state === 'handoff' && facts.inFlight === null) {
    return { action: 'start-fresh', text: 'Handoff notes are valid. Starting the fresh context (Sentinel has not seen Claude Code’s list of background work since it reloaded).' }
  }
  const isBlocked = blockingOf(running).length > 0
  const work =
    facts.isForced === true && isBlocked
      ? 'you chose not to wait for the background work'
      : running.length === 0
        ? model.waitedFor > 0
          ? 'the background work has finished'
          : 'no background work is running'
        : 'only long-running services are running'
  return { action: 'start-fresh', text: `Handoff notes are valid and ${work}. Starting the fresh context.${kept}` }
}

/** `/cr handoff` and Hand off now: a handoff when none is under way; otherwise what the one under way is doing. */
export function handoffVerdict(model: Autopilot, facts: HandoffFacts): Verdict {
  const none = (text: string): Verdict => ({ action: 'none', text })
  switch (model.state) {
    case 'off':
    case 'armed':
    case 'pending':
    case 'awaiting':
      return { action: 'hand-off', text: facts.isTurnRunning ? 'Handing off: Claude writes the handoff notes when the current turn ends.' : 'Handing off: Claude is writing the handoff notes.' }
    case 'requested':
      return none('A handoff is already starting: Claude writes the notes next.')
    case 'verifying':
      return none('Handoff is complete; Sentinel is checking the notes.')
    case 'clearing':
    case 'compacting':
      return none('Handoff is complete; Sentinel is starting the fresh context.')
    case 'resuming':
      return none('The handoff is done: Claude is continuing the work in the fresh context.')
    case 'waiting-background': {
      const left = blockingOf(model.background)
      if (left.length > 0 && facts.isForced !== true) {
        const waiting = model.notesWritten === false ? `The handoff is waiting for ${waitWords(left)}; the notes are not written yet.` : `Handoff notes are written; waiting for ${waitWords(left)}.`
        return none(`${waiting} /cr handoff now hands off without waiting (${left.length === 1 ? 'it keeps' : 'they keep'} running for the fresh context).`)
      }
      if (facts.isTurnRunning) {
        return none(left.length > 0 ? 'A turn is running (Claude is recording a background result): the handoff goes on when it ends.' : 'The background work has finished and Claude is recording its result. The fresh context starts when this turn ends.')
      }
      break
    }
    case 'handoff':
      if (facts.isTurnRunning) return none('A handoff is already in progress. Claude is writing the notes.')
      break
  }
  // A handoff whose turn ended unseen (a reload, a record from before 1.6.3): finished when that is safe, begun again when no notes were written.
  const blocker = blockerOf(model, facts)
  if (blocker === null) return { action: 'start-fresh', text: `The handoff turn has ended and its notes are current. Starting the fresh context.${leftWords(inFlightOf(model, facts))}` }
  const running = blockingNow(model, facts)
  if (running.length > 0) return none(`Handoff notes are ${facts.notes === 'fresh' ? 'written' : 'not written yet'}; waiting for ${waitWords(running)}.`)
  return { action: 'hand-off', text: 'The handoff turn ended without current notes. Handing off again: Claude is writing the handoff notes.' }
}

/**
 * A background task's notification as Claude Code words it (`<task-notification>` with the task's id and
 * status, and the tool call that started it when it says); null for any other text.
 */
export function notificationTask(text: string): { id: string; status: string | null; toolUseId?: string } | null {
  if (!/^\s*<task-notification>/.test(text)) return null
  const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1]
  if (id === undefined) return null
  const status = /<status>\s*([^<]+?)\s*<\/status>/.exec(text)?.[1] ?? null
  const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(text)?.[1]
  return toolUseId === undefined ? { id, status } : { id, status, toolUseId }
}

/** "20 minutes", "1 hour", "90 minutes". */
const minutesWords = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m % 60 === 0 && m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minute${m === 1 ? '' : 's'}`
}

const kTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(n / 1000)}k`)
