/**
 * The handoff notes (`NEXT_SESSION_PROMPT.md`) as one canonical artifact: where they are, whether they
 * were written for the handoff under way, and the proof. Every reader uses this verdict: the handoff's
 * own check before the clear, `/cr handoff`, `/cr fresh`, the Handoff Supervisor, Ready to resume and
 * the panel, so none of them can disagree.
 *
 * Seen in a real run: the notes existed at the project root, were written during the handoff, written
 * again after a background check, committed and pushed, and the check still said "missing" twice and
 * kept the context. What could make a check that only stats one path against one time say so:
 *
 *   the path      "the project root" is not one place. The session's root as read at the load, its root
 *                 now (a worktree move, /cd), the working directory (a Desktop worktree session lives in
 *                 `<project>/.claude/worktrees/<name>` and reads its config from the main checkout), the
 *                 repository's top level. Claude writes where IT thinks the root is.
 *   an error      a locked file, a permission, a network share: a stat that fails is not a missing file.
 *   the clock     `mtime >= handoff start` breaks when the file system's clock, a sync tool or a copy that
 *                 keeps times disagrees, and when the start moves forward (a retry asked again).
 *
 * So the verdict looks at every candidate place, separates "missing" from "could not inspect", and
 * accepts three proofs that the notes are this handoff's, any one enough:
 *
 *   write    Claude's own editing tool wrote that file after the handoff began (the call is seen)
 *   changed  the file differs from the snapshot taken as the handoff began (created, size, time or
 *            Git's blob id), whatever the clocks say
 *   time     its modification time is after the handoff began (less a little slack)
 *
 * The baseline is the handoff's first turn, kept through a retry or a restart (features/autopilot.ts).
 * Pure: the Runtime stats, hashes and records the writes.
 */

/** `present`: a file is there, and no handoff began in this context to compare it with. */
export type NotesState = 'valid' | 'present' | 'stale' | 'empty' | 'missing' | 'uninspectable'

export type CandidateVia = 'configured' | 'session root' | 'working directory' | 'repository root' | 'root at load' | 'written by Claude'

export type NotesCandidate = { path: string; via: CandidateVia }

export type NotesProbe =
  | { path: string; via: CandidateVia; ok: true; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; realPath: string | null }
  | { path: string; via: CandidateVia; ok: false; isMissing: boolean; error: string }

/** A write to the notes Sentinel saw: an editing tool's (certain), or a shell command that seems to write them (not proof). */
export type NotesWrite = { path: string; at: number; tool: string; isCertain: boolean }

/** One candidate as it was when the handoff began. */
export type NotesBaseline = { path: string; exists: boolean; size: number | null; mtimeMs: number | null; blob: string | null; at: number }

export type NotesVerdict = {
  state: NotesState
  /** The file the verdict is about (the one found, else the configured path). */
  path: string | null
  via: CandidateVia | null
  size: number | null
  mtimeMs: number | null
  /** How it was proven this handoff's, when valid. */
  proof: 'write' | 'changed' | 'time' | null
  /** In words: why this state ("written by Edit at 14:02", "modified before the handoff began"). */
  reason: string
  probes: NotesProbe[]
  checkedAt: number
}

/** Below this the notes are taken as empty (a stub a tool left). */
export const NOTES_MIN_BYTES = 1

/** Clocks and file systems disagree a little: a file modified this long before the baseline still counts by time. */
export const TIME_SLACK_MS = 5_000

const isAbsolute = (p: string): boolean => /^([a-z]:[\\/]|[\\/])/i.test(p)

/** A path as compared: forward slashes, no trailing slash, no `\\?\` prefix; lower case where the file system ignores case. */
export function normPath(p: string, isCaseInsensitive: boolean): string {
  const n = p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/\.\//g, '/')
  return isCaseInsensitive ? n.toLowerCase() : n
}

