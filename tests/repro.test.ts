/**
 * Real long-run failures, replayed against the Runtime as Claude Code raises them (each step's request, then its
 * answer; Sentinel's own prompts recognised by their text). Each test failed on 1.7.0, which this release fixes:
 *
 *   - the handoff notes existed, were written during the handoff and written again, and the check said "missing"
 *   - a fresh context was told it had hit its handoff threshold at the old context's ~701k tokens
 *   - a context window that changed under a model switch (1M → 200k) handed off at once, then again and again
 *   - handoff after handoff with no real growth burned through fresh contexts
 *   - `/cr fresh` refused notes written in this context ("no handoff is under way")
 *   - Keep warm stood down while the handoff only checked its notes
 *
 * Only the Runtime, the views and the fake host are used, so the file runs against an earlier Runtime too.
 */

import { describe, expect, test } from 'claude-code/testing'

import type { ToolCallResult } from 'claude-code'

import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { classicSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { fakeHost, flush } from './fixtures/fake-host'

type Started = Awaited<ReturnType<typeof started>>

async function started(patch: (s: Settings) => void, options: Parameters<typeof fakeHost>[0] = {}) {
  const f = fakeHost(options)
  const s = classicSettings()
  s.autopilot.enabled = true
  s.autopilot.thresholdMode = 'percent'
  s.autopilot.thresholdPercent = 70
  patch(s)
  f.kept.store['settings.v1'] = s
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: options.cwd ?? '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  // The session's own reading: a 1M window (Claude Code's status line figures).
  rt.onMeasure({ context: { tokens: 20_000, window: 1_000_000, percent: 2 }, cost: { usd: 0.1 }, changed: ['context'] })
  return { rt, ...f }
}

const usageOf = (tokens: number) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' })

/** One step as the engine raises it: its request (`turn.step` before `next`), then its answer. */
function stepAt(rt: Runtime, turnId: string, index: number, tokens: number, stop: 'tool_use' | 'end_turn'): void {
  const e = { turnId, index, model: 'claude-opus-5-5', messageCount: 3 }
  rt.stepRequest(e)
  rt.stepResponse(e, {}, { turnId, index, answer: '', toolUses: [], stopReason: stop, usage: usageOf(tokens) })
}

/** Claude's editing tool writes a file: the call, then its result. */
function writes(rt: Runtime, path: string, id: string): void {
  const input = { file_path: path, content: '# Next session\n\nContinue the work.' }
  void rt.beforeTool('Write', input, id, undefined)
  rt.afterTool('Write', input, id, { result: 'ok' } as ToolCallResult, undefined)
}

const framed = (text: string | undefined) => `The project-sentinel plugin sent a message:\n${text ?? ''}`
const count = (list: readonly string[], part: string): number => list.filter(t => t.includes(part)).length

let seq = 0

/**
 * A full automatic handoff: a turn crosses the threshold at `at` tokens, the handoff turn writes the notes
 * (at `notesPath`, the configured place when not given), the context is cleared, the continuation's turn begins.
 */
async function handOff(f: Started, at: number, notesPath = '/work/NEXT_SESSION_PROMPT.md'): Promise<void> {
  const { rt, kept, live, advance } = f
  const id = ++seq
  // This handoff's number in this test's own session (each test has its own host).
  const n = kept.commands.filter(c => c === 'clear').length + 1
  rt.onTurnStart({ turnId: `w${id}`, text: 'Work through the roadmap.' })
  stepAt(rt, `w${id}`, 0, at, 'tool_use')
  await flush()
  expect(rt.autopilot.state).toBe('pending')
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
  await advance(300)
  expect(rt.autopilot.state).toBe('requested')
  await rt.onTurnStart({ turnId: `h${id}`, text: framed(kept.submitted.at(-1)) })
  expect(rt.autopilot.state).toBe('handoff')
  writes(rt, notesPath, `write-${id}`)
  stepAt(rt, `h${id}`, 0, at + 5_000, 'end_turn')
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'handoff written' })
  await advance(2000)
  expect(kept.commands.filter(c => c === 'clear').length).toBe(n)
  live.sessionId = `S${n + 1}`
  await rt.onClassicSessionStart({ source: 'clear', sessionId: `S${n + 1}` })
  await advance(1000)
  const continuation = kept.submitted.at(-1) ?? ''
  expect(continuation).toContain('Context Autopilot continuation')
  await rt.onTurnStart({ turnId: `c${id}`, text: framed(continuation) })
  lastContinuation = `c${id}`
}

