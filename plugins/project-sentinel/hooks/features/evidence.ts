/**
 * Milestone evidence: what a verified milestone stood on, and whether it still does.
 *
 * When a milestone is completed, Sentinel keeps a small snapshot of it: which milestone, when it was
 * verified and in which session, the checks that were green during its work (their kind and command),
 * the files its work changed (the edits Sentinel saw while it was under way, and the outputs Claude
 * named), each with Git's blob id of its content (`git hash-object --no-filters`: only the id is kept,
 * never the content), its size and modification time, and the commit HEAD pointed at. Nothing else is
 * hashed, never the repository.
 *
 * At a handoff, at a fresh context's start and (at most once a minute, only while snapshots exist) at
 * a turn's end, each snapshot is compared with the workspace. A file whose size and modification time
 * are unchanged is current without hashing; one that moved is hashed again, so a file only touched (or
 * changed and changed back) stays current. A change is never called wrong: the milestone's earlier
 * verification is *stale*, with which files changed, since when, and which checks to run again.
 *
 * Later milestones legitimately change the same files, so a change is weighed by who made it and
 * what verified it since:
 * - a change Sentinel saw (through Claude's tools) after which the latest run of every kind of check
 *   the milestone had passed: those checks cover the new content, so the snapshot takes it as its own
 *   (re-baselined, said quietly: "re-verified by Tests at 14:05", or by the later milestone); a change
 *   Sentinel did not see counts from when a comparison found it, as long as the file is still as found;
 * - a documentation file, or any file of a milestone verified with no check, changed by a later
 *   milestone that has since been completed: that milestone's verification owns it now (re-baselined);
 * - a change made while a later milestone is still under way, not yet covered: quiet ("being changed
 *   by M3"), not stale;
 * - anything else (a later milestone whose checks do not cover it, an edit with no milestone under way
 *   and no check after it, or a change outside Sentinel's view: the person, a checkout, a command whose
 *   changes Claude Code does not report) makes the evidence stale, until checks cover it as above or
 *   the person accepts the files as they are (`acceptChanges`: /cr evidence accept, or Accept in
 *   Activity), which re-baselines them as theirs.
 *
 * Only the milestone's own files are compared: a file its checks depend on but its work never changed
 * is not watched (that would mean hashing the repository).
 *
 * Pure: the Runtime gathers the stats and blob ids and keeps the store in the run record.
 */

import { clock } from '../core/format'

/** A file as found: whether it exists, its size and time (`stat`), its blob id (null: not hashed). */
export type Fingerprint = { exists: boolean; isDir?: boolean; size: number | null; mtimeMs: number | null; blob: string | null }

/** `isDoc`: documentation (README, docs, a changelog): verified by review, not by a check. */
export type EvidenceFile = Fingerprint & { path: string; isDoc?: boolean }

/** A check that was green during the milestone's work: its kind ("test"), name ("Tests"), command, when it ended. */
export type EvidenceCheck = { kind: string; label: string; command: string; at: number }

/** An edit Sentinel saw to a snapshot's file after it was verified: the milestone under way then (null: none), and when. */
export type Touch = { path: string; key: string | null; subject: string | null; at: number }

export type EvidenceStatus = 'current' | 'changing' | 'stale'

/** A file found changed since the snapshot (or since its re-baseline), and who changed it when Sentinel saw it. */
export type EvidenceChange = {
  path: string
  kind: 'changed' | 'deleted' | 'created'
  /** The later milestone whose work changed it; null: no milestone was under way, or the change was not seen. */
  by: string | null
  byKey: string | null
  /** That milestone is still under way. */
  isByActive: boolean
  /** Sentinel saw the edit (it came through Claude's tools); false: changed outside its view. */
  isSeen: boolean
  /** When Sentinel saw the edit; null for a change it did not see. */
  at: number | null
  /** When a comparison first found the file this way, and how it was then (a later change starts the clock again). */
  foundAt: number
  found: { size: number | null; mtimeMs: number | null; blob: string | null }
}

