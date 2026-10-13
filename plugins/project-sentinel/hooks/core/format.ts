/**
 * Formatting for compact, consistent display across terminal and desktop.
 * Pure functions; no locale APIs are assumed to exist in the mod sandbox.
 */

/** 684123 → "684k", 1000000 → "1M", 1500000 → "1.5M", 950 → "950". */
export function tokens(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  const v = Math.max(0, n)
  if (v >= 1_000_000) {
    const m = v / 1_000_000
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : trimZero(m.toFixed(1))}M`
  }
  if (v >= 1000) {
    const k = v / 1000
    return `${k >= 100 ? Math.round(k) : trimZero(k.toFixed(k >= 10 ? 0 : 1))}k`
  }
  return String(Math.round(v))
}

const trimZero = (s: string): string => (s.endsWith('.0') ? s.slice(0, -2) : s)

/** US dollars as Claude Code reports them; "—" when not exposed. */
export function cost(usd: number | undefined | null): string {
  if (usd === undefined || usd === null || !Number.isFinite(usd)) return '—'
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  if (usd >= 1000) return `$${groupThousands(Math.round(usd))}`
  return `$${usd.toFixed(2)}`
}

function groupThousands(n: number): string {
  const s = String(n)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const fromEnd = s.length - i
    out += s[i]
    if (fromEnd > 1 && fromEnd % 3 === 1) out += ','
  }
  return out
}

export const percent = (n: number | undefined | null): string =>
  n === undefined || n === null || !Number.isFinite(n) ? '—' : `${Math.round(n)}%`

/** 8_040_000 → "2h 14m", 303_000 → "5m 3s", 42_000 → "42s". */
export function duration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/**
 * Time left, to the minute and never less than it is: 14 min → "14m", 2 h 14 min → "2h 14m", under a
 * minute → "<1m". `isTight` drops the space ("2h14m") for a status bar's narrow cell.
 */
export function countdown(ms: number | undefined | null, isTight = false): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 60_000) return '<1m'
  const m = Math.ceil(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h >= 48) return `${Math.floor(h / 24)}d${isTight ? '' : ' '}${h % 24}h`
  return m % 60 === 0 ? `${h}h` : `${h}h${isTight ? '' : ' '}${m % 60}m`
}

/** A setting in minutes, as a person says it: 45 → "45 min", 120 → "2 h", 90 → "1 h 30 min". */
export function minutes(n: number): string {
  const m = Math.max(0, Math.round(n))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/** Local wall-clock time, "09:12". */
export function clock(ts: number | undefined | null): string {
  if (ts === undefined || ts === null || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Local wall-clock time to the second, "09:12:05": for diagnostics, where minutes are too coarse. */
export function clockSeconds(ts: number | undefined | null): string {
  if (ts === undefined || ts === null || !Number.isFinite(ts)) return '—'
  return `${clock(ts)}:${pad2(new Date(ts).getSeconds())}`
}

/** "Oct 7 09:12" for older timestamps, the clock alone for today. */
export function when(ts: number | undefined | null, now: number): string {
  if (ts === undefined || ts === null || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  const n = new Date(now)
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  if (sameDay) return clock(ts)
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  return `${month} ${d.getDate()} ${clock(ts)}`
}

/** A bar of `width` cells, `fraction` filled: "▰▰▰▰▱▱▱▱". */
export function bar(fraction: number, width: number, full = '▰', empty = '▱'): string {
  const w = Math.max(1, Math.floor(width))
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const filled = Math.round(f * w)
  return full.repeat(filled) + empty.repeat(w - filled)
}

/** Singular or plural: plural(1, 'file') → "1 file", plural(3, 'file') → "3 files". */
export const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`
