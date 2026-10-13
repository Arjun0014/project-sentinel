/**
 * Handoff Health and Continuity: whether a handoff left what a fresh context
 * needs, and whether the fresh context picked it up.
 *
 * A handoff leaves the work in four places, each for what it is for: the
 * run's milestones (Control Room's run state, the canonical record of
 * progress), the project's own documentation, CLAUDE.md (only for durable
 * instructions), and the handoff notes (the prompt Claude would want to
 * receive). Health is read when the notes are verified, from what Control
 * Room counted in the handoff turn. Continuity is read when the first turn of
 * the fresh context ends: the notes read, the run state restored, the
 * milestone under way picked up again, the project's docs read, the work
 * resumed.
 *
 * Every item is counted from tool calls Control Room saw, never from what
 * Claude says. Pure: the Runtime gathers the facts.
 */

export type CheckState = 'ok' | 'missing' | 'none'

export type Check = { id: string; label: string; state: CheckState; detail: string }

export type HandoffRecord = {
  at: number
  fromSession: number
  /** The session that picks the work up after the clear; null while none has started, or when the handoff compacted instead. */
  toSession: number | null
  via: 'clear' | 'compact' | 'manual'
  health: Check[]
  /** The milestone under way when the notes were written (its key and words), and the plan's count then. */
  currentKey: string | null
  currentSubject: string | null
  done: number
  total: number
  /** Null until the fresh context's first turn ends. */
  continuity: Check[] | null
  /**
   * Background work still running as the context was cleared (1.7.0): a server or watcher (never waited
   * for), or work the handoff stopped waiting for. Claude Code keeps it running across the clear and
   * reports its end to the fresh context, which was told; its end is filled in when it is reported.
   */
  leftRunning?: LeftTask[]
}

/** One task a handoff left running, and its end once Claude Code reported it (its notification, a stop). */
export type LeftTask = { id: string; description: string; class: 'persistent' | 'finite' | 'agent' | 'unknown'; endedAt: number | null; status: string | null }

/** A short subject for a line's right-hand note. */
const short = (text: string, max = 32): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const fileName = (path: string): string => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path

const names = (paths: readonly string[]): string => {
  const unique = [...new Set(paths.map(fileName))]
  return unique.length <= 2 ? unique.join(', ') : `${unique.slice(0, 2).join(', ')} +${unique.length - 2}`
}

export type HealthFacts = {
  /** The run keeps milestones at all (a task list or Control Room's milestones tool). */
  hasPlan: boolean
  /** The milestones were sent again during the handoff turn. */
  isPlanUpdated: boolean
  /** The milestone under way when the notes were checked, else null; and whether every milestone is done or blocked. */
  current: { key: string; subject: string } | null
  isPlanSettled: boolean
  /** The first milestone still to come: a handoff between milestones, with the list just sent again, stopped cleanly. */
  next?: { subject: string } | null
  isNotesWritten: boolean
  handoffFile: string
  /** Documentation files changed in the handoff turn (README, docs, changelog). */
  docsEdited: readonly string[]
  /** Checks run in this context, the latest first (label and outcome). */
  checks: readonly { label: string; status: string }[]
  isClaudeMdEdited: boolean
  /** A handoff that waited for background work: how many tasks, and whether the notes were written again after the last ended. */
  background?: { tasks: number; isNotesAfter: boolean } | null
  /** Work still running as the handoff went on: services (never waited for) and work it stopped waiting for. */
  left?: { services: number; work: number; names: string } | null
  /**
   * Milestone evidence (features/evidence.ts) as the handoff leaves it: how many verified milestones keep
   * a snapshot of their files, which of them are stale now, and the checks to run again. Null with none.
   */
  evidence?: { verified: number; stale: readonly string[]; rerun: readonly string[] } | null
}

/** A handoff at a clean boundary: the last milestone finished, the next not begun, and the list sent again to say so. */
const isBetween = (f: HealthFacts): boolean => f.isPlanUpdated && f.current === null && f.next !== undefined && f.next !== null

