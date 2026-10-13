/**
 * The session's agents as Project Sentinel can observe them, and nothing it cannot.
 *
 *   `agent.spawn`      the agent exists from here: its type, description, model, background, fork,
 *                      parent, a workflow run's id and place (seen live on 2.1.296: a background agent
 *                      is listed right after its spawn resolves; a workflow's agents never are)
 *   `$.agent.list()`   reconciles: status, parent, name, teammate address; an agent it stops listing
 *                      keeps its last status for a few polls before it reads as no longer listed
 *   its loop's events  `tool.call` and `turn.step` carrying its `agentId`: what it is doing (its latest
 *                      call), how many calls, when it last did anything, its model; a task list or
 *                      milestones it keeps in its own loop, as its plan
 *   `turn.complete`    its end: the first line of its answer, or why it stopped
 *
 * A workflow's agents are tracked from their spawn and their own loop's events, grouped by the run's id;
 * the list never names them. No percent complete is ever made up from time or calls: an agent's own plan
 * is its progress, else its latest activity. No cost per agent: Claude Code reports none. Ended agents
 * stay a few minutes, then go. Pure: the ledger is plain data the Runtime feeds.
 */

import type { AgentRowView, TrackStop } from '../../types'
import { clean } from '../core/text'
import { type Plan, type PlanStatus, applyTool, emptyPlan, fromMilestones, planOf, progressOf } from './plan'

/** What Claude Code's agent list says of one agent (AgentInfo). */
export type ListedAgent = {
  id: string
  type: string
  description: string
  status: string
  parentId?: string
  name?: string
  teammateId?: string
}

export type AgentDetail = {
  id: string
  /** When its spawn was seen; null for one first seen in Claude Code's list (it began before a reload). */
  spawnedAt: number | null
  model: string | null
  isBackground: boolean | null
  isFork: boolean
  description: string
  type: string
  name: string | null
  parentId: string | null
  endedAt: number | null
  result: string | null
  isFailed: boolean
  /**
   * Its status as last observed: `starting` from its spawn until Claude Code lists it, then the listed
   * status; a workflow agent's from its own events; `gone` once the list dropped it alive, with no end seen.
   */
  status: string
  /** A workflow run's agent (never listed): the run's id and its place among the run's agents. */
  workflow: { runId: string; index: number } | null
  /** The Agent (or Workflow) tool call that started it; a workflow run's agents share one. */
  toolUseId: string | null
  /** When Claude Code last listed it, and since when and for how many looks it has not (a list may omit it for a moment). */
  listedAt: number | null
  missed: number
  missingSince: number | null
  /** Its loop: calls made, the latest call in words, when it last made a call or a request. */
  calls: number
  doing: string | null
  activeAt: number | null
  /** The plan it keeps in its own loop (a task list, milestones); null while it keeps none. */
  plan: Plan | null
  /** A teammate: each of its turns ends (its turn.complete) and it goes idle, never ended by that. */
  isTeammate: boolean
}

export type AgentLedger = Map<string, AgentDetail>

/** How long an agent that ended stays shown, as ended. */
export const ENDED_SHOWN_MS = 10 * 60_000
/**
 * An alive agent missing from Claude Code's list reads as no longer listed only after this many looks
 * (one every couple of seconds while agents run) over at least OMIT_MS: a list may leave it out a moment.
 */
export const OMIT_LOOKS = 3
export const OMIT_MS = 6_000
/** How many agents the ledger keeps; ended ones give way first. */
const KEPT = 40

const ALIVE = new Set(['starting', 'pending', 'running', 'waiting', 'idle'])
const ENDED = new Set(['completed', 'failed', 'killed', 'gone'])

export const isAlive = (status: string): boolean => ALIVE.has(status)

const blank = (id: string, at: number | null): AgentDetail => ({
  id,
  spawnedAt: at,
  model: null,
  isBackground: null,
  isFork: false,
  description: '',
  type: '',
  name: null,
  parentId: null,
  endedAt: null,
  result: null,
  isFailed: false,
  status: 'starting',
  workflow: null,
  toolUseId: null,
  listedAt: null,
  missed: 0,
  missingSince: null,
  calls: 0,
  doing: null,
  activeAt: null,
  plan: null,
  isTeammate: false,
})

function trim(ledger: AgentLedger): void {
  while (ledger.size > KEPT) {
    const oldest = [...ledger.values()].filter(a => a.endedAt !== null).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))[0]
    if (oldest === undefined) return
    ledger.delete(oldest.id)
  }
}

