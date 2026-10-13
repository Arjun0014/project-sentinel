import { describe, expect, test } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'

import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { handleCommand } from '../hooks/app/commands'
import { defaultSettings } from '../hooks/core/settings'
import {
  type EvidenceCheck,
  type EvidenceFile,
  type EvidenceStore,
  type Fingerprint,
  acceptChanges,
  addSnapshot,
  compare,
  covers,
  dropSnapshots,
  emptyEvidence,
  evidenceLine,
  evidenceOf,
  filesFor,
  greenChecks,
  noteActive,
  noteEdits,
  noteOutputs,
  pathsToHash,
  staleText,
  windowStart,
} from '../hooks/features/evidence'
import { healthOf } from '../hooks/features/handoff'
import { fakeHost } from './fixtures/fake-host'
import { SESSION, world } from './fixtures/world'

// Milestone evidence (1.7.0): a completed milestone keeps what it stood on (green checks, its files' blob ids,
// HEAD), and later changes make its verification stale, never "wrong". Later milestones that legitimately
// change the same files are weighed so this is not constant noise: quiet while they are under way,
// re-baselined once checks covering the earlier ones pass after the change.

const A = '/work/src/cache.ts'
const B = '/work/src/hud.ts'
const DOC = '/work/README.md'
const fp = (size: number, mtimeMs: number, blob: string | null = null): Fingerprint => ({ exists: true, size, mtimeMs, blob })
const blob = (c: string) => c.repeat(40).slice(0, 40)
const tests = (at: number) => ({ kind: 'tests', label: 'Tests', command: 'npm test', at })
const typecheck = (at: number) => ({ kind: 'typecheck', label: 'Type-check', command: 'npm run typecheck', at })

/** A store where "Fix the scheduler" (m1) was verified at 1000 with Tests, over cache.ts (and README.md as a doc). */
function verified(checks: EvidenceCheck[] = [tests(900)], files: EvidenceFile[] = [{ path: A, ...fp(10, 100, blob('a')) }]): EvidenceStore {
  let s = noteActive(emptyEvidence(), 'm1', 0)
  s = noteEdits(s, { key: 'm1', subject: 'Fix the scheduler' }, files.map(f => f.path), 500)
  return addSnapshot(s, { key: 'm1', subject: 'Fix the scheduler', verifiedAt: 1000, session: 1, checks, files, head: 'c0ffee'.padEnd(40, '0') })
}

const ctx = (patch: Partial<Parameters<typeof compare>[2]> = {}) => ({ active: new Set<string>(), completed: new Set(['m1']), green: [], now: 5000, ...patch })

