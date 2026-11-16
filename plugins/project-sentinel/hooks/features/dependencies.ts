/**
 * Background work that outlives a context: a dependency of the run, kept in its record across handoffs.
 *
 * A handoff never waits for hours: finite work still running when its wait runs out (a multi-hour render, a long
 * benchmark), and every server or watcher, is left running for the fresh context. Claude Code keeps that work
 * across `/clear` and delivers its end to whichever context is current then (seen live on 2.1.296; its changelog
 * for 2.1.319 fixed `/clear` killing background agents' commands). The last handoff's record says what IT left
 * running; this list keeps every such task until its end is reported, however many handoffs come between, so a
 * render left running in session 2 and ending in session 5 is still known for what it is, and when.
 *
 * Nothing here waits, polls or wakes anything: Claude Code's own notification is the only word on a task's end.
 * Pure: the Runtime records what was left running and what ended.
 */

export type DependencyClass = 'persistent' | 'finite' | 'agent' | 'unknown'

export type Dependency = {
  /** Claude Code's background task id. */
  id: string
  description: string
  /** A server or watcher to reuse (persistent), or work whose result arrives in a later context. */
  class: DependencyClass
  /** The session that left it running, and when. */
  fromSession: number
  leftAt: number
  /** Its end as Claude Code reported it, in whichever context it arrived; null while it runs. */
  endedAt: number | null
  status: string | null
  /** The session its end arrived in. */
  endedIn: number | null
}

/** How many dependencies a run keeps; how long an ended one stays listed. */
export const DEPENDENCIES_KEPT = 20
export const ENDED_KEPT_MS = 24 * 3_600_000

const CLASSES: readonly DependencyClass[] = ['persistent', 'finite', 'agent', 'unknown']

/** The tasks a handoff left running, joined to the list (a task already listed keeps when it was first left). */
export function noteLeft(deps: readonly Dependency[], tasks: readonly { id: string; description: string; class?: string }[], session: number, now: number): Dependency[] {
  const out = [...deps]
  for (const t of tasks) {
    const i = out.findIndex(d => d.id === t.id)
    if (i >= 0) {
      const d = out[i]!
      // Listed again while still running: the same task. One that ended and is listed again is a new run of that id.
      if (d.endedAt === null) continue
      out.splice(i, 1)
    }
    const cls = CLASSES.find(c => c === t.class) ?? 'unknown'
    out.push({ id: t.id, description: t.description.slice(0, 120), class: cls, fromSession: session, leftAt: now, endedAt: null, status: null, endedIn: null })
  }
  return prune(out, now)
}

/** Claude Code reported a task's end (its notification, a TaskStop): the dependency is over, in this session. */
export function noteEnded(deps: readonly Dependency[], id: string, status: string | null, session: number, now: number): Dependency[] {
  if (!deps.some(d => d.id === id && d.endedAt === null)) return [...deps]
  return deps.map(d => (d.id === id && d.endedAt === null ? { ...d, endedAt: now, status: status ?? 'ended', endedIn: session } : d))
}

/** Still running, oldest first. */
export const runningOf = (deps: readonly Dependency[]): Dependency[] => deps.filter(d => d.endedAt === null)

/** Ended ones go after a day; past the cap, the oldest ended first, then the oldest running. */
export function prune(deps: readonly Dependency[], now: number): Dependency[] {
  const kept = deps.filter(d => d.endedAt === null || now - d.endedAt < ENDED_KEPT_MS)
  while (kept.length > DEPENDENCIES_KEPT) {
    const i = kept.findIndex(d => d.endedAt !== null)
    kept.splice(i >= 0 ? i : 0, 1)
  }
  return kept
}

/** The list as the run record keeps it, validated (never trusted): an entry that does not read is dropped. */
export function dependenciesOf(raw: unknown): Dependency[] {
  if (!Array.isArray(raw)) return []
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const out: Dependency[] = []
  for (const r of raw.slice(-DEPENDENCIES_KEPT)) {
    if (typeof r !== 'object' || r === null) continue
    const x = r as Record<string, unknown>
    const fromSession = num(x.fromSession)
    const leftAt = num(x.leftAt)
    if (typeof x.id !== 'string' || typeof x.description !== 'string' || fromSession === null || leftAt === null) continue
    out.push({
      id: x.id,
      description: x.description.slice(0, 120),
      class: CLASSES.find(c => c === x.class) ?? 'unknown',
      fromSession,
      leftAt,
      endedAt: num(x.endedAt),
      status: typeof x.status === 'string' ? x.status.slice(0, 40) : null,
      endedIn: num(x.endedIn),
    })
  }
  return out
}