export type Snapshot = {
  key: string
  subject: string
  verifiedAt: number
  session: number
  checks: EvidenceCheck[]
  files: EvidenceFile[]
  /** The commit HEAD pointed at when verified; null outside a Git repository. */
  head: string | null
  touches: Touch[]
  /** Files whose evidence a later verified milestone took over, and which. */
  rebaselined: { path: string; by: string; at: number }[]
  status: EvidenceStatus
  changes: EvidenceChange[]
  /** When it was last compared with the workspace; null before the first comparison. */
  checkedAt: number | null
}

/** A milestone under way: when it was first seen under way, the files its work changed, the outputs Claude named. */
export type MilestoneWork = { since: number; files: { path: string; at: number }[]; outputs: string[] }

export type EvidenceStore = { work: Record<string, MilestoneWork>; snapshots: Snapshot[] }

export const emptyEvidence = (): EvidenceStore => ({ work: {}, snapshots: [] })

/** At most this many files per milestone (the latest edited), outputs Claude names, snapshots, and checks. */
export const EVIDENCE_LIMITS = { files: 12, outputs: 10, snapshots: 30, checks: 6, touches: 24, observed: 200 } as const

/** Larger files are not hashed: their size and time stand in for their content. */
export const HASH_MAX_BYTES = 8 * 1024 * 1024

/** Turn ends compare the workspace at most this often. */
export const EVIDENCE_CHECK_EVERY_MS = 60_000

const samePath = (a: string, b: string): boolean => a === b || a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

function workOf(store: EvidenceStore, key: string, now: number): MilestoneWork {
  return store.work[key] ?? { since: now, files: [], outputs: [] }
}

/** At most as many milestones' work as snapshots: the ones begun longest ago go first (a plan rewritten without them). */
function trimmed(work: Record<string, MilestoneWork>): Record<string, MilestoneWork> {
  const keys = Object.keys(work)
  if (keys.length <= EVIDENCE_LIMITS.snapshots) return work
  const kept = keys.sort((a, b) => (work[b]?.since ?? 0) - (work[a]?.since ?? 0)).slice(0, EVIDENCE_LIMITS.snapshots)
  return Object.fromEntries(kept.map(k => [k, work[k]!]))
}

/** A milestone is under way (in progress or verifying): its work counts from the first time it is seen so. */
export function noteActive(store: EvidenceStore, key: string, now: number): EvidenceStore {
  if (store.work[key] !== undefined) return store
  return { ...store, work: trimmed({ ...store.work, [key]: workOf(store, key, now) }) }
}

/**
 * Files Claude's tools changed (edits, writes, a command's reported changes), with the milestone under
 * way: they become that milestone's files, and an edit to a verified milestone's file is noted on its
 * snapshot as a touch (who changed it, when).
 */
export function noteEdits(store: EvidenceStore, current: { key: string; subject: string } | null, paths: readonly string[], now: number): EvidenceStore {
  if (paths.length === 0) return store
  let work = store.work
  if (current !== null) {
    const w = workOf(store, current.key, now)
    const kept = w.files.filter(f => !paths.some(p => samePath(p, f.path)))
    const files = [...kept, ...paths.map(path => ({ path, at: now }))].slice(-EVIDENCE_LIMITS.files)
    work = trimmed({ ...work, [current.key]: { ...w, files } })
  }
  const snapshots = store.snapshots.map(s => {
    if (now < s.verifiedAt) return s
    const hit = paths.filter(p => s.files.some(f => samePath(f.path, p)))
    if (hit.length === 0) return s
    const touches = [...s.touches.filter(t => !hit.some(p => samePath(p, t.path))), ...hit.map(path => ({ path, key: current?.key ?? null, subject: current?.subject ?? null, at: now }))].slice(-EVIDENCE_LIMITS.touches)
    return { ...s, touches }
  })
  return { work, snapshots }
}

