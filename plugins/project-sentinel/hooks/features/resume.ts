/**
 * Resume state: whether a fresh context could take this run on safely, and what it would get.
 *
 * A fresh start (the Cold Resume Guard's *Start fresh*, a fresh watcher wake, Autopilot's *Start
 * fresh*) throws the conversation away, so it is offered only when what replaces it is there:
 * the run's milestones (structured run state), the handoff notes written since those milestones
 * last changed, and no failed pickup by the last handoff's fresh context since. The preview says
 * what the fresh context will restore and read, what it carries (queued work, open decisions) and
 * what it does next. Pure: the Runtime gathers the facts (the notes' size and time from `stat`).
 */

import type { ResumeView } from '../../types'
import { clock } from '../core/format'
import type { PlanStatus } from './plan'

/** The notes may be written up to this long before the milestones' last change (a turn writes both, in either order). */
export const NOTES_GRACE_MS = 10 * 60_000
/** Notes this small say nothing a fresh context could act on. */
export const NOTES_MIN_BYTES = 200

export type ResumeInput = {
  runNumber: number | null
  objective: string | null
  tasks: readonly { subject: string; status: PlanStatus; detail: string | null; activeForm?: string | null }[]
  planUpdatedAt: number | null
  /** The notes' path as shown, and its stat; null when missing, undefined when not looked at yet. */
  notesPath: string
  notes: { size: number; mtimeMs: number } | null | undefined
  /** The last handoff's continuity check: its items' ids and states, and when the fresh context's first turn ended. */
  continuity: { items: readonly { id: string; state: 'ok' | 'missing' | 'none' }[]; at: number } | null
  /** The docs the last handoff updated, by name. */
  docs: readonly string[]
  /** Queued items that a fresh context carries, and decisions open or answered and not yet with Claude. */
  queued: number
  decisions: number
  /** Completed milestones whose verification is stale (features/evidence.ts): told to the fresh context, never a reason not to start it. */
  stale?: readonly { subject: string; status: 'stale' | 'changing' | 'rebaselined'; line: string }[]
}

export type ResumeHealth = { isHealthy: boolean; problems: string[] }

const fileName = (path: string): string => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path

const isUnderWay = (s: PlanStatus): boolean => s === 'in_progress' || s === 'verifying' || s === 'waiting' || s === 'blocked'

export function resumeHealthOf(i: ResumeInput): ResumeHealth {
  const problems: string[] = []
  const file = fileName(i.notesPath)
  if (i.tasks.length === 0) problems.push('No run state: Claude keeps no milestones for this run')
  if (i.notes === undefined) problems.push(`${file} has not been checked yet`)
  else if (i.notes === null) problems.push(`No handoff notes: ${file} is missing`)
  else if (i.notes.size < NOTES_MIN_BYTES) problems.push(`The handoff notes are nearly empty (${file})`)
  else if (i.planUpdatedAt !== null && i.notes.mtimeMs < i.planUpdatedAt - NOTES_GRACE_MS) problems.push(`${file} is older than the run's latest milestones`)
  // The last fresh context did not pick up its notes or its run state, and nothing was written since.
  const failed = i.continuity?.items.filter(c => (c.id === 'notesRead' || c.id === 'runState') && c.state === 'missing') ?? []
  if (failed.length > 0 && i.continuity !== null && (i.notes === null || i.notes === undefined || i.notes.mtimeMs < i.continuity.at)) {
    problems.push("The last handoff's fresh context did not pick up its notes or its run state")
  }
  return { isHealthy: problems.length === 0, problems }
}

/** What a fresh context would get, and whether it is ready to. */
export function resumePreviewOf(i: ResumeInput): ResumeView {
  const health = resumeHealthOf(i)
  const done = i.tasks.filter(t => t.status === 'completed')
  const current = [...i.tasks].reverse().find(t => isUnderWay(t.status)) ?? i.tasks.find(t => t.status === 'pending') ?? null
  const file = fileName(i.notesPath)
  const notes = i.notes ?? null
  const reads: ResumeView['reads'] = [
    { label: i.tasks.length === 0 ? 'Run state: no milestones' : `Run state: ${done.length} of ${i.tasks.length} milestones`, isOk: i.tasks.length > 0 },
    { label: notes === null ? `${file} (missing)` : `${file} (written ${clock(notes.mtimeMs)})`, isOk: notes !== null && notes.size >= NOTES_MIN_BYTES },
    ...i.docs.slice(0, 4).map(d => ({ label: d, isOk: true })),
  ]
  const next =
    current === null
      ? done.length > 0 && done.length === i.tasks.length
        ? 'Every milestone is done: check the work and wrap up'
        : null
      : current.status === 'waiting'
        ? `Check ${current.detail ?? current.subject}, then continue`
        : current.status === 'blocked'
          ? `Get ${current.detail ?? 'what blocks it'} from you, then continue`
          : (current.activeForm ?? current.subject)
  return {
    isHealthy: health.isHealthy,
    problems: health.problems,
    run: i.runNumber,
    objective: i.objective,
    done: done.slice(-5).map(t => t.subject),
    doneCount: done.length,
    total: i.tasks.length,
    current: current === null ? null : current.status === 'waiting' && current.detail !== null ? `Waiting for ${current.detail}` : current.subject,
    reads,
    notes: { path: i.notesPath, writtenAt: notes?.mtimeMs ?? null },
    queued: i.queued,
    decisions: i.decisions,
    next,
    stale: [...(i.stale ?? [])],
  }
}

/** The preview in one paragraph: what the Cold Resume Guard's question and the debug log say. */
export function previewLine(p: ResumeView): string {
  const run = p.run === null ? 'the run' : `run ${p.run}`
  const parts = [
    `Claude restores ${run}'s ${p.total} milestones (${p.doneCount} done${p.current === null ? '' : `; now: ${p.current}`})`,
    `reads ${p.reads.slice(1).map(r => r.label.replace(/ \(.*\)$/, '')).join(', ')}`,
  ]
  if (p.queued > 0) parts.push(`${p.queued} queued item${p.queued === 1 ? '' : 's'}`)
  if (p.decisions > 0) parts.push(`${p.decisions} open decision${p.decisions === 1 ? '' : 's'}`)
  if (p.stale.length > 0) parts.push(`${p.stale.length} milestone${p.stale.length === 1 ? "'s" : "s'"} verification stale (told to rerun ${p.stale.length === 1 ? 'its' : 'their'} checks)`)
  return parts.join(', ')
}