/** The continuation turn the last handOff began (its steps are that turn's). */
let lastContinuation = ''

/** The fresh context reads itself in and starts working (its milestones), then its turn ends: room counts from here. */
async function works(f: Started, tokens: number): Promise<void> {
  stepAt(f.rt, lastContinuation, 0, tokens, 'tool_use')
  f.rt.recordMilestones({ milestones: [{ title: 'Next milestone', status: 'in_progress' }] }, undefined)
  stepAt(f.rt, lastContinuation, 1, tokens + 2_000, 'end_turn')
  await f.rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'read in' })
  await f.advance(300)
}

describe('the fresh context never inherits the old context usage', () => {
  test('701k old context → clear → the stale 701k reading arrives → the continuation runs: no handoff', async () => {
    const f = await started(() => undefined)
    const { rt, kept, live } = f
    await handOff(f, 705_000)
    // Before any request of the fresh context: a late measurement of the old one. The status bar knows nothing yet.
    rt.onMeasure({ context: { tokens: 701_000, window: 1_000_000, percent: 70 }, cost: { usd: 3 }, changed: ['context'] })
    expect(Views.hudOf(rt).ctx.tokens).toBeNull()
    // The fresh context reads itself in and starts working.
    stepAt(rt, lastContinuation, 0, 30_000, 'tool_use')
    rt.recordMilestones({ milestones: [{ title: 'Pressure module', status: 'in_progress', doing: 'Writing it' }] }, undefined)
    // The old figure again, late (session.measure) and as the session's own reading at the turn's end.
    rt.onMeasure({ context: { tokens: 701_000, window: 1_000_000, percent: 70 }, cost: { usd: 3 }, changed: ['context'] })
    live.usage = { ...live.usage, context: { tokens: 701_000, window: 1_000_000, percent: 70 } }
    stepAt(rt, lastContinuation, 1, 32_000, 'end_turn')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'read in' })
    await f.advance(3000)
    expect(count(kept.submitted, 'final handoff for this context window')).toBe(1)
    expect(rt.autopilot.state).toBe('armed')
    expect(Views.hudOf(rt).ctx.tokens).toBe(32_000)
    expect(kept.traces.some(t => t.startsWith('context: set aside a session reading of 701000 tokens'))).toBe(true)
  })

  test('701k → clear → a real fresh 50k that grows normally hands off at the new threshold, once', async () => {
    const f = await started(() => undefined)
    const { rt, kept } = f
    await handOff(f, 705_000)
    stepAt(rt, lastContinuation, 0, 50_000, 'tool_use')
    rt.recordMilestones({ milestones: [{ title: 'Pressure module', status: 'in_progress' }] }, undefined)
    stepAt(rt, lastContinuation, 1, 52_000, 'end_turn')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'started' })
    await f.advance(500)
    expect(rt.autopilot.state).toBe('armed')
    // Real growth, measured by the context's own requests, across turns.
    rt.onTurnStart({ turnId: 'g1', text: 'Carry on.' })
    stepAt(rt, 'g1', 0, 400_000, 'tool_use')
    stepAt(rt, 'g1', 1, 690_000, 'tool_use')
    expect(rt.autopilot.state).toBe('armed')
    stepAt(rt, 'g1', 2, 702_000, 'tool_use')
    await flush()
    expect(rt.autopilot.state).toBe('pending')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'more done' })
    await f.advance(300)
    expect(count(kept.submitted, 'final handoff for this context window')).toBe(2)
    expect(rt.autopilot.lastError).toBeNull()
  })

  test('an answer to a request made before the clear, arriving after it, is not the fresh context’s size', async () => {
    const f = await started(() => undefined)
    const { rt } = f
    rt.onTurnStart({ turnId: 'w0', text: 'Work.' })
    // A request of the old context goes out ...
    const late = { turnId: 'w0', index: 0, model: 'claude-opus-5-5', messageCount: 3 }
    rt.stepRequest(late)
    // ... the person clears the context meanwhile ...
    f.live.sessionId = 'S2'
    await rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    // ... and its answer comes back afterwards.
    rt.stepResponse(late, {}, { turnId: 'w0', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: usageOf(701_000) })
    expect(Views.hudOf(rt).ctx.tokens).toBeNull()
    expect(rt.autopilot.state).toBe('armed')
  })
})