/** Outputs Claude named for a milestone (files its verification covers that no editing tool reported: generated, rendered). */
export function noteOutputs(store: EvidenceStore, key: string, outputs: readonly string[], now: number): EvidenceStore {
  const clean = outputs.map(o => o.trim()).filter(o => o !== '' && o.length <= 400)
  if (clean.length === 0) return store
  const w = workOf(store, key, now)
  const merged = [...w.outputs.filter(o => !clean.some(c => samePath(c, o))), ...clean].slice(-EVIDENCE_LIMITS.outputs)
  if (merged.length === w.outputs.length && merged.every((o, i) => o === w.outputs[i]) && store.work[key] !== undefined) return store
  return { ...store, work: { ...store.work, [key]: { ...w, outputs: merged } } }
}

/** The files a milestone's snapshot covers: the outputs Claude named, then the latest edited files. */
export function filesFor(store: EvidenceStore, key: string): string[] {
  const w = store.work[key]
  if (w === undefined) return []
  const out: string[] = []
  for (const p of [...w.outputs, ...[...w.files].reverse().map(f => f.path)]) {
    if (!out.some(o => samePath(o, p))) out.push(p)
    if (out.length >= EVIDENCE_LIMITS.files) break
  }
  return out
}

/** Where a milestone's work began: first seen under way, else the latest earlier verification, else `fallback`. */
export function windowStart(store: EvidenceStore, key: string, fallback: number): number {
  const w = store.work[key]
  if (w !== undefined) return w.since
  const earlier = store.snapshots.filter(s => s.key !== key).map(s => s.verifiedAt)
  return earlier.length === 0 ? fallback : Math.max(...earlier)
}

/** A check run as Activity's Validation records it. */
export type CheckRun = { kind: string; label: string; command: string; status: string; endedAt: number | null }

/** The checks green in a window: for each kind, its latest run that ended in the window, when that run passed. */
export function greenChecks(runs: readonly CheckRun[], from: number, to: number): EvidenceCheck[] {
  const latest = new Map<string, CheckRun>()
  for (const r of runs) {
    if (r.endedAt === null || r.endedAt < from || r.endedAt > to) continue
    const prev = latest.get(r.kind)
    if (prev === undefined || (prev.endedAt ?? 0) <= r.endedAt) latest.set(r.kind, r)
  }
  return [...latest.values()]
    .filter(r => r.status === 'passed')
    .map(r => ({ kind: r.kind, label: r.label, command: r.command.slice(0, 160), at: r.endedAt ?? to }))
    .slice(0, EVIDENCE_LIMITS.checks)
}

/**
 * Whether green checks cover every kind the earlier milestone had, each ending after the change (a check
 * that ended in the very millisecond of an edit cannot have run on it).
 */
export function covers(later: readonly EvidenceCheck[], earlier: readonly EvidenceCheck[], after: number): boolean {
  return earlier.every(e => later.some(l => l.kind === e.kind && l.at > after))
}

const statusOf = (changes: readonly EvidenceChange[]): EvidenceStatus => (changes.length === 0 ? 'current' : changes.every(c => c.isByActive) ? 'changing' : 'stale')

/**
 * A milestone verified: its snapshot, replacing one it had before (a milestone reopened and completed
 * again). Earlier snapshots it changed are re-baselined at the next comparison (`compare`).
 */
export function addSnapshot(store: EvidenceStore, snap: Omit<Snapshot, 'touches' | 'rebaselined' | 'status' | 'changes' | 'checkedAt'>): EvidenceStore {
  const { [snap.key]: _done, ...work } = store.work
  void _done
  const fresh: Snapshot = { ...snap, touches: [], rebaselined: [], status: 'current', changes: [], checkedAt: snap.verifiedAt }
  return { work, snapshots: [...store.snapshots.filter(s => s.key !== snap.key), fresh].slice(-EVIDENCE_LIMITS.snapshots) }
}

/**
 * A milestone no longer completed (reopened): its snapshot goes, and its files go back to its work, so
 * the snapshot taken when it is completed again still covers them.
 */
