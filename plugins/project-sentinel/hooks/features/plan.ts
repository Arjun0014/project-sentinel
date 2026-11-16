/**
 * The run plan: the milestones Claude tracks with its own task tools
 * (TodoWrite, or TaskCreate / TaskUpdate / TaskList), kept with the run so
 * work progress survives a handoff while the context starts over.
 *
 * Progress is finished ÷ total of those tasks, never a guess. Within one session (one context) a list
 * Claude rewrites is authoritative for the open work that session wrote; a finished task it drops stays
 * finished, because a fresh context's list rarely repeats what an earlier one completed.
 *
 * Open work an EARLIER session left (pending, in progress, waiting, blocked) is carried, never dropped
 * because a fresh context's first list happened to restate only part of the plan (seen in a real run: the
 * code work continued from the notes while the Work track looked like unrelated new work). It leaves the
 * plan when a later list names it (any status), when Claude marks it `dropped`, or when Claude starts new
 * work (another objective, none of the plan's milestones). A title reworded across the handoff ("Fix the
 * cache" → "Fix the cache scheduler") is matched to the carried milestone it names.
 */

import { clean } from '../core/text'

/**
 * TodoWrite and the Task tools know pending, in progress and completed.
 * Control Room's milestones tool adds three more a run needs to be honest:
 * verifying (done, being checked), waiting (for a result that will come by
 * itself: a job, a run, a review) and blocked (cannot go on without
 * something only the person can give).
 */
export type PlanStatus = 'pending' | 'in_progress' | 'verifying' | 'waiting' | 'blocked' | 'completed'

export type PlanTask = {
  /** Normalised subject: how a rewritten list is matched to what came before. */
  key: string
  /** The Task tools' id; null for TodoWrite items. */
  id: string | null
  subject: string
  /** Present-continuous form ("Running regression tests"), when Claude gave one. */
  activeForm: string | null
  status: PlanStatus
  /** The session (1-based, in the run) that last wrote the task. */
  session: number
  doneAt: number | null
  /** How it was (or is being) verified, or what blocks it, in Claude's words; null when not given. */
  detail: string | null
}

export type Plan = { tasks: PlanTask[]; session: number; updatedAt: number | null }

export const PLAN_MAX = 60

export const emptyPlan = (): Plan => ({ tasks: [], session: 0, updatedAt: null })

/** How a milestone is matched across rewritten lists (and the evidence kept for it): its subject, normalised. */
export const keyOf = (subject: string): string => subject.toLowerCase().replace(/\s+/g, ' ').trim()

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const statusOf = (v: unknown): PlanStatus | null =>
  v === 'pending' || v === 'in_progress' || v === 'verifying' || v === 'waiting' || v === 'blocked' || v === 'completed' ? v : null

/** Work under way: a milestone in progress, or one being verified. */
export const isActive = (status: PlanStatus): boolean => status === 'in_progress' || status === 'verifying'

/** Work that cannot go on by Claude's own hand for now: waiting for a result, or blocked on the person. */
export const isHeld = (status: PlanStatus): boolean => status === 'waiting' || status === 'blocked'

/** Every task stays: earlier sessions' open work is carried until a list names it, drops it, or starts new work. */
function forSession(plan: Plan, _session: number): PlanTask[] {
  return plan.tasks
}

/** Open work an earlier session left: carried until this session names it. */
export const isCarried = (t: PlanTask, session: number): boolean => t.status !== 'completed' && t.session < session

/** A status that takes a milestone out of the plan: Claude says it is no longer part of the work. */
const isDropped = (v: unknown): boolean => v === 'dropped' || v === 'cancelled' || v === 'canceled' || v === 'removed'

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'its', 'all', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'up'])

const wordsOf = (subject: string): Set<string> => new Set(keyOf(subject).replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length >= 3 && !STOP_WORDS.has(w)))

/**
 * Whether two milestone titles name the same outcome: most of their words in common, or one's words all in the
 * other's (at least two). Only used to match a fresh context's list to the work it carried over.
 */
export function isSameMilestone(a: string, b: string): boolean {
  const x = wordsOf(a)
  const y = wordsOf(b)
  if (x.size === 0 || y.size === 0) return false
  let common = 0
  for (const w of x) if (y.has(w)) common += 1
  const union = x.size + y.size - common
  if (common / union >= 0.6) return true
  const [small, large] = x.size <= y.size ? [x, y] : [y, x]
  return small.size >= 2 && common === small.size && large.size <= small.size * 2
}