describe('the circuit breaker', () => {
  test('a third handoff into fresh contexts within minutes is refused: Handoff loop prevented, and the person chooses', async () => {
    const f = await started(() => undefined)
    const { rt, kept } = f
    // Each fresh context reads itself in, starts working, and fills again within minutes.
    await handOff(f, 705_000)
    await works(f, 40_000)
    await handOff(f, 710_000)
    await works(f, 40_000)
    await handOff(f, 715_000)
    await works(f, 40_000)
    // The fourth context fills as fast: refused, not a fourth handoff.
    rt.onTurnStart({ turnId: 'x1', text: 'Carry on.' })
    stepAt(rt, 'x1', 0, 790_000, 'tool_use')
    await flush()
    expect(rt.autopilot.state).toBe('awaiting')
    expect(rt.autopilot.lastError).toBe('handoff loop prevented')
    expect(count(kept.submitted, 'final handoff for this context window')).toBe(3)
    expect(kept.toasts.some(t => t.startsWith('Handoff loop prevented'))).toBe(true)
    expect(Views.hudOf(rt).alert?.text).toContain('Handoff loop prevented')
  })
})

describe('the context window sanity guard', () => {
  test('a switch that reports a 200k window under a 500k context does not hand off at once; the person chooses', async () => {
    const f = await started(() => undefined)
    const { rt, kept } = f
    rt.onTurnStart({ turnId: 't1', text: 'Work.' })
    stepAt(rt, 't1', 0, 500_000, 'tool_use')
    expect(rt.autopilot.state).toBe('armed')
    // The person switches to a model the host reports with a 200k window.
    rt.onPostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-fable-5-2', cache_ttl: '1h', source: 'sdk' })
    // A read of the session made before the switch answers late with the old window: the hold stands.
    f.live.usage = { ...f.live.usage, context: { tokens: 500_000, window: 1_000_000, percent: 50 } }
    rt.onMeasure({ context: { tokens: 500_000, window: 200_000, percent: 100 }, cost: { usd: 3 }, changed: ['context'] })
    stepAt(rt, 't1', 1, 505_000, 'tool_use')
    await flush()
    expect(rt.autopilot.state).toBe('armed')
    expect(count(kept.submitted, 'final handoff')).toBe(0)
    expect(kept.toasts.some(t => t.includes('Model window changed unexpectedly'))).toBe(true)
    expect(Views.hudOf(rt).alert?.text).toContain('Model window changed unexpectedly')
    // The person takes Claude Code's limit: Autopilot measures against it, and hands off at the next step.
    expect(rt.windowHold).not.toBeNull()
    rt.resolveWindowHold('accept')
    // Claude Code's next reading: the window it uses for this model.
    rt.onMeasure({ context: { tokens: 505_000, window: 200_000, percent: 100 }, cost: { usd: 3 }, changed: ['context'] })
    stepAt(rt, 't1', 2, 506_000, 'tool_use')
    await flush()
    expect(rt.autopilot.state).toBe('pending')
  })
})