export function dropSnapshots(store: EvidenceStore, keys: readonly string[], now: number): EvidenceStore {
  const dropped = store.snapshots.filter(s => keys.includes(s.key))
  if (dropped.length === 0) return store
  const work = { ...store.work }
  for (const s of dropped) {
    const w = work[s.key] ?? { since: now, files: [], outputs: [] }
    const earlier = s.files.filter(f => !w.files.some(x => samePath(x.path, f.path))).map(f => ({ path: f.path, at: s.verifiedAt }))
    work[s.key] = { ...w, files: [...earlier, ...w.files].slice(-EVIDENCE_LIMITS.files) }
  }
  return { work, snapshots: store.snapshots.filter(s => !keys.includes(s.key)) }
}

/** Every file the snapshots cover, to look at (at most EVIDENCE_LIMITS.observed). */
export function pathsToObserve(store: EvidenceStore): string[] {
  const out: string[] = []
  for (const s of [...store.snapshots].reverse()) {
    for (const f of s.files) if (!out.some(o => samePath(o, f.path))) out.push(f.path)
  }
  return out.slice(0, EVIDENCE_LIMITS.observed)
}

/** The files whose size or time moved since a snapshot that holds their blob: those, and only those, are hashed again. */
export function pathsToHash(store: EvidenceStore, found: ReadonlyMap<string, Fingerprint>): string[] {
  const out: string[] = []
  for (const s of store.snapshots) {
    for (const f of s.files) {
      const o = found.get(f.path)
      if (o === undefined || !o.exists || o.isDir === true || f.blob === null) continue
      if (o.size !== null && o.size > HASH_MAX_BYTES) continue
      if (o.size === f.size && o.mtimeMs === f.mtimeMs) continue
      if (!out.some(p => samePath(p, f.path))) out.push(f.path)
    }
  }
  return out
}

/** How one file compares with its record: the same, changed in some way, or not decidable now (a hash that failed). */
function compareFile(f: EvidenceFile, o: Fingerprint): 'same' | 'changed' | 'deleted' | 'created' | 'unknown' {
  if (!f.exists && !o.exists) return 'same'
  if (f.exists && !o.exists) return 'deleted'
  if (!f.exists && o.exists) return 'created'
  if (f.isDir === true || o.isDir === true) return 'same'
  if (o.size === f.size && o.mtimeMs === f.mtimeMs) return 'same'
  if (f.blob !== null && o.blob !== null) return f.blob === o.blob ? 'same' : 'changed'
  if (f.blob !== null && o.blob === null) return o.size !== f.size ? 'changed' : 'unknown'
  return 'changed'
}

export type CompareContext = {
  /** Milestones under way now (in progress, verifying). */
  active: ReadonlySet<string>
  /** Milestones completed now. */
  completed: ReadonlySet<string>
  /** The latest run of each kind of check, when it passed (`greenChecks` over this context's runs). */
  green: readonly EvidenceCheck[]
  now: number
}

/** Who took a re-baselined file over, in words: the checks that passed after the change, or the later milestone. */
const checkWords = (checks: readonly EvidenceCheck[], kinds: readonly string[], now: number): string => {
  const used = checks.filter(c => kinds.includes(c.kind))
  const at = used.length === 0 ? now : Math.max(...used.map(c => c.at))
  return `${[...new Set(used.map(c => c.label))].join(', ')} at ${clock(at)}`
}

/** The file is still as a comparison found it before (same size and time, or the same content). */
const isStill = (was: EvidenceChange['found'], o: Fingerprint): boolean =>
  (was.size === o.size && was.mtimeMs === o.mtimeMs) || (was.blob !== null && was.blob === o.blob)

/**
 * The snapshots compared with the workspace as found (`found`, by path; blob ids for the files that
 * moved). A change covered since (see the module's comment) re-baselines the file on what was found.
 * The same store when nothing changed.
 */