/** At most PLAN_MAX tasks: the oldest finished ones go first, open work stays. */
function capped(tasks: PlanTask[]): PlanTask[] {
  let over = tasks.length - PLAN_MAX
  if (over <= 0) return tasks
  return tasks
    .filter(t => {
      if (over > 0 && t.status === 'completed') {
        over -= 1
        return false
      }
      return true
    })
    .slice(-PLAN_MAX)
}

/** TodoWrite: the whole list, rewritten. */
export function fromTodoWrite(plan: Plan, todos: unknown, session: number, now: number): Plan {
  if (!Array.isArray(todos)) return plan
  const before = forSession(plan, session)
  const previous = new Map(plan.tasks.map(t => [t.key, t]))
  const next: PlanTask[] = []
  const seen = new Set<string>()
  const dropped = new Set<string>()
  /** Carried milestones a reworded title named: the old key → the new one (the place in the plan is kept). */
  const renamed = new Map<string, string>()
  for (const item of todos) {
    if (!isRecord(item)) continue
    const subject = clean(str(item.content), 120)
    if (subject === '') continue
    // A carried milestone named in other words is that milestone: it takes the new title (and its key, so later
    // lists match it exactly), and keeps its place and its finished time.
    const key = keyOf(subject)
    const reworded = previous.has(key) ? undefined : before.find(t => isCarried(t, session) && !seen.has(t.key) && !renamed.has(t.key) && isSameMilestone(t.subject, subject))
    if (isDropped(item.status)) {
      dropped.add(reworded?.key ?? key)
      continue
    }
    const status = statusOf(item.status)
    if (status === null || seen.has(key)) continue
    seen.add(key)
    if (reworded !== undefined) renamed.set(reworded.key, key)
    const prev = previous.get(key) ?? reworded
    next.push({
      key,
      id: null,
      subject,
      activeForm: clean(str(item.activeForm), 80) || null,
      status,
      session,
      doneAt: status === 'completed' ? (prev?.doneAt ?? now) : null,
      detail: clean(str(item.detail), 160) || (status === 'completed' && prev?.status === 'completed' ? prev.detail : null),
    })
  }
  // Finished work stays; open work an earlier session left is carried until named or dropped (see the module).
  const kept = before.filter(t => !seen.has(t.key) && !dropped.has(t.key) && !renamed.has(t.key) && (t.status === 'completed' || isCarried(t, session)))
  return { tasks: capped(ordered(before, kept, next, renamed)), session: Math.max(plan.session, session), updatedAt: now }
}

/**
 * The plan in its order: the tasks of the list as written, each carried task kept where it stood before the
 * first of them (so a fresh context's partial list does not push the run's earlier milestones to the end); a
 * reworded milestone stands where the one it renames stood.
 */
function ordered(before: readonly PlanTask[], kept: readonly PlanTask[], next: readonly PlanTask[], renamed: ReadonlyMap<string, string>): PlanTask[] {
  const keptKeys = new Set(kept.map(t => t.key))
  const nextKeys = new Set(next.map(t => t.key))
  const out: PlanTask[] = []
  let i = 0
  for (const t of before) {
    const target = renamed.get(t.key) ?? t.key
    if (keptKeys.has(t.key)) out.push(t)
    else if (nextKeys.has(target)) {
      // A task of the new list that stood here before: the new list's run of tasks continues from here.
      while (i < next.length) {
        const n = next[i++]!
        out.push(n)
        if (n.key === target) break
      }
    }
  }
  while (i < next.length) out.push(next[i++]!)
  return out
}

/** TaskCreate: one new task, with the id the tool's result gave it. */
export function fromTaskCreate(plan: Plan, input: Record<string, unknown>, result: unknown, session: number, now: number): Plan {
  const task = isRecord(result) && isRecord(result.task) ? result.task : null
  const id = task === null ? '' : str(task.id)
  const subject = clean(str(task?.subject) || str(input.subject), 120)
  if (id === '' || subject === '') return plan
  // Claude Code's task ids start over in each session (a new context's task 1 is not the last one's): an id names a
  // task of this session only.
  const tasks = forSession(plan, session).filter(t => !(t.id === id && t.session === session))
  tasks.push({ key: keyOf(subject), id, subject, activeForm: clean(str(input.activeForm), 80) || null, status: 'pending', session, doneAt: null, detail: null })
  return { tasks: capped(tasks), session: Math.max(plan.session, session), updatedAt: now }
}