describe('milestone evidence: the rules', () => {
  test('edits belong to the milestone under way; named outputs first; generated windows and checks counted from when it began', () => {
    let s = noteActive(emptyEvidence(), 'm1', 100)
    s = noteEdits(s, { key: 'm1', subject: 'Fix it' }, [A, B], 200)
    s = noteEdits(s, { key: 'm1', subject: 'Fix it' }, [A], 300)
    s = noteOutputs(s, 'm1', ['/work/out/report.pdf'], 300)
    expect(filesFor(s, 'm1')).toEqual(['/work/out/report.pdf', A, B])
    expect(windowStart(s, 'm1', 0)).toBe(100)
    // Edits with no milestone under way belong to none.
    expect(noteEdits(emptyEvidence(), null, [A], 10).work).toEqual({})
    // Milestones a rewritten plan dropped never pile up: the work of the latest thirty is kept.
    let many = emptyEvidence()
    for (let i = 0; i < 35; i++) many = noteActive(many, `m${i}`, i)
    expect(Object.keys(many.work)).toHaveLength(30)
    expect(many.work.m0).toBeUndefined()
    expect(many.work.m34).toBeDefined()
    // The latest run of each kind in the window, only when it passed.
    const runs = [
      { kind: 'tests', label: 'Tests', command: 'npm test', status: 'failed', endedAt: 150 },
      { kind: 'tests', label: 'Tests', command: 'npm test', status: 'passed', endedAt: 250 },
      { kind: 'typecheck', label: 'Type-check', command: 'tsc', status: 'passed', endedAt: 260 },
      { kind: 'typecheck', label: 'Type-check', command: 'tsc', status: 'failed', endedAt: 270 },
      { kind: 'lint', label: 'Lint', command: 'eslint', status: 'passed', endedAt: 50 },
    ]
    expect(greenChecks(runs, 100, 400)).toEqual([{ kind: 'tests', label: 'Tests', command: 'npm test', at: 250 }])
    expect(covers([tests(300)], [tests(100)], 200)).toBe(true)
    expect(covers([tests(150)], [tests(100)], 200)).toBe(false)
    // Ended in the very millisecond of the change: it cannot have run on it.
    expect(covers([tests(200)], [tests(100)], 200)).toBe(false)
    expect(covers([tests(300)], [tests(100), typecheck(100)], 200)).toBe(false)
  })

  test('unchanged files cost no hashing; a file only touched stays current; a change outside Claude\'s tools makes it stale, never wrong', () => {
    const s = verified()
    // Same size and time: nothing to hash, current.
    const same = new Map([[A, fp(10, 100)]])
    expect(pathsToHash(s, same)).toEqual([])
    expect(compare(s, same, ctx()).snapshots[0]?.status).toBe('current')
    // Touched (time moved), same content: hashed again, still current.
    const touched = new Map([[A, fp(10, 200)]])
    expect(pathsToHash(s, touched)).toEqual([A])
    const t = compare(s, new Map([[A, fp(10, 200, blob('a'))]]), ctx())
    expect(t.snapshots[0]?.status).toBe('current')
    // Changed content, no edit seen: stale, with what to rerun.
    const changed = compare(s, new Map([[A, fp(12, 300, blob('b'))]]), ctx())
    const snap = changed.snapshots[0]!
    expect(snap.status).toBe('stale')
    expect(snap.changes).toMatchObject([{ path: A, kind: 'changed', by: null, isSeen: false, foundAt: 5000 }])
    expect(evidenceLine(snap)).toMatch(/^cache\.ts changed since \d\d:\d\d · rerun Tests$/)
    const told = staleText(changed.snapshots) ?? ''
    expect(told).toContain('"Fix the scheduler"')
    expect(told).toContain("cache.ts changed outside Claude's tools")
    expect(told).toContain('rerun Tests (npm test)')
    expect(told).toContain('does not mean it is wrong')
    expect(told.replace('this does not mean it is wrong', '')).not.toMatch(/wrong|fail/i)
    // Deleted.
    const gone = compare(s, new Map([[A, { exists: false, size: null, mtimeMs: null, blob: null }]]), ctx())
    expect(evidenceLine(gone.snapshots[0]!)).toMatch(/^cache\.ts deleted since/)
    // A hash that failed: the same size cannot decide, so nothing is claimed; a new size can.
    expect(compare(s, new Map([[A, fp(10, 300, null)]]), ctx()).snapshots[0]?.status).toBe('current')
    expect(compare(s, new Map([[A, fp(11, 300, null)]]), ctx()).snapshots[0]?.status).toBe('stale')
  })

  test('a later milestone changing the file: quiet while under way, re-baselined when checks covering the earlier ones pass after the change', () => {
    let s = verified([tests(900), typecheck(950)])
    s = noteActive(s, 'm2', 2000)
    s = noteEdits(s, { key: 'm2', subject: 'Polish the HUD' }, [A], 2100)
    const after = new Map([[A, fp(14, 2100, blob('c'))]])
    // Under way: being changed, not stale.
    const under = compare(s, after, ctx({ active: new Set(['m2']), now: 2200 }))
    expect(under.snapshots[0]).toMatchObject({ status: 'changing' })
    expect(evidenceLine(under.snapshots[0]!)).toBe('cache.ts being changed by Polish the HUD')
    // Tests passed after the change but no type-check: still not covered, so once m2 is done it is stale.
    const half = compare(under, after, ctx({ completed: new Set(['m1', 'm2']), green: [tests(2300)], now: 2400 }))
    expect(half.snapshots[0]).toMatchObject({ status: 'stale' })
    expect(half.snapshots[0]?.changes[0]).toMatchObject({ by: 'Polish the HUD', isSeen: true, at: 2100 })
    expect(staleText(half.snapshots)).toContain('cache.ts changed by "Polish the HUD"')
    // Both kinds passed after the change: re-baselined on the new content, quietly.
    const covered = compare(half, after, ctx({ completed: new Set(['m1', 'm2']), green: [tests(2300), typecheck(2350)], now: 2500 }))
    const snap = covered.snapshots[0]!
    expect(snap.status).toBe('current')
    expect(snap.files[0]).toMatchObject({ path: A, size: 14, blob: blob('c') })
    expect(snap.rebaselined).toEqual([{ path: A, by: expect.stringMatching(/^Tests, Type-check at \d\d:\d\d$/), at: 2500 }])
    expect(evidenceLine(snap)).toMatch(/^re-verified by Tests, Type-check at/)
    // Checks that passed before the change never cover it.
    expect(compare(under, after, ctx({ completed: new Set(['m1', 'm2']), green: [tests(2050), typecheck(2050)], now: 2600 })).snapshots[0]?.status).toBe('stale')
  })

  test('documentation, and milestones verified with no check, belong to the later milestone that changed them once it is done', () => {
    let s = verified([tests(900)], [{ path: A, ...fp(10, 100, blob('a')) }, { path: DOC, isDoc: true, ...fp(50, 100, blob('d')) }])
    s = noteEdits(s, { key: 'm2', subject: 'Document it' }, [DOC], 2100)
    const after = new Map([[A, fp(10, 100, blob('a'))], [DOC, fp(60, 2100, blob('e'))]])
    const done = compare(s, after, ctx({ completed: new Set(['m1', 'm2']), now: 2200 }))
    expect(done.snapshots[0]).toMatchObject({ status: 'current', rebaselined: [{ path: DOC, by: 'Document it' }] })
    // A doc changed outside Claude's tools: stale, and a review is what it needs, not a rerun.
    const outside = compare(verified([tests(900)], [{ path: DOC, isDoc: true, ...fp(50, 100, blob('d')) }]), new Map([[DOC, fp(70, 3000, blob('f'))]]), ctx())
    expect(evidenceLine(outside.snapshots[0]!)).toMatch(/· review the change$/)
    // No check recorded: a later completed milestone owns the change; an unseen one asks for a review.
    const bare = noteEdits(verified([]), { key: 'm2', subject: 'Refactor' }, [A], 2100)
    expect(compare(bare, new Map([[A, fp(20, 2100, blob('g'))]]), ctx({ completed: new Set(['m1', 'm2']) })).snapshots[0]?.status).toBe('current')
    const unseen = compare(verified([]), new Map([[A, fp(20, 2100, blob('g'))]]), ctx())
    expect(evidenceLine(unseen.snapshots[0]!)).toMatch(/· no check was recorded: review it$/)
  })

  test('a change outside the tools clears once the checks pass after it was found, while the file stays as found; the person can accept it', () => {
    const s = verified()
    const outside = new Map([[A, fp(12, 300, blob('b'))]])
    const found = compare(s, outside, ctx({ now: 5000 }))
    expect(found.snapshots[0]?.status).toBe('stale')
    // Tests that passed before it was found prove nothing about it.
    expect(compare(found, outside, ctx({ green: [tests(4000)], now: 6000 })).snapshots[0]?.status).toBe('stale')
    // Tests passed after it was found, the file still as found: re-verified.
    const rerun = compare(found, outside, ctx({ green: [tests(5500)], now: 6000 }))
    expect(rerun.snapshots[0]).toMatchObject({ status: 'current', rebaselined: [{ path: A }] })
    // Changed again since it was found: the clock starts over.
    const again = compare(found, new Map([[A, fp(13, 5600, blob('h'))]]), ctx({ green: [tests(5500)], now: 6000 }))
    expect(again.snapshots[0]).toMatchObject({ status: 'stale', changes: [{ foundAt: 6000 }] })
    // The person accepts the files as they are.
    const accepted = acceptChanges(found, null, new Map([[A, fp(12, 300, blob('b'))]]), 7000)
    expect(accepted.snapshots[0]).toMatchObject({ status: 'current', rebaselined: [{ path: A, by: 'you', at: 7000 }], files: [{ path: A, blob: blob('b') }] })
    expect(acceptChanges(s, null, outside, 7000)).toBe(s)
  })

  test('reopened milestones lose their snapshot; stored evidence is validated', () => {
    const s = verified()
    const reopened = dropSnapshots(s, ['m1'], 9000)
    expect(reopened.snapshots).toEqual([])
    // Its files are still its work: a snapshot taken when it is done again covers them.
    expect(filesFor(reopened, 'm1')).toEqual([A])
    expect(dropSnapshots(s, ['other'], 9000)).toBe(s)
    const stored = JSON.parse(JSON.stringify(compare(s, new Map([[A, fp(12, 300, blob('b'))]]), ctx())))
    expect(evidenceOf(stored)).toEqual(stored)
    expect(evidenceOf({ snapshots: [{ key: 'x' }], work: 'no' })).toEqual(emptyEvidence())
    expect(evidenceOf({ snapshots: [{ key: 'k', subject: 'S', verifiedAt: 1, files: [{ path: A, blob: 'not-hex', size: 'big' }] }] }).snapshots[0]?.files[0]).toEqual({ path: A, exists: true, size: null, mtimeMs: null, blob: null })
    expect(evidenceOf(null)).toEqual(emptyEvidence())
  })

  test('Handoff Health says whether verification is current, never more than that', () => {
    const base = { hasPlan: true, isPlanUpdated: true, current: null, isPlanSettled: true, isNotesWritten: true, handoffFile: 'NEXT_SESSION_PROMPT.md', docsEdited: [], checks: [{ label: 'Tests', status: 'passing' }], isClaudeMdEdited: false }
    expect(healthOf(base).find(c => c.id === 'evidence')).toBeUndefined()
    expect(healthOf({ ...base, evidence: { verified: 3, stale: [], rerun: [] } }).find(c => c.id === 'evidence')).toEqual({ id: 'evidence', label: 'Verification current', state: 'ok', detail: '3 verified milestones unchanged' })
    expect(healthOf({ ...base, evidence: { verified: 3, stale: ['Fix the scheduler'], rerun: ['Tests'] } }).find(c => c.id === 'evidence')).toEqual({ id: 'evidence', label: 'Verification current', state: 'missing', detail: 'Fix the scheduler stale · rerun Tests' })
  })
})