export function compare(store: EvidenceStore, found: ReadonlyMap<string, Fingerprint>, ctx: CompareContext): EvidenceStore {
  let isChanged = false
  const snapshots = store.snapshots.map(s => {
    const changes: EvidenceChange[] = []
    let files = s.files
    let touches = s.touches
    let rebaselined = s.rebaselined
    const kinds = [...new Set(s.checks.map(c => c.kind))]
    for (const f of s.files) {
      const o = found.get(f.path)
      const before = s.changes.find(c => samePath(c.path, f.path))
      if (o === undefined) {
        // Not looked at this time: what was found before stands.
        if (before !== undefined) changes.push(before)
        continue
      }
      const verdict = compareFile(f, o)
      if (verdict === 'same') continue
      if (verdict === 'unknown') {
        if (before !== undefined) changes.push(before)
        continue
      }
      const t = touches.find(x => samePath(x.path, f.path))
      // An unseen change counts from when it was first found, while the file stays as it was found then.
      const foundAt = before !== undefined && before.kind === verdict && isStill(before.found, o) ? before.foundAt : ctx.now
      const since = t?.at ?? foundAt
      const isFoundBefore = t !== undefined || foundAt < ctx.now
      const byLater = t !== undefined && t.key !== null && t.key !== s.key && ctx.completed.has(t.key) ? t.subject : null
      const by =
        kinds.length > 0 && isFoundBefore && covers(ctx.green, s.checks, since)
          ? checkWords(ctx.green, kinds, ctx.now)
          : byLater !== null && (f.isDoc === true || kinds.length === 0)
            ? byLater
            : null
      if (by !== null) {
        files = files.map(x => (x === f ? { ...o, path: f.path, ...(f.isDoc === true ? { isDoc: true } : {}) } : x))
        touches = touches.filter(x => x !== t)
        rebaselined = [...rebaselined.filter(r => !samePath(r.path, f.path)), { path: f.path, by, at: ctx.now }].slice(-EVIDENCE_LIMITS.files)
        continue
      }
      changes.push({
        path: f.path,
        kind: verdict,
        by: t?.subject ?? null,
        byKey: t?.key ?? null,
        isByActive: t !== undefined && t.key !== null && ctx.active.has(t.key),
        isSeen: t !== undefined,
        at: t?.at ?? null,
        foundAt,
        found: { size: o.size, mtimeMs: o.mtimeMs, blob: o.blob },
      })
    }
    const status = statusOf(changes)
    const isSame = files === s.files && status === s.status && changes.length === s.changes.length && changes.every((c, i) => JSON.stringify(c) === JSON.stringify(s.changes[i]))
    if (isSame) return s.checkedAt === null ? { ...s, checkedAt: ctx.now } : s
    isChanged = true
    return { ...s, files, touches, rebaselined, changes, status, checkedAt: ctx.now }
  })
  return isChanged || snapshots.some((s, i) => s !== store.snapshots[i]) ? { ...store, snapshots } : store
}

/**
 * The person accepts the files of stale snapshots as they are now (`key`: one milestone; null: every
 * stale one): their evidence is re-baselined on what was found, "accepted by you". Files not found
 * this time keep their change.
 */
export function acceptChanges(store: EvidenceStore, key: string | null, found: ReadonlyMap<string, Fingerprint>, now: number): EvidenceStore {
  let isChanged = false
  const snapshots = store.snapshots.map(s => {
    if (s.status !== 'stale' || (key !== null && s.key !== key)) return s
    const taken = s.changes.filter(c => found.has(c.path))
    if (taken.length === 0) return s
    isChanged = true
    const files = s.files.map(f => {
      const o = found.get(f.path)
      return o === undefined || !taken.some(c => samePath(c.path, f.path)) ? f : { ...o, path: f.path, ...(f.isDoc === true ? { isDoc: true } : {}) }
    })
    const changes = s.changes.filter(c => !taken.includes(c))
    return {
      ...s,
      files,
      touches: s.touches.filter(t => !taken.some(c => samePath(c.path, t.path))),
      rebaselined: [...s.rebaselined.filter(r => !taken.some(c => samePath(c.path, r.path))), ...taken.map(c => ({ path: c.path, by: 'you', at: now }))].slice(-EVIDENCE_LIMITS.files),
      changes,
      status: statusOf(changes),
      checkedAt: now,
    }
  })
  return isChanged ? { ...store, snapshots } : store
}

// ---------------------------------------------------------------------------
// Words

const fileName = (path: string): string => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path