export function healthOf(f: HealthFacts): Check[] {
  const latest = f.checks[0]
  return [
    {
      id: 'runState',
      label: 'Run state saved',
      state: !f.hasPlan ? 'none' : f.isPlanUpdated ? 'ok' : 'missing',
      detail: !f.hasPlan ? 'No milestones in this run' : f.isPlanUpdated ? 'Milestones sent again' : 'Milestones not updated',
    },
    {
      id: 'milestone',
      label: 'Milestone under way captured',
      state: !f.hasPlan ? 'none' : f.current !== null || f.isPlanSettled || isBetween(f) ? 'ok' : 'missing',
      detail:
        f.current !== null
          ? short(f.current.subject)
          : f.isPlanSettled
            ? 'Every milestone settled'
            : isBetween(f)
              ? `Next: ${short(f.next?.subject ?? '')}`
              : f.hasPlan
                ? 'None marked in progress'
                : '—',
    },
    {
      id: 'notes',
      label: 'Handoff notes written',
      state: f.isNotesWritten ? 'ok' : 'missing',
      detail: f.isNotesWritten ? fileName(f.handoffFile) : `${fileName(f.handoffFile)} not updated`,
    },
    {
      id: 'docs',
      label: 'Project docs updated',
      state: f.docsEdited.length > 0 ? 'ok' : 'none',
      detail: f.docsEdited.length > 0 ? names(f.docsEdited) : 'None changed in the handoff',
    },
    {
      id: 'validation',
      label: 'Validation recorded',
      state: latest === undefined ? 'missing' : 'ok',
      detail: latest === undefined ? 'No check ran in this context' : `${latest.label} ${latest.status}`,
    },
    {
      id: 'claudeMd',
      label: 'CLAUDE.md',
      state: f.isClaudeMdEdited ? 'ok' : 'none',
      detail: f.isClaudeMdEdited ? 'Updated' : 'No update needed',
    },
    ...(f.background === undefined || f.background === null
      ? []
      : [
          {
            id: 'background',
            label: 'Background work recorded',
            state: f.background.isNotesAfter ? ('ok' as const) : ('missing' as const),
            detail: `${f.background.tasks === 1 ? '1 task' : `${f.background.tasks} tasks`} finished · ${f.background.isNotesAfter ? 'notes updated after' : 'notes not updated after'}`,
          },
        ]),
    // Verified milestones whose files changed since: their verification is stale (never "wrong"); the fresh context is told what to rerun.
    ...(f.evidence === undefined || f.evidence === null
      ? []
      : [
          {
            id: 'evidence',
            label: 'Verification current',
            state: f.evidence.stale.length === 0 ? ('ok' as const) : ('missing' as const),
            detail:
              f.evidence.stale.length === 0
                ? `${f.evidence.verified === 1 ? '1 verified milestone' : `${f.evidence.verified} verified milestones`} unchanged`
                : `${f.evidence.stale.length === 1 ? short(f.evidence.stale[0] ?? '', 24) : `${f.evidence.stale.length} milestones`} stale · ${f.evidence.rerun.length === 0 ? 'review' : `rerun ${f.evidence.rerun.join(', ')}`}`,
          },
        ]),
    // Neither good nor missing: a fact the fresh context was told (servers to reuse, results that arrive there).
    ...(f.left === undefined || f.left === null || f.left.services + f.left.work === 0
      ? []
      : [
          {
            id: 'leftRunning',
            label: 'Left running',
            state: 'none' as const,
            detail: [f.left.services > 0 ? `${f.left.services === 1 ? '1 service' : `${f.left.services} services`}` : '', f.left.work > 0 ? `${f.left.work === 1 ? '1 task' : `${f.left.work} tasks`} not waited for` : ''].filter(Boolean).join(' · ') + ' · fresh context told',
          },
        ]),
  ]
}

export type ContinuityFacts = {
  handoffFile: string
  /** Files the fresh context read (Read calls of the main conversation). */
  reads: readonly string[]
  /** Which of those are project documentation. */
  isDoc: (path: string) => boolean
  /** The plan as the fresh context left it, and whether it sent its milestones yet. */
  isPlanUpdated: boolean
  tasks: readonly { key: string; subject: string; status: string }[]
  done: number
  current: { key: string; subject: string } | null
  /** Edits made or checks run in the fresh context. */
  edits: number
  checks: number
}