/** An agent started (its `agent.spawn` resolved with its id): it shows from now, as starting until Claude Code lists it. */
export function noteSpawn(
  ledger: AgentLedger,
  input: {
    agentId: string
    at: number
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
  },
): void {
  const before = ledger.get(input.agentId)
  ledger.set(input.agentId, {
    ...(before ?? blank(input.agentId, input.at)),
    spawnedAt: before?.spawnedAt ?? input.at,
    model: input.model,
    isBackground: input.isBackground,
    isFork: input.isFork,
    description: clean(input.description, 80),
    type: clean(input.type, 40),
    name: input.name === null ? null : clean(input.name, 40),
    parentId: input.parentId,
    endedAt: null,
    result: null,
    isFailed: false,
    // A workflow's agent is never listed: running from its spawn, as its own loop shows.
    status: input.workflow != null ? 'running' : 'starting',
    workflow: input.workflow ?? null,
    toolUseId: input.toolUseId ?? null,
    missed: 0,
    missingSince: null,
    isTeammate: input.isTeammate === true || before?.isTeammate === true,
  })
  trim(ledger)
}

/**
 * Claude Code's list, looked at: every agent it lists takes its status (a resumed one comes back alive);
 * one it stops listing keeps its last status for OMIT_LOOKS looks, then reads as no longer listed (ended,
 * with no end seen). An ended status it last listed stands. A workflow's agents are never in it. True when
 * anything changed.
 */
export function reconcile(ledger: AgentLedger, listed: readonly ListedAgent[], now: number): boolean {
  let changed = false
  const seen = new Set<string>()
  for (const l of listed) {
    seen.add(l.id)
    const isNew = !ledger.has(l.id)
    // A row first seen in the list (spawned before a reload): when it began is not known.
    const a = ledger.get(l.id) ?? blank(l.id, null)
    // Listed alive after an end this runtime saw: a list a moment behind (the end stands), unless the
    // agent's loop has acted since (a message resumed it under the same id).
    const isStale = isAlive(l.status) && a.endedAt !== null && a.status !== 'gone' && !a.isTeammate && (a.activeAt === null || a.activeAt <= a.endedAt)
    const status = isStale ? a.status : l.status
    const next: AgentDetail = {
      ...a,
      type: a.type || clean(l.type, 40),
      description: a.description || clean(l.description, 80),
      name: a.name ?? (l.name === undefined ? null : clean(l.name, 40)),
      parentId: a.parentId ?? l.parentId ?? null,
      isTeammate: a.isTeammate || l.teammateId !== undefined,
      status,
      listedAt: now,
      missed: 0,
      missingSince: null,
      ...(isAlive(status) ? { endedAt: null, result: a.isTeammate ? a.result : null, isFailed: false } : {}),
      ...(!isAlive(status) && a.endedAt === null ? { endedAt: now, isFailed: status !== 'completed', result: a.result ?? (status === 'killed' ? 'Stopped' : status === 'failed' ? 'Failed' : null) } : {}),
    }
    if (isNew || a.status !== next.status || a.missed !== 0 || a.endedAt !== next.endedAt) changed = true
    ledger.set(l.id, next)
  }
  for (const a of ledger.values()) {
    if (seen.has(a.id) || a.workflow !== null || !isAlive(a.status)) continue
    const missed = a.missed + 1
    const missingSince = a.missingSince ?? now
    changed = true
    // Starting: not listed yet. Alive and dropped: kept a few looks over a few seconds, then no longer listed.
    if (missed < OMIT_LOOKS || now - missingSince < OMIT_MS) ledger.set(a.id, { ...a, missed, missingSince })
    else ledger.set(a.id, { ...a, missed, missingSince, status: 'gone', endedAt: now, isFailed: false, result: a.result ?? (a.status === 'starting' ? 'Never listed by Claude Code' : 'No longer listed by Claude Code (its end was not seen)') })
  }
  trim(ledger)
  return changed
}

/** A call in the agent's loop began: what it is doing now, and one more call. False for an agent the ledger does not know (an engine fork). */
export function noteCall(ledger: AgentLedger, agentId: string, doing: string, at: number): boolean {
  const a = ledger.get(agentId)
  if (a === undefined) return false
  ledger.set(agentId, { ...a, ...revived(a, at), calls: a.calls + 1, doing: clean(doing, 80), activeAt: at })
  return true
}

