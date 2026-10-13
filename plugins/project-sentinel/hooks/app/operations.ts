/**
 * Operations: the orchestration layer at work (docs/ORCHESTRATION.md). The Mission Queue, the
 * Decision Inbox, Watchers, the Run Budget, the Cold Resume Guard and the Agent Command Center
 * live in the run (features/ops.ts); this class moves them at the run's boundaries:
 *
 *   turn end       queued work and answers go out, a due watcher wakes, the Scout looks for a wait
 *   milestone done queued work for after it goes with the next tool results
 *   fresh context  work queued for it rides its first message
 *   a prompt       answers that did not block ride it; a cold cache is asked about before it goes
 *   a timer        a watcher's time comes (`$.clock`: only while Claude Code runs)
 *
 * At most one of Project Sentinel's own prompts goes out per boundary, and only while the session
 * is free: no turn running, no handoff under way, no question open, no background work that will
 * bring the turn back. Nothing is appended to the transcript, and nothing here answers or bypasses
 * a permission prompt. The Runtime owns the run, the context and the engine; this class asks it.
 */

import type { PromptOrigin, Timer } from 'claude-code'

import type { ColdResumeView, ForeignOpsView, HudOps, OpsView, QueueTarget, Tone, WatchStrategy } from '../../types'
import * as fmt from '../core/format'
import { clean } from '../core/text'
import type { AgentRowView } from '../../types'
import { type AgentLedger, agentRows, aliveRows, noteCall, noteEnd, noteModel, notePlan, noteSpawn, noteStep, noteWorkflowEnd, reconcile, restoreLedger } from '../features/agents'
import * as Cache from '../features/cache'
import * as Chain from '../features/chain'
import * as Evidence from '../features/evidence'
import { doingOf } from '../features/digest'
import * as Ops from '../features/ops'
import * as Plan from '../features/plan'
import * as prompts from '../features/prompts'
import { type ResumeInput, previewLine, resumeHealthOf, resumePreviewOf } from '../features/resume'
import { type ScoutSuggestion, scoutOf, suggestionWords } from '../features/scout'
import { type WhenResult, agoWords, clockAhead, parseWhen, untilWords } from '../features/when'
import { wakeAt as cronWakeAt } from './headline'
import type { Runtime } from './runtime'

/** The Cold Resume Guard's choices, as its question offers them. */
export const COLD = {
  continue: 'Continue full session',
  fresh: 'Start fresh from resume state',
  compact: 'Compact first (reads it once)',
  cancel: 'Cancel',
} as const

/** How long after a boundary Project Sentinel's own prompt goes, so the turn's end settles first. */
const BOUNDARY_MS = 700
/** Compact first waits this long after the prompt it replaces is dropped, then asks Claude Code to compact. */
const COMPACT_AFTER_DROP_MS = 600
/** How many times Compact first asks while Claude Code still counts the dropped prompt as a turn under way. */
const COMPACT_TRIES = 3

/** A session that compacts only inside a turn (headless, SDK, Desktop's host protocol): `$.session.compact` refuses, /compact does it. */
export const isTurnOnlyCompact = (message: string): boolean => /not available in a headless|runs inside a turn/i.test(message)

/** A watcher's tick: countdowns move on, and a time missed by a sleeping machine is caught. */
const TICK_MS = 30_000
/** Past this, a cache with no known lifetime has surely lapsed (no lifetime is longer than an hour). */
const SURELY_LAPSED_MS = 61 * 60_000

type OwnInFlight = { kind: 'queued' | 'answer' | 'wake' | 'park'; ids: string[]; isForced: boolean }

export type FreshPurpose = {
  /** The first sentence of the fresh context's first prompt: why it is fresh. */
  why: string
  /** What Claude does once it has read in. */
  then: string
  /** The chain's note for the context that ended ("fresh wake (W-1)"). */
  endNote: string
  /** Why the context was cleared, as the fresh context reads it ("for a watcher's fresh wake"). */
  cause: string
  /** A watcher whose wake this is. */
  watcherId: string | null
}

const isPersonOrigin = (origin: PromptOrigin | undefined): boolean => origin === undefined || origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'

export class Operations {
  readonly agentLedger: AgentLedger = new Map()
  /** The Watcher Scout's suggestion after the last turn, until it is taken or ignored (memory only). */
  suggestion: (ScoutSuggestion & { id: string; at: number }) | null = null
  /** A message the Cold Resume Guard did not send and the prompt box could not take back (memory only, never stored). */
  held: { text: string; at: number; hasAttachments: boolean } | null = null
  /** An ended run of this project that left open operations, offered here once (Bring them here). */
  foreign: ForeignOpsView | null = null
  private foreignDismissed = new Set<string>()
  /** The Cold Resume Guard's last question: when, and what the person chose. */
  coldLast: { at: number; choice: string } | null = null
  /** What Claude Code said of the cache when this session was resumed (`classic.SessionStart`), for its first message. */
  resumed: { at: number; secondsSince: number | null; tokens: number | null; isExpired: boolean; usd: number | null; model: string | null } | null = null
  /** The handoff notes' stat, looked at after turns and before a fresh start (undefined: not looked at yet). */
  notes: { size: number; mtimeMs: number } | null | undefined = undefined
  private notesAt = 0
  /** Claude's last message as the turn stopped: the Scout reads it, once (memory only). */
  private stopMessage = ''
  private timer: Timer | null = null
  private ticker: Timer | null = null
  private inFlight: OwnInFlight | null = null
  /** When the prompt in flight went, and whether its turn began: one whose turn never began stops blocking after a while. */
  private inFlightAt = 0
  private isInFlightStarted = false
  /** A message waiting for a compaction the person chose in the Cold Resume Guard. */
  private afterCompact: { text: string; at: number } | null = null
  private deliverTimer: Timer | null = null

  constructor(private readonly rt: Runtime) {}

  // -------------------------------------------------------------------------
  // The run's operations

  /** The run's operations as they stand (none before the run's first message). */
  current(): Ops.RunOps {
    return this.rt.run?.ops ?? Ops.emptyOps()
  }

  /** Writes the run's operations, at once (an item must never be lost to a crash), and redraws. */
  private commit(next: Ops.RunOps): void {
    const rt = this.rt
    if (rt.run === null || next === rt.run.ops) return
    rt.run = { ...rt.run, ops: next }
    rt.persistRun(true)
    rt.publisher.mark('ops', 'hud', 'pane')
    this.rearm()
  }

  private log(text: string): void {
    this.commit(Ops.logged(this.current(), this.now(), text))
    this.rt.trace(`ops: ${text}`)
  }

  private now(): number {
    return this.rt.clock()
  }

  private toast(text: string, ms = 5000): void {
    if (this.rt.settings.ui.toasts) this.rt.host?.toast(text, ms)
  }

  // -------------------------------------------------------------------------
  // Loading

  /**
   * A runtime takes the run on (a session start, a reload, a resume): timers are set again from the
   * stored watchers, and what was on its way when the last runtime ended is said, never repeated.
   */
  async onLoad(): Promise<void> {
    const now = this.now()
    let ops = this.current()
    const sending = ops.queue.filter(q => q.status === 'sending').map(q => q.id)
    if (sending.length > 0) ops = Ops.markQueue(ops, sending, 'unsure', now)
    const answering = ops.decisions.filter(d => d.status === 'sending').map(d => d.id)
    if (answering.length > 0) ops = Ops.markDecisions(ops, answering, 'unsure', now)
    for (const w of ops.watchers) {
      if (w.status === 'waking') ops = Ops.patchWatcher(ops, w.id, { status: 'due', needs: 'A reload interrupted its wake.' })
      // Overdue: the person is here now, so it waits for them rather than acting by itself.
      else if (w.status === 'armed' && w.wakeAt < now - TICK_MS) {
        ops = Ops.patchWatcher(ops, w.id, { status: 'due', needs: `Watcher was due ${agoWords(now - w.wakeAt)}.` })
        this.rt.trace(`ops: ${w.id} was due ${agoWords(now - w.wakeAt)} (Claude Code was not running): it waits for you`)
      }
    }
    if (sending.length + answering.length > 0) this.rt.trace(`ops: ${[...sending, ...answering].join(', ')} were on their way when the last runtime ended: marked unsure, not sent again`)
    this.commit(ops)
    await this.restoreAgents()
    await this.refreshNotes(true)
    this.findForeign()
    this.rearm()
  }

  /** The newest ended run of this project that left watchers, queued work or open decisions. */
  findForeign(): void {
    const rt = this.rt
    const current = rt.run
    if (current === null) return
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    for (const run of rt.history) {
      if (run.id === current.id || run.status !== 'ended' || norm(run.root) !== norm(current.root) || this.foreignDismissed.has(run.id)) continue
      const ops = Ops.opsOf(run.ops)
      const watchers = ops.watchers.filter(Ops.isWatcherOpen)
      const queued = ops.queue.filter(Ops.isQueueOpen).length
      const decisions = ops.decisions.filter(d => Ops.isDecisionOpen(d) || Ops.isAnswerWaiting(d)).length
      if (watchers.length + queued + decisions === 0) continue
      const overdue = watchers.filter(w => w.wakeAt < this.now()).sort((a, b) => a.wakeAt - b.wakeAt)[0]
      this.foreign = { runId: run.id, runNumber: run.number, watchers: watchers.length, queued, decisions, overdue: overdue === undefined ? null : `${overdue.label}, due ${agoWords(this.now() - overdue.wakeAt)}` }
      rt.publisher.mark('ops', 'hud')
      return
    }
    this.foreign = null
  }

  /** Bring the open operations of an ended run of this project into this one (the person pressed it). */
  async bringForeign(): Promise<void> {
    const rt = this.rt
    const f = this.foreign
    const host = rt.host
    if (f === null || host === null || rt.run === null) return
    const source = rt.history.find(r => r.id === f.runId)
    if (source === undefined) return
    const from = Ops.opsOf(source.ops)
    const now = this.now()
    let ops = this.current()
    for (const q of from.queue.filter(Ops.isQueueOpen)) {
      const added = Ops.addQueueItem(ops, { text: q.text, target: q.target === 'milestone' ? 'boundary' : q.target, now, milestone: null })
      if (!('error' in added)) ops = added.ops
    }
    for (const d of from.decisions.filter(d => Ops.isDecisionOpen(d) || Ops.isAnswerWaiting(d))) {
      const added = Ops.addDecision(ops, { question: d.question, context: d.context, options: d.options, allowText: d.allowText, urgency: d.urgency, blocking: d.isBlocking, milestone: d.milestone, now, currentMilestone: null })
      if (!('error' in added)) {
        ops = added.ops
        if (d.answer !== null) {
          const answered = Ops.answerDecision(ops, added.decision.id, d.answer, now)
          if (!('error' in answered)) ops = answered
        }
      }
    }
    for (const w of from.watchers.filter(Ops.isWatcherOpen)) {
      // It parks this run from now: overdue ones wait for the person; the checkpoint is this run's now.
      const wakeAt = Math.max(w.wakeAt, now + 60_000)
      const added = Ops.addWatcher(ops, { label: w.label, wakeAt, strategy: w.strategy, now, milestone: w.milestone, checkpoint: rt.turn.isRunning ? null : this.checkpoint(), source: 'carried', decided: null })
      if (!('error' in added)) ops = w.wakeAt < now ? Ops.patchWatcher(added.ops, added.watcher.id, { status: 'due', needs: `Watcher was due ${agoWords(now - w.wakeAt)} (in run ${f.runNumber}).` }) : added.ops
    }
    ops = Ops.logged(ops, now, `Brought ${[f.watchers > 0 ? fmt.plural(f.watchers, 'watcher') : '', f.queued > 0 ? `${f.queued} queued` : '', f.decisions > 0 ? fmt.plural(f.decisions, 'decision') : ''].filter(Boolean).join(', ')} from run ${f.runNumber}`)
    this.commit(ops)
    // The ended run keeps its record; its operations are marked moved, so they are offered once.
    const moved = Ops.opsOf(source.ops)
    const done: Ops.RunOps = {
      ...moved,
      queue: moved.queue.map(q => (Ops.isQueueOpen(q) ? { ...q, status: 'cancelled' as const } : q)),
      decisions: moved.decisions.map(d => (Ops.isDecisionOpen(d) || Ops.isAnswerWaiting(d) ? { ...d, status: 'withdrawn' as const } : d)),
      watchers: moved.watchers.map(w => (Ops.isWatcherOpen(w) ? { ...w, status: 'dismissed' as const, outcome: `Moved to run ${rt.run?.number ?? ''}` } : w)),
    }
    const updated: Chain.Run = { ...source, ops: Ops.logged(done, now, `Moved to run ${rt.run.number}`) }
    rt.history = rt.history.map(r => (r.id === updated.id ? updated : r))
    await rt.saveOtherRun(updated)
    this.foreign = null
    rt.publisher.mark('ops', 'hud', 'chain')
  }

