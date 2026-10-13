/**
 * The status bar's headline and its chips: what the run is doing now, in
 * words a person would use, and what needs a look.
 *
 * The headline tells apart the states a long run spends its time in, so it
 * never says one thing while another is true:
 *
 *   working          a milestone under way (in Claude's words), or the call running
 *   thinking         a turn runs and no call does
 *   validating       a check running, or a milestone being verified
 *   handoff          Autopilot writing the notes, starting fresh, resuming
 *   waitingExternal  a result will come by itself: a background job, a scheduled
 *                    wake-up, a milestone marked waiting
 *   blocked          a milestone needs something only the person can give
 *   waitingUser      Claude asked the person something, or a handoff waits for them
 *   complete         every milestone done
 *   done / failing   the last turn's outcome, in counted words
 *   sleeping         a watcher parks the run until its time (Activity → Operations)
 *   ready            nothing has happened in this context yet
 *
 * Pure: a projection of the Runtime, like the other views.
 */

import type { HudChip, HudHeadline, HudModel, HudOps, Tone, TrackStop } from '../../types'
import * as fmt from '../core/format'
import { clean } from '../core/text'
import { blockingOf } from '../features/autopilot'
import { doingOf } from '../features/digest'
import type { PlanStatus, PlanTask } from '../features/plan'
import type { Runtime } from './runtime'

/** A running call is worth timing after this long. */
export const LONG_CALL_MS = 20_000

const HANDOFF_WORDS: Record<string, string> = {
  requested: 'Handing off: Claude writes the notes next',
  handoff: 'Writing the handoff notes',
  verifying: 'Handoff complete · checking the notes',
  clearing: 'Handoff complete · starting the fresh context',
  compacting: 'Handoff complete · compacting the context',
  resuming: 'Resuming in the fresh context',
}

/**
 * A written handoff waiting for background work, as the status bar says it: what it waits for and
 * that it runs, never "writing the handoff" while Claude Code reports a render still going.
 */
function waitingLine(rt: Runtime): HudHeadline {
  const a = rt.autopilot
  // The wait's end was set by the engine's clock: measured by it.
  const now = rt.engineTime()
  // What it waits for: a server running beside the handoff is not (it keeps running for the fresh context).
  const waiting = blockingOf(a.background)
  const first = waiting[0]
  if (first === undefined) {
    return {
      state: 'handoff',
      text: 'Handoff · background work finished',
      detail: rt.turn.isRunning ? 'Claude records the result, then the notes are checked' : 'then the notes are checked',
      tone: 'info',
    }
  }
  const more = waiting.length > 1 ? ` · ${waiting.length - 1} more` : ''
  // How much longer it waits at most, then it goes on and leaves the work running.
  const left = a.skipWait ? ' · goes on when this turn ends' : a.waitUntil === null ? '' : a.waitUntil > now ? ` · goes on in ${fmt.countdown(a.waitUntil - now)} at most` : ' · going on'
  return {
    state: 'handoff',
    text: a.notesWritten === true ? 'Handoff written · waiting for background work' : 'Handoff · waiting for background work',
    detail: `${clean(first.description, 80)} · running${more}${left}`,
    tone: rt.supervisor?.status === 'stalled' ? 'warn' : 'info',
  }
}

const TRACK: Record<PlanStatus, TrackStop> = { completed: 'done', in_progress: 'now', verifying: 'verify', waiting: 'held', blocked: 'held', pending: 'open' }

/** One stop per milestone, in plan order. */
export function trackOf(tasks: readonly { status: PlanStatus }[]): TrackStop[] {
  return tasks.map(t => TRACK[t.status])
}

/** "step 3 of 8": where a milestone sits in the plan. */
function stepOf(tasks: readonly PlanTask[], task: PlanTask): string {
  return `step ${tasks.indexOf(task) + 1} of ${tasks.length}`
}

/** A one-shot wake-up's cron ("37 5 8 10 *") as a clock time; null for a recurring or unreadable one. */
export function wakeAt(schedule: string, recurring: boolean, now: number): number | null {
  if (recurring) return null
  const [minute, hour, day, month] = schedule
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .map(v => (/^\d+$/.test(v) ? Number(v) : Number.NaN))
  if (minute === undefined || hour === undefined || day === undefined || month === undefined || [minute, hour, day, month].some(Number.isNaN)) return null
  const year = new Date(now).getFullYear()
  const at = new Date(year, month - 1, day, hour, minute).getTime()
  // A date already past this year is next year's.
  return at < now - 60_000 ? new Date(year + 1, month - 1, day, hour, minute).getTime() : at
}