/** A path under a root, in the root's own separator. */
export function joinPath(root: string, file: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${file.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep)}`
}

/** Whether `path` names the notes file (`file` is the setting, relative to a root): its tail matches, segment by segment. */
export function isNotesPath(path: string, file: string, isCaseInsensitive: boolean): boolean {
  const tail = normPath(file, isCaseInsensitive).split('/').filter(Boolean)
  const parts = normPath(path, isCaseInsensitive).split('/').filter(Boolean)
  if (tail.length === 0 || parts.length < tail.length) return false
  return tail.every((seg, i) => parts[parts.length - tail.length + i] === seg)
}

/**
 * A shell command that seems to write the notes (a redirect, tee, cp or mv onto them, a script writing a
 * file of that name). A hint only: it adds a place to look and a line to the trace, never proof.
 */
export function shellWritesNotes(command: string, file: string): boolean {
  const name = file.replace(/\\/g, '/').split('/').pop() ?? file
  if (name === '' || !command.includes(name)) return false
  const at = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(>>?\\s*["']?[^\\s"']*${at})|(\\btee\\b[^|;&]*${at})|(\\b(cp|mv|copy|move|Copy-Item|Move-Item|Set-Content|Out-File)\\b[^|;&]*${at})|(open\\([^)]*${at}[^)]*['"][wa])|(write(File|_text|Text)[^;]*${at})`).test(command)
}

/** The places the notes may be, the configured one first, without duplicates. */
export function candidatesOf(input: {
  file: string
  roots: readonly { path: string | null; via: CandidateVia }[]
  writes: readonly NotesWrite[]
  isCaseInsensitive: boolean
}): NotesCandidate[] {
  const out: NotesCandidate[] = []
  const seen = new Set<string>()
  const add = (path: string, via: CandidateVia) => {
    const key = normPath(path, input.isCaseInsensitive)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ path, via })
  }
  if (isAbsolute(input.file)) add(input.file, 'configured')
  else for (const r of input.roots) if (r.path !== null && r.path !== '') add(joinPath(r.path, input.file), r.via)
  // Newest first: where Claude last wrote a file of that name.
  for (const w of [...input.writes].sort((a, b) => b.at - a.at)) if (isNotesPath(w.path, input.file, input.isCaseInsensitive) && isAbsolute(w.path)) add(w.path, 'written by Claude')
  return out
}

/** Whether an error from a stat means "no such file" (anything else means the file could not be looked at). */
export function isMissingError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') return true
  const message = error instanceof Error ? error.message : String(error)
  return /\bENOENT\b|\bENOTDIR\b|no such file|not found|does not exist|cannot find/i.test(message)
}

/** An instant for the debug trace; never throws on a figure that is no time. */
export function iso(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : String(ms)
}

