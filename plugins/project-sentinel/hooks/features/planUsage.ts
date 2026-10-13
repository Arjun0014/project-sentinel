/**
 * The plan's five-hour usage window, as Claude Code reports it.
 *
 * On a claude.ai plan each API response carries the account's rate-limit windows, and Claude Code
 * hands them on: `$.session.usage().rateLimits`, and `session.measure`'s `rateLimits` (its `changed`
 * names 'rateLimits' when a window moves a whole point, appears or leaves). Each window has a
 * `kind` ('five_hour', 'seven_day', a Claude gateway's 'spend_limit'), `percentUsed` (0 to 100, at
 * most one decimal) and `resetsAt` (ISO 8601). Seen live on Claude Code 2.1.296: the list is empty
 * before the first response of a session, then reads five_hour 47% (resets 04:20Z) and seven_day
 * 17%; it carries across /clear; off a subscription (an API key) it stays empty.
 *
 * Nothing here estimates. The percentage is the engine's latest reading and the countdown is the
 * window's own reset time against the clock. Once that time has passed, the old reading says
 * nothing about the new window: it reads "reset" with no number until a response brings the new
 * window's figure (a window that drops out of the list at its reset reads the same). A request
 * Claude Code ended on the rate limit (StopFailure `rate_limit`), or a window read at 100%, reads
 * "limit reached" until a turn is answered again, a reading under 100% comes, or the window resets.
 *
 * Pure: the Runtime feeds it readings and draws its view.
 */

/** One window as Claude Code reads it (SessionRateLimit, Claude Code 2.1.289 and later). */
export type RateLimitReading = { kind: string; percentUsed: number; resetsAt?: string }

/** A window's latest reading: how much is used, when it resets (ms; null when the engine gave no time), when it was read. */
export type WindowReading = { percent: number; resetsAt: number | null; readAt: number }

export type LimitWindow = 'five_hour' | 'seven_day'

export type PlanUsage = {
  fiveHour: WindowReading | null
  sevenDay: WindowReading | null
  /**
   * A turn was answered and the list still held no five-hour window: an API key, or a plan
   * without one. False until then (the list is empty before the first response too).
   */
  isAbsent: boolean
  /** Claude Code ended a request on the rate limit: when, and the window read as full then (null: none was). */
  limited: { at: number; window: LimitWindow | null } | null
}

export const emptyPlanUsage = (): PlanUsage => ({ fiveHour: null, sevenDay: null, isAbsent: false, limited: null })

/** From this share of the window used, the reading asks for a look (amber); at 100% the limit is reached (red). */
export const WARN_PERCENT = 80

const percentOf = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.round(n * 10) / 10) : 0)

function timeOf(iso: string | undefined): number | null {
  if (iso === undefined) return null
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : null
}

const readingOf = (r: RateLimitReading | undefined, now: number): WindowReading | null =>
  r === undefined ? null : { percent: percentOf(r.percentUsed), resetsAt: timeOf(r.resetsAt), readAt: now }

/** Two readings that say the same (a refresh of an unchanged window): the state is kept as it is. */
const isSame = (a: WindowReading | null, b: WindowReading | null): boolean =>
  a === b || (a !== null && b !== null && a.percent === b.percent && a.resetsAt === b.resetsAt)

/**
 * The windows Claude Code reports now. A window missing from the list keeps its last reading (it
 * lapses at its own reset time, in the view). `isAfterAnswer`: read right after a turn was answered,
 * so an API response has come back and an empty list means no five-hour window on this account.
 */
export function readWindows(state: PlanUsage, rateLimits: readonly RateLimitReading[], now: number, isAfterAnswer = false): PlanUsage {
  const five = readingOf(rateLimits.find(r => r.kind === 'five_hour'), now)
  const seven = readingOf(rateLimits.find(r => r.kind === 'seven_day'), now)
  const fiveHour = five === null ? state.fiveHour : isSame(state.fiveHour, five) ? state.fiveHour : five
  const sevenDay = seven === null ? state.sevenDay : isSame(state.sevenDay, seven) ? state.sevenDay : seven
  const isAbsent = five !== null ? false : isAfterAnswer && state.fiveHour === null ? true : state.isAbsent
  // A fresh reading under 100% of the window that was full: the limit has lifted.
  let limited = state.limited
  if (limited !== null && limited.window !== null) {
    const fresh = limited.window === 'five_hour' ? five : seven
    if (fresh !== null && fresh.percent < 100 && now > limited.at) limited = null
  }
  if (fiveHour === state.fiveHour && sevenDay === state.sevenDay && isAbsent === state.isAbsent && limited === state.limited) return state
  return { fiveHour, sevenDay, isAbsent, limited }
}