/** The words a turn ended with ask the person something. */
export function endsWithQuestion(text: string): boolean {
  // A question inside a code block is code, not one put to the person.
  const lines = text
    .replace(/```[\s\S]*?(```|$)/g, '')
    .trim()
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('```'))
  const last = (lines.at(-1) ?? '').replace(/[*_`)\]"'”’]+$/u, '').trim()
  return last.endsWith('?')
}

export function headlineOf(rt: Runtime, now: number, summary: { text: string; durationMs: number | null; isFailing: boolean } | null): HudHeadline {
  const ap = rt.settings.autopilot.enabled ? rt.autopilot.state : 'off'
  const p = rt.progress()
  const tasks = rt.plan().tasks
  if (ap === 'waiting-background') return waitingLine(rt)
  const handoff = HANDOFF_WORDS[ap]
  if (handoff !== undefined) return { state: 'handoff', text: handoff, detail: rt.run === null ? null : `run ${rt.run.number}`, tone: rt.supervisor?.status === 'stalled' ? 'warn' : 'info' }

  // A call set to Ask waits for the person's answer to Control Room's question.
  const approval = rt.pendingApprovals[0]
  if (approval !== undefined) return { state: 'waitingUser', text: `Waiting for you to approve: ${approval.label.toLowerCase()}`, detail: approval.what, tone: 'warn' }

  if (rt.turn.isRunning) {
    const running = rt.activity.runningItems().filter(i => i.agentId === null)
    const longest = running.reduce((ms, i) => Math.max(ms, now - i.startedAt), 0)
    const elapsed = longest >= LONG_CALL_MS ? fmt.duration(longest) : null
    const step = p.current === null ? null : stepOf(tasks, p.current)
    const check = running.find(i => i.validation !== null)
    if (check !== undefined) {
      return { state: 'validating', text: doingOf(check), detail: [step, elapsed].filter(Boolean).join(' · ') || null, tone: 'info' }
    }
    if (p.current !== null) {
      const words = p.current.activeForm ?? p.current.subject
      const call = running.length > 0 && elapsed !== null ? `${doingOf(running[0]!).toLowerCase()} · ${elapsed}` : null
      if (p.current.status === 'verifying') return { state: 'validating', text: p.current.activeForm ?? `Verifying: ${p.current.subject}`, detail: [step, call].filter(Boolean).join(' · '), tone: 'info' }
      return { state: 'working', text: words, detail: [step, call].filter(Boolean).join(' · '), tone: 'info' }
    }
    if (running.length > 0) return { state: 'working', text: doingOf(running[0]!), detail: elapsed, tone: 'info' }
    return { state: 'thinking', text: 'Thinking', detail: null, tone: 'muted' }
  }

  // Between turns: what the run waits for, if anything, comes before what the last turn did.
  if (ap === 'awaiting') return { state: 'waitingUser', text: 'Waiting for you to start the fresh context', detail: null, tone: 'warn' }
  // The orchestration layer: a decision that blocks the run, a watcher that waits for the person, the run asleep.
  const ops = rt.ops.hud()
  if (ops !== null) {
    if (ops.blocking > 0) return { state: 'waitingUser', text: `Needs you · ${fmt.plural(ops.blocking, 'decision')}`, detail: ops.blockingQuestion === null ? null : clean(ops.blockingQuestion, 100), tone: 'warn' }
    const w = ops.watcher
    if (w !== null && (w.status === 'due' || w.status === 'stale') && w.needs !== null) return { state: 'waitingUser', text: `Watcher due: ${w.label}`, detail: w.needs, tone: 'warn' }
    if (w !== null && ops.isSleeping) {
      const how = w.isHeldWarm ? 'cache held warm' : w.mode === 'fresh' ? 'fresh wake · no keep-alive' : w.mode === null ? 'Smart decides at the wake' : 'wakes in this context'
      return { state: 'sleeping', text: `Sleeping until ${w.at} · ${w.label}`, detail: how, tone: 'info' }
    }
  }
  const stop = rt.lastStop
  // A result that will come by itself: work whose notification brings the turn back, never a server.
  const inFlight = blockingOf(stop?.background ?? [])
  if (inFlight.length > 0) {
    const first = inFlight[0]!
    const more = inFlight.length > 1 ? `${inFlight.length - 1} more running` : 'running in the background'
    return { state: 'waitingExternal', text: `Waiting for ${first.description}`, detail: more, tone: 'info' }
  }
  if (stop !== null && stop.wakeups.length > 0) {
    const next = stop.wakeups.map(w => wakeAt(w.schedule, w.recurring, now)).filter((t): t is number => t !== null).sort((a, b) => a - b)[0]
    return { state: 'waitingExternal', text: 'Waiting to check back', detail: next === undefined ? 'a scheduled check-in' : `wakes at ${fmt.clock(next)}`, tone: 'info' }
  }
  const waiting = p.waiting.at(-1)
  if (waiting !== undefined) return { state: 'waitingExternal', text: `Waiting for ${waiting.detail ?? waiting.subject}`, detail: stepOf(tasks, waiting), tone: 'info' }
  const blocked = p.blocked.at(-1)
  if (blocked !== undefined) return { state: 'blocked', text: `Blocked: ${blocked.detail ?? blocked.subject}`, detail: stepOf(tasks, blocked), tone: 'warn' }
  if (stop !== null && stop.isQuestion) return { state: 'waitingUser', text: 'Waiting for your answer', detail: summary?.text ?? null, tone: 'warn' }
  if (p.total > 0 && p.done === p.total) {
    return { state: 'complete', text: `All ${fmt.plural(p.total, 'milestone')} done`, detail: summary?.text ?? null, tone: 'good' }
  }
  if (summary !== null) {
    return { state: summary.isFailing ? 'failing' : 'done', text: summary.text, detail: summary.durationMs === null ? null : fmt.duration(summary.durationMs), tone: summary.isFailing ? 'warn' : 'good' }
  }
  // Nothing yet in this context: the run's objective as Claude stated it, else ready.
  const objective = rt.run?.objectiveBy === 'claude' ? (rt.run.objective ?? null) : null
  return { state: 'ready', text: objective === null ? 'Ready' : clean(objective, 120), detail: p.total > 0 ? `${p.done} of ${p.total} milestones done` : null, tone: 'muted' }
}

/**
 * Activity's "Now": what the run is doing or waiting for, without the last
 * turn's summary (This turn shows that). Between turns with nothing awaited,
 * the run is idle, ready for the next prompt; with every milestone done, it is
 * complete.
 */
export function runNowOf(rt: Runtime, now: number): { state: HudHeadline['state']; text: string } {
  const line = headlineOf(rt, now, null)
  if (line.state === 'ready' && rt.activity.turn.index > 0) return { state: 'idle', text: 'Idle, ready for your next prompt' }
  if (line.state === 'ready') return { state: 'ready', text: 'Ready for the first prompt' }
  return { state: line.state, text: line.detail === null || line.state === 'complete' ? line.text : `${line.text} · ${line.detail}` }
}

/**
 * What needs a look, most pressing first: failing checks, calls with trouble, decisions to review,
 * the guard, the machine, the budget, a watcher, queued work due, agents, the level. The
 * orchestration layer's chips open Activity → Operations; each shows only while it matters.
 */
export function chipsOf(hud: Pick<HudModel, 'failing' | 'attention' | 'guard' | 'load' | 'agents' | 'quest'> & { ops?: HudOps | null; isWorking?: boolean }): HudChip[] {
  const chips: HudChip[] = []
  const ops = hud.ops ?? null
  if (hud.failing.length > 0) chips.push({ key: 'failing', text: `${hud.failing.join(', ')} failing`, tone: 'bad' })
  if (hud.attention > 0) chips.push({ key: 'attention', text: fmt.plural(hud.attention, 'issue'), tone: 'warn' })
  // Decisions to review: the headline says it when one blocks the run.
  if (ops !== null && ops.review > 0 && (ops.blocking === 0 || hud.isWorking === true)) chips.push({ key: 'review', text: `Review ${ops.review}`, tone: 'warn', opens: 'ops' })
  if (hud.guard.isOn && hud.guard.continued > 0) chips.push({ key: 'guard', text: `Kept going ×${hud.guard.continued}`, tone: 'warn' })
  const load = hud.load
  const isHigh = (t: Tone) => t === 'warn' || t === 'bad'
  if (load !== null && isHigh(load.cpuTone)) chips.push({ key: 'cpu', text: `CPU ${Math.round(load.cpu ?? 0)}%`, tone: load.cpuTone })
  if (load !== null && isHigh(load.ramTone)) chips.push({ key: 'ram', text: `RAM ${Math.round(load.ram ?? 0)}%`, tone: load.ramTone })
  if (ops?.budget != null && ops.budget.tone !== 'muted') chips.push({ key: 'budget', text: ops.budget.text, tone: ops.budget.tone, opens: 'ops' })
  // A watcher armed while the run is not asleep (Claude works, or the person does): its countdown.
  if (ops?.watcher != null && !ops.isSleeping && ops.watcher.status === 'armed') chips.push({ key: 'watcher', text: `Watcher ${ops.watcher.left}`, tone: 'info', opens: 'ops' })
  if (ops != null && ops.due > 0 && hud.isWorking === true) chips.push({ key: 'queued', text: `Queued ${ops.due}`, tone: 'info', opens: 'ops' })
  if (hud.agents.running > 0) chips.push({ key: 'agents', text: hud.agents.limit === null ? fmt.plural(hud.agents.running, 'agent') : `${hud.agents.running} of ${hud.agents.limit} agents`, tone: 'info', opens: 'agents' })
  if (hud.quest !== null) chips.push({ key: 'quest', text: `Lv ${hud.quest.level}`, tone: 'accent' })
  return chips
}