const names = (paths: readonly string[]): string => {
  const unique = [...new Set(paths.map(fileName))]
  return unique.length <= 2 ? unique.join(', ') : `${unique.slice(0, 2).join(', ')} +${unique.length - 2}`
}

/** The checks to run again, by name ("Tests, Type-check"); a milestone verified with none says so. */
export function rerunWords(s: Snapshot): string {
  return s.checks.length === 0 ? 'no check was recorded: review it' : `rerun ${[...new Set(s.checks.map(c => c.label))].join(', ')}`
}

/** A stale snapshot whose changed files are all documentation: its checks do not cover them, so a review does. */
const isDocsOnly = (s: Snapshot, changes: readonly EvidenceChange[]): boolean => changes.length > 0 && changes.every(c => s.files.find(f => samePath(f.path, c.path))?.isDoc === true)

/** What the snapshot says now, in a line for a milestone's row (null while it is current and nothing was re-verified). */
export function evidenceLine(s: Snapshot): string | null {
  if (s.status === 'stale') {
    const stale = s.changes.filter(c => !c.isByActive)
    const what = stale.some(c => c.kind === 'deleted') && stale.every(c => c.kind === 'deleted') ? 'deleted' : 'changed'
    return `${names(stale.map(c => c.path))} ${what} since ${clock(s.verifiedAt)} · ${isDocsOnly(s, stale) ? 'review the change' : rerunWords(s)}`
  }
  if (s.status === 'changing') {
    const by = [...new Set(s.changes.map(c => c.by).filter((b): b is string => b !== null))]
    return `${names(s.changes.map(c => c.path))} being changed by ${by.join(', ') || 'the work under way'}`
  }
  if (s.rebaselined.length > 0) return `re-verified by ${[...new Set(s.rebaselined.map(r => r.by))].join(', ')}`
  return null
}

/** Who changed a stale file, in words: the later milestone, no milestone under way, or outside Sentinel's view. */
const byWords = (c: EvidenceChange): string => (c.by !== null ? `by "${c.by}"` : c.isSeen ? 'with no milestone under way' : "outside Claude's tools")

/**
 * For Claude (the fresh context's block, the handoff prompt): the milestones whose verification is stale,
 * what changed and what to run again. Null with none.
 */
export function staleText(snapshots: readonly Snapshot[]): string | null {
  const stale = snapshots.filter(s => s.status === 'stale').slice(-5)
  if (stale.length === 0) return null
  const items = stale.map(s => {
    const changes = s.changes.filter(c => !c.isByActive)
    const what = changes.map(c => `${fileName(c.path)} ${c.kind} ${byWords(c)}`).slice(0, 4).join(', ')
    const rerun = s.checks.length === 0 || isDocsOnly(s, changes) ? 'no check covers that, so review it' : `rerun ${[...new Set(s.checks.map(c => `${c.label} (${c.command})`))].join(', ')}`
    return `"${s.subject}" (verified ${clock(s.verifiedAt)}): ${what}; ${rerun}`
  })
  return `Verification gone stale since it was recorded (files changed after the milestone was verified; this does not mean it is wrong): ${items.join('; ')}. Rerun those checks before relying on these milestones, and record the result.`
}

// ---------------------------------------------------------------------------
// Stored

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.slice(0, max) : '')

function fileOf(raw: unknown): EvidenceFile | null {
  if (!isRecord(raw) || typeof raw.path !== 'string' || raw.path === '') return null
  return { path: str(raw.path), exists: raw.exists !== false, ...(raw.isDir === true ? { isDir: true } : {}), ...(raw.isDoc === true ? { isDoc: true } : {}), size: num(raw.size), mtimeMs: num(raw.mtimeMs), blob: typeof raw.blob === 'string' && /^[0-9a-f]{40,64}$/.test(raw.blob) ? raw.blob : null }
}

