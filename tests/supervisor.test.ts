/**
 * The handoff's background work, its supervisor and the person's ways out, as Claude Code raises them:
 * a multi-hour render across three contexts, a confirmed fresh start from notes Sentinel could not verify,
 * what the supervisor says happens next, and the session-only Autopilot and window commands.
 */

import { describe, expect, test } from 'claude-code/testing'

import type { ToolCallResult } from 'claude-code'

import { Runtime } from '../hooks/app/runtime'
import { classicSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { diagnose } from '../hooks/features/supervisor'
import { fakeHost, flush } from './fixtures/fake-host'

type Started = Awaited<ReturnType<typeof started>>

async function started(patch: (s: Settings) => void = () => undefined, options: Parameters<typeof fakeHost>[0] = {}) {
  const f = fakeHost(options)
  const s = classicSettings()
  s.autopilot.enabled = true
  s.autopilot.thresholdMode = 'percent'
  s.autopilot.thresholdPercent = 70
  patch(s)
  f.kept.store['settings.v1'] = s
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  rt.onMeasure({ context: { tokens: 20_000, window: 1_000_000, percent: 2 }, cost: { usd: 0.1 }, changed: ['context'] })
  return { rt, ...f }
}

const usageOf = (tokens: number) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' })

function stepAt(rt: Runtime, turnId: string, index: number, tokens: number, stop: 'tool_use' | 'end_turn'): void {
  const e = { turnId, index, model: 'claude-opus-5-5', messageCount: 3 }
  rt.stepRequest(e)
  rt.stepResponse(e, {}, { turnId, index, answer: '', toolUses: [], stopReason: stop, usage: usageOf(tokens) })
}

function writesNotes(rt: Runtime, id: string): void {
  const input = { file_path: '/work/NEXT_SESSION_PROMPT.md', content: '# Next session' }
  void rt.beforeTool('Write', input, id, undefined)
  rt.afterTool('Write', input, id, { result: 'ok' } as ToolCallResult, undefined)
}

const framed = (text: string | undefined) => `The project-sentinel plugin sent a message:\n${text ?? ''}`
const count = (list: readonly string[], part: string): number => list.filter(t => t.includes(part)).length

const RENDER = { id: 'r4k', type: 'shell', description: 'Render the 4K master', command: 'blender -b film.blend -a' }
const VITE = { id: 'vite1', type: 'shell', description: 'Vite preview server', command: 'npx vite preview --port 4181' }

let turnSeq = 0

/** A turn crosses the threshold; the handoff turn writes the notes and stops with `background` still running. */
async function handoffTurn(f: Started, background: (typeof RENDER)[]): Promise<void> {
  const { rt, kept } = f
  const n = ++turnSeq
  rt.onTurnStart({ turnId: `w${n}`, text: 'Carry on with the film.' })
  stepAt(rt, `w${n}`, 0, 705_000, 'tool_use')
  await rt.onStop({ stopHookActive: false, lastMessage: 'Step done.', background, wakeups: [], permissionMode: undefined })
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Step done.' })
  await f.advance(300)
  await rt.onTurnStart({ turnId: `h${n}`, text: framed(kept.submitted.at(-1)) })
  writesNotes(rt, `wn${n}`)
  stepAt(rt, `h${n}`, 0, 706_000, 'end_turn')
  await rt.onStop({ stopHookActive: false, lastMessage: 'Handoff written.', background, wakeups: [], permissionMode: undefined })
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Handoff written.' })
}

/** Time passes until Project Sentinel's own /clear runs (at most `ms`), as the engine would let it. */
async function untilCleared(f: Started, ms: number): Promise<void> {
  const before = f.kept.commands.filter(c => c === 'clear').length
  for (let t = 0; t < ms && f.kept.commands.filter(c => c === 'clear').length === before; t += 500) await f.advance(500)
}

/** The clear goes through (its fresh session's start reported right away) and the continuation begins. */
async function freshContext(f: Started, sessionId: string): Promise<string> {
  const { rt, kept, live } = f
  await untilCleared(f, 5_000)
  live.sessionId = sessionId
  await rt.onClassicSessionStart({ source: 'clear', sessionId })
  const block = rt.takeFreshContext() ?? ''
  await f.advance(1000)
  const n = ++turnSeq
  await rt.onTurnStart({ turnId: `c${n}`, text: framed(kept.submitted.at(-1)) })
  stepAt(rt, `c${n}`, 0, 40_000, 'tool_use')
  rt.recordMilestones({ milestones: [{ title: 'Grade the film', status: 'in_progress' }] }, undefined)
  stepAt(rt, `c${n}`, 1, 42_000, 'end_turn')
  await rt.onStop({ stopHookActive: false, lastMessage: 'Picked up.', background: [], wakeups: [], permissionMode: undefined })
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Picked up.' })
  return block
}

describe('work that outlives a context', () => {
  test('a multi-hour render: the first handoff waits its patience, then leaves it running; no later handoff waits for it again; its end, two contexts later, is recorded where it arrived', { timeoutMs: 30_000 }, async () => {
    const f = await started()
    const { rt, kept } = f
    await handoffTurn(f, [RENDER, VITE])
    expect(rt.autopilot.state).toBe('waiting-background')
    // The server is never waited for; the render is, for 20 minutes at most. Keep warm holds the cache meanwhile.
    expect(rt.autopilot.background.map(t => `${t.id}:${t.class}`)).toEqual(['r4k:finite', 'vite1:persistent'])
    expect(rt.keepWarmStandDown()).toBeNull()
    // Twenty minutes later the wait's patience is over: the supervisor moves it on, leaving the render running.
    await f.advance(20 * 60_000)
    await untilCleared(f, 3 * 60_000)
    expect(kept.commands).toContain('clear')
    const block2 = await freshContext(f, 'S2')
    expect(block2).toContain('Render the 4K master')
    expect(block2).toContain('Vite preview server')
    expect(rt.run?.dependencies?.map(d => `${d.id}:${d.class}:${d.fromSession}:${d.endedAt === null ? 'running' : 'ended'}`)).toEqual(['r4k:finite:1:running', 'vite1:persistent:1:running'])

    // Half an hour of work later the context fills again; the render still runs: this handoff does not wait for it.
    await f.advance(31 * 60_000)
    await handoffTurn(f, [RENDER, VITE])
    expect(rt.autopilot.state).not.toBe('waiting-background')
    const block3 = await freshContext(f, 'S3')
    expect(block3).toContain('Render the 4K master (since session 1)')
    expect(count(kept.submitted, 'Context Autopilot continuation')).toBe(2)

    // The render ends in session 3: Claude Code's notification, delivered here, closes the dependency.
    rt.onPromptSubmit('<task-notification>\n<task-id>r4k</task-id>\n<status>completed</status>\n<summary>Render finished</summary>\n</task-notification>', { kind: 'task-notification' })
    const render = rt.run?.dependencies?.find(d => d.id === 'r4k')
    expect(render).toMatchObject({ fromSession: 1, status: 'completed', endedIn: 3 })
    expect(rt.run?.dependencies?.find(d => d.id === 'vite1')?.endedAt).toBeNull()
  })
})

describe('the person’s ways out', () => {
  /** A handoff whose notes could not be inspected: the context kept, waiting for the person. */
  async function uninspectable(answer: string | null, surfaces?: string[]): Promise<Started> {
    const f = await started()
    if (surfaces !== undefined) f.rt.surfaces = surfaces as never
    f.live.statErrors['/work/NEXT_SESSION_PROMPT.md'] = 'EBUSY: resource busy or locked'
    await handoffTurn(f, [])
    await f.advance(4000)
    expect(f.rt.autopilot.lastError).toBe('handoff notes could not be inspected')
    f.live.answer = answer
    return f
  }

  test('/cr fresh force: what it means is said and asked; Start fresh anyway clears once', async () => {
    const f = await uninspectable('Start fresh anyway')
    const plain = await f.rt.startFreshContext()
    expect(plain).toContain('could not inspect the handoff notes: /work/NEXT_SESSION_PROMPT.md could not be inspected (EBUSY')
    expect(plain).toContain('/cr fresh force')
    expect(f.kept.commands).not.toContain('clear')
    const said = (await f.rt.runCommand('fresh force')).text ?? ''
    expect(f.kept.asked.at(-1)?.question).toContain('could not inspect the handoff notes: /work/NEXT_SESSION_PROMPT.md could not be inspected (EBUSY')
    expect(f.kept.asked.at(-1)?.options).toEqual(['Start fresh anyway', 'Keep this context'])
    expect(said).toContain('Starting the fresh context')
    await f.advance(2000)
    expect(f.kept.commands.filter(c => c === 'clear').length).toBe(1)
  })

  test('Keep this context: nothing is cleared; with nobody to ask (headless), nothing is cleared either', async () => {
    const kept = await uninspectable('Keep this context')
    expect(await kept.rt.forceFresh()).toBe('Nothing was cleared: this context is kept.')
    await kept.advance(2000)
    expect(kept.kept.commands).not.toContain('clear')
    const headless = await uninspectable(null, [])
    expect(await headless.rt.forceFresh()).toContain('Nobody to confirm a fresh start from unverified notes here, so nothing was cleared.')
    expect(headless.kept.asked).toEqual([])
    await headless.advance(2000)
    expect(headless.kept.commands).not.toContain('clear')
  })

  test('“start fresh now” typed while the notes could not be verified asks first, and is never sent into the old context', async () => {
    const f = await uninspectable('Start fresh anyway')
    const held = await f.rt.handoffGuard({ text: 'start fresh now', origin: { kind: 'composer' } })
    expect(held?.drop).toContain('Starting the fresh context')
    expect(f.kept.asked.at(-1)?.header).toBe('Start fresh')
    await f.advance(2000)
    expect(f.kept.commands.filter(c => c === 'clear').length).toBe(1)
  })

  test('the session-only controls: pause, resume, recheck, and the window commands', async () => {
    const f = await started()
    const { rt } = f
    expect((await rt.runCommand('autopilot pause')).text).toContain('Autopilot is paused for this session')
    rt.onTurnStart({ turnId: 'p1', text: 'Work.' })
    stepAt(rt, 'p1', 0, 900_000, 'tool_use')
    await flush()
    expect(rt.autopilot.state).toBe('armed')
    expect(rt.settings.autopilot.enabled).toBe(true)
    expect((await rt.runCommand('autopilot resume')).text).toBe('Autopilot is watching the context again.')
    expect((await rt.runCommand('autopilot recheck')).text).toBe('No handoff loop is held.')
    expect((await rt.runCommand('window')).text).toContain('No window change is held')
    expect((await rt.runCommand('window sideways')).text).toBe('Usage: /cr window [accept|back|pause]')
  })
})

describe('the Handoff Supervisor says what happens next', () => {
  const base = { now: 100_000, stateSince: 40_000, isTurnRunning: false, isHandoffTurn: false, background: [], waitSince: null, waitUntil: null, skipWait: false, notesWritten: null, questionsOpen: 0, quietMs: 60_000, lastError: null, continuation: 'clear' as const }

  test('each step’s next action, the notes’ state, and the wait’s end in words', () => {
    expect(diagnose({ ...base, state: 'armed' }).next).toBeNull()
    expect(diagnose({ ...base, state: 'handoff', isTurnRunning: true, notes: { state: 'missing', words: 'missing (/work/NEXT_SESSION_PROMPT.md)' } })).toMatchObject({ next: 'Checks the notes when this turn ends', notes: 'missing (/work/NEXT_SESSION_PROMPT.md)' })
    const waiting = diagnose({ ...base, state: 'waiting-background', background: [{ id: 'r', description: 'Render', class: 'finite' }], waitSince: 40_000, waitUntil: 1_240_000, waitEndsWords: '14:20' })
    expect(waiting.next).toBe('Hands off as soon as the work ends, or at 14:20 at the latest, leaving it running')
    expect(diagnose({ ...base, state: 'waiting-background', background: [{ id: 'v', description: 'Vite', class: 'persistent' }] }).next).toBe('Checks the notes, then starts the fresh context')
    expect(diagnose({ ...base, state: 'verifying' }).next).toBe('Starts the fresh context once the notes check passes')
    expect(diagnose({ ...base, state: 'clearing', isTurnRunning: true }).next).toBe('Clears this context when the turn you queued ends')
    expect(diagnose({ ...base, state: 'awaiting' }).next).toBe('Nothing by itself: waits for you')
  })
})