/** An agent that ended and acts again (a message resumed it under its id): alive from now, its old end gone. */
const revived = (a: AgentDetail, at: number): Partial<AgentDetail> =>
  !isAlive(a.status) && a.status !== 'gone' && a.endedAt !== null && at > a.endedAt ? { status: 'running', endedAt: null, result: null, isFailed: false } : {}

/** A request in the agent's loop (its `turn.step`): it is active, on this model. */
export function noteStep(ledger: AgentLedger, agentId: string, at: number, model?: string): boolean {
  const a = ledger.get(agentId)
  if (a === undefined) return false
  ledger.set(agentId, { ...a, ...revived(a, at), activeAt: at, ...(model === undefined ? {} : { model }) })
  return true
}

/** The model an agent's own requests report (its loop's turn.step). */
export function noteModel(ledger: AgentLedger, agentId: string, model: string): boolean {
  const a = ledger.get(agentId)
  if (a === undefined || a.model === model) return false
  ledger.set(agentId, { ...a, model })
  return true
}

/** The plan the agent keeps in its own loop: a task list call (TodoWrite, the Task tools), or the milestones tool. */
export function notePlan(ledger: AgentLedger, agentId: string, change: { tool: string; input: Record<string, unknown>; result: unknown; now: number } | { milestones: Record<string, unknown>; now: number }): boolean {
  const a = ledger.get(agentId)
  if (a === undefined) return false
  const base = a.plan ?? emptyPlan()
  const plan = 'milestones' in change ? fromMilestones(base, change.milestones, 1, change.now) : applyTool(base, { tool: change.tool, input: change.input, result: change.result, session: 1, now: change.now })
  if (plan === base) return false
  ledger.set(agentId, { ...a, plan })
  return true
}