/** Claude Code ended a request on the rate limit (StopFailure `rate_limit`). */
export function noteRateLimited(state: PlanUsage, now: number): PlanUsage {
  const window: LimitWindow | null = (state.fiveHour?.percent ?? 0) >= 100 ? 'five_hour' : (state.sevenDay?.percent ?? 0) >= 100 ? 'seven_day' : null
  return { ...state, limited: { at: now, window } }
}

/** A turn of the main conversation was answered: whatever limit stopped a request before has lifted. */
export function noteAnswered(state: PlanUsage): PlanUsage {
  return state.limited === null ? state : { ...state, limited: null }
}

export type PlanUsageView =
  /** No reading yet: before the session's first API response. */
  | { kind: 'pending' }
  /** Responses came back with no five-hour window: an API key, or a plan without one. */
  | { kind: 'absent' }
  | { kind: 'reading'; percent: number; resetsAt: number | null; leftMs: number | null; isHigh: boolean }
  /** The window's reset time has passed: a new window, with no reading of it until the next response. */
  | { kind: 'reset'; at: number }
  /** The limit is reached: a request was refused for it, or the window reads 100%. */
  | { kind: 'limited'; window: LimitWindow | null; percent: number | null; resetsAt: number | null; leftMs: number | null }

const isPast = (w: WindowReading | null, now: number): boolean => w !== null && w.resetsAt !== null && now >= w.resetsAt

const leftOf = (w: WindowReading | null, now: number): number | null => (w === null || w.resetsAt === null ? null : Math.max(0, w.resetsAt - now))

/** The five-hour window at `now` (system time: `resetsAt` is wall-clock). */
export function planUsageView(state: PlanUsage, now: number): PlanUsageView {
  const five = state.fiveHour
  const limited = state.limited
  if (limited !== null) {
    const full = limited.window === 'seven_day' ? state.sevenDay : limited.window === 'five_hour' ? five : null
    // A known full window that has since reset no longer holds the limit; an unknown one holds until a turn is answered.
    if (!isPast(full, now)) {
      const shown = limited.window === 'seven_day' ? state.sevenDay : isPast(five, now) ? null : five
      return { kind: 'limited', window: limited.window, percent: shown?.percent ?? null, resetsAt: full?.resetsAt ?? null, leftMs: leftOf(full, now) }
    }
  }
  if (five === null) return state.isAbsent ? { kind: 'absent' } : { kind: 'pending' }
  if (isPast(five, now)) return { kind: 'reset', at: five.resetsAt ?? now }
  if (five.percent >= 100) return { kind: 'limited', window: 'five_hour', percent: five.percent, resetsAt: five.resetsAt, leftMs: leftOf(five, now) }
  return { kind: 'reading', percent: five.percent, resetsAt: five.resetsAt, leftMs: leftOf(five, now), isHigh: five.percent >= WARN_PERCENT }
}

/** Whether a countdown or a reset is still ahead, so a minute tick has something to redraw. */
export const isTicking = (state: PlanUsage, now: number): boolean => {
  const v = planUsageView(state, now)
  return v.kind === 'reading' || (v.kind === 'limited' && v.leftMs !== null)
}

/** One window for the detail views (Context → Run): its name, its reading, its reset. */
export type WindowRow = { key: LimitWindow; name: string; percent: number | null; resetsAt: number | null; leftMs: number | null; isReset: boolean }

export function windowRows(state: PlanUsage, now: number): WindowRow[] {
  const rows: WindowRow[] = []
  const add = (key: LimitWindow, name: string, w: WindowReading | null) => {
    if (w === null) return
    const isReset = isPast(w, now)
    rows.push({ key, name, percent: isReset ? null : w.percent, resetsAt: w.resetsAt, leftMs: isReset ? null : leftOf(w, now), isReset })
  }
  add('five_hour', '5-hour', state.fiveHour)
  add('seven_day', '7-day', state.sevenDay)
  return rows
}
