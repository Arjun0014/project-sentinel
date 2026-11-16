import { describe, expect, test } from 'claude-code/testing'

import * as Epoch from '../hooks/features/contextEpoch'
import * as Artifact from '../hooks/features/handoffArtifact'
import { type Autopilot, type AutopilotConfig, type AutopilotEvent, LOOP_ERROR, NOTES_ERROR, NOTES_UNINSPECTABLE, initialAutopilot, loopReason, recordOf, recover, step } from '../hooks/features/autopilot'

describe('context epochs', () => {
  test('a new context is unknown until a request made in it is answered; the old context’s last figure is its echo', () => {
    let ep = Epoch.firstEpoch('startup', 0)
    ep = Epoch.stepReading(ep, { epochId: ep.id, tokens: 701_000, at: 1 }).epoch
    expect(Epoch.trustedTokens(ep)).toBe(701_000)
    const fresh = Epoch.nextEpoch(ep, 'handoff', 2)
    expect(fresh.previous?.tokens).toBe(701_000)
    expect(Epoch.trustedTokens(fresh)).toBeNull()
    expect(Epoch.shownTokens(fresh)).toEqual({ tokens: null, isProvisional: false })
    // The old figure, late: rejected as the previous context's.
    const echo = Epoch.sessionReading(fresh, { tokens: 700_500, window: 1_000_000, at: 3 })
    expect(echo.accepted).toBe(false)
    expect(echo.why).toContain("previous context's last reading")
    expect(echo.epoch.rejected).toBe(1)
    // Another unproven figure: held aside, never acted on (and not shown after a boundary).
    const other = Epoch.sessionReading(echo.epoch, { tokens: 45_000, window: 1_000_000, at: 4 })
    expect(other.accepted).toBe(false)
    expect(other.epoch.provisional?.tokens).toBe(45_000)
    expect(Epoch.trustedTokens(other.epoch)).toBeNull()
    expect(Epoch.shownTokens(other.epoch).tokens).toBeNull()
    // The fresh context's own request proves it: its baseline.
    const proven = Epoch.stepReading(other.epoch, { epochId: fresh.id, tokens: 48_000, at: 5 })
    expect(proven.accepted).toBe(true)
    expect(proven.epoch.baseline).toBe(48_000)
    expect(Epoch.trustedTokens(proven.epoch)).toBe(48_000)
    expect(Epoch.isAfterHandoff(proven.epoch)).toBe(true)
  })

  test('a request made before a boundary, answered after it, is not the new context’s', () => {
    const old = Epoch.firstEpoch('startup', 0)
    const fresh = Epoch.nextEpoch(old, 'clear', 1)
    const v = Epoch.stepReading(fresh, { epochId: old.id, tokens: 701_000, at: 2 })
    expect(v.accepted).toBe(false)
    expect(v.why).toBe(`a request made in context ${old.id}, answered after the boundary`)
    // A request whose start this runtime never saw counts only in the context a reload began (no boundary there).
    expect(Epoch.stepReading(fresh, { epochId: null, tokens: 50_000, at: 3 }).accepted).toBe(false)
    expect(Epoch.stepReading(Epoch.firstEpoch('reload', 0), { epochId: null, tokens: 50_000, at: 3 }).accepted).toBe(true)
  })

  test('once proven, a session-level figure never moves it, up or down; a far one is counted as foreign', () => {
    let ep = Epoch.firstEpoch('startup', 0)
    ep = Epoch.stepReading(ep, { epochId: ep.id, tokens: 120_000, at: 1 }).epoch
    const lower = Epoch.sessionReading(ep, { tokens: 10_000, window: 1_000_000, at: 2 })
    expect(Epoch.trustedTokens(lower.epoch)).toBe(120_000)
    expect(lower.epoch.rejected).toBe(1)
    const echo = Epoch.sessionReading(ep, { tokens: 119_000, window: 1_000_000, at: 2 })
    expect(echo.accepted).toBe(false)
    expect(echo.epoch.rejected).toBe(0)
    expect(echo.epoch.window).toBe(1_000_000)
    const higher = Epoch.sessionReading(ep, { tokens: 701_000, window: 1_000_000, at: 2 })
    expect(Epoch.trustedTokens(higher.epoch)).toBe(120_000)
    expect(higher.epoch.lastRejected).toContain('not this context')
  })

  test('the engine’s own count proves a context at once: a compaction’s, a resumed transcript’s; the window carries over', () => {
    let ep = Epoch.firstEpoch('startup', 0)
    ep = Epoch.sessionReading(ep, { tokens: undefined, window: 1_000_000, at: 0 }).epoch
    const compacted = Epoch.nextEpoch(ep, 'compact', 1, { tokens: 52_000, via: 'compaction' })
    expect(Epoch.trustedTokens(compacted)).toBe(52_000)
    expect(compacted.current?.via).toBe('compaction')
    expect(compacted.window).toBe(1_000_000)
    const resumed = Epoch.nextEpoch(ep, 'resume', 1, { tokens: 616_000, via: 'resume' })
    expect(resumed.current?.via).toBe('resume')
    expect(Epoch.nextEpoch(ep, 'compact', 1, { tokens: 0 }).isResolved).toBe(false)
  })

  test('after a reload (no boundary), the session’s figure is shown, marked, and still never acted on', () => {
    const ep = Epoch.sessionReading(Epoch.firstEpoch('reload', 0), { tokens: 300_000, window: 1_000_000, at: 1 }).epoch
    expect(Epoch.shownTokens(ep)).toEqual({ tokens: 300_000, isProvisional: true })
    expect(Epoch.trustedTokens(ep)).toBeNull()
    expect(Epoch.turnEnded(Epoch.turnEnded(ep)).turns).toBe(2)
    expect(Epoch.growthOf(ep)).toBeNull()
  })

  test('the window sanity check: a shrink that would hand off at once, or a context larger than its window; never a boundary or a harmless change', () => {
    const base = { modelBefore: 'claude-opus-5-5', modelAfter: 'claude-fable-5-2', at: 9, hostVersion: '2.1.300', isNewContext: false }
    expect(Epoch.windowAnomaly({ ...base, before: 1_000_000, after: 200_000, tokens: 500_000, threshold: 140_000 })?.why).toBe('over')
    expect(Epoch.windowAnomaly({ ...base, before: 1_000_000, after: 200_000, tokens: 150_000, threshold: 140_000 })?.why).toBe('shrank')
    expect(Epoch.windowAnomaly({ ...base, before: 1_000_000, after: 200_000, tokens: 90_000, threshold: 140_000 })).toBeNull()
    expect(Epoch.windowAnomaly({ ...base, before: 1_000_000, after: 900_000, tokens: 800_000, threshold: 630_000 })).toBeNull()
    expect(Epoch.windowAnomaly({ ...base, before: 1_000_000, after: 200_000, tokens: 150_000, threshold: 140_000, isNewContext: true })).toBeNull()
    expect(Epoch.windowAnomaly({ ...base, before: null, after: 200_000, tokens: 150_000, threshold: 140_000 })).toBeNull()
    const a = Epoch.windowAnomaly({ ...base, before: 1_000_000, after: 200_000, tokens: 150_000, threshold: 140_000 })!
    expect(Epoch.anomalyText(a)).toBe('The context window changed from 1M (claude-opus-5-5) to 200k for claude-fable-5-2 with 150k in this context')
  })
})