// ---------------------------------------------------------------------------
// The runtime: real tool calls, a modeled workspace (stat, git hash-object, HEAD).

let ids = 0
async function call(rt: Runtime, tool: string, input: Record<string, unknown>, result: unknown = { stdout: 'ok', stderr: '', interrupted: false }, isError = false) {
  const id = `e${++ids}`
  gap()
  await rt.beforeTool(tool, input, id, undefined)
  rt.afterTool(tool, input, id, (isError ? { isError: true, result, text: 'Exit code 1\nFAIL cache.test.ts' } : { result }) as ToolCallResult)
}

async function started() {
  const f = fakeHost()
  f.live.repo = '/work'
  f.kept.store['settings.v1'] = defaultSettings()
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { ...f, rt }
}

type Started = Awaited<ReturnType<typeof started>>

/** A few real milliseconds: the runtime times edits and checks by the system clock, and their order matters here. */
function gap(): void {
  const until = Date.now() + 3
  while (Date.now() < until) {
    // Spins: the test kit has no timers of the system's own.
  }
}

/** Claude edits a file: the workspace changes, then the Edit tool reports it. */
async function edit(f: Started, path: string, content: string, mtimeMs: number) {
  gap()
  f.live.workspace[path] = { content, mtimeMs }
  await call(f.rt, 'Edit', { file_path: path, old_string: 'a', new_string: 'b' }, { filePath: path, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] })
}