/** TaskUpdate: a status, subject or active form changed; `deleted` removes the task. */
export function fromTaskUpdate(plan: Plan, input: Record<string, unknown>, session: number, now: number): Plan {
  const id = str(input.taskId)
  const isIt = (t: PlanTask) => t.id === id && t.session === session
  if (id === '' || !plan.tasks.some(isIt)) return plan
  if (input.status === 'deleted') return { ...plan, tasks: plan.tasks.filter(t => !isIt(t)), updatedAt: now }
  const status = statusOf(input.status)
  const subject = clean(str(input.subject), 120)
  const activeForm = clean(str(input.activeForm), 80)
  const tasks = plan.tasks.map(t =>
    !isIt(t)
      ? t
      : {
          ...t,
          subject: subject || t.subject,
          key: subject === '' ? t.key : keyOf(subject),
          activeForm: activeForm || t.activeForm,
          status: status ?? t.status,
          session,
          doneAt: (status ?? t.status) === 'completed' ? (t.doneAt ?? now) : null,
        },
  )
  return { tasks, session: Math.max(plan.session, session), updatedAt: now }
}

/** TaskList: the tool's own list is the truth for the tasks it knows. */
export function fromTaskList(plan: Plan, result: unknown, session: number, now: number): Plan {
  if (!isRecord(result) || !Array.isArray(result.tasks)) return plan
  const listed = new Map<string, { subject: string; status: PlanStatus }>()
  for (const item of result.tasks) {
    if (!isRecord(item)) continue
    const id = str(item.id)
    const status = statusOf(item.status)
    if (id !== '' && status !== null) listed.set(id, { subject: clean(str(item.subject), 120), status })
  }
  const before = forSession(plan, session)
  const tasks: PlanTask[] = []
  for (const t of before) {
    // A task-list id is this session's: an earlier session's task (its id from another list) is carried as it was.
    if (t.id === null || t.session < session) {
      if (t.id === null || t.status === 'completed' || isCarried(t, session)) tasks.push(t)
      continue
    }
    const l = listed.get(t.id)
    if (l === undefined) {
      if (t.status === 'completed' || isCarried(t, session)) tasks.push(t)
      continue
    }
    listed.delete(t.id)
    tasks.push({ ...t, subject: l.subject || t.subject, status: l.status, doneAt: l.status === 'completed' ? (t.doneAt ?? now) : null })
  }
  for (const [id, l] of listed) {
    if (l.subject === '') continue
    tasks.push({ key: keyOf(l.subject), id, subject: l.subject, activeForm: null, status: l.status, session, doneAt: l.status === 'completed' ? now : null, detail: null })
  }
  return { tasks: capped(tasks), session: Math.max(plan.session, session), updatedAt: now }
}

/** Applies one finished task-tool call; any other tool leaves the plan as it is. */
export function applyTool(plan: Plan, input: { tool: string; input: Record<string, unknown>; result: unknown; session: number; now: number }): Plan {
  switch (input.tool) {
    case 'TodoWrite': {
      const result = isRecord(input.result) ? input.result : {}
      return fromTodoWrite(plan, Array.isArray(result.newTodos) ? result.newTodos : input.input.todos, input.session, input.now)
    }
    case 'TaskCreate':
      return fromTaskCreate(plan, input.input, input.result, input.session, input.now)
    case 'TaskUpdate':
      return fromTaskUpdate(plan, input.input, input.session, input.now)
    case 'TaskList':
      return fromTaskList(plan, input.result, input.session, input.now)
    default:
      return plan
  }
}

export const isPlanTool = (tool: string): boolean => tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate' || tool === 'TaskList'

/**
 * Control Room's own milestones tool, where Claude Code offers no task list:
 * the whole list each time, as TodoWrite sends it.
 */
/**
 * Whether a milestone list starts new work: Claude states another objective and names none of the
 * plan's milestones. Its plan then starts empty, so the finished milestones of the work before do
 * not count toward it ("10 of 17" for work just begun). A list rewritten for the same work, or one
 * that carries any of the old milestones, keeps them.
 */
export function isNewWork(plan: Plan, input: Record<string, unknown>, isOtherObjective: boolean): boolean {
  if (!isOtherObjective || plan.tasks.length === 0 || !Array.isArray(input.milestones)) return false
  const keys = new Set(plan.tasks.map(t => t.key))
  const titles = input.milestones
    .filter(isRecord)
    .map(m => clean(str(m.title), 120))
    .filter(t => t !== '')
  return titles.length > 0 && !titles.some(t => keys.has(keyOf(t)) || plan.tasks.some(p => isSameMilestone(p.subject, t)))
}