  dismissForeign(): void {
    if (this.foreign !== null) this.foreignDismissed.add(this.foreign.runId)
    this.foreign = null
    this.rt.publisher.mark('ops', 'hud')
  }

  // -------------------------------------------------------------------------
  // Timers: a watcher's time

  /** Sets the timer for the next wake, and the tick that keeps countdowns moving while a watcher is armed. */
  rearm(): void {
    const host = this.rt.host
    if (host === null) return
    this.timer?.cancel()
    this.timer = null
    const next = Ops.nextWakeAt(this.current())
    const isWatching = next !== null || this.current().watchers.some(w => w.status === 'due' || w.status === 'stale') || this.current().budget?.durationMs != null
    if (next !== null) {
      this.timer = host.after(Math.max(1000, next - this.now()), () => {
        this.timer = null
        this.onTime()
      })
    }
    if (isWatching && this.ticker === null) {
      this.ticker = host.every(TICK_MS, () => this.onTime())
    } else if (!isWatching && this.ticker !== null) {
      this.ticker.cancel()
      this.ticker = null
    }
  }

  stop(): void {
    this.timer?.cancel()
    this.ticker?.cancel()
    this.deliverTimer?.cancel()
    this.saveTimer?.cancel()
    this.timer = null
    this.ticker = null
    this.deliverTimer = null
    this.saveTimer = null
  }

  /** A watcher's time may have come (or a sleeping machine missed it): due ones are marked, and acted on when free. */
  private onTime(): void {
    const rt = this.rt
    const now = this.now()
    const due = Ops.dueWatchers(this.current(), now)
    if (due.length > 0) {
      let ops = this.current()
      for (const w of due) ops = Ops.patchWatcher(ops, w.id, { status: 'due', needs: null, firedAt: now }, { at: now, text: `${w.id} due (${w.label})` })
      this.commit(ops)
      rt.trace(`ops: ${due.map(w => w.id).join(', ')} due`)
      if (!this.isFree()) {
        rt.trace(`ops: ${due.map(w => w.id).join(', ')} due while ${rt.turn.isRunning ? 'a turn runs' : 'the session is busy'}: waits for its end`)
        this.toast(`Watcher due: ${due[0]!.label} · waits for Claude's turn to end`)
      }
    }
    this.checkBudget()
    rt.publisher.mark('hud', 'ops')
    if (due.length > 0) this.atBoundary()
  }

  // -------------------------------------------------------------------------
  // Boundaries

  /** Whether Project Sentinel may start a turn of its own now. */
  isFree(): boolean {
    const rt = this.rt
    if (this.inFlight !== null && !this.isInFlightStarted && !rt.turn.isRunning && this.now() - this.inFlightAt > 120_000) this.inFlight = null
    const ap = rt.settings.autopilot.enabled ? rt.autopilot.state : 'off'
    return (
      rt.host !== null &&
      !rt.turn.isRunning &&
      (ap === 'off' || ap === 'armed') &&
      this.inFlight === null &&
      rt.pendingApprovals.length === 0 &&
      // Work whose notification brings a turn back; a dev server or a watcher never does.
      rt.blockingInFlight().length === 0 &&
      !rt.isFreshStarting &&
      this.afterCompact === null
    )
  }

  /** The run is parked by a watcher: nothing runs, and an armed watcher will wake it. */
  isSleeping(): boolean {
    return !this.rt.turn.isRunning && this.current().watchers.some(w => w.status === 'armed')
  }

  /** A boundary: deliveries go out shortly, one at a time. */
  atBoundary(): void {
    const host = this.rt.host
    if (host === null || this.deliverTimer !== null) return
    this.deliverTimer = host.after(BOUNDARY_MS, () => {
      this.deliverTimer = null
      void this.deliverNext()
    })
  }

  /**
   * The milestone under way (its key and words), for After the current milestone. With none in
   * progress, the one the run waits on or is blocked on: queued "once this milestone is done" while
   * the run waits for a reviewer means after that wait (seen live: it went at once).
   */
  private currentMilestone(): { key: string; subject: string } | null {
    const p = this.rt.progress()
    const t = p.current ?? p.waiting.at(-1) ?? p.blocked.at(-1) ?? null
    return t === null ? null : { key: t.key, subject: t.subject }
  }

  /** The run's fingerprint now. */
  checkpoint(): Ops.Checkpoint {
    const rt = this.rt
    return Ops.checkpointNow({ now: this.now(), sessionId: rt.sessionId, turns: this.current().personTurns, tasks: rt.plan().tasks })
  }

  /** A main turn began: the Scout's suggestion is no longer about now; a prompt in flight has its turn. */
  onTurnStart(): void {
    if (this.inFlight !== null) this.isInFlightStarted = true
    if (this.suggestion !== null) {
      this.suggestion = null
      this.rt.publisher.mark('hud', 'ops')
    }
  }

  /** Claude's last message as its turn stopped (the Scout reads it at the turn's end). */
  noteStop(lastMessage: string): void {
    this.stopMessage = lastMessage.slice(-4000)
  }

  /**
   * A main turn ended. The person's turns are counted (a watcher's checkpoint compares them);
   * checkpoints armed mid-turn are taken; after a turn of Project Sentinel's own, the run is parked
   * again where it is. Then the boundary: due work goes out, a due watcher wakes, the Scout looks.
   */
  onTurnEnd(input: { reason: 'answer' | 'aborted' | 'refusal' | 'error'; kind: string }): void {
    const rt = this.rt
    const now = this.now()
    let ops = this.current()
    const flight = this.inFlight
    this.inFlight = null
    const isPerson = input.kind === 'person' || (flight?.isForced ?? false)
    if (isPerson) ops = { ...ops, personTurns: ops.personTurns + 1 }
    const cp = Ops.checkpointNow({ now, sessionId: rt.sessionId, turns: ops.personTurns, tasks: rt.plan().tasks })
    for (const w of ops.watchers) {
      if (w.status !== 'armed') continue
      // Armed while this turn ran: the run parks where this turn left it.
      if (w.checkpoint === null) ops = Ops.patchWatcher(ops, w.id, { checkpoint: cp })
      // After a turn of Project Sentinel's own with no turn of the person's since the park, the run is parked here now.
      else if (!isPerson && w.checkpoint.turns === ops.personTurns) ops = Ops.patchWatcher(ops, w.id, { checkpoint: cp })
    }
    // Notes that never left (the turn made no more tool calls) go as a prompt instead.
    if (rt.notesBox.drop('queue')) ops = Ops.markQueue(ops, ops.queue.filter(q => q.status === 'sending' && q.via === 'note').map(q => q.id), 'due', now)
    if (rt.notesBox.drop('answers')) ops = Ops.markDecisions(ops, ops.decisions.filter(d => d.status === 'sending' && d.via === 'note').map(d => d.id), 'answered', now)
    rt.notesBox.drop('budget')
    if (input.reason !== 'aborted') {
      const tasks = rt.plan().tasks
      ops = Ops.queueDueAt(ops, { kind: 'turnEnd', completed: tasks.filter(t => t.status === 'completed').map(t => t.key), planKeys: tasks.map(t => t.key), current: this.currentMilestone()?.key ?? null }, now)
    }
    this.commit(ops)
    void this.refreshNotes()
    if (input.reason !== 'aborted') this.scout(input.kind)
    this.checkBudget()
    // An interrupt is the person taking over: nothing goes out by itself after it.
    if (input.reason !== 'aborted') this.atBoundary()
  }

  /**
   * The run's milestones changed. One completed mid-turn is a boundary for work queued after it (and
   * for the next safe boundary): that work goes with the next batch of tool results.
   */
  onPlanChanged(before: Plan.Plan, after: Plan.Plan): void {
    const rt = this.rt
    const was = new Set(before.tasks.filter(t => t.status === 'completed').map(t => t.key))
    const completed = after.tasks.filter(t => t.status === 'completed' && !was.has(t.key)).map(t => t.key)
    if (completed.length === 0) return
    const now = this.now()
    let ops = Ops.queueDueAt(this.current(), { kind: 'milestones', completed, planKeys: after.tasks.map(t => t.key), current: Plan.progressOf(after).current?.key ?? null }, now)
    if (rt.turn.isRunning && !this.isSleeping()) {
      const due = Ops.dueQueue(ops).filter(q => q.target === 'milestone' || q.target === 'boundary')
      if (due.length > 0) {
        rt.tell('queue', prompts.queuedNote(due))
        ops = Ops.markQueue(ops, due.map(q => q.id), 'sending', now, 'note')
        rt.trace(`ops: ${due.map(q => q.id).join(', ')} go with the next tool results (a milestone completed)`)
      }
    }
    this.commit(ops)
  }

  /** A note of the layer's left with tool results or a prompt: what it carried is with Claude now. */
  onNoteDelivered(kind: string): void {
    const now = this.now()
    if (kind === 'agents') this.agentActions = []
    if (kind === 'queue' || kind === 'answers') this.rt.trace(`ops: ${kind === 'queue' ? 'queued work' : 'answers'} delivered with the tool results`)
    if (kind === 'queue') this.commit(Ops.markQueue(this.current(), this.current().queue.filter(q => q.status === 'sending' && q.via === 'note').map(q => q.id), 'delivered', now, 'note'))
    if (kind === 'answers') this.commit(Ops.markDecisions(this.current(), this.current().decisions.filter(d => d.status === 'sending' && d.via === 'note').map(d => d.id), 'delivered', now, 'note'))
  }