function changeOf(raw: unknown): EvidenceChange | null {
  if (!isRecord(raw) || typeof raw.path !== 'string') return null
  const kind = raw.kind === 'deleted' || raw.kind === 'created' ? raw.kind : 'changed'
  const f = isRecord(raw.found) ? raw.found : {}
  return {
    path: str(raw.path),
    kind,
    by: typeof raw.by === 'string' ? str(raw.by, 120) : null,
    byKey: typeof raw.byKey === 'string' ? str(raw.byKey, 120) : null,
    isByActive: raw.isByActive === true,
    isSeen: raw.isSeen === true,
    at: num(raw.at),
    foundAt: num(raw.foundAt) ?? 0,
    found: { size: num(f.size), mtimeMs: num(f.mtimeMs), blob: typeof f.blob === 'string' && /^[0-9a-f]{40,64}$/.test(f.blob) ? f.blob : null },
  }
}

function snapshotOf(raw: unknown): Snapshot | null {
  if (!isRecord(raw) || typeof raw.key !== 'string' || typeof raw.subject !== 'string' || num(raw.verifiedAt) === null) return null
  const list = <T>(v: unknown, of: (x: unknown) => T | null, max: number): T[] => (Array.isArray(v) ? v.map(of).filter((x): x is T => x !== null).slice(-max) : [])
  const checks = list(raw.checks, c => (isRecord(c) && typeof c.kind === 'string' && num(c.at) !== null ? { kind: str(c.kind, 40), label: str(c.label, 40) || str(c.kind, 40), command: str(c.command, 160), at: num(c.at) ?? 0 } : null), EVIDENCE_LIMITS.checks)
  const touches = list(raw.touches, t => (isRecord(t) && typeof t.path === 'string' && num(t.at) !== null ? { path: str(t.path), key: typeof t.key === 'string' ? str(t.key, 120) : null, subject: typeof t.subject === 'string' ? str(t.subject, 120) : null, at: num(t.at) ?? 0 } : null), EVIDENCE_LIMITS.touches)
  const rebaselined = list(raw.rebaselined, r => (isRecord(r) && typeof r.path === 'string' && typeof r.by === 'string' ? { path: str(r.path), by: str(r.by, 120), at: num(r.at) ?? 0 } : null), EVIDENCE_LIMITS.files)
  const changes = list(raw.changes, changeOf, EVIDENCE_LIMITS.files)
  return {
    key: str(raw.key, 120),
    subject: str(raw.subject, 120),
    verifiedAt: num(raw.verifiedAt) ?? 0,
    session: num(raw.session) ?? 1,
    checks,
    files: list(raw.files, fileOf, EVIDENCE_LIMITS.files),
    head: typeof raw.head === 'string' && /^[0-9a-f]{7,64}$/.test(raw.head) ? raw.head : null,
    touches,
    rebaselined,
    status: raw.status === 'stale' || raw.status === 'changing' ? raw.status : changes.length > 0 ? statusOf(changes) : 'current',
    changes,
    checkedAt: num(raw.checkedAt),
  }
}

/** A stored evidence store, validated: anything malformed reads as none. */
export function evidenceOf(raw: unknown): EvidenceStore {
  if (!isRecord(raw)) return emptyEvidence()
  const work: Record<string, MilestoneWork> = {}
  if (isRecord(raw.work)) {
    for (const [key, w] of Object.entries(raw.work).slice(-EVIDENCE_LIMITS.snapshots)) {
      if (!isRecord(w) || num(w.since) === null) continue
      const files = Array.isArray(w.files) ? w.files.filter(isRecord).filter(f => typeof f.path === 'string' && num(f.at) !== null).map(f => ({ path: str(f.path), at: num(f.at) ?? 0 })).slice(-EVIDENCE_LIMITS.files) : []
      const outputs = Array.isArray(w.outputs) ? w.outputs.filter((o): o is string => typeof o === 'string').map(o => o.slice(0, 400)).slice(-EVIDENCE_LIMITS.outputs) : []
      work[key.slice(0, 120)] = { since: num(w.since) ?? 0, files, outputs }
    }
  }
  const snapshots = Array.isArray(raw.snapshots) ? raw.snapshots.map(snapshotOf).filter((s): s is Snapshot => s !== null).slice(-EVIDENCE_LIMITS.snapshots) : []
  return { work, snapshots }
}