/** The carried milestones a list left out (open work from earlier contexts it did not name): the tool's reply says them. */
export function carriedLeftOut(plan: Plan, input: Record<string, unknown>, session: number): PlanTask[] {
  if (!Array.isArray(input.milestones)) return []
  const named = input.milestones.filter(isRecord).map(m => clean(str(m.title), 120))
  return plan.tasks.filter(t => isCarried(t, session) && !named.some(n => keyOf(n) === t.key || isSameMilestone(t.subject, n)))
}

export function fromMilestones(plan: Plan, input: Record<string, unknown>, session: number, now: number): Plan {
  if (!Array.isArray(input.milestones)) return plan
  const todos = input.milestones.filter(isRecord).map(m => ({
    content: str(m.title),
    status: m.status,
    activeForm: str(m.doing),
    // Evidence for a milestone verified or being verified; what a waiting or blocked one waits for.
    detail: m.status === 'blocked' || m.status === 'waiting' ? str(m.blocker) || str(m.waiting_for) : str(m.evidence),
  }))
  return fromTodoWrite(plan, todos, session, now)
}

export type Progress = {
  done: number
  total: number
  /** The task under way: the latest one marked in progress, else the latest being verified. */
  current: PlanTask | null
  /** The first open task after it. */
  next: PlanTask | null
  /** Milestones that cannot go on, with what blocks them. */
  blocked: PlanTask[]
  /** Milestones waiting for a result that will come by itself, with what they wait for. */
  waiting: PlanTask[]
}

export function progressOf(plan: Plan): Progress {
  const done = plan.tasks.filter(t => t.status === 'completed').length
  // Work in hand outranks work being checked: with one milestone in progress and others done but
  // still being verified, the one in progress is what Claude is doing.
  const latest = (status: PlanStatus) => [...plan.tasks].reverse().find(t => t.status === status) ?? null
  const current = latest('in_progress') ?? latest('verifying')
  const next = plan.tasks.find(t => t.status === 'pending') ?? null
  return { done, total: plan.tasks.length, current, next, blocked: plan.tasks.filter(t => t.status === 'blocked'), waiting: plan.tasks.filter(t => t.status === 'waiting') }
}

/** The tags Desktop wraps a pasted prompt in, `<pasted_content id="…">` and `</pasted_content id="…">`. */
const PASTE_WRAPPER = /<\/?pasted_content(?:\s[^<>]*)?>/gi
/** A line that is nothing but one markup tag. */
const TAG_LINE = /^<\/?[a-z][\w-]*(?:\s[^<>]*)?\/?>$/i

/**
 * The objective a request states: its first line that is not a command, a
 * paste's placeholder or a bare tag, cut to the first sentence when that says
 * enough. Null for a request too short to name one ("yes", "go on").
 */
export function objectiveOf(text: string): string | null {
  const first = text
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.replace(PASTE_WRAPPER, '').trim())
    .find(l => l !== '' && !l.startsWith('/') && !/^\[(image|pasted)[^\]]*\]$/i.test(l) && !TAG_LINE.test(l))
  if (first === undefined) return null
  const sentence = /^.+?[.!?](?=\s|$)/.exec(first)?.[0] ?? first
  const objective = clean(sentence.length >= 24 ? sentence : first, 140)
  return objective.length < 8 ? null : objective
}

/** A stored plan, validated: anything malformed reads as no plan. */
export function planOf(raw: unknown): Plan {
  if (!isRecord(raw) || !Array.isArray(raw.tasks)) return emptyPlan()
  const tasks: PlanTask[] = []
  for (const t of raw.tasks) {
    if (!isRecord(t)) continue
    const status = statusOf(t.status)
    const subject = str(t.subject)
    if (status === null || subject === '') continue
    tasks.push({
      key: str(t.key) || keyOf(subject),
      id: typeof t.id === 'string' ? t.id : null,
      subject,
      activeForm: typeof t.activeForm === 'string' ? t.activeForm : null,
      status,
      session: typeof t.session === 'number' ? t.session : 1,
      doneAt: typeof t.doneAt === 'number' ? t.doneAt : null,
      detail: typeof t.detail === 'string' ? t.detail : null,
    })
  }
  return { tasks: tasks.slice(-PLAN_MAX), session: typeof raw.session === 'number' ? raw.session : 0, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null }
}