describe('the handoff notes verdict', () => {
  const ci = true
  const file = 'NEXT_SESSION_PROMPT.md'
  const probe = (path: string, over: Partial<Extract<Artifact.NotesProbe, { ok: true }>> = {}): Artifact.NotesProbe => ({ path, via: 'configured', ok: true, kind: 'file', size: 4000, mtimeMs: 100, realPath: null, ...over })
  const missing = (path: string): Artifact.NotesProbe => ({ path, via: 'working directory', ok: false, isMissing: true, error: 'ENOENT' })
  const judge = (over: Partial<Parameters<typeof Artifact.judge>[0]>) => Artifact.judge({ file, probes: [], writes: [], since: 100_000, baseline: null, isCaseInsensitive: ci, now: 200_000, ...over })

  test('paths: joined in the root’s own separator, compared without case where the system ignores it, matched by their tail', () => {
    expect(Artifact.joinPath('C:\\proj\\', file)).toBe('C:\\proj\\NEXT_SESSION_PROMPT.md')
    expect(Artifact.joinPath('/home/u/proj', 'docs/next.md')).toBe('/home/u/proj/docs/next.md')
    expect(Artifact.normPath('\\\\?\\C:\\Proj\\NEXT_SESSION_PROMPT.md', true)).toBe('c:/proj/next_session_prompt.md')
    expect(Artifact.isNotesPath('c:/proj/next_session_prompt.md', file, true)).toBe(true)
    expect(Artifact.isNotesPath('/home/u/proj/next_session_prompt.md', file, false)).toBe(false)
    expect(Artifact.isNotesPath('/home/u/proj/docs/NEXT.md', 'docs/NEXT.md', false)).toBe(true)
    expect(Artifact.isNotesPath('/home/u/proj/NEXT.md', 'docs/NEXT.md', false)).toBe(false)
  })

  test('a shell command that writes the notes is a hint; one that reads them is not', () => {
    expect(Artifact.shellWritesNotes(`cat > NEXT_SESSION_PROMPT.md <<'EOF'`, file)).toBe(true)
    expect(Artifact.shellWritesNotes('echo done >> ./NEXT_SESSION_PROMPT.md', file)).toBe(true)
    expect(Artifact.shellWritesNotes('cp /tmp/n.md NEXT_SESSION_PROMPT.md', file)).toBe(true)
    expect(Artifact.shellWritesNotes(`python -c "open('NEXT_SESSION_PROMPT.md','w').write(x)"`, file)).toBe(true)
    expect(Artifact.shellWritesNotes('cat NEXT_SESSION_PROMPT.md', file)).toBe(false)
    expect(Artifact.shellWritesNotes('git add NEXT_SESSION_PROMPT.md && git commit -m notes', file)).toBe(false)
  })

  test('the places looked at: the configured one first, then the others, then where Claude wrote it; no duplicates', () => {
    const c = Artifact.candidatesOf({
      file,
      roots: [
        { path: 'C:\\repo', via: 'configured' },
        { path: 'C:\\repo\\.claude\\worktrees\\w1', via: 'working directory' },
        { path: 'c:\\REPO', via: 'repository root' },
        { path: null, via: 'root at load' },
      ],
      writes: [{ path: 'D:\\elsewhere\\NEXT_SESSION_PROMPT.md', at: 5, tool: 'Write', isCertain: true }, { path: 'notes.txt', at: 6, tool: 'Write', isCertain: true }],
      isCaseInsensitive: true,
    })
    expect(c).toEqual([
      { path: 'C:\\repo\\NEXT_SESSION_PROMPT.md', via: 'configured' },
      { path: 'C:\\repo\\.claude\\worktrees\\w1\\NEXT_SESSION_PROMPT.md', via: 'working directory' },
      { path: 'D:\\elsewhere\\NEXT_SESSION_PROMPT.md', via: 'written by Claude' },
    ])
    expect(Artifact.candidatesOf({ file: '/abs/NOTES.md', roots: [{ path: '/repo', via: 'configured' }], writes: [], isCaseInsensitive: false })).toEqual([{ path: '/abs/NOTES.md', via: 'configured' }])
  })

  test('a project nested inside another repository: the outer repository’s notes are another project’s, never looked at', () => {
    const c = Artifact.candidatesOf({
      file,
      roots: [
        { path: 'C:\\outer\\packages\\app', via: 'configured' },
        { path: 'C:\\outer\\packages\\app', via: 'working directory' },
        { path: 'C:\\Outer', via: 'repository root' },
      ],
      writes: [],
      isCaseInsensitive: true,
    })
    expect(c).toEqual([{ path: 'C:\\outer\\packages\\app\\NEXT_SESSION_PROMPT.md', via: 'configured' }])
    // Claude writing the notes up there is still followed: its own write is a candidate of its own.
    const w = Artifact.candidatesOf({ file, roots: [{ path: '/repo/app', via: 'configured' }, { path: '/repo', via: 'repository root' }], writes: [{ path: '/repo/NEXT_SESSION_PROMPT.md', at: 5, tool: 'Write', isCertain: true }], isCaseInsensitive: false })
    expect(w.map(x => x.via)).toEqual(['configured', 'written by Claude'])
    // A repository root that is the project, or a worktree elsewhere, stays a place to look.
    expect(Artifact.candidatesOf({ file, roots: [{ path: '/repo/app', via: 'configured' }, { path: '/elsewhere/wt', via: 'repository root' }], writes: [], isCaseInsensitive: false }).map(x => x.via)).toEqual(['configured', 'repository root'])
  })

  test('missing is only "no such file": any other failure is "could not inspect", even beside a missing place', () => {
    expect(Artifact.isMissingError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true)
    expect(Artifact.isMissingError(new Error('ENOENT: no such file or directory'))).toBe(true)
    expect(Artifact.isMissingError(new Error('EACCES: permission denied'))).toBe(false)
    expect(Artifact.isMissingError(new Error('EBUSY: resource busy or locked'))).toBe(false)
    expect(judge({ probes: [missing('/a/NEXT_SESSION_PROMPT.md')] }).state).toBe('missing')
    const v = judge({ probes: [missing('/a/NEXT_SESSION_PROMPT.md'), { path: '/b/NEXT_SESSION_PROMPT.md', via: 'repository root', ok: false, isMissing: false, error: 'EACCES' }] })
    expect(v.state).toBe('uninspectable')
    expect(v.reason).toBe('/b/NEXT_SESSION_PROMPT.md could not be inspected (EACCES)')
    expect(judge({ probes: [probe('/a/NEXT_SESSION_PROMPT.md', { kind: 'dir' })] }).reason).toBe('/a/NEXT_SESSION_PROMPT.md is not a file')
  })

  test('three proofs a file is this handoff’s: Claude’s write, a change since the handoff began, its time', () => {
    const p = probe('/a/NEXT_SESSION_PROMPT.md', { mtimeMs: 50_000 })
    // No proof: stale.
    expect(judge({ probes: [p] }).state).toBe('stale')
    // A write seen after the baseline (its own clock may lag): valid.
    expect(judge({ probes: [p], writes: [{ path: '/A/next_session_prompt.md', at: 150_000, tool: 'Edit', isCertain: true }] })).toMatchObject({ state: 'valid', proof: 'write' })
    // A shell command's hint is not proof.
    expect(judge({ probes: [p], writes: [{ path: '/a/NEXT_SESSION_PROMPT.md', at: 150_000, tool: 'Bash', isCertain: false }] }).state).toBe('stale')
    // Changed since the snapshot taken as the handoff began: created, resized, retouched, or new content.
    const base = (over: Partial<Artifact.NotesBaseline>): Artifact.NotesBaseline[] => [{ path: '/a/NEXT_SESSION_PROMPT.md', exists: true, size: 4000, mtimeMs: 50_000, blob: 'a'.repeat(40), at: 90_000, ...over }]
    expect(judge({ probes: [p], baseline: base({ exists: false, size: null, mtimeMs: null, blob: null }) }).reason).toBe('created since the handoff began')
    expect(judge({ probes: [p], baseline: base({ size: 3000 }) }).proof).toBe('changed')
    expect(judge({ probes: [p], baseline: base({ mtimeMs: 40_000 }) }).proof).toBe('changed')
    expect(judge({ probes: [p], baseline: base({}), blobs: new Map([['/a/next_session_prompt.md', 'b'.repeat(40)]]) }).reason).toBe('its content changed since the handoff began')
    expect(judge({ probes: [p], baseline: base({}), blobs: new Map([['/a/next_session_prompt.md', 'a'.repeat(40)]]) }).state).toBe('stale')
    // Its time, with a little slack for clocks.
    expect(judge({ probes: [probe('/a/NEXT_SESSION_PROMPT.md', { mtimeMs: 100_000 - 4_000 })] }).proof).toBe('time')
    // No handoff under way: present; empty is empty.
    expect(judge({ probes: [p], since: null }).state).toBe('present')
    expect(judge({ probes: [probe('/a/NEXT_SESSION_PROMPT.md', { size: 0 })] }).state).toBe('empty')
  })

  test('the best place wins: valid notes elsewhere beat a stale copy at the configured path', () => {
    const v = judge({
      probes: [probe('/repo/NEXT_SESSION_PROMPT.md', { mtimeMs: 10_000 }), { ...probe('/repo/wt/NEXT_SESSION_PROMPT.md', { mtimeMs: 150_000 }), via: 'working directory' }],
    })
    expect(v).toMatchObject({ state: 'valid', path: '/repo/wt/NEXT_SESSION_PROMPT.md', via: 'working directory', proof: 'time' })
    expect(Artifact.probeLines(v, 100_000)[1]).toContain('[working directory]: file 4000 B')
    expect(Artifact.iso(Number.NaN)).toBe('NaN')
  })
})