describe('the handoff notes are judged where they really are', () => {
  test('a worktree session: Claude writes the notes in its working directory, not the stale copy at the session root; the handoff goes on', async () => {
    const f = await started(() => undefined, { cwd: '/repo', sessionCwd: '/repo/.claude/worktrees/w1' })
    const { rt, kept, live } = f
    live.workspace['/repo/NEXT_SESSION_PROMPT.md'] = { content: 'old notes', mtimeMs: f.now() - 3_600_000 }
    live.workspace['/repo/.claude/worktrees/w1/NEXT_SESSION_PROMPT.md'] = null
    rt.onTurnStart({ turnId: 't1', text: 'Work.' })
    stepAt(rt, 't1', 0, 705_000, 'tool_use')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await f.advance(300)
    await rt.onTurnStart({ turnId: 'h1', text: framed(kept.submitted.at(-1)) })
    live.workspace['/repo/.claude/worktrees/w1/NEXT_SESSION_PROMPT.md'] = { content: 'new notes', mtimeMs: f.now() }
    writes(rt, '/repo/.claude/worktrees/w1/NEXT_SESSION_PROMPT.md', 'wr1')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'handoff written' })
    await f.advance(2000)
    expect(count(kept.submitted, 'could not find an updated')).toBe(0)
    expect(kept.commands).toContain('clear')
    // The fresh context is pointed where the notes are.
    live.sessionId = 'S2'
    await rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    await f.advance(1000)
    expect(kept.submitted.at(-1)).toContain('/repo/.claude/worktrees/w1/NEXT_SESSION_PROMPT.md')
  })

  test('the file system’s clock runs behind: notes Claude wrote during the handoff count, whatever their time says', async () => {
    const f = await started(() => undefined)
    const { rt, kept, live } = f
    rt.onTurnStart({ turnId: 't1', text: 'Work.' })
    stepAt(rt, 't1', 0, 705_000, 'tool_use')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await f.advance(300)
    await rt.onTurnStart({ turnId: 'h1', text: framed(kept.submitted.at(-1)) })
    live.workspace['/work/NEXT_SESSION_PROMPT.md'] = { content: 'notes', mtimeMs: f.now() - 120_000 }
    writes(rt, '/work/NEXT_SESSION_PROMPT.md', 'wr1')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'handoff written' })
    await f.advance(2000)
    expect(count(kept.submitted, 'could not find an updated')).toBe(0)
    expect(kept.commands).toContain('clear')
  })

  test('asking again never moves the baseline: notes written before an interruption still count after /cr handoff', async () => {
    const f = await started(() => undefined)
    const { rt, kept, live } = f
    rt.onTurnStart({ turnId: 't1', text: 'Work.' })
    stepAt(rt, 't1', 0, 705_000, 'tool_use')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await f.advance(300)
    await rt.onTurnStart({ turnId: 'h1', text: framed(kept.submitted.at(-1)) })
    live.workspace['/work/NEXT_SESSION_PROMPT.md'] = { content: 'notes', mtimeMs: f.now() + 1 }
    writes(rt, '/work/NEXT_SESSION_PROMPT.md', 'wr1')
    // Interrupted before it ended: the handoff waits for the person.
    await rt.onTurnComplete({ agentId: undefined, reason: 'aborted', answer: '' })
    expect(rt.autopilot.state).toBe('awaiting')
    await f.advance(5 * 60_000)
    // The person asks again; Claude says the notes are already written and does not touch them.
    await rt.requestHandoff()
    await f.advance(300)
    await rt.onTurnStart({ turnId: 'h2', text: framed(kept.submitted.at(-1)) })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'The notes are already current.' })
    await f.advance(2000)
    expect(count(kept.submitted, 'could not find an updated')).toBe(0)
    expect(kept.commands).toContain('clear')
  })

  test('notes that cannot be inspected are not "missing": Claude is not asked to write them again, and the reason is said', async () => {
    const f = await started(() => undefined)
    const { rt, kept, live } = f
    live.statErrors['/work/NEXT_SESSION_PROMPT.md'] = 'EACCES: permission denied'
    rt.onTurnStart({ turnId: 't1', text: 'Work.' })
    stepAt(rt, 't1', 0, 705_000, 'tool_use')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await f.advance(300)
    await rt.onTurnStart({ turnId: 'h1', text: framed(kept.submitted.at(-1)) })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'handoff written' })
    await f.advance(4000)
    expect(count(kept.submitted, 'could not find an updated')).toBe(0)
    expect(kept.commands).not.toContain('clear')
    expect(rt.autopilot.state).toBe('awaiting')
    expect(rt.autopilot.lastError).toBe('handoff notes could not be inspected')
    expect(kept.toasts.some(t => t.includes('could not inspect the handoff notes') && t.includes('EACCES'))).toBe(true)
    expect(rt.autopilot.note).not.toContain('No handoff notes found')
  })

  test('Claude writes the notes after the handoff gave up on them: checked again at once, and the handoff goes on by itself', async () => {
    const f = await started(() => undefined)
    const { rt, kept, live } = f
    live.workspace['/work/NEXT_SESSION_PROMPT.md'] = null
    rt.onTurnStart({ turnId: 't1', text: 'Work.' })
    stepAt(rt, 't1', 0, 705_000, 'tool_use')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await f.advance(300)
    await rt.onTurnStart({ turnId: 'h1', text: framed(kept.submitted.at(-1)) })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'handoff written' })
    await f.advance(1000)
    // The retry: still nothing written.
    expect(count(kept.submitted, 'could not find an updated')).toBe(1)
    await rt.onTurnStart({ turnId: 'r1', text: framed(kept.submitted.at(-1)) })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await f.advance(1000)
    expect(rt.autopilot.state).toBe('awaiting')
    expect(kept.commands).not.toContain('clear')
    // The person asks Claude to write them; it does, in a turn of their own.
    rt.onTurnStart({ turnId: 'p1', text: 'Write the handoff notes please.' })
    live.workspace['/work/NEXT_SESSION_PROMPT.md'] = { content: 'notes', mtimeMs: f.now() }
    writes(rt, '/work/NEXT_SESSION_PROMPT.md', 'wr1')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Written.' })
    await f.advance(3000)
    expect(kept.commands).toContain('clear')
  })

  test('Windows: a write spelled in another case and with forward slashes is the same notes file', async () => {
    const f = await started(() => undefined, { cwd: 'C:\\proj' })
    const { rt, kept, live } = f
    rt.onTurnStart({ turnId: 't1', text: 'Work.' })
    stepAt(rt, 't1', 0, 705_000, 'tool_use')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await f.advance(300)
    await rt.onTurnStart({ turnId: 'h1', text: framed(kept.submitted.at(-1)) })
    // The file system's time lags; the write is Claude's own.
    live.workspace['C:\\proj\\NEXT_SESSION_PROMPT.md'] = { content: 'notes', mtimeMs: f.now() - 600_000 }
    writes(rt, 'c:/proj/next_session_prompt.md', 'wr1')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'handoff written' })
    await f.advance(2000)
    expect(count(kept.submitted, 'could not find an updated')).toBe(0)
    expect(kept.commands).toContain('clear')
  })

  test('POSIX: another case is another file; the retry names the exact path Sentinel checks', async () => {
    const f = await started(() => undefined, { cwd: '/home/u/proj' })
    const { rt, kept, live } = f
    live.workspace['/home/u/proj/NEXT_SESSION_PROMPT.md'] = { content: 'old', mtimeMs: f.now() - 3_600_000 }
    rt.onTurnStart({ turnId: 't1', text: 'Work.' })
    stepAt(rt, 't1', 0, 705_000, 'tool_use')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await f.advance(300)
    await rt.onTurnStart({ turnId: 'h1', text: framed(kept.submitted.at(-1)) })
    writes(rt, '/home/u/proj/next_session_prompt.md', 'wr1')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'handoff written' })
    await f.advance(1000)
    const retry = kept.submitted.find(t => t.includes('could not find an updated')) ?? ''
    expect(retry).toContain('`/home/u/proj/NEXT_SESSION_PROMPT.md`')
    expect(retry).toContain('not changed after this handoff began')
  })
})