const clockWords = (ms: number): string => {
  if (!Number.isFinite(ms)) return String(ms)
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

type FileProbe = Extract<NotesProbe, { ok: true }>

/** The verdict on the notes, from what the stats found, the writes seen and the snapshot taken as the handoff began. */
export function judge(input: {
  file: string
  probes: readonly NotesProbe[]
  writes: readonly NotesWrite[]
  /** The handoff's baseline (its first turn's start); null when no handoff began in this context. */
  since: number | null
  baseline: readonly NotesBaseline[] | null
  /** Git's blob id of a candidate now, where it was worth asking (by normalized path). */
  blobs?: ReadonlyMap<string, string>
  isCaseInsensitive: boolean
  now: number
}): NotesVerdict {
  const ci = input.isCaseInsensitive
  const probes = [...input.probes]
  const keyOf = (p: { path: string; realPath?: string | null }) => normPath(p.realPath ?? p.path, ci)
  const files = probes.filter((p): p is FileProbe => p.ok && p.kind === 'file')
  const base = (state: NotesState, p: FileProbe | null, reason: string, proof: NotesVerdict['proof'] = null): NotesVerdict => ({
    state,
    path: p?.path ?? probes[0]?.path ?? null,
    via: p?.via ?? probes[0]?.via ?? null,
    size: p?.size ?? null,
    mtimeMs: p?.mtimeMs ?? null,
    proof,
    reason,
    probes,
    checkedAt: input.now,
  })
  if (files.length === 0) {
    const failed = probes.find((p): p is Extract<NotesProbe, { ok: false }> => !p.ok && !p.isMissing)
    if (failed !== undefined) return base('uninspectable', null, `${failed.path} could not be inspected (${failed.error})`)
    const dir = probes.find(p => p.ok && p.kind !== 'file')
    if (dir !== undefined) return base('missing', null, `${dir.path} is not a file`)
    return base('missing', null, probes.length === 0 ? `no place to look for ${input.file}` : `${input.file} is not at ${probes.map(p => p.path).join(', or ')}`)
  }
  type Judged = { p: FileProbe; state: NotesState; proof: NotesVerdict['proof']; reason: string }
  const judged: Judged[] = files.map(p => {
    if (p.size < NOTES_MIN_BYTES) return { p, state: 'empty', proof: null, reason: `${p.path} is empty` }
    if (input.since === null) return { p, state: 'present', proof: null, reason: `written ${clockWords(p.mtimeMs)}` }
    const since = input.since
    const key = keyOf(p)
    const write = input.writes.filter(w => w.isCertain && w.at >= since - TIME_SLACK_MS && (normPath(w.path, ci) === key || normPath(w.path, ci) === normPath(p.path, ci))).sort((a, b) => b.at - a.at)[0]
    if (write !== undefined) return { p, state: 'valid', proof: 'write', reason: `written by ${write.tool} at ${clockWords(write.at)}, after the handoff began` }
    const before = input.baseline?.find(b => normPath(b.path, ci) === normPath(p.path, ci) || normPath(b.path, ci) === key) ?? null
    if (before !== null) {
      const blobNow = input.blobs?.get(normPath(p.path, ci)) ?? null
      const what = !before.exists ? 'created' : before.size !== p.size ? 'its size changed' : before.mtimeMs !== p.mtimeMs ? 'its modification time changed' : before.blob !== null && blobNow !== null && before.blob !== blobNow ? 'its content changed' : null
      if (what !== null) return { p, state: 'valid', proof: 'changed', reason: `${what} since the handoff began` }
    }
    if (p.mtimeMs >= since - TIME_SLACK_MS) return { p, state: 'valid', proof: 'time', reason: `modified ${clockWords(p.mtimeMs)}, after the handoff began` }
    return { p, state: 'stale', proof: null, reason: `${p.path} was last modified ${clockWords(p.mtimeMs)}, before the handoff began (${clockWords(since)}), and has not changed since` }
  })
  const rank: Record<NotesState, number> = { valid: 0, present: 1, stale: 2, empty: 3, missing: 4, uninspectable: 5 }
  // The best state wins; among equals, the configured place first (the order the candidates were made in).
  const best = [...judged].sort((a, b) => rank[a.state] - rank[b.state] || probes.indexOf(a.p) - probes.indexOf(b.p))[0]!
  return base(best.state, best.p, best.reason, best.proof)
}

/** One line per candidate for the debug trace: exactly where it looked and what it found. */
export function probeLines(v: NotesVerdict, since: number | null): string[] {
  return v.probes.map(p => {
    if (!p.ok) return `  ${p.path} [${p.via}]: ${p.isMissing ? 'not there' : `could not inspect (${p.error})`}`
    const rel = since === null ? '' : ` (${p.mtimeMs - since >= 0 ? '+' : ''}${Math.round((p.mtimeMs - since) / 1000)} s from the baseline)`
    return `  ${p.path} [${p.via}]: ${p.kind} ${p.size} B, modified ${iso(p.mtimeMs)}${rel}${p.realPath !== null && p.realPath !== p.path ? `, real path ${p.realPath}` : ''}`
  })
}

/** The state in a few words, as the panel and the commands say it. */
export const STATE_WORDS: Record<NotesState, string> = {
  valid: 'written for this handoff',
  present: 'on disk',
  stale: 'not updated for this handoff',
  empty: 'empty',
  missing: 'missing',
  uninspectable: 'could not be inspected',
}