describe('the machine: the notes baseline, the verdicts, the circuit breaker', () => {
  const CFG: AutopilotConfig = { continuation: 'clear', fallbackToCompact: true, autoContinue: true }
  const armed = (): Autopilot => step(initialAutopilot(), { kind: 'configure', enabled: true, threshold: 700_000, isClamped: false }, CFG).model
  const run = (model: Autopilot, events: AutopilotEvent[]): Autopilot => events.reduce((m, e) => step(m, e, CFG).model, model)

  test('the baseline is the handoff’s first turn; a restart after an interruption keeps it; a new handoff starts its own', () => {
    const first = run(armed(), [{ kind: 'manualHandoff', now: 1 }, { kind: 'handoffStarted', now: 10 }])
    expect(first.handoffSince).toBe(10)
    const interrupted = run(first, [{ kind: 'turnComplete', reason: 'aborted', turn: 'handoff', now: 20 }])
    expect(interrupted.state).toBe('awaiting')
    const again = run(interrupted, [{ kind: 'manualHandoff', now: 300 }, { kind: 'handoffStarted', now: 310 }])
    expect(again.handoffSince).toBe(10)
    // A retry (notes not found) keeps it too.
    const retried = run(again, [{ kind: 'turnComplete', reason: 'answer', turn: 'handoff', now: 320, background: [] }, { kind: 'handoffVerified', isOk: false, now: 321, state: 'stale' }])
    expect(retried.state).toBe('handoff')
    expect(retried.handoffSince).toBe(10)
    // Snoozed: over; the next handoff counts from its own first turn.
    const snoozed = run(interrupted, [{ kind: 'snooze', tokens: 710_000, window: 1_000_000 }])
    expect(snoozed.handoffSince).toBeNull()
    expect(run(snoozed, [{ kind: 'manualHandoff', now: 900 }, { kind: 'handoffStarted', now: 905 }]).handoffSince).toBe(905)
  })

  test('notes that could not be inspected: the context is kept and Claude is not asked to write them; a later valid look goes on', () => {
    const verifying = run(armed(), [{ kind: 'manualHandoff', now: 1 }, { kind: 'handoffStarted', now: 2 }, { kind: 'turnComplete', reason: 'answer', turn: 'handoff', now: 3, background: [] }])
    expect(verifying.state).toBe('verifying')
    const r = step(verifying, { kind: 'handoffVerified', isOk: false, now: 4, state: 'uninspectable', reason: 'EACCES' }, CFG)
    expect(r.model).toMatchObject({ state: 'awaiting', lastError: NOTES_UNINSPECTABLE })
    expect(r.effects.some(e => e.kind === 'submitRetry')).toBe(false)
    expect(r.effects.some(e => e.kind === 'notify' && e.text.includes('could not inspect the handoff notes: EACCES'))).toBe(true)
    expect(step(r.model, { kind: 'notesRevalidated', now: 5 }, CFG)).toMatchObject({ model: { state: 'clearing', lastError: null }, effects: [{ kind: 'clear' }] })
    // Missing twice: kept; Claude writing them later goes on by itself.
    const missingTwice = run(verifying, [{ kind: 'handoffVerified', isOk: false, now: 4, state: 'missing' }, { kind: 'turnComplete', reason: 'answer', turn: 'retry', now: 5, background: [] }, { kind: 'handoffVerified', isOk: false, now: 6, state: 'missing' }])
    expect(missingTwice).toMatchObject({ state: 'awaiting', lastError: NOTES_ERROR, note: 'No handoff notes found, so the context was kept' })
    expect(step(missingTwice, { kind: 'notesRevalidated', now: 7 }, CFG).model.state).toBe('clearing')
    // Only a handoff that gave up on its notes: never one waiting for the person for another reason.
    const stale = run(verifying, [{ kind: 'handoffVerified', isOk: false, now: 4, state: 'stale' }, { kind: 'turnComplete', reason: 'answer', turn: 'retry', now: 5, background: [] }, { kind: 'handoffVerified', isOk: false, now: 6, state: 'stale' }])
    expect(stale.note).toBe('The handoff notes were not updated, so the context was kept')
    expect(step(armed(), { kind: 'notesRevalidated', now: 1 }, CFG).effects).toEqual([])
  })

  test('the circuit breaker: too many handoffs into fresh contexts, or a fresh context at the point within a turn or two without growing', () => {
    const m = armed()
    expect(loopReason(m, 720_000, { turns: 5, baseline: 40_000, isAfterHandoff: true, recentHandoffs: 3 })).toBe('3 handoffs into fresh contexts in the last 30 minutes')
    expect(loopReason(m, 720_000, { turns: 1, baseline: 701_000, isAfterHandoff: true, recentHandoffs: 1 })).toContain('after 1 turn, growing 19k from 701k')
    expect(loopReason(m, 720_000, { turns: 0, baseline: null, isAfterHandoff: true, recentHandoffs: 1 })).toContain('with no proven starting size')
    // Real growth, or a context not opened by a handoff, or later turns: no loop.
    expect(loopReason(m, 720_000, { turns: 1, baseline: 40_000, isAfterHandoff: true, recentHandoffs: 1 })).toBeNull()
    expect(loopReason(m, 720_000, { turns: 1, baseline: 701_000, isAfterHandoff: false, recentHandoffs: 0 })).toBeNull()
    expect(loopReason(m, 720_000, { turns: 3, baseline: 701_000, isAfterHandoff: true, recentHandoffs: 1 })).toBeNull()
    expect(loopReason(m, 720_000, undefined)).toBeNull()
    // The machine: refused, waiting for the person; Recheck watches again; a record carries it across a reload.
    const held = step(m, { kind: 'context', tokens: 720_000, window: 1_000_000, isInTurn: true, now: 9, epoch: { turns: 5, baseline: 40_000, isAfterHandoff: true, recentHandoffs: 3 } }, CFG)
    expect(held.model).toMatchObject({ state: 'awaiting', lastError: LOOP_ERROR, note: 'Handoff loop prevented', loop: { at: 9 } })
    expect(held.effects.some(e => e.kind === 'submitHandoff')).toBe(false)
    const record = recordOf(held.model, 'S1', 10)!
    expect(recover(armed(), record, { sessionId: 'S1' }).model.loop).toEqual(held.model.loop)
    expect(step(held.model, { kind: 'loopRecheck' }, CFG).model).toMatchObject({ state: 'armed', loop: null, lastError: null })
    // A manual handoff after a loop is the person's own: a new one.
    expect(step(held.model, { kind: 'manualHandoff', now: 20 }, CFG).model).toMatchObject({ state: 'requested', loop: null, handoffSince: null })
  })
})