export function continuityOf(f: ContinuityFacts, handoff: HandoffRecord): Check[] {
  const handoffName = fileName(f.handoffFile).toLowerCase()
  const isNotes = (p: string) => fileName(p).toLowerCase() === handoffName
  const docs = f.reads.filter(p => !isNotes(p) && f.isDoc(p))
  const kept = handoff.currentKey === null ? undefined : f.tasks.find(t => t.key === handoff.currentKey)
  let milestone: Check
  if (handoff.currentKey === null) {
    milestone = { id: 'milestone', label: 'Milestone picked up', state: 'none', detail: 'None was under way' }
  } else if (!f.isPlanUpdated) {
    milestone = { id: 'milestone', label: 'Milestone picked up', state: 'missing', detail: 'Milestones not recorded yet' }
  } else if (kept !== undefined && kept.status !== 'pending') {
    milestone = { id: 'milestone', label: 'Milestone picked up', state: 'ok', detail: short(kept.status === 'completed' ? `Finished: ${kept.subject}` : kept.subject) }
  } else if (f.current !== null && f.done >= handoff.done) {
    milestone = { id: 'milestone', label: 'Milestone picked up', state: 'ok', detail: short(`Moved on: ${f.current.subject}`) }
  } else {
    milestone = { id: 'milestone', label: 'Milestone picked up', state: 'missing', detail: short(`Not resumed: ${handoff.currentSubject ?? 'the milestone'}`) }
  }
  return [
    {
      id: 'notesRead',
      label: 'Handoff notes read',
      state: f.reads.some(isNotes) ? 'ok' : 'missing',
      detail: f.reads.some(isNotes) ? fileName(f.handoffFile) : 'Not opened',
    },
    {
      id: 'runState',
      label: 'Run state restored',
      state: handoff.total === 0 ? 'none' : f.isPlanUpdated ? 'ok' : 'missing',
      detail: handoff.total === 0 ? 'No milestones to restore' : f.isPlanUpdated ? `${f.done} of ${f.tasks.length} milestones` : 'Milestones not recorded yet',
    },
    milestone,
    {
      id: 'docsRead',
      label: 'Project docs read',
      state: docs.length > 0 ? 'ok' : 'missing',
      detail: docs.length > 0 ? names(docs) : 'None opened',
    },
    {
      id: 'resumed',
      label: 'Work resumed',
      state: f.edits + f.checks > 0 ? 'ok' : 'missing',
      detail: f.edits + f.checks === 0 ? 'No edits or checks yet' : [f.edits > 0 ? `${f.edits} edit${f.edits === 1 ? '' : 's'}` : '', f.checks > 0 ? `${f.checks} check${f.checks === 1 ? '' : 's'}` : ''].filter(Boolean).join(', '),
    },
  ]
}

/** "4 of 5", counting only what could be done (`none` items are neither). */
export function scoreOf(checks: readonly Check[]): { ok: number; of: number; missing: Check[] } {
  const counted = checks.filter(c => c.state !== 'none')
  return { ok: counted.filter(c => c.state === 'ok').length, of: counted.length, missing: counted.filter(c => c.state === 'missing') }
}

/** The toast after the fresh context's first turn: all picked up, or what was not. */
export function continuityToast(checks: readonly Check[]): string {
  const s = scoreOf(checks)
  if (s.missing.length === 0) return `Fresh context picked up the work: ${s.ok} of ${s.of} checks`
  return `Fresh context, ${s.ok} of ${s.of}: ${s.missing.map(c => c.label.toLowerCase()).join(', ')} missing`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function checksOf(raw: unknown): Check[] | null {
  if (!Array.isArray(raw)) return null
  return raw
    .filter(isRecord)
    .map(c => ({
      id: typeof c.id === 'string' ? c.id : '',
      label: typeof c.label === 'string' ? c.label.slice(0, 60) : '',
      state: c.state === 'ok' || c.state === 'missing' ? c.state : ('none' as CheckState),
      detail: typeof c.detail === 'string' ? c.detail.slice(0, 80) : '',
    }))
    .filter(c => c.id !== '' && c.label !== '')
    .slice(0, 12)
}

const CLASSES = ['persistent', 'finite', 'agent', 'unknown'] as const

function leftOf(raw: unknown): LeftTask[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter(isRecord)
    .filter(t => typeof t.id === 'string' && typeof t.description === 'string')
    .map(t => ({
      id: String(t.id).slice(0, 80),
      description: String(t.description).slice(0, 120),
      class: CLASSES.find(c => c === t.class) ?? 'unknown',
      endedAt: typeof t.endedAt === 'number' && Number.isFinite(t.endedAt) ? t.endedAt : null,
      status: typeof t.status === 'string' ? t.status.slice(0, 40) : null,
    }))
    .slice(0, 8)
}

/** A task the handoff left running ended (its notification reached the fresh context, or it was stopped): the record says so. */
export function noteLeftEnded(record: HandoffRecord, id: string, status: string | null, at: number): HandoffRecord {
  const left = record.leftRunning
  if (left === undefined || !left.some(t => t.id === id && t.endedAt === null)) return record
  return { ...record, leftRunning: left.map(t => (t.id === id && t.endedAt === null ? { ...t, endedAt: at, status } : t)) }
}

/** A stored handoff record, validated: anything malformed reads as none. */
export function handoffRecordOf(raw: unknown): HandoffRecord | null {
  if (!isRecord(raw)) return null
  const health = checksOf(raw.health)
  if (health === null || typeof raw.at !== 'number' || typeof raw.fromSession !== 'number') return null
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const left = leftOf(raw.leftRunning)
  return {
    at: raw.at,
    fromSession: raw.fromSession,
    toSession: typeof raw.toSession === 'number' ? raw.toSession : null,
    via: raw.via === 'compact' || raw.via === 'manual' ? raw.via : 'clear',
    health,
    currentKey: typeof raw.currentKey === 'string' ? raw.currentKey : null,
    currentSubject: typeof raw.currentSubject === 'string' ? raw.currentSubject : null,
    done: num(raw.done),
    total: num(raw.total),
    continuity: checksOf(raw.continuity),
    ...(left === undefined ? {} : { leftRunning: left }),
  }
}