  /**
   * A fresh context Project Sentinel started (a handoff, a fresh wake, a fresh resume): work queued
   * for it, answers waiting and the decisions still open ride its first message.
   */
  onFreshContext(purpose: FreshPurpose | null): string | null {
    const now = this.now()
    let ops = Ops.queueDueAt(this.current(), { kind: 'fresh' }, now)
    // A note that waited for tool results of the old context never left: those items go now.
    ops = Ops.markQueue(ops, ops.queue.filter(q => q.status === 'sending' && q.via === 'note').map(q => q.id), 'due', now)
    const fresh = ops.queue.filter(q => q.status === 'due' && q.target === 'fresh')
    const answered = ops.decisions.filter(d => Ops.isAnswerWaiting(d))
    const open = ops.decisions.filter(Ops.isDecisionOpen)
    const watcher = purpose?.watcherId == null ? null : ops.watchers.find(w => w.id === purpose.watcherId)
    const why = watcher == null ? null : `This fresh context began because watcher ${watcher.id} woke the run: it was parked waiting for ${watcher.label}${watcher.milestone === null ? '' : ` (milestone "${watcher.milestone}")`}. Check that first.`
    const extras = prompts.freshExtras({ why, queued: fresh, decisions: [...answered, ...open].map(d => ({ id: d.id, question: d.question, answer: d.answer })) })
    if (fresh.length > 0 || answered.length > 0 || open.length > 0 || why !== null) this.rt.trace(`ops: the fresh context carries ${[why === null ? '' : `${purpose?.watcherId}'s wake`, fresh.length > 0 ? fresh.map(q => q.id).join(', ') : '', answered.length + open.length > 0 ? [...answered, ...open].map(d => d.id).join(', ') : ''].filter(Boolean).join('; ')}`)
    if (fresh.length > 0) ops = Ops.markQueue(ops, fresh.map(q => q.id), 'delivered', now, 'fresh')
    if (answered.length > 0) ops = Ops.markDecisions(ops, answered.map(d => d.id), 'delivered', now, 'fresh')
    this.commit(ops)
    return extras
  }

  /**
   * A prompt goes out (the person's or Project Sentinel's own): answers that did not block ride it as
   * context. The person's own prompt is a turn of theirs: a watcher's run is no longer parked.
   */
  onPromptSubmit(origin: PromptOrigin | undefined, text: string): string[] {
    const now = this.now()
    // Project Sentinel's own answers prompt carries them itself.
    if (prompts.ownPromptKind(text) === 'answer') return []
    void origin
    const waiting = this.current().decisions.filter(d => d.status === 'answered')
    if (waiting.length === 0) return []
    this.commit(Ops.markDecisions(this.current(), waiting.map(d => d.id), 'delivered', now, 'context'))
    this.rt.trace(`ops: answers to ${waiting.map(d => d.id).join(', ')} ride the prompt as context`)
    return [prompts.answersNote(waiting.map(d => ({ id: d.id, question: d.question, answer: d.answer ?? '', milestone: d.milestone })))]
  }

  /**
   * One delivery at a boundary, in order: a due watcher's wake; answers the run waits on; due queued
   * work. Each starts a turn of its own; the next waits for that turn's end.
   */
  async deliverNext(): Promise<void> {
    const rt = this.rt
    const host = rt.host
    if (host === null || !this.isFree() || rt.run === null) return
    const now = this.now()
    if (await this.wakeDue(now)) return
    // The person's own push (an answer the run waits on, Send now, Deliver now) goes even past a park, as their turn.
    const answered = this.current().decisions.filter(d => d.status === 'answered')
    const pushed = answered.filter(d => d.isBlocking || this.forcedIds.has(d.id))
    if (pushed.length > 0) {
      await this.sendOwn('answer', answered.map(d => d.id), prompts.answersPrompt(answered.map(d => ({ id: d.id, question: d.question, answer: d.answer ?? '', milestone: d.milestone }))), true)
      return
    }
    const due = Ops.dueQueue(this.current()).filter(q => q.target !== 'fresh')
    const forced = due.filter(q => this.forcedIds.has(q.id))
    // A parked run keeps its queue for the wake; at a budget limit, automation waits for the person.
    const going = forced.length > 0 ? forced : this.isSleeping() || !this.mayAutomate('queued work') ? [] : due
    if (going.length > 0) {
      await this.sendOwn('queued', going.map(q => q.id), prompts.queuedPrompt(going.map(q => ({ id: q.id, text: q.text, createdAt: q.createdAt, when: Ops.TARGET_WORDS[q.target] }))), forced.length > 0)
    }
  }

  /** Items and answers the person pressed Deliver now / Send now on: they go even past a park, and count as the person's. */
  private forcedIds = new Set<string>()

  /** Sends one of the layer's prompts; marks what it carries once Claude Code took it. */
  private setInFlight(flight: OwnInFlight): void {
    this.inFlight = flight
    this.inFlightAt = this.now()
    this.isInFlightStarted = false
  }

  private async sendOwn(kind: 'queued' | 'answer', ids: string[], text: string, isForced: boolean): Promise<void> {
    const rt = this.rt
    const host = rt.host
    if (host === null) return
    const now = this.now()
    this.commit(kind === 'queued' ? Ops.markQueue(this.current(), ids, 'sending', now, 'prompt') : Ops.markDecisions(this.current(), ids, 'sending', now, 'prompt'))
    this.setInFlight({ kind, ids, isForced })
    rt.trace(`ops: submitting ${kind === 'queued' ? 'queued work' : 'answers'} ${ids.join(', ')}`)
    try {
      const result = await host.submit(text)
      if (result.drop !== undefined) throw new Error(`dropped: ${result.drop}`)
      this.commit(kind === 'queued' ? Ops.markQueue(this.current(), ids, 'delivered', this.now(), 'prompt') : Ops.markDecisions(this.current(), ids, 'delivered', this.now(), 'prompt'))
      for (const id of ids) this.forcedIds.delete(id)
    } catch (error) {
      this.inFlight = null
      this.commit(kind === 'queued' ? Ops.markQueue(this.current(), ids, 'due', this.now()) : Ops.markDecisions(this.current(), ids, 'answered', this.now()))
      this.log(`${ids.join(', ')} not sent: ${error instanceof Error ? clean(error.message, 120) : String(error)}`)
    }
  }

  // -------------------------------------------------------------------------
  // Mission Queue

  queueAdd(text: string, target: QueueTarget): { ok: true; id: string; when: string } | { ok: false; error: string } {
    const rt = this.rt
    if (rt.run === null) return { ok: false, error: 'No run yet: send a first message.' }
    const now = this.now()
    const milestone = target === 'milestone' ? this.currentMilestone() : null
    const added = Ops.addQueueItem(this.current(), { text, target, now, milestone })
    if ('error' in added) return { ok: false, error: added.error }
    let ops = added.ops
    // Nothing runs and nothing parks the run: the next safe boundary is now.
    if (!rt.turn.isRunning && !this.isSleeping()) ops = Ops.queueDueAt(ops, { kind: 'idle', current: this.currentMilestone()?.key ?? null }, now)
    this.commit(ops)
    const item = ops.queue.find(q => q.id === added.item.id)!
    rt.trace(`ops: ${item.id} queued (${item.target}${item.status === 'due' ? ', due now' : rt.turn.isRunning ? ', a turn runs' : ''})`)
    this.atBoundary()
    return { ok: true, id: item.id, when: this.queueWhen(item) }
  }

  /** When an item goes, in words, as things stand. */
  queueWhen(q: Ops.QueueItem): string {
    const rt = this.rt
    if (q.status === 'delivered') return `Delivered ${fmt.clock(q.deliveredAt)}${q.via === 'note' ? ' with tool results' : q.via === 'fresh' ? ' into the fresh context' : ''}`
    if (q.status === 'cancelled') return 'Deleted'
    if (q.status === 'sending') return q.via === 'note' ? 'Goes with Claude’s next tool results' : 'On its way'
    if (q.status === 'unsure') return 'Sent before a reload: check the transcript'
    const holder = Ops.holdingWatcher(this.current())
    const isHeld = holder !== null && holder.status === 'armed' && !rt.turn.isRunning
    // After the handoff: the next fresh context Project Sentinel starts, a watcher's fresh wake included.
    if (q.target === 'fresh') return isHeld && Ops.modeOf(holder).mode === 'fresh' ? `Goes into ${holder.id}'s fresh wake (${clockAhead(holder.wakeAt, this.now())})` : Ops.TARGET_WORDS.fresh
    if (isHeld) return `Waits for ${holder.id}'s wake (${clockAhead(holder.wakeAt, this.now())})`
    // At a limit set to Ask or Finish, automation waits for the person: never "goes now" when it will not.
    if (q.status === 'due' && !this.forcedIds.has(q.id) && this.isBudgetHolding()) return 'Waits for you: the run budget is reached (Continue the run, or /cr budget continue)'
    if (q.status === 'due') return rt.turn.isRunning ? 'Due: goes when this turn ends' : 'Due: goes now'
    if (q.target === 'milestone' && q.milestone !== null) return `After the current milestone: ${clean(q.milestone, 50)}`
    if (q.target === 'boundary' && rt.turn.isRunning && this.currentMilestone() !== null) return 'At the next boundary: this milestone or this turn'
    return Ops.TARGET_WORDS[q.target]
  }

  queueEdit(id: string, patch: { text?: string; target?: QueueTarget }): void {
    const milestone = patch.target === 'milestone' ? this.currentMilestone() : undefined
    let ops = Ops.editQueueItem(this.current(), id, { ...patch, ...(milestone === undefined ? {} : { milestone }) })
    if (!this.rt.turn.isRunning && !this.isSleeping()) ops = Ops.queueDueAt(ops, { kind: 'idle', current: this.currentMilestone()?.key ?? null }, this.now())
    this.commit(ops)
    this.atBoundary()
  }

  queueMove(id: string, delta: -1 | 1): void {
    this.commit(Ops.moveQueueItem(this.current(), id, delta))
  }

  queueCancel(id: string): void {
    this.commit(Ops.cancelQueueItem(this.current(), id, this.now()))
  }

  /** Deliver now: at the next moment the session is free, past a park; it counts as the person's own turn. */
  queueNow(id: string): void {
    const item = this.current().queue.find(q => q.id === id)
    if (item === undefined || (item.status !== 'queued' && item.status !== 'due' && item.status !== 'unsure')) return
    this.forcedIds.add(id)
    this.commit(Ops.forceDue(this.current(), id, this.now()))
    this.atBoundary()
  }

  // -------------------------------------------------------------------------
  // Decision Inbox

  /** The `decision_request` tool: the question goes to the inbox; Claude is told what to do meanwhile. */
  decisionTool(input: Record<string, unknown>, agentId: string | undefined): string {
    const rt = this.rt
    if (!rt.settings.ops.decisions) return 'The Decision Inbox is off in Project Sentinel: ask the user directly instead, or decide yourself if the choice is yours.'
    if (agentId !== undefined) return 'The Decision Inbox is for the main conversation: put this decision in your final answer instead, for the main conversation to raise.'
    if (rt.run === null) return 'Recorded nothing: no run yet.'
    const before = new Set(this.current().decisions.map(d => d.id))
    const added = Ops.addDecision(this.current(), {
      question: input.question,
      context: input.context,
      options: input.options,
      allowText: input.allowText,
      urgency: input.urgency,
      blocking: input.blocking,
      milestone: input.milestone,
      now: this.now(),
      currentMilestone: rt.progress().current?.subject ?? null,
    })
    if ('error' in added) return added.error
    this.commit(added.ops)
    const d = added.decision
    rt.trace(`ops: ${d.id} ${before.has(d.id) ? 'asked again (the same decision)' : `recorded${d.isBlocking ? ' (blocking)' : ''}`}`)
    if (!before.has(d.id)) this.toast(`${d.isBlocking ? 'Needs you' : 'Review'}: ${clean(d.question, 90)}`, 7000)
    return prompts.decisionRecorded({ id: d.id, isBlocking: d.isBlocking, isRepeat: before.has(d.id) })
  }

  /** The person answered (a button, the text field, `/cr decide`). Goes to Claude at the right boundary. */
  answer(id: string, text: string): { ok: true } | { ok: false; error: string } {
    const rt = this.rt
    const result = Ops.answerDecision(this.current(), id, text, this.now())
    if ('error' in result) return { ok: false, error: result.error }
    let ops = result
    const d = ops.decisions.find(x => x.id === id)!
    if (rt.turn.isRunning) {
      // With the next batch of tool results, all the answers waiting.
      const waiting = ops.decisions.filter(x => x.status === 'answered' || (x.status === 'sending' && x.via === 'note'))
      rt.tell('answers', prompts.answersNote(waiting.map(x => ({ id: x.id, question: x.question, answer: x.answer ?? '', milestone: x.milestone }))))
      ops = Ops.markDecisions(ops, waiting.map(x => x.id), 'sending', this.now(), 'note')
    }
    this.commit(ops)
    rt.trace(`ops: ${id} answered (${rt.turn.isRunning ? 'goes with the next tool results' : d.isBlocking ? 'goes now' : 'rides the next prompt'})`)
    if (!rt.turn.isRunning && d.isBlocking) this.atBoundary()
    return { ok: true }
  }

  /** Send now: an answer that would wait for the next message goes as a prompt of its own. */
  answerNow(id: string): void {
    const d = this.current().decisions.find(x => x.id === id)
    if (d === undefined || (d.status !== 'answered' && d.status !== 'unsure')) return
    this.forcedIds.add(id)
    if (d.status === 'unsure') this.commit(Ops.markDecisions(this.current(), [id], 'answered', this.now()))
    this.atBoundary()
  }

  withdraw(id: string): void {
    this.commit(Ops.markDecisions(this.current(), [id], 'withdrawn', this.now()))
  }

  /** `/cr decide D-2`: Claude Code's own question dialog. */
  async askDecision(id: string): Promise<string> {
    const host = this.rt.host
    const d = this.current().decisions.find(x => x.id === id.toUpperCase())
    if (host === null || d === undefined) return `No open decision ${id}.`
    if (d.status !== 'open') return `${d.id} is already answered${d.answer === null ? '' : `: ${d.answer}`}.`
    const options = d.options.length >= 2 ? d.options : d.options.length === 1 ? [d.options[0]!, 'Something else (type it under Other)'] : ['Let Claude choose', 'Decide later']
    let answer: string
    try {
      answer = await host.ask(`${d.question}${d.context === null ? '' : ` (${d.context})`}`.slice(0, 900), options, d.id)
    } catch {
      return `${d.id} is still open.`
    }
    if (answer === 'Decide later') return `${d.id} is still open.`
    if (answer === 'Something else (type it under Other)') return `${d.id} is still open: type your answer under Other, or in Activity → Operations.`
    const done = this.answer(d.id, answer === 'Let Claude choose' ? 'You choose: decide as you judge best, and say what you chose.' : answer)
    return done.ok ? `${d.id} answered: ${answer}. ${this.rt.turn.isRunning ? 'It reaches Claude with its next tool results.' : d.isBlocking ? 'Claude continues with it now.' : 'It reaches Claude with your next message (Send now in Operations sends it at once).'}` : done.error
  }

  // -------------------------------------------------------------------------
  // Watchers

  /** Arms a watcher from what the person typed (`in 2h`, `at 14:00`); an ambiguous time comes back to be chosen. */
  armFrom(label: string, whenText: string, strategy: WatchStrategy, source: Ops.Watcher['source'] = 'person'): { ok: true; id: string; words: string } | { ok: false; error: string; options?: { at: number; label: string }[] } {
    const result = parseWhen(whenText, this.now())
    return this.armAt(label, result, strategy, source)
  }

  armAt(label: string, when: WhenResult, strategy: WatchStrategy, source: Ops.Watcher['source'] = 'person'): { ok: true; id: string; words: string } | { ok: false; error: string; options?: { at: number; label: string }[] } {
    const rt = this.rt
    if (!rt.settings.ops.watchers) return { ok: false, error: 'Watchers are off (Activity → Operations → Watchers).' }
    if (rt.run === null) return { ok: false, error: 'No run yet: send a first message.' }
    if (when.kind === 'error') return { ok: false, error: when.message }
    if (when.kind === 'ambiguous') return { ok: false, error: `Which one? ${when.options.map(o => o.label).join(' or ')}`, options: when.options }
    const now = this.now()
    const current = rt.progress()
    const waiting = current.waiting.at(-1)
    const decided = strategy === 'smart' ? this.smartFor(when.at) : null
    const added = Ops.addWatcher(this.current(), {
      label: label.trim() || waiting?.detail || waiting?.subject || 'the result',
      wakeAt: when.at,
      strategy,
      now,
      milestone: waiting?.subject ?? current.current?.subject ?? null,
      checkpoint: rt.turn.isRunning ? null : this.checkpoint(),
      source,
      decided,
    })
    if ('error' in added) return { ok: false, error: added.error }
    this.commit(added.ops)
    rt.trace(`ops: ${added.watcher.id} armed for ${added.watcher.label}, wakes in ${untilWords(when.at - now)} (${added.watcher.strategy}${decided === null ? '' : `: ${decided.mode}${decided.hold ? ', holds the cache' : ''}`}; checkpoint ${added.watcher.checkpoint === null ? 'at the turn end' : 'now'})`)
    this.suggestion = null
    // A held cache needs its refreshes planned now (the person is away from here on).
    if (!rt.turn.isRunning) rt.cache.schedule()
    const w = added.watcher
    const how = Ops.modeOf(w)
    const mode = how.mode === 'fresh' ? 'wakes fresh' : how.hold ? 'holds the cache warm' : 'wakes in this context'
    return { ok: true, id: w.id, words: `${w.id} wakes ${clockAhead(w.wakeAt, now)} (in ${untilWords(w.wakeAt - now)}) for ${w.label}: ${Ops.STRATEGY_WORDS[w.strategy]}${w.strategy === 'smart' ? `, ${mode}` : ''}` }
  }

  /** Smart's choice for a wake at `at`, from the cache and the resume state now. */
  smartFor(at: number): Ops.SmartChoice {
    const rt = this.rt
    const c = rt.cache.state
    const health = this.resumeHealth()
    const threshold = rt.settings.autopilot.enabled ? (rt.autopilot.threshold ?? null) : null
    const ref = threshold ?? (rt.usage.window === undefined ? null : rt.usage.window * 0.9)
    return Ops.smartChoice({
      now: this.now(),
      wakeAt: at,
      ttl: c.ttl?.value ?? null,
      cachedTokens: Math.max(c.lastPrefix, rt.usage.tokens ?? 0),
      expiresAt: Cache.warmthOf(c, this.now()) === 'warm' ? Cache.expiresAt(c) : null,
      contextShare: ref === null || rt.usage.tokens === undefined ? null : rt.usage.tokens / ref,
      isKeepWarmBroken: c.keepWarm.verified === 'no',
      resume: { isHealthy: health.isHealthy, problem: health.problems[0] ?? null },
      smallTokens: rt.settings.cache.coldResumeTokens,
    })
  }

  /** The watcher holding the cache warm now, if any: Keep warm refreshes until it wakes. */
  hold(): { until: number } | null {
    const w = this.current().watchers.filter(x => x.status === 'armed' && Ops.modeOf(x).hold).sort((a, b) => a.wakeAt - b.wakeAt)[0]
    return w === undefined ? null : { until: w.wakeAt }
  }

  /**
   * A due watcher, at a boundary. It wakes the run only while the run is still parked at its
   * checkpoint; if anything moved, it asks. A fresh wake needs healthy resume state; a warm wake
   * over a cache that went cold uses a healthy fresh resume (Smart), or asks.
   */
  private async wakeDue(now: number): Promise<boolean> {
    const w = this.current().watchers.filter(x => (x.status === 'due' && x.needs === null) || (x.status === 'armed' && x.wakeAt <= now)).sort((a, b) => a.wakeAt - b.wakeAt)[0]
    if (w === undefined) return false
    const cp = w.checkpoint ?? this.checkpoint()
    const at = this.checkpoint()
    const changed = Ops.changedSince(cp, at)
    if (changed !== null) {
      this.commit(Ops.patchWatcher(this.current(), w.id, { status: 'stale', needs: changed, firedAt: w.firedAt ?? now }, { at: now, text: `${w.id} due, but the run changed since it was armed: waits for you` }))
      this.rt.trace(`ops: ${w.id} due, but the run changed since it was armed (${Ops.changesSince(cp, at).join(', ')}): waits for you; nothing sent, nothing cleared`)
      this.toast(`Watcher due: ${w.label}. This run changed since it was armed, so it waits for you.`, 8000)
      return true
    }
    if (!this.mayAutomate(`${w.id}'s wake`)) {
      this.commit(Ops.patchWatcher(this.current(), w.id, { status: 'due', needs: 'The run budget is reached: the wake waits for you.' }))
      this.rt.trace(`ops: ${w.id} due, the run budget is reached: waits for you`)
      return true
    }
    const decided = w.strategy === 'smart' ? this.smartFor(now) : w.decided
    const how = Ops.modeOf({ strategy: w.strategy, decided })
    if (decided !== null) this.commit(Ops.patchWatcher(this.current(), w.id, { decided }))
    const cold = this.coldState(now)
    const health = this.resumeHealth()
    if (how.mode === 'fresh') {
      if (!health.isHealthy) {
        this.commit(Ops.patchWatcher(this.current(), w.id, { status: 'due', needs: `A fresh wake is not safe now: ${health.problems[0] ?? 'the resume state is not ready'}.` }))
        this.rt.trace(`ops: ${w.id} due, a fresh wake is not safe (${health.problems.join('; ')}): waits for you; nothing cleared`)
        this.toast(`Watcher due: ${w.label}. A fresh wake is not safe now, so it waits for you.`, 8000)
        return true
      }
      await this.wakeFresh(w, null)
      return true
    }
    if (cold.isArmed) {
      // Keep warm did not hold the cache to the wake: re-reading it all is the person's call, unless a fresh resume is healthy.
      if (w.strategy === 'smart' && health.isHealthy) {
        await this.wakeFresh(w, `the cache went cold before the wake (${cold.cause ?? 'it lapsed'})`)
        return true
      }
      this.commit(Ops.patchWatcher(this.current(), w.id, { status: 'due', needs: `The cache went cold before the wake (${cold.cause ?? 'it lapsed'}): waking here re-reads ${fmt.tokens(cold.tokens)} tokens.` }))
      this.rt.trace(`ops: ${w.id} due, the cache went cold before the wake (${cold.cause ?? 'lapsed'}): waits for you`)
      this.toast(`Watcher due: ${w.label}. The cache went cold, so it waits for you.`, 8000)
      return true
    }
    await this.wakeHere(w)
    return true
  }

  /** Wakes the run in this context: a prompt that says what it waited for. */
  private async wakeHere(w: Ops.Watcher): Promise<void> {
    const rt = this.rt
    const host = rt.host
    if (host === null) return
    const now = this.now()
    this.commit(Ops.patchWatcher(this.current(), w.id, { status: 'waking', firedAt: w.firedAt ?? now }))
    const queued = this.current().queue.filter(q => q.status === 'due' || q.status === 'queued').length
    this.setInFlight({ kind: 'wake', ids: [w.id], isForced: false })
    rt.trace(`ops: ${w.id} wakes the run in this context`)
    try {
      const result = await host.submit(prompts.wakePrompt({ id: w.id, label: w.label, armedAt: w.createdAt, milestone: w.milestone, lateMs: Math.max(0, now - w.wakeAt), queued }))
      if (result.drop !== undefined) throw new Error(result.drop)
      this.commit(Ops.patchWatcher(this.current(), w.id, { status: 'done', endedAt: this.now(), outcome: 'Woke the run in this context', needs: null }, { at: this.now(), text: `${w.id} woke the run in this context` }))
      // Queued work waited for the wake: it is due at the wake turn's end.
      this.commit(Ops.queueDueAt(this.current(), { kind: 'idle', current: this.currentMilestone()?.key ?? null }, this.now()))
    } catch (error) {
      this.inFlight = null
      this.commit(Ops.patchWatcher(this.current(), w.id, { status: 'due', needs: `Claude Code did not take the wake: ${error instanceof Error ? clean(error.message, 100) : String(error)}.` }))
    }
  }

  /** Wakes the run in a fresh context: /clear, the run state and notes into it, then the check. */
  private async wakeFresh(w: Ops.Watcher, because: string | null): Promise<void> {
    const rt = this.rt
    this.commit(Ops.patchWatcher(this.current(), w.id, { status: 'waking', firedAt: w.firedAt ?? this.now() }))
    const preview = this.resumePreview()
    rt.trace(`ops: ${w.id} wakes the run fresh${because === null ? '' : ` (${because})`}. Resume preview: ${previewLine(preview)}`)
    const result = await rt.freshStart({
      why: `watcher ${w.id} woke the run, parked waiting for ${w.label}${because === null ? '' : `; ${because}`}.`,
      then: `Then check ${w.label} and continue the work from where it was parked${w.milestone === null ? '' : ` (the milestone "${w.milestone}")`}.`,
      endNote: `fresh wake (${w.id})`,
      cause: "for a watcher's fresh wake",
      watcherId: w.id,
    })
    if (result.ok) {
      this.commit(Ops.patchWatcher(this.current(), w.id, { status: 'done', endedAt: this.now(), outcome: because === null ? 'Woke the run in a fresh context' : 'Woke the run fresh: the cache had gone cold', needs: null }, { at: this.now(), text: `${w.id} woke the run in a fresh context` }))
      this.setInFlight({ kind: 'wake', ids: [w.id], isForced: false })
    } else {
      this.commit(Ops.patchWatcher(this.current(), w.id, { status: 'due', needs: `The fresh start failed (${result.error}): nothing was cleared.` }))
    }
  }

  /** Check now (a stale or due watcher): a prompt in this context, never a clear. */
  async checkNow(id: string): Promise<void> {
    const w = this.current().watchers.find(x => x.id === id)
    if (w === undefined || !Ops.isWatcherOpen(w)) return
    if (!this.isFree()) {
      this.commit(Ops.patchWatcher(this.current(), id, { status: 'due', needs: null }))
      this.toast(`${id} goes when Claude's turn ends`)
      return
    }
    await this.wakeHere(w)
  }

  /** Wake now, as its strategy says (the person pressed it): fresh only while the run is parked and the resume state is healthy. */
  async wakeNow(id: string): Promise<void> {
    const w = this.current().watchers.find(x => x.id === id)
    if (w === undefined || !Ops.isWatcherOpen(w)) return
    this.commit(Ops.patchWatcher(this.current(), id, { status: 'due', needs: null, wakeAt: Math.min(w.wakeAt, this.now()), firedAt: this.now() }))
    if (this.isFree()) await this.deliverNext()
    else this.toast(`${id} wakes when Claude's turn ends`)
  }

  /** Start fresh (a due watcher whose fresh wake is safe): the person chose it, so the checkpoint is not asked again. */
  async wakeFreshNow(id: string): Promise<void> {
    const w = this.current().watchers.find(x => x.id === id)
    if (w === undefined || !Ops.isWatcherOpen(w) || !this.isFree()) return
    if (!this.resumeHealth().isHealthy) {
      this.toast('A fresh start is not safe now: Context → Ready to resume says why.')
      return
    }
    await this.wakeFresh(w, null)
  }

  reschedule(id: string, whenText: string): { ok: true; words: string } | { ok: false; error: string } {
    const result = parseWhen(whenText, this.now())
    if (result.kind === 'error') return { ok: false, error: result.message }
    if (result.kind === 'ambiguous') return { ok: false, error: `Which one? ${result.options.map(o => o.label).join(' or ')}` }
    return this.rescheduleAt(id, result.at)
  }

  rescheduleAt(id: string, at: number): { ok: true; words: string } | { ok: false; error: string } {
    const rt = this.rt
    const w = this.current().watchers.find(x => x.id === id)
    if (w === undefined || !Ops.isWatcherOpen(w)) return { ok: false, error: `No open watcher ${id}.` }
    const now = this.now()
    // Rescheduled, it parks the run from here: a fresh checkpoint (or the next turn's end).
    const decided = w.strategy === 'smart' ? this.smartFor(at) : w.decided
    this.commit(Ops.patchWatcher(this.current(), id, { wakeAt: at, status: 'armed', needs: null, checkpoint: rt.turn.isRunning ? null : this.checkpoint(), decided, firedAt: null }, { at: now, text: `${id} rescheduled to ${clockAhead(at, now)}` }))
    if (!rt.turn.isRunning) rt.cache.schedule()
    return { ok: true, words: `${id} wakes ${clockAhead(at, now)} (in ${untilWords(at - now)})` }
  }

  pause(id: string): void {
    this.commit(Ops.patchWatcher(this.current(), id, { status: 'paused' }, { at: this.now(), text: `${id} paused` }))
  }

  resume(id: string): void {
    const w = this.current().watchers.find(x => x.id === id)
    if (w === undefined || w.status !== 'paused') return
    const now = this.now()
    this.commit(Ops.patchWatcher(this.current(), id, { status: w.wakeAt <= now ? 'due' : 'armed', needs: w.wakeAt <= now ? `Watcher was due ${agoWords(now - w.wakeAt)} while paused.` : null, checkpoint: this.rt.turn.isRunning ? null : this.checkpoint() }, { at: now, text: `${id} resumed` }))
  }

  dismiss(id: string): void {
    this.commit(Ops.patchWatcher(this.current(), id, { status: 'dismissed', endedAt: this.now(), outcome: 'Dismissed', needs: null }, { at: this.now(), text: `${id} dismissed` }))
    this.rt.cache.schedule()
  }

  setStrategy(id: string, strategy: WatchStrategy): void {
    const w = this.current().watchers.find(x => x.id === id)
    if (w === undefined || !Ops.isWatcherOpen(w)) return
    this.commit(Ops.patchWatcher(this.current(), id, { strategy, decided: strategy === 'smart' ? this.smartFor(w.wakeAt) : null }))
    if (!this.rt.turn.isRunning) this.rt.cache.schedule()
  }

  /** Before a fresh park: Claude writes the notes now (the person asked), so the fresh wake has them. */
  async prepareNotes(id: string): Promise<void> {
    const rt = this.rt
    const host = rt.host
    const w = this.current().watchers.find(x => x.id === id)
    if (host === null || w === undefined || !this.isFree()) return
    this.setInFlight({ kind: 'park', ids: [id], isForced: false })
    const planTool = rt.planSource === 'milestones' ? rt.milestonesTool : rt.planSource === 'tasks' ? 'your task list (TodoWrite or the Task tools)' : null
    try {
      const result = await host.submit(prompts.parkPrompt({ id, label: w.label, wakeAt: w.wakeAt, handoffFile: rt.settings.autopilot.handoffFile, planTool }))
      if (result.drop !== undefined) throw new Error(result.drop)
      this.log(`${id}: Claude was asked to write the notes before the park`)
    } catch {
      this.inFlight = null
    }
  }

  // -------------------------------------------------------------------------
  // Watcher Scout

  /** After a turn: whether Claude evidently waits for a future result. Suggests a watcher, or arms one for an explicit wait. */
  private scout(kind: string): void {
    const rt = this.rt
    const mode = rt.settings.ops.scout
    const message = this.stopMessage
    this.stopMessage = ''
    if (mode === 'off' || !rt.settings.ops.watchers || this.current().watchers.some(Ops.isWatcherOpen)) return
    // A handoff under way (or waiting for background work) ends this context: no watcher is suggested into it.
    if (kind === 'park' || kind === 'handoff' || kind === 'retry' || rt.effective().autopilot.isHandoff) return
    // Claude Code's own wake-up already brings the run back: no watcher on top of it.
    if ((rt.lastStop?.wakeups.length ?? 0) > 0 || rt.blockingInFlight().length > 0) return
    const p = rt.progress()
    const found = scoutOf({ now: this.now(), message, waiting: p.waiting.map(t => ({ subject: t.subject, detail: t.detail })) })
    if (found === null) return
    if (mode === 'auto' && found.isExplicit && found.when !== null && found.when.kind === 'at') {
      const armed = this.armAt(found.label, found.when, 'smart', 'scout')
      if (armed.ok) {
        this.toast(`Watcher armed: ${armed.words}. Delete it in Activity → Operations if it is not wanted.`, 8000)
        this.log(`${armed.id} armed by the Scout: ${found.reason}`)
        return
      }
    }
    this.suggestion = { ...found, id: `S-${this.now().toString(36)}`, at: this.now() }
    rt.trace(`ops: Scout suggests a watcher (${found.reason})`)
    rt.publisher.mark('hud', 'ops')
  }

  /** Create watcher, from the suggestion (its time, or one the person gives). */
  takeSuggestion(whenText?: string): { ok: true; words: string } | { ok: false; error: string; options?: { at: number; label: string }[] } {
    const s = this.suggestion
    if (s === null) return { ok: false, error: 'No suggestion now.' }
    const result = whenText !== undefined ? parseWhen(whenText, this.now()) : s.when
    if (result === null) return { ok: false, error: 'When should it wake? Pick a time.' }
    const armed = this.armAt(s.label, result, 'smart', 'scout')
    if (!armed.ok) return armed
    this.suggestion = null
    this.rt.publisher.mark('hud', 'ops')
    return { ok: true, words: armed.words }
  }

  ignoreSuggestion(): void {
    this.suggestion = null
    this.rt.publisher.mark('hud', 'ops')
  }

  // -------------------------------------------------------------------------
  // Resume state

  /** The handoff notes' stat, looked at again after a turn (at most every 15 s) or when asked. */
  async refreshNotes(isNow = false): Promise<void> {
    const host = this.rt.host
    if (host === null) return
    const now = Date.now()
    if (!isNow && now - this.notesAt < 15_000) return
    this.notesAt = now
    const stat = await host.stat(this.rt.handoffPath(), false).catch(() => null)
    const next = stat === null || stat.kind !== 'file' ? null : { size: stat.size, mtimeMs: stat.mtimeMs }
    if (JSON.stringify(next) !== JSON.stringify(this.notes)) {
      this.notes = next
      this.rt.publisher.mark('ops', 'hud')
    }
  }

  private resumeInput(): ResumeInput {
    const rt = this.rt
    const plan = rt.plan()
    const h = rt.run?.lastHandoff ?? null
    const docs = h?.health.find(c => c.id === 'docs' && c.state === 'ok')?.detail ?? null
    const ops = this.current()
    return {
      runNumber: rt.run?.number ?? null,
      objective: rt.run?.objective ?? null,
      tasks: plan.tasks.map(t => ({ subject: t.subject, status: t.status, detail: t.detail, activeForm: t.activeForm })),
      planUpdatedAt: plan.updatedAt,
      notesPath: rt.handoffPath(),
      notes: this.notes,
      continuity: h === null || h.continuity === null ? null : { items: h.continuity, at: h.at },
      docs: docs === null ? [] : docs.split(/, | \+\d+$/).filter(Boolean),
      queued: ops.queue.filter(q => q.status === 'queued' || q.status === 'due').length,
      decisions: ops.decisions.filter(d => Ops.isDecisionOpen(d) || Ops.isAnswerWaiting(d)).length,
      stale: rt.staleEvidence().map(s => ({ subject: s.subject, status: 'stale' as const, line: Evidence.evidenceLine(s) ?? 'verification stale' })),
    }
  }

  resumeHealth(): { isHealthy: boolean; problems: string[] } {
    return resumeHealthOf(this.resumeInput())
  }

  resumePreview(): ReturnType<typeof resumePreviewOf> {
    return resumePreviewOf(this.resumeInput())
  }

  // -------------------------------------------------------------------------
  // Cold Resume Guard

  /** Claude Code's word on a resumed session: how long since its last answer, its context, whether the cache likely expired, its estimate. */
  noteResumed(input: { secondsSince?: number; tokens?: number; isExpired?: boolean; usd?: number; model?: string }): void {
    this.resumed = {
      at: this.now(),
      secondsSince: input.secondsSince ?? null,
      tokens: input.tokens ?? null,
      isExpired: input.isExpired === true,
      usd: input.usd !== undefined && Number.isFinite(input.usd) && input.usd > 0 ? input.usd : null,
      model: input.model ?? null,
    }
    if (input.model !== undefined && input.usd !== undefined && input.tokens !== undefined) {
      this.rt.cache.noteWriteRate({ model: input.model, ttl: null, usd: input.usd, tokens: input.tokens, pricing: undefined })
    }
    this.rt.publisher.mark('ops')
  }

  /** Whether the cache has surely lapsed over a large context: what the guard and a watcher's wake act on. */
  coldState(now: number): ColdResumeView {
    const rt = this.rt
    const s = rt.settings.cache
    const c = rt.cache.state
    let tokens = rt.usage.tokens ?? c.lastPrefix
    let isCold = false
    let cause: string | null = null
    let usd: number | null = null
    let priceNote: string | null = null
    const r = this.resumed
    // Claude Code's own request since (its away summary, seen live) read this cache: it may be warm until that plus its lifetime.
    const side = rt.cache.sideRequestAt
    const isSideWarm = (since: number): boolean => side !== null && side > since && now < side + (Cache.ttlMs(c) ?? SURELY_LAPSED_MS)
    if (r !== null && c.requests === 0 && c.lastRequestAt === null && r.isExpired && (r.tokens ?? 0) > 0 && !isSideWarm(r.at)) {
      isCold = true
      tokens = r.tokens ?? tokens
      cause = r.secondsSince === null ? 'the session was resumed after its cache lapsed' : `its last answer was ${agoWords(r.secondsSince * 1000)}, longer than the cache lasts`
      if (r.usd !== null) {
        usd = r.usd
        priceNote = "Claude Code's own estimate"
      }
    } else if (c.lastRequestAt !== null && c.lastPrefix >= Cache.MIN_PREFIX) {
      const warmth = Cache.warmthOf(c, now, rt.turn.isRunning)
      const idle = now - c.lastRequestAt
      isCold = (warmth === 'cold' || (c.ttl === null && idle > SURELY_LAPSED_MS)) && !isSideWarm(c.lastRequestAt)
      if (isCold) cause = this.coldCause(idle)
    }
    if (isCold && usd === null) {
      const model = c.model ?? rt.sessionModel
      const rate = model === '' ? null : rt.cache.writeRate(model, c.ttl?.value ?? null)
      if (rate !== null) {
        usd = (tokens * rate.usdPerMTok) / 1_000_000
        priceNote = `at Claude Code's cache-write price for ${Cache.shortModel(model)} (${rate.pricing === 'configured' ? 'your managed pricing' : 'list price'}, ${fmt.when(rate.at, now)})`
      }
    }
    return { isOn: s.coldResume, threshold: s.coldResumeTokens, isArmed: s.coldResume && isCold && tokens >= s.coldResumeTokens, tokens: isCold ? tokens : (rt.usage.tokens ?? null), cause, usd, priceNote, last: this.coldLast }
  }

  /** Why the cache lapsed, from what Keep warm knows. */
  private coldCause(idleMs: number): string {
    const rt = this.rt
    const c = rt.cache
    const s = rt.settings.cache
    const idle = `idle ${fmt.duration(idleMs)}`
    if (c.state.keepWarm.verified === 'no') return `${idle}; Keep warm paused itself (${clean(c.state.keepWarm.pausedReason ?? 'it did not hold the cache', 80)})`
    // Before "off": a watcher that held the cache is no longer armed at its own wake (seen live: a refused refresh read as "Keep warm was off").
    if (c.lastError !== null) return `${idle}; Keep warm's refresh failed (${clean(c.lastError, 60)})`
    if (!s.keepWarm && this.hold() === null) return `${idle}; Keep warm was off`
    const reason = c.plan.at === null ? c.plan.reason : ''
    if (/^Paused (after|at)/.test(reason)) return `${idle}; Keep warm stopped at its ${fmt.minutes(s.maxIdleMinutes)} idle limit`
    if (/handoff/i.test(reason)) return `${idle}; Keep warm stood down for a handoff`
    return `${idle}; the ${c.state.ttl?.value === '5m' ? '5-minute' : c.state.ttl?.value === '1h' ? '1-hour' : ''} cache lapsed`.replace('the  cache', 'the cache')
  }

  /**
   * Before a message is sent into a context whose cache has surely lapsed over a large context: ask,
   * in Claude Code's own question dialog. Returns null to let the message go, or a drop reason.
   * Nothing has been sent when it asks; Cancel puts the message back in the prompt box.
   */
  async coldGuard(e: { text: string; origin?: PromptOrigin; turnId?: string; attachments?: readonly unknown[] }): Promise<{ drop: string } | null> {
    const rt = this.rt
    const host = rt.host
    if (host === null || e.turnId !== undefined || rt.turn.isRunning || !isPersonOrigin(e.origin)) return null
    if (prompts.ownPromptKind(e.text) !== null || rt.surfaces.length === 0) return null
    const now = this.now()
    const cold = this.coldState(now)
    if (!cold.isArmed || cold.tokens === null) return null
    const health = this.resumeHealth()
    const preview = this.resumePreview()
    // Tokens are the fact; a price is only ever an estimate, and the re-read costs at least that (seen live: Claude Code's $0.36 was $0.52).
    const cost = Cache.coldCostWords(cold)
    const fresh = health.isHealthy ? ` Start fresh: ${previewLine(preview)}, then your message.` : ` A fresh start is not offered: ${health.problems[0] ?? 'the resume state is not ready'}.`
    const question = `${fmt.tokens(cold.tokens)} tokens need to be reprocessed: the prompt cache expired, and continuing sends this session's earlier context again before the cache is warm.${cost === null ? '' : ` ${cost.sentence}`} Why: ${cold.cause ?? 'it lapsed'}.${fresh} Compact first reads it all once more to summarise it, then the context is smaller. Continue?`
    const options = [COLD.continue, ...(health.isHealthy ? [COLD.fresh] : []), COLD.compact, COLD.cancel]
    rt.trace(`cold resume: asking before a message re-reads ${cold.tokens} tokens (${cold.cause ?? 'lapsed'})`)
    let answer: string
    let isDismissed = false
    try {
      answer = await host.ask(question, options, 'Cache cold')
    } catch {
      // Dismissed: nothing is sent, the message comes back.
      answer = COLD.cancel
      isDismissed = true
    }
    this.coldLast = { at: this.now(), choice: answer }
    rt.publisher.mark('ops')
    const hasAttachments = (e.attachments?.length ?? 0) > 0
    switch (answer) {
      case COLD.continue:
        rt.trace('cold resume: continued with the full session')
        return null
      case COLD.fresh:
        if (!health.isHealthy) return null
        void this.freshForMessage(e.text, hasAttachments, cold.tokens)
        this.clearRestored(e.text, 'goes to the fresh context')
        return { drop: 'Starting fresh from the resume state: your message goes to the fresh context.' }
      case COLD.compact:
        this.compactForMessage(e.text, hasAttachments)
        this.clearRestored(e.text, 'is sent after the compaction')
        return { drop: 'Compacting first (it reads the conversation once now): your message is sent after.' }
      default:
        rt.trace(`cold resume: ${isDismissed ? 'the question was dismissed' : answer === COLD.cancel ? 'cancelled' : `answered "${clean(answer, 60)}"`}; nothing sent, the message goes back to the prompt box`)
        this.putBack(e.text, hasAttachments)
        return { drop: hasAttachments ? 'Not sent. Your message is back in the prompt box (attachments were not kept).' : 'Not sent. Your message is back in the prompt box.' }
    }
  }

  /**
   * The message goes on by Project Sentinel's own hand (Start fresh, Compact first), but Claude Code
   * puts a dropped prompt's text back in the prompt box, where one Enter would send it a second time
   * (seen live). The box is cleared while it still holds just that text, never what the person typed.
   */
  clearRestored(text: string, how: string): void {
    const host = this.rt.host
    if (host === null || text.trim() === '') return
    host.after(400, () => {
      void host
        .readPrompt()
        .then(async box => {
          if (box.text.trim() !== text.trim()) return
          const cleared = await host.fillPrompt('')
          this.rt.trace(`cold resume: ${cleared.isFilled ? 'cleared the copy Claude Code put back in the prompt box' : 'could not clear the copy Claude Code put back in the prompt box'}; the message ${how}`)
        })
        .catch(() => undefined)
    })
  }

  /** The message goes back in the prompt box; where it cannot, it is kept in Operations (memory only). */
  putBack(text: string, hasAttachments: boolean): void {
    const host = this.rt.host
    if (host === null) return
    host.after(400, () => {
      void host
        .fillPrompt(text)
        .catch(() => ({ isFilled: false }))
        .then(r => {
          if (r.isFilled) return
          this.held = { text, at: this.now(), hasAttachments }
          this.rt.publisher.mark('ops', 'hud')
          this.toast('Your message is kept in Control Room → Activity → Operations (the prompt box could not take it back).', 8000)
        })
    })
  }

  /** Start fresh from the resume state, then the person's message. */
  private async freshForMessage(text: string, hasAttachments: boolean, tokens: number): Promise<void> {
    const rt = this.rt
    rt.trace(`cold resume: starting fresh instead of re-reading ${tokens} tokens. Resume preview: ${previewLine(this.resumePreview())}`)
    const result = await rt.freshStart({
      why: `the user chose to start fresh instead of re-reading ${fmt.tokens(tokens)} tokens of earlier context whose prompt cache had expired.`,
      then: `Then answer the user's message, which they sent just before the fresh start:\n\n${text}`,
      endNote: 'fresh resume (cache cold)',
      cause: 'to start fresh instead of re-reading a context whose prompt cache had expired',
      watcherId: null,
    })
    if (!result.ok) {
      this.toast(`Could not start fresh (${result.error}). Your message is back in the prompt box.`, 8000)
      this.putBack(text, hasAttachments)
    }
  }

  /**
   * Compact first, then the person's message, as theirs. The compaction starts once the prompt it
   * replaces is dropped: asked from inside that prompt's dispatch, Claude Code refuses it as a turn
   * under way (seen live: Compact first gave up at once and nothing was compacted).
   */
  private compactForMessage(text: string, hasAttachments: boolean): void {
    const rt = this.rt
    const host = rt.host
    if (host === null) return
    this.afterCompact = { text, at: this.now() }
    rt.trace('cold resume: compacting before the message')
    const giveUp = (why: string) => {
      if (this.afterCompact?.text !== text) return
      this.afterCompact = null
      rt.trace(`cold resume: the compaction did not run (${why}); the message goes back to the prompt box`)
      this.toast(`The compaction did not run (${clean(why, 80)}). Your message is back in the prompt box.`, 8000)
      this.putBack(text, hasAttachments)
    }
    host.after(10 * 60_000, () => giveUp('it did not finish within 10 minutes'))
    const instructions = 'Keep the current task, its state, decisions and unfinished work.'
    const attempt = async (n: number): Promise<void> => {
      if (this.afterCompact?.text !== text) return
      try {
        const result = await host.compact(instructions)
        if (result.skip !== undefined) {
          giveUp(`a hook skipped it: ${result.skip}`)
          return
        }
        // Claude Code runs every session.compact hook but the caller's for this one ("skipped: re-entry",
        // seen live: the message waited for a compaction it never heard of), so it is seen here.
        rt.trace(`cold resume: compacted (${result.tokensBefore === undefined ? '?' : fmt.tokens(result.tokensBefore)} → ${result.tokensAfter === undefined ? '?' : fmt.tokens(result.tokensAfter)} tokens)`)
        rt.onCompacted('manual', result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A session that compacts only inside a turn (Desktop's, a headless one): the /compact command does it.
        if (isTurnOnlyCompact(message)) {
          await host.compactCommand(instructions).catch(e => giveUp(e instanceof Error ? e.message : String(e)))
          return
        }
        // The dropped prompt's dispatch had not settled yet: try again shortly.
        if (n < COMPACT_TRIES && /\bturn\b|busy|in progress|running|loading|submit/i.test(message)) {
          rt.trace(`cold resume: the compaction was refused (${clean(message, 100)}); trying again`)
          host.after(1500 * n, () => void attempt(n + 1))
          return
        }
        giveUp(message)
      }
    }
    host.after(COMPACT_AFTER_DROP_MS, () => void attempt(1))
  }

  /** A compaction finished: a message the Cold Resume Guard held for it goes now, as the person's. */
  onCompacted(): void {
    const held = this.afterCompact
    const host = this.rt.host
    if (held === null || host === null) return
    this.afterCompact = null
    host.after(600, () => {
      void host.submitAsUser(held.text).catch(() => this.putBack(held.text, false))
    })
  }

  /** Held message: back to the prompt box, sent now, or dropped. */
  heldPutBack(): void {
    const h = this.held
    if (h === null) return
    this.held = null
    this.putBack(h.text, h.hasAttachments)
    this.rt.publisher.mark('ops', 'hud')
  }

  heldSend(): void {
    const h = this.held
    const host = this.rt.host
    if (h === null || host === null) return
    this.held = null
    // The person chose to send it as it is: the guard does not ask again for it.
    this.coldLast = { at: this.now(), choice: COLD.continue }
    void host.submitAsUser(h.text).catch(() => (this.held = h))
    this.rt.publisher.mark('ops', 'hud')
  }

  heldDiscard(): void {
    this.held = null
    this.rt.publisher.mark('ops', 'hud')
  }

  // -------------------------------------------------------------------------
  // Run Budget

  private metrics(): Ops.BudgetMetrics {
    const rt = this.rt
    const totals = rt.run === null ? null : Chain.totals(rt.run, this.now())
    return { costUsd: totals?.costUsd ?? null, isCostPartial: totals?.isCostPartial ?? false, durationMs: totals?.durationMs ?? 0, handoffs: totals?.handoffs ?? 0 }
  }

  budgetCheck(): Ops.BudgetCheck | null {
    const b = this.current().budget
    return b === null ? null : Ops.checkBudget(b, this.metrics())
  }

  /** Says a limit once when it is near and once when it is reached; Finish the milestone tells Claude mid-turn. */
  checkBudget(): void {
    const rt = this.rt
    const b = this.current().budget
    if (b === null) return
    const check = Ops.checkBudget(b, this.metrics())
    const newlyNear = check.near.filter(k => !b.warned.includes(k))
    const newlyReached = check.reached.filter(k => !b.reached.includes(k))
    if (newlyNear.length === 0 && newlyReached.length === 0) return
    this.commit({ ...this.current(), budget: { ...b, warned: [...new Set([...b.warned, ...newlyNear, ...newlyReached])], reached: [...new Set([...b.reached, ...newlyReached])] } })
    const words = (keys: readonly Ops.BudgetKey[]) => keys.map(k => check.words[k]).filter((w): w is string => w !== null)
    if (newlyNear.length > 0) this.toast(`Run budget near: ${words(newlyNear).join('; ')}`, 6000)
    if (newlyReached.length > 0) {
      this.toast(`Run budget reached: ${words(newlyReached).join('; ')}${b.atLimit === 'notify' ? '' : '. Project Sentinel starts no more work by itself until you say so.'}`, 8000)
      this.log(`Run budget reached: ${words(newlyReached).join('; ')}`)
      if (b.atLimit === 'finish' && rt.turn.isRunning) rt.tell('budget', prompts.budgetNote(words(check.reached)))
    }
  }

  /** A cost limit is set and not reached yet: the Runtime reads the session's cost as Claude works. */
  isCostWatched(): boolean {
    const b = this.current().budget
    return b !== null && b.costUsd !== null && !b.reached.includes('cost')
  }

  /** A limit set to Ask or Finish is reached and the person has not said go on: automation waits for them. */
  isBudgetHolding(): boolean {
    const b = this.current().budget
    if (b === null || b.atLimit === 'notify') return false
    return Ops.checkBudget(b, this.metrics()).reached.some(k => !b.approved.includes(k))
  }

  /** Whether automation may start a turn now: not past a limit set to Ask or Finish, unless the person said go on. */
  mayAutomate(what: string): boolean {
    if (!this.isBudgetHolding()) return true
    if (this.budgetHeld !== what) {
      this.budgetHeld = what
      this.rt.trace(`ops: run budget reached, ${what} waits for you`)
      this.rt.publisher.mark('hud', 'ops')
    }
    return false
  }

  /** What automation waits on the budget for, in words; null when nothing does. */
  budgetHeld: string | null = null

  /** Continue anyway: automation goes on past the limits reached now; a new one asks again. */
  approveBudget(): void {
    const b = this.current().budget
    if (b === null) return
    const check = Ops.checkBudget(b, this.metrics())
    this.commit({ ...this.current(), budget: { ...b, approved: [...new Set([...b.approved, ...check.reached])] } })
    this.budgetHeld = null
    this.log('Run budget: you let the run go on past its limit')
    this.atBoundary()
  }

  /**
   * At a limit set to Ask or Finish, the person's next message asks once whether the run goes on;
   * a yes lets automation go on past the limits reached now. A no keeps the message in the box.
   */
  async budgetGuard(e: { text: string; origin?: PromptOrigin; turnId?: string; attachments?: readonly unknown[] }): Promise<{ drop: string } | null> {
    const rt = this.rt
    const host = rt.host
    const b = this.current().budget
    if (host === null || b === null || b.atLimit === 'notify' || e.turnId !== undefined || rt.turn.isRunning || !isPersonOrigin(e.origin)) return null
    if (prompts.ownPromptKind(e.text) !== null || rt.surfaces.length === 0) return null
    const check = Ops.checkBudget(b, this.metrics())
    const blocking = check.reached.filter(k => !b.approved.includes(k))
    if (blocking.length === 0) return null
    const words = blocking.map(k => check.words[k]).filter((w): w is string => w !== null)
    let answer: string
    try {
      answer = await host.ask(`The run budget is reached: ${words.join('; ')}. Continue this run?`, ['Continue the run', 'Not now'], 'Budget')
    } catch {
      answer = 'Not now'
    }
    if (answer === 'Continue the run') {
      this.approveBudget()
      return null
    }
    this.putBack(e.text, (e.attachments?.length ?? 0) > 0)
    return { drop: 'Not sent: the run budget is reached. Your message is back in the prompt box; raise the budget in Activity → Operations, or continue.' }
  }

  setBudget(patch: Parameters<typeof Ops.setBudget>[1]): void {
    this.commit(Ops.setBudget(this.current(), patch, this.now()))
    this.budgetHeld = null
    this.checkBudget()
  }

  // -------------------------------------------------------------------------
  // Agents

  /** An agent started (its spawn resolved with its id): it shows from now, before Claude Code lists it (a workflow's never are). */
  noteSpawn(input: {
    agentId: string
    model: string | null
    isBackground: boolean
    isFork: boolean
    description: string
    type: string
    name: string | null
    parentId: string | null
    workflow?: { runId: string; index: number } | null
    toolUseId?: string | null
    isTeammate?: boolean
  }): void {
    noteSpawn(this.agentLedger, { ...input, at: this.now() })
    this.saveAgents(true)
    this.rt.publisher.mark('ops', 'hud', 'activity', 'pane')
  }

  noteAgentModel(agentId: string, model: string): void {
    if (noteModel(this.agentLedger, agentId, model)) this.saveAgents()
  }

  /** A request in an agent's loop: it is active now. */
  noteAgentStep(agentId: string): void {
    if (noteStep(this.agentLedger, agentId, this.now())) this.rt.publisher.mark('ops', 'hud')
  }

  /** A call in an agent's loop: what it is doing now. An id the ledger does not know (an engine fork) is left out. */
  noteAgentCall(agentId: string, doing: string): void {
    if (!noteCall(this.agentLedger, agentId, doing, this.now())) return
    this.saveAgents()
    this.rt.publisher.mark('ops', 'hud')
  }

  /** A plan an agent keeps in its own loop (a task list call, the milestones tool). */
  noteAgentPlan(agentId: string, change: Parameters<typeof notePlan>[2]): boolean {
    if (!notePlan(this.agentLedger, agentId, change)) return false
    this.saveAgents()
    this.rt.publisher.mark('ops', 'hud')
    return true
  }

  noteAgentEnd(agentId: string, reason: 'answer' | 'aborted' | 'refusal' | 'error', answer: string): void {
    noteEnd(this.agentLedger, agentId, { at: this.now(), reason, answer })
    this.saveAgents(true)
    this.rt.publisher.mark('ops', 'hud', 'activity', 'pane')
  }

  /** A workflow run's tool call ended: its agents with no end of their own seen end with it. */
  noteWorkflowEnd(toolUseId: string, status: string | null): void {
    const n = noteWorkflowEnd(this.agentLedger, toolUseId, status, this.now())
    if (n === 0) return
    this.rt.trace(`agents: the workflow of ${toolUseId} ended (${status ?? 'ended'}); ${n} of its agents with no end seen end with it`)
    this.saveAgents(true)
    this.rt.publisher.mark('ops', 'hud', 'activity', 'pane')
  }

  /** Claude Code's list, looked at: the ledger reconciles with it (features/agents.ts reconcile). */
  reconcileAgents(listed: Parameters<typeof reconcile>[1]): void {
    if (!reconcile(this.agentLedger, listed, this.now())) return
    this.saveAgents()
    this.rt.publisher.mark('ops', 'hud', 'activity', 'pane')
  }

  /** The agents as the panel, the status bar and the limit count them now. */
  agentRowsNow(): AgentRowView[] {
    const rt = this.rt
    const listed = rt.agents.list.map(a => ({ id: a.id, type: a.type, description: a.description, status: a.status, parentId: a.parentId, name: a.name, teammateId: a.teammateId }))
    const activityOf = (agentId: string) => {
      const items = rt.activity.items.filter(i => i.agentId === agentId)
      const last = items.find(i => i.status === 'running') ?? items[0]
      return { label: last === undefined ? null : doingOf(last), calls: items.length }
    }
    return agentRows(this.agentLedger, listed, this.now(), activityOf)
  }

  private saveTimer: Timer | null = null

  /**
   * The ledger rides `$.state`: a reload of the plugin keeps what this session saw of its agents (seen
   * live: after a reload a running background agent lost Stop and Message, and its time and model).
   * Written at once for a start or an end, else at most every couple of seconds (an agent's every call).
   */
  private saveAgents(isNow = false): void {
    const host = this.rt.host
    if (host === null) return
    const write = () => void host.saveAgentLedger([...this.agentLedger.values()]).catch(() => undefined)
    if (isNow) {
      this.saveTimer?.cancel()
      this.saveTimer = null
      write()
      return
    }
    if (this.saveTimer !== null) return
    this.saveTimer = host.after(2000, () => {
      this.saveTimer = null
      write()
    })
  }

  /** At a load: what the runtime before this one saw of the session's agents. */
  async restoreAgents(): Promise<void> {
    const host = this.rt.host
    if (host === null) return
    const n = restoreLedger(this.agentLedger, await host.loadAgentLedger().catch(() => null))
    if (n > 0) this.rt.trace(`ops: ${n} agent${n === 1 ? '' : 's'} carried across the reload`)
  }

  /** What the person did to agents here, until Claude has been told (one note: a newer note of a kind replaces a waiting one). */
  private agentActions: string[] = []

  private tellAgents(action: string): void {
    this.agentActions = [...this.agentActions, action].slice(-6)
    this.rt.tell('agents', prompts.agentActionsNote(this.agentActions))
  }

  private agentName(id: string): string {
    const listed = this.rt.agents.list.find(a => a.id === id)
    const seen = this.agentLedger.get(id)
    return clean(listed?.name ?? seen?.name ?? (listed?.description || seen?.description || id), 60)
  }

  /** Stop: Claude Code's TaskStop, which takes background agents and teammates by id. Its refusal is said as it words it. */
  async stopAgent(id: string): Promise<void> {
    const rt = this.rt
    const host = rt.host
    if (host === null) return
    const result = await host.stopTask(id).catch(error => ({ deny: error instanceof Error ? error.message : String(error) }) as { deny: string })
    const refusal = 'deny' in result && result.deny !== undefined ? result.deny : 'isError' in result && result.isError === true ? (result.text ?? 'refused') : null
    this.log(refusal === null ? `Stopped agent ${id}` : `Claude Code did not stop agent ${id}: ${clean(String(refusal), 100)}`)
    if (refusal !== null) this.toast(`Could not stop the agent: ${clean(String(refusal), 100)}`)
    else {
      this.tellAgents(`stopped the agent "${this.agentName(id)}" (${id})`)
      // Background work in flight, as a handoff waiting for it counts it, ended here.
      rt.noteTaskEnded(id, 'killed', 'your Stop', await rt.engineNow())
    }
    await rt.refreshAgents()
  }

  /** Message: Claude Code's own SendMessage delivery to the agent. */
  async messageAgent(id: string, text: string): Promise<void> {
    const host = this.rt.host
    const t = text.trim()
    if (host === null || t === '') return
    const result = await host.sendToAgent(id, t).catch(error => ({ isDelivered: false, reason: error instanceof Error ? error.message : String(error) }))
    this.log(result.isDelivered ? `Message sent to agent ${id}` : `Message to agent ${id} not delivered: ${clean(result.reason ?? 'refused', 100)}`)
    if (!result.isDelivered) this.toast(`Not delivered: ${clean(result.reason ?? 'refused', 100)}`)
    else this.tellAgents(`sent the agent "${this.agentName(id)}" (${id}) this message: "${clean(t, 300)}"`)
  }

  // -------------------------------------------------------------------------
  // Views

  view(): OpsView {
    const rt = this.rt
    const now = this.now()
    const ops = this.current()
    const s = rt.settings.ops
    const qView = (q: Ops.QueueItem) => ({ id: q.id, text: q.text, target: q.target, when: this.queueWhen(q), status: q.status, createdAt: q.createdAt, deliveredAt: q.deliveredAt })
    const route = (d: Ops.Decision): string | null => {
      if (d.status === 'unsure') return 'Sent before a reload: check the transcript'
      if (d.status === 'sending') return d.via === 'note' ? 'Goes with Claude’s next tool results' : 'On its way'
      if (d.status !== 'answered') return null
      if (rt.turn.isRunning) return 'Goes with Claude’s next tool results'
      if (d.isBlocking) return 'Goes to Claude now'
      // A parked run: the wake carries it (the fresh context's first message, or the wake prompt as context).
      const holder = Ops.holdingWatcher(ops)
      if (holder !== null && holder.status === 'armed') return `Goes with ${holder.id}'s wake (${clockAhead(holder.wakeAt, now)}), or with your next message (or Send now)`
      return 'Goes with your next message (or Send now)'
    }
    const dView = (d: Ops.Decision) => ({ id: d.id, question: d.question, context: d.context, options: d.options, allowText: d.allowText, urgency: d.urgency, isBlocking: d.isBlocking, milestone: d.milestone, status: d.status, answer: d.answer, createdAt: d.createdAt, answeredAt: d.answeredAt, deliveredAt: d.deliveredAt, route: route(d) })
    const wView = (w: Ops.Watcher) => {
      const how = Ops.modeOf(w)
      return {
        id: w.id,
        label: w.label,
        createdAt: w.createdAt,
        wakeAt: w.wakeAt,
        strategy: w.strategy,
        decided: w.strategy === 'smart' && w.decided !== null ? { mode: w.decided.mode, hold: w.decided.hold, reason: w.decided.reason } : w.strategy === 'smart' ? null : { mode: how.mode, hold: how.hold, reason: w.strategy === 'warm' ? 'You chose Keep warm: the cache is held to the wake' : 'You chose Fresh: nothing is spent while it sleeps' },
        status: w.status,
        milestone: w.milestone,
        isCheckpointPending: w.checkpoint === null && w.status === 'armed',
        needs: w.needs,
        outcome: w.outcome,
        source: w.source,
      }
    }
    const check = this.budgetCheck()
    const b = ops.budget
    const m = this.metrics()
    const tone = (k: Ops.BudgetKey): Tone => (check?.reached.includes(k) ? 'bad' : check?.near.includes(k) ? 'warn' : 'normal')
    const wakes = (rt.lastStop?.wakeups ?? []).map(w => ({ schedule: w.schedule, at: cronWakeAt(w.schedule, w.recurring, now), isRecurring: w.recurring }))
    const headline = rt.hudHeadline()
    return {
      settings: { decisions: s.decisions, watchers: s.watchers, scout: s.scout },
      queue: ops.queue.filter(Ops.isQueueOpen).map(qView),
      queueDone: ops.queue.filter(q => !Ops.isQueueOpen(q)).slice(-4).reverse().map(qView),
      decisions: ops.decisions.filter(d => Ops.isDecisionOpen(d) || Ops.isAnswerWaiting(d)).map(dView),
      decisionsDone: ops.decisions.filter(d => d.status === 'delivered' || d.status === 'withdrawn').slice(-4).reverse().map(dView),
      watchers: ops.watchers.filter(Ops.isWatcherOpen).sort((a, b) => a.wakeAt - b.wakeAt).map(wView),
      watchersDone: ops.watchers.filter(w => !Ops.isWatcherOpen(w)).slice(-4).reverse().map(wView),
      externalWakes: wakes,
      agents: this.agentRowsNow(),
      main: { state: headline.state, text: headline.text },
      budget: {
        isSet: b !== null,
        cost: { used: m.costUsd, limit: b?.costUsd ?? null, tone: tone('cost'), isPartial: m.isCostPartial },
        time: { used: m.durationMs, limit: b?.durationMs ?? null, tone: tone('time') },
        handoffs: { used: m.handoffs, limit: b?.handoffs ?? null, tone: tone('handoffs') },
        atLimit: b?.atLimit ?? 'ask',
        state: b === null ? 'off' : check !== null && check.reached.length > 0 ? 'reached' : check !== null && check.near.length > 0 ? 'near' : 'ok',
        reached: check === null ? [] : check.reached.map(k => check.words[k]).filter((x): x is string => x !== null),
        held: this.budgetHeld,
      },
      resume: this.resumePreview(),
      cold: this.coldState(now),
      held: this.held,
      suggestion:
        this.suggestion === null
          ? null
          : {
              id: this.suggestion.id,
              label: this.suggestion.label,
              wakeAt: this.suggestion.when?.kind === 'at' ? this.suggestion.when.at : null,
              reason: this.suggestion.reason,
              isExplicit: this.suggestion.isExplicit,
              question: suggestionWords(this.suggestion, now),
            },
      foreign: this.foreign,
      log: ops.log.slice(0, 8),
      isSleeping: this.isSleeping(),
      isTurnRunning: rt.turn.isRunning,
      ui: { ...rt.ui.ops, expanded: [...rt.ui.ops.expanded] },
    }
  }

  /** The layer at a glance, for the status bar and Overview; null while it holds nothing. */
  hud(): HudOps | null {
    const rt = this.rt
    const ops = this.current()
    const open = ops.decisions.filter(Ops.isDecisionOpen)
    const review = open.length + (this.held === null ? 0 : 1)
    const blocking = open.filter(d => d.isBlocking).length
    const queued = ops.queue.filter(q => q.status === 'queued' || q.status === 'due' || q.status === 'unsure').length
    const due = ops.queue.filter(q => q.status === 'due').length
    const watchers = ops.watchers.filter(Ops.isWatcherOpen)
    const w = Ops.holdingWatcher(ops)
    const agents = aliveRows(this.agentRowsNow()).length
    const check = this.budgetCheck()
    const budget =
      check === null
        ? null
        : {
            text: check.reached.length > 0 ? `Budget reached` : (check.words.cost ?? check.words.time ?? check.words.handoffs ?? 'Budget set'),
            tone: (check.reached.length > 0 ? 'bad' : check.near.length > 0 ? 'warn' : 'muted') as Tone,
            isReached: check.reached.length > 0,
          }
    if (review === 0 && queued === 0 && watchers.length === 0 && agents === 0 && budget === null) return null
    const how = w === null ? null : Ops.modeOf(w)
    return {
      review,
      blocking,
      queued,
      due,
      watcher:
        w === null
          ? null
          : {
              id: w.id,
              label: w.label,
              wakeAt: w.wakeAt,
              at: clockAhead(w.wakeAt, this.now()),
              left: w.status === 'armed' ? untilWords(w.wakeAt - this.now()) : 'due',
              isHeldWarm: how?.hold === true && w.status === 'armed',
              mode: w.strategy === 'smart' && w.decided === null ? null : (how?.mode ?? null),
              status: w.status,
              needs: w.needs,
            },
      blockingQuestion: open.find(d => d.isBlocking)?.question ?? null,
      watchers: watchers.length,
      isSleeping: this.isSleeping(),
      agents,
      budget,
    }
  }
}