describe('one truth for /cr fresh, /cr handoff and the panel', () => {
  test('notes written in this context: /cr fresh starts the fresh context instead of asking for another handoff', async () => {
    const f = await started(() => undefined)
    const { rt, kept, live } = f
    rt.onTurnStart({ turnId: 't1', text: 'Write the handoff notes, then I will start fresh.' })
    stepAt(rt, 't1', 0, 300_000, 'tool_use')
    live.workspace['/work/NEXT_SESSION_PROMPT.md'] = { content: 'notes', mtimeMs: f.now() }
    writes(rt, '/work/NEXT_SESSION_PROMPT.md', 'wr1')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Written.' })
    expect(rt.autopilot.state).toBe('armed')
    const said = await rt.startFreshContext()
    expect(said).toBe('Handoff notes written in this context are valid. Starting the fresh context.')
    await f.advance(2000)
    expect(kept.commands).toContain('clear')
    expect(count(kept.submitted, 'final handoff')).toBe(0)
  })
})

describe('Keep warm while a handoff only waits', () => {
  test('every waiting step keeps the cache warm; only the clear itself stands it down', async () => {
    const f = await started(() => undefined)
    const { rt } = f
    for (const state of ['pending', 'requested', 'handoff', 'waiting-background', 'verifying', 'awaiting'] as const) {
      rt.autopilot = { ...rt.autopilot, state }
      expect(rt.keepWarmStandDown()).toBeNull()
    }
    rt.autopilot = { ...rt.autopilot, state: 'clearing' }
    expect(rt.keepWarmStandDown()).not.toBeNull()
  })
})
