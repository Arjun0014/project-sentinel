/**
 * Persistence in the plugin's `$.store` (one JSON file shared by every
 * session on the machine). Settings are one key, written whole and
 * debounced; each run is its own key so two sessions never overwrite each
 * other's chains; a small index lists recent runs. Reads are validated —
 * a corrupt or foreign value falls back to defaults, never throws.
 */

import { LIMITS, STORE_ENTRIES } from '../constants'
import { type Run, isRun, updateIndex } from '../features/chain'
import { PERMISSION_CATEGORIES, PERMISSION_LABEL, type Settings, normalizeSettings } from '../core/settings'
import type { Host } from '../host'

export async function loadSettings(
  host: Host,
): Promise<{ settings: Settings; isFresh: boolean; wasRepaired: boolean; allowRemoved: string[] }> {
  const raw = await host.storeGet(STORE_ENTRIES.settings).catch(() => undefined)
  if (raw === undefined || raw === null) return { settings: normalizeSettings(undefined), isFresh: true, wasRepaired: false, allowRemoved: [] }
  const settings = normalizeSettings(raw)
  const { value, allowRemoved } = withAllowRemoved(raw)
  return { settings, isFresh: false, wasRepaired: hasChangedValues(value, settings), allowRemoved }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Whether this install was used before, though it never saved a setting (settings are saved only when one
 * changes): a run, its counter, the cache's memory or the Quest log in the store. Such an install keeps the
 * defaults it had (Classic); only a store with none of them is a fresh install.
 */
export async function hasPriorUse(host: Host): Promise<boolean> {
  for (const key of [STORE_ENTRIES.runCounter, STORE_ENTRIES.runsIndex, STORE_ENTRIES.cache, STORE_ENTRIES.quest]) {
    const value = await host.storeGet(key).catch(() => undefined)
    if (value !== undefined && value !== null) return true
  }
  return false
}

/** The first-run card's record: shown at, dismissed at (null while it shows). */
export type Onboarding = { at: number; dismissedAt: number | null }

export function onboardingOf(raw: unknown): Onboarding | null {
  if (!isRecord(raw) || typeof raw.at !== 'number') return null
  return { at: raw.at, dismissedAt: typeof raw.dismissedAt === 'number' ? raw.dismissedAt : null }
}

/**
 * Allow ("answers prompts for you") was removed in 1.4.0. A saved Allow reads as Default, so Claude
 * Code's own rules decide again: that is a deliberate change, not a repair, and it is reported by
 * name, in the settings and in custom profiles alike.
 */
export function withAllowRemoved(raw: unknown): { value: unknown; allowRemoved: string[] } {
  if (!isRecord(raw)) return { value: raw, allowRemoved: [] }
  const removed = new Set<string>()
  const fix = (permissions: unknown): unknown => {
    if (!isRecord(permissions)) return permissions
    const out: Record<string, unknown> = { ...permissions }
    for (const category of PERMISSION_CATEGORIES) {
      if (out[category] === 'allow') {
        out[category] = 'default'
        removed.add(PERMISSION_LABEL[category])
      }
    }
    return out
  }
  // Only a stored group is fixed: adding one that was missing would read as a repair.
  const value: Record<string, unknown> = { ...raw }
  if ('permissions' in raw) value.permissions = fix(raw.permissions)
  if (Array.isArray(raw.customProfiles)) {
    value.customProfiles = raw.customProfiles.map(p =>
      isRecord(p) && isRecord(p.systems) ? { ...p, systems: { ...p.systems, permissions: fix(p.systems.permissions) } } : p,
    )
  }
  return { value, allowRemoved: [...removed] }
}

/** Whether normalising changed a value that was present (missing fields are not repairs). */
export function hasChangedValues(raw: unknown, normalized: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return raw !== normalized
  if (Array.isArray(raw)) return JSON.stringify(raw) !== JSON.stringify(normalized)
  if (typeof normalized !== 'object' || normalized === null) return true
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in normalized)) continue
    if (hasChangedValues(value, (normalized as Record<string, unknown>)[key])) return true
  }
  return false
}

export async function loadRun(host: Host, id: string): Promise<Run | null> {
  const raw = await host.storeGet(`${STORE_ENTRIES.runPrefix}${id}`).catch(() => undefined)
  return isRun(raw) ? raw : null
}

export async function loadIndex(host: Host): Promise<string[]> {
  const raw = await host.storeGet(STORE_ENTRIES.runsIndex).catch(() => undefined)
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, LIMITS.runsKept) : []
}

/** The run whose sessions include `sessionId`, newest first. */
export async function findRunBySession(host: Host, sessionId: string): Promise<Run | null> {
  for (const id of await loadIndex(host)) {
    const run = await loadRun(host, id)
    if (run?.sessions.some(s => s.id === sessionId)) return run
  }
  return null
}

export async function nextRunNumber(host: Host): Promise<number> {
  const raw = await host.storeGet(STORE_ENTRIES.runCounter).catch(() => undefined)
  const n = (typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0) + 1
  await host.storeSet(STORE_ENTRIES.runCounter, n).catch(() => undefined)
  return n
}

export async function saveRun(host: Host, run: Run): Promise<void> {
  await host.storeSet(`${STORE_ENTRIES.runPrefix}${run.id}`, run)
  const { index, dropped } = updateIndex(await loadIndex(host), run.id)
  await host.storeSet(STORE_ENTRIES.runsIndex, index)
  for (const old of dropped) await host.storeDelete(`${STORE_ENTRIES.runPrefix}${old}`).catch(() => undefined)
}

export async function loadHistory(host: Host, exceptId: string | null): Promise<Run[]> {
  const out: Run[] = []
  for (const id of (await loadIndex(host)).slice(0, 10)) {
    if (id === exceptId) continue
    const run = await loadRun(host, id)
    if (run) out.push(run)
  }
  return out
}

/** Coalesces writes: the last value wins, written at most once per `delayMs`. */
export class Debounced<T> {
  private pending: T | undefined
  private timer: { cancel: () => void } | null = null

  constructor(
    private readonly host: () => Host | null,
    private readonly write: (host: Host, value: T) => Promise<void>,
    private readonly delayMs: number,
  ) {}

  schedule(value: T): void {
    this.pending = value
    const host = this.host()
    if (host === null || this.timer !== null) return
    this.timer = host.after(this.delayMs, () => {
      this.timer = null
      void this.flush()
    })
  }

  async flush(): Promise<void> {
    const host = this.host()
    const value = this.pending
    if (host === null || value === undefined) return
    this.pending = undefined
    this.timer?.cancel()
    this.timer = null
    await this.write(host, value).catch(() => undefined)
  }

  /**
   * Forgets the waiting value when `isSuperseded` says a newer one is being written now: the pending
   * value is a copy taken when it was scheduled, and writing it later would put the older copy back.
   */
  drop(isSuperseded: (pending: T) => boolean): void {
    if (this.pending === undefined || !isSuperseded(this.pending)) return
    this.pending = undefined
    this.timer?.cancel()
    this.timer = null
  }
}