/** An agent's loop ended (its turn.complete): the first line of its answer, or why it stopped. */
export function noteEnd(ledger: AgentLedger, agentId: string, input: { at: number; reason: 'answer' | 'aborted' | 'refusal' | 'error'; answer: string }): void {
  const a = ledger.get(agentId)
  const firstLine = input.answer
    .split('\n')
    .map(l => l.trim())
    .find(l => l !== '' && !l.startsWith('```'))
  const result = input.reason === 'answer' ? (firstLine === undefined ? 'Finished' : clean(firstLine.replace(/^#+\s*/, ''), 140)) : input.reason === 'aborted' ? 'Stopped before it finished' : input.reason === 'refusal' ? 'Refused the task' : 'Ended with an error'
  const base: AgentDetail = a ?? blank(agentId, input.at)
  // A teammate's turn ended: it goes idle, waiting for a message, and keeps its last answer.
  if (base.isTeammate) {
    ledger.set(agentId, { ...base, status: 'idle', result, isFailed: input.reason !== 'answer' && input.reason !== 'aborted', doing: null })
    return
  }
  const status = input.reason === 'answer' ? 'completed' : input.reason === 'aborted' ? 'killed' : 'failed'
  ledger.set(agentId, { ...base, endedAt: input.at, result, isFailed: input.reason !== 'answer', status, doing: null })
  trim(ledger)
}

/**
 * A workflow run's tool call ended (its task's notification): its agents with no end seen ended with it
 * (an agent in a cloud session never reports one). Returns how many it ended.
 */
export function noteWorkflowEnd(ledger: AgentLedger, toolUseId: string, status: string | null, at: number): number {
  let n = 0
  for (const a of ledger.values()) {
    if (a.workflow === null || a.toolUseId !== toolUseId || !isAlive(a.status)) continue
    ledger.set(a.id, { ...a, status: 'gone', endedAt: at, isFailed: status === 'failed', result: a.result ?? `The workflow ended${status === null ? '' : ` (${status})`} with no end of its own seen` })
    n += 1
  }
  return n
}

/**
 * The ledger as `$.state` kept it across a reload (never trusted: each entry is checked). Entries the
 * ledger already holds stay as they are.
 */
export function restoreLedger(ledger: AgentLedger, raw: unknown): number {
  if (!Array.isArray(raw)) return 0
  const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? clean(v, max) : null)
  const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  let n = 0
  for (const r of raw.slice(-KEPT)) {
    if (typeof r !== 'object' || r === null) continue
    const x = r as Record<string, unknown>
    const id = str(x.id, 80)
    const spawnedAt = time(x.spawnedAt)
    if (id === null || id === '' || spawnedAt === null || ledger.has(id)) continue
    const wf = typeof x.workflow === 'object' && x.workflow !== null ? (x.workflow as Record<string, unknown>) : null
    const endedAt = time(x.endedAt)
    const status = str(x.status, 20)
    ledger.set(id, {
      ...blank(id, spawnedAt),
      model: str(x.model, 80),
      isBackground: typeof x.isBackground === 'boolean' ? x.isBackground : null,
      isFork: x.isFork === true,
      description: str(x.description, 80) ?? '',
      type: str(x.type, 40) ?? '',
      name: str(x.name, 40),
      parentId: str(x.parentId, 80),
      endedAt,
      result: str(x.result, 140),
      isFailed: x.isFailed === true,
      // A status from before 1.7.0 is not kept: ended when it ended, else as it last was (the list reconciles it).
      status: status !== null && (ALIVE.has(status) || ENDED.has(status)) ? status : endedAt === null ? 'starting' : x.isFailed === true ? 'failed' : 'completed',
      workflow: wf !== null && typeof wf.runId === 'string' && typeof wf.index === 'number' ? { runId: clean(wf.runId, 60), index: wf.index } : null,
      toolUseId: str(x.toolUseId, 80),
      listedAt: time(x.listedAt),
      calls: typeof x.calls === 'number' && Number.isFinite(x.calls) ? Math.max(0, Math.round(x.calls)) : 0,
      doing: str(x.doing, 80),
      activeAt: time(x.activeAt),
      plan: x.plan === undefined || x.plan === null ? null : planOf(x.plan),
      isTeammate: x.isTeammate === true,
    })
    n += 1
  }
  return n
}

const TRACK: Record<PlanStatus, TrackStop> = { completed: 'done', in_progress: 'now', verifying: 'verify', waiting: 'held', blocked: 'held', pending: 'open' }

/** An agent's own plan as a Work-style track: its milestones' states and counts, never a made-up percent. */
function planView(plan: Plan | null): AgentRowView['plan'] {
  if (plan === null || plan.tasks.length === 0) return null
  const p = progressOf(plan)
  return { done: p.done, total: p.total, current: p.current === null ? null : (p.current.activeForm ?? p.current.subject), track: plan.tasks.map(t => TRACK[t.status]) }
}

/** The row of one agent, from the ledger and, when Claude Code lists it, its list entry. */
function rowOf(d: AgentDetail, l: ListedAgent | undefined, activity: { label: string | null; calls: number }): AgentRowView {
  // Once reconciled with the list, the ledger's status is the one to show (an end it saw outranks a list a moment behind).
  const status = l === undefined || d.listedAt === null ? (l?.status ?? d.status) : d.status
  const alive = isAlive(status)
  const isTeammate = l?.teammateId !== undefined || d.isTeammate
  const name = l?.name ?? d.name
  // Claude Code's TaskStop takes background agents and teammates by id; SendMessage reaches them too. A workflow's agents are the workflow's.
  const isAddressable = d.workflow === null && (isTeammate || name !== null || d.isBackground === true)
  const calls = Math.max(d.calls, activity.calls)
  return {
    id: d.id,
    name,
    type: l?.type ?? (d.type || (d.workflow !== null ? 'workflow agent' : 'agent')),
    description: clean(l?.description || d.description || '', 80),
    status,
    model: d.model,
    isBackground: d.isBackground ?? (isTeammate ? true : null),
    isFork: d.isFork,
    parentId: l?.parentId ?? d.parentId,
    startedAt: d.spawnedAt,
    endedAt: alive ? null : d.endedAt,
    activity: alive ? (d.doing ?? activity.label) : null,
    calls,
    // An idle teammate keeps its last answer; any other agent's shows once it ended.
    result: alive ? (isTeammate && status === 'idle' ? d.result : null) : (d.result ?? (status === 'killed' ? 'Stopped' : status === 'failed' ? 'Failed' : null)),
    isFailed: status === 'failed' || status === 'killed' || (!alive && d.isFailed),
    canStop: alive && isAddressable,
    canMessage: alive && isAddressable,
    isTeammate,
    workflow: d.workflow,
    activeAt: d.activeAt,
    plan: planView(d.plan),
    isListed: l !== undefined,
    note: alive && l === undefined && d.workflow === null ? (d.status === 'starting' ? 'Starting: not listed by Claude Code yet' : `Not in Claude Code's list for ${d.missed} look${d.missed === 1 ? '' : 's'}`) : null,
  }
}

/**
 * The rows: every agent the ledger knows or Claude Code lists (alive ones whatever the list says this
 * moment, within its omission allowance), then the ones that ended in the last few minutes. Running first,
 * then starting, waiting and idle, then the ended ones newest first. `activityOf` is a fallback for an
 * agent the ledger has no calls for.
 */
export function agentRows(ledger: AgentLedger, listed: readonly ListedAgent[], now: number, activityOf: (agentId: string) => { label: string | null; calls: number } = () => ({ label: null, calls: 0 })): AgentRowView[] {
  const rows: AgentRowView[] = []
  const seen = new Set<string>()
  for (const l of listed) {
    seen.add(l.id)
    const d = ledger.get(l.id) ?? { ...blank(l.id, null), status: l.status, type: l.type, description: l.description }
    const row = rowOf(d, l, activityOf(l.id))
    if (!isAlive(row.status) && row.endedAt !== null && now - row.endedAt > ENDED_SHOWN_MS) continue
    rows.push(row)
  }
  for (const d of ledger.values()) {
    if (seen.has(d.id)) continue
    if (!isAlive(d.status) && (d.endedAt === null || now - d.endedAt > ENDED_SHOWN_MS)) continue
    rows.push(rowOf(d, undefined, activityOf(d.id)))
  }
  const rank = (r: AgentRowView) => (r.status === 'running' ? 0 : r.status === 'starting' || r.status === 'pending' ? 1 : r.status === 'waiting' ? 2 : r.status === 'idle' ? 3 : 4)
  return rows.sort((a, b) => rank(a) - rank(b) || (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))
}

/** The agents alive now, as the rows reconcile them (the status bar's count, the band). */
export const aliveRows = (rows: readonly AgentRowView[]): AgentRowView[] => rows.filter(r => isAlive(r.status))

/** At most this many agents get a line of their own in the band; more are counted by what they are doing. */
export const BAND_LINES = 3

/** What an agent is doing, as one word for a count ("2 reading · 1 testing"), from its latest call's words. */
export function doingWord(r: Pick<AgentRowView, 'status' | 'activity'>): string {
  if (r.status === 'starting' || r.status === 'pending') return 'starting'
  if (r.status === 'waiting') return 'waiting'
  if (r.status === 'idle') return 'idle'
  const a = (r.activity ?? '').toLowerCase()
  if (a === '') return 'thinking'
  if (/^(running (the )?tests|testing|type-checking|linting|building|running a (check|build)|running the build)/.test(a)) return 'checking'
  if (a.startsWith('reading')) return 'reading'
  if (a.startsWith('editing')) return 'editing'
  if (a.startsWith('searching')) return 'searching'
  if (a.startsWith('looking things up')) return 'researching'
  if (a.startsWith('subagent')) return 'delegating'
  if (a.startsWith('running') || a.startsWith('installing')) return 'running commands'
  return 'working'
}

/**
 * The agent band: while agents run, one line per agent (up to BAND_LINES), or, past that, one line counting
 * them by what they are doing ("5 agents · 2 reading · 2 editing · 1 checking"). Null when none runs.
 */
export function bandOf(rows: readonly AgentRowView[], now: number): { lines: { id: string; name: string; status: string; doing: string; elapsedMs: number | null; plan: string | null }[]; summary: string | null } | null {
  const alive = aliveRows(rows)
  if (alive.length === 0) return null
  if (alive.length > BAND_LINES) {
    const counts = new Map<string, number>()
    for (const r of alive) counts.set(doingWord(r), (counts.get(doingWord(r)) ?? 0) + 1)
    const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`)
    return { lines: [], summary: `${alive.length} agents · ${parts.join(' · ')}` }
  }
  return {
    lines: alive.map(r => ({
      id: r.id,
      name: clean(r.name ?? (r.description || r.type), 40),
      status: r.status,
      doing: r.activity ?? (r.status === 'starting' || r.status === 'pending' ? 'Starting' : r.status === 'waiting' ? 'Waiting' : r.status === 'idle' ? 'Idle' : 'Thinking'),
      elapsedMs: r.startedAt === null ? null : Math.max(0, now - r.startedAt),
      plan: r.plan === null ? null : `${r.plan.done}/${r.plan.total}`,
    })),
    summary: null,
  }
}

/** What counts against a subagent limit: alive agents a model's Agent call started (a workflow's do not), teammates when asked. */
export function limitCount(rows: readonly AgentRowView[], countTeammates: boolean): number {
  return rows.filter(r => isAlive(r.status) && r.workflow === null && (countTeammates || !r.isTeammate)).length
}