const plan = (m1: string, m2: string, extra: Record<string, unknown> = {}) => ({
  objective: 'Speed up the cache',
  milestones: [
    { title: 'Fix the scheduler', status: m1, ...extra },
    { title: 'Polish the HUD', status: m2 },
  ],
})

describe('milestone evidence in the runtime', () => {
  test('a completed milestone keeps its green checks, its files\' blob ids and HEAD; a change outside the tools makes it stale everywhere it shows', async () => {
    const f = await started()
    const { rt } = f
    rt.recordMilestones(plan('in_progress', 'pending'), undefined)
    await edit(f, A, 'v1', 100)
    // Generated and temporary files are no milestone's evidence.
    await edit(f, '/work/dist/bundle.js', 'x', 100)
    await edit(f, '/work/NEXT_SESSION_PROMPT.md', 'notes', 100)
    await call(rt, 'Bash', { command: 'npm test' })
    // A report a command wrote (no editing tool reported it): Claude names it as an output.
    f.live.workspace['/work/out/report.txt'] = { content: 'report', mtimeMs: 150 }
    rt.recordMilestones(plan('completed', 'in_progress', { outputs: ['out/report.txt'] }), undefined)
    await f.advance(10)
    const snap = rt.evidence().snapshots[0]!
    expect(snap).toMatchObject({ key: 'fix the scheduler', subject: 'Fix the scheduler', status: 'current', head: f.live.head })
    expect(snap.checks).toMatchObject([{ kind: 'tests', label: 'Tests', command: 'npm test' }])
    // The output Claude named first, then the edited file.
    expect(snap.files.map(x => x.path)).toEqual(['/work/out/report.txt', A])
    expect(snap.files.find(x => x.path === A)).toMatchObject({ exists: true, size: 2, mtimeMs: 100, blob: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(f.kept.hashed.at(-1)).toEqual(['/work/out/report.txt', A])
    expect(f.kept.traces.some(t => t.startsWith('evidence: "Fix the scheduler" verified with Tests; 2 files (blob ids) at c0ffee00'))).toBe(true)
    // Nothing moved: a look costs a stat per file and no hashing.
    const hashes = f.kept.hashed.length
    await rt.checkEvidence('test')
    expect(f.kept.hashed.length).toBe(hashes)
    expect(rt.staleEvidence()).toEqual([])
    // The person edits cache.ts in their editor: stale, with what changed and what to rerun.
    f.live.workspace[A] = { content: 'v2 by hand', mtimeMs: 900 }
    await rt.checkEvidence('test')
    expect(f.kept.hashed.at(-1)).toEqual([A])
    expect(rt.staleEvidence().map(s => s.subject)).toEqual(['Fix the scheduler'])
    expect(f.kept.traces.some(t => /^evidence \(test\): "Fix the scheduler" stale: cache\.ts changed since \d\d:\d\d · rerun Tests$/.test(t))).toBe(true)
    // Run Progress, Activity's attention, Ready to Resume, /cr evidence.
    const row = Views.missionOf(rt).plan?.tasks.find(t => t.subject === 'Fix the scheduler')
    expect(row?.evidence).toMatchObject({ status: 'stale', line: expect.stringMatching(/^cache\.ts changed since .* · rerun Tests$/) })
    expect(Views.activityOf(rt).attention[0]).toMatchObject({ kind: 'stale', title: 'Fix the scheduler' })
    expect(rt.ops.resumePreview().stale).toMatchObject([{ subject: 'Fix the scheduler', status: 'stale' }])
    expect(rt.ops.resumePreview().isHealthy === rt.ops.resumeHealth().isHealthy).toBe(true)
    const listed = await handleCommand(rt, 'evidence')
    expect(listed.text).toContain('1. ▲ Fix the scheduler: verification stale · cache.ts changed since')
    expect(listed.text).toContain('/cr evidence accept 1')
    // Claude reruns the tests after it was found: re-verified, quietly.
    await call(rt, 'Bash', { command: 'npm test' })
    await rt.checkEvidence('test')
    expect(rt.staleEvidence()).toEqual([])
    expect(Views.missionOf(rt).plan?.tasks.find(t => t.subject === 'Fix the scheduler')?.evidence).toMatchObject({ status: 'rebaselined', line: expect.stringMatching(/^re-verified by Tests at/) })
  })

  test('a later milestone editing the same file is quiet while under way; failing tests after it keep the earlier one stale; passing ones re-baseline it', async () => {
    const f = await started()
    const { rt } = f
    rt.recordMilestones(plan('in_progress', 'pending'), undefined)
    await edit(f, A, 'v1', 100)
    await call(rt, 'Bash', { command: 'npm test' })
    rt.recordMilestones(plan('completed', 'in_progress'), undefined)
    await f.advance(10)
    await edit(f, A, 'v2', 200)
    await rt.checkEvidence('test')
    expect(rt.evidence().snapshots[0]).toMatchObject({ status: 'changing', changes: [{ by: 'Polish the HUD', isByActive: true }] })
    expect(rt.staleEvidence()).toEqual([])
    expect(Views.activityOf(rt).attention.some(a => a.kind === 'stale')).toBe(false)
    // Its tests fail after the change: when it is completed anyway, the earlier milestone's verification is stale.
    await call(rt, 'Bash', { command: 'npm test' }, { stdout: '', stderr: 'FAIL', interrupted: false }, true)
    rt.recordMilestones(plan('completed', 'completed'), undefined)
    await f.advance(10)
    expect(rt.staleEvidence().map(s => s.subject)).toEqual(['Fix the scheduler'])
    expect(rt.evidence().snapshots.find(s => s.subject === 'Polish the HUD')?.checks).toEqual([])
    // Fixed and green: re-baselined.
    await call(rt, 'Bash', { command: 'npm test' })
    await rt.checkEvidence('test')
    expect(rt.staleEvidence()).toEqual([])
  })

  test('a handoff tells Claude and the fresh context what went stale; Handoff Health and Last handoff show it; the person can accept it', async () => {
    const f = await started()
    const { rt } = f
    rt.update(s => {
      s.autopilot.enabled = true
    })
    rt.recordMilestones(plan('in_progress', 'pending'), undefined)
    await edit(f, A, 'v1', 100)
    await call(rt, 'Bash', { command: 'npm test' })
    rt.recordMilestones(plan('completed', 'in_progress'), undefined)
    await f.advance(10)
    f.live.workspace[A] = { content: 'changed by hand', mtimeMs: 999 }
    await rt.checkEvidence('test')
    // The handoff prompt asks for the rerun.
    rt.onTurnStart({ turnId: 't1', text: 'go' })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'ok' })
    void rt.requestHandoff()
    await f.advance(300)
    const prompt = f.kept.submitted.at(-1) ?? ''
    expect(prompt).toContain('Verification gone stale since it was recorded')
    expect(prompt).toContain('"Fix the scheduler"')
    expect(prompt).toContain('rerun Tests (npm test)')
    expect(prompt).toContain('say in the notes that their verification is stale')
    // The handoff turn ends with the notes written: Handoff Health has the item, the fresh context's block names it.
    rt.onTurnStart({ turnId: 'h1', text: prompt })
    rt.recordMilestones(plan('completed', 'in_progress'), undefined)
    await call(rt, 'Write', { file_path: '/work/NEXT_SESSION_PROMPT.md', content: 'notes' }, { type: 'create', filePath: '/work/NEXT_SESSION_PROMPT.md', content: 'notes', structuredPatch: [], originalFile: null })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'handoff written' })
    await f.advance(2000)
    const handoff = Views.paneOf(rt).handoff
    expect(handoff?.health.find(c => c.id === 'evidence')).toEqual({ id: 'evidence', label: 'Verification current', state: 'missing', detail: 'Fix the scheduler stale · rerun Tests' })
    expect(handoff?.evidence).toMatchObject([{ subject: 'Fix the scheduler', status: 'stale' }])
    expect(f.kept.commands).toContain('clear')
    f.live.sessionId = 'S2'
    await rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    const block = rt.takeFreshContext() ?? ''
    expect(block).toContain('Verification gone stale since it was recorded')
    expect(block).toContain('cache.ts changed outside Claude')
    // The person looked and accepts the file as it is.
    const text = await rt.acceptEvidence(null)
    expect(text).toBe('Accepted "Fix the scheduler" as it is now: its files are the evidence from here.')
    expect(rt.staleEvidence()).toEqual([])
    expect(Views.paneOf(rt).handoff?.evidence).toEqual([])
    expect((await handleCommand(rt, 'evidence accept')).text).toBe('No milestone has stale verification.')
  })

  test('reopened, the snapshot goes and a fresh one is taken when it is done again; a reload keeps the evidence; no Git: size and time stand in', async () => {
    const f = await started()
    const { rt } = f
    rt.recordMilestones(plan('in_progress', 'pending'), undefined)
    await edit(f, A, 'v1', 100)
    rt.recordMilestones(plan('completed', 'pending'), undefined)
    await f.advance(10)
    expect(rt.evidence().snapshots).toHaveLength(1)
    rt.recordMilestones(plan('in_progress', 'pending'), undefined)
    expect(rt.evidence().snapshots).toHaveLength(0)
    await edit(f, B, 'w1', 300)
    f.live.isHashBroken = true
    rt.recordMilestones(plan('completed', 'pending'), undefined)
    await f.advance(10)
    const snap = rt.evidence().snapshots[0]!
    expect(snap.files.map(x => [x.path, x.blob])).toEqual([[B, null], [A, null]])
    expect(f.kept.traces.some(t => t.startsWith('evidence: git hash-object failed (exit 127): size and time stand in'))).toBe(true)
    // A reload: the run record carries it.
    await f.advance(5000)
    rt.stopTimers()
    const again = new Runtime()
    again.bind(f.host)
    await again.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    expect(again.evidence().snapshots.map(s => s.subject)).toEqual(['Fix the scheduler'])
    // Without blob ids, a new size is a change.
    f.live.workspace[B] = { content: 'w22', mtimeMs: 400 }
    await again.checkEvidence('test')
    expect(again.staleEvidence()).toHaveLength(1)
  })

  test('a session that starts on a run (a restart, a resume, a reload) compares at once, so Ready to resume reads the workspace as it is', async () => {
    const f = await started()
    const { rt } = f
    rt.recordMilestones(plan('in_progress', 'pending'), undefined)
    await edit(f, A, 'v1', 100)
    await call(rt, 'Bash', { command: 'npm test' })
    rt.recordMilestones(plan('completed', 'pending'), undefined)
    await f.advance(10)
    expect(rt.staleEvidence()).toEqual([])
    await f.advance(5000)
    rt.stopTimers()
    // Changed while no session ran: nothing has compared yet.
    f.live.workspace[A] = { content: 'v2 while away', mtimeMs: 900 }
    const again = new Runtime()
    again.bind(f.host)
    await again.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    expect(again.staleEvidence().map(s => s.subject)).toEqual(['Fix the scheduler'])
    expect(again.ops.resumePreview().stale).toMatchObject([{ subject: 'Fix the scheduler', status: 'stale' }])
    expect(f.kept.traces.some(t => /^evidence \(session start\): "Fix the scheduler" stale: cache\.ts changed since \d\d:\d\d · rerun Tests$/.test(t))).toBe(true)
  })

  test('a session that starts with nothing verified runs no Git at all', async () => {
    const f = await started()
    expect(f.kept.hashed).toEqual([])
    expect(f.kept.traces.some(t => t.startsWith('evidence'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// On the surfaces: the real hooks, the engine beneath answering stat and Git for one file.

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
const isNode = (n: unknown): n is Node => typeof n === 'object' && n !== null && !Array.isArray(n)
const textOf = (n: unknown): string => (typeof n === 'string' ? n : isNode(n) ? (n.children ?? []).map(textOf).join('') : '')

describe('milestone evidence on the surfaces', () => {
  test('Run progress and Attention say a stale verification and what to rerun; Accept takes the files as they are', { timeoutMs: 30_000 }, async ($, on) => {
    const file = { content: 'v1', mtimeMs: 100 }
    on('tool.call', { tool: 'Edit' }, ($, e) => ({ result: { filePath: e.file_path, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
    // Beneath the plugin: the one project file, and Git's answers for it.
    const w = world(on, {
      tokens: 300_000,
      stat: path => (path === A ? { size: file.content.length, mtimeMs: file.mtimeMs } : undefined),
      run: argv =>
        argv[0] !== 'git'
          ? undefined
          : argv[1] === 'hash-object'
            ? { exitCode: 0, stdout: `${argv.slice(4).map(() => blob(file.content.length.toString(16))).join('\n')}\n` }
            : argv[1] === 'rev-parse'
              ? { exitCode: 0, stdout: `${'ab'.repeat(20)}\n` }
              : undefined,
    })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('session.repo', () => ({ value: { root: '/work', remote: null, internal: false, name: 'work' } as never }))
    await $.session.start(SESSION)
    await w.clock.advance(300)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const list = (m1: string) => ({ tool: 'mcp__project-sentinel__milestones', objective: 'Speed up the cache', milestones: [{ title: 'Fix the scheduler', status: m1 }, { title: 'Polish the HUD', status: m1 === 'completed' ? 'in_progress' : 'pending' }] }) as never
    await $.tool.call(list('in_progress'))
    await $.tool.call({ tool: 'Edit', file_path: A, old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await $.tool.call(list('completed'))
    await w.clock.advance(300)
    // The file changes outside Claude's tools; a look finds it.
    file.content = 'changed by hand'
    file.mtimeMs = 900
    const checked = await $.command.run({ command: 'cr', args: 'evidence check', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    expect(JSON.stringify(checked)).toContain('Fix the scheduler: verification stale')
    await w.clock.advance(300)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: { title: 'Control Room', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } })
      await ui.press({ key: 'tab-activity' })
      await w.clock.advance(300)
      const text = textOf(await ui.drawn())
      expect(text, surface).toContain('verification stale')
      expect(text, surface).toMatch(/cache\.ts changed since \d\d:\d\d · rerun Tests/)
      expect(await ui.find({ type: 'Button', key: 'evidence-accept' }), surface).toBeDefined()
      await ui.unmount()
    }
    // Accept: the files as they are now are the evidence; the attention goes.
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: { title: 'Control Room', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } })
    await ui.press({ key: 'tab-activity' })
    await w.clock.advance(300)
    await ui.press({ key: 'evidence-accept' })
    await w.clock.advance(300)
    await ui.redraw()
    expect(textOf(await ui.drawn())).not.toContain('verification stale')
    expect(w.kept.toasts.some(t => t.startsWith('Accepted "Fix the scheduler" as it is now'))).toBe(true)
  })
})
