import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { classicSettings, defaultSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { fakeHost, flush } from './fixtures/fake-host'

const MIN = 60_000
const OPUS = 'claude-opus-5-5'
const ONE_HOUR = { v: 1, ttl: '1h', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }

type Fake = ReturnType<typeof fakeHost>

async function started(patch: (s: Settings) => void, options: { memory?: Record<string, unknown>; fake?: Fake } = {}) {
  const f = options.fake ?? fakeHost()
  const s = classicSettings()
  patch(s)
  f.kept.store['settings.v1'] = s
  if (options.memory !== undefined) f.kept.store['cache.v1'] = options.memory
  f.live.usage = { ...f.live.usage, context: { tokens: 300_000, window: 1_000_000, percent: 30 } }
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { rt, ...f }
}

let turns = 0

/**
 * One main-thread request as the engine makes it: the system prompt composed (prompt.compose),
 * the request's step (turn.step, before and after), each `prompt` tokens long with `read` from the cache.
 */
async function request(f: Fake, rt: Runtime, input: { turnId: string; index: number; prompt: number; read: number; effort?: 'high' | 'medium' }) {
  rt.composeSection(null, [])
  const e = { turnId: input.turnId, index: input.index, model: OPUS, effort: input.effort ?? ('high' as const), messageCount: 3 + input.index }
  const sent = rt.stepRequest(e)
  await f.advance(1000)
  rt.stepResponse(e, sent, {
    turnId: input.turnId,
    index: input.index,
    answer: '',
    toolUses: [],
    stopReason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: input.read, cache_creation_input_tokens: Math.max(0, input.prompt - input.read - 100), model: OPUS },
  })
  return sent
}

async function turn(f: Fake, rt: Runtime, prompt: number, read: number) {
  const turnId = `d${++turns}`
  rt.onPromptSubmit('Carry on with the parser.', { kind: 'composer' })
  await rt.onTurnStart({ turnId, text: 'Carry on with the parser.' })
  const sent = await request(f, rt, { turnId, index: 0, prompt, read })
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
  await f.advance(10)
  return sent
}

describe('policy delivery (the ledger)', () => {
  test('a brand-new session with Frontier Max saved: its first request carries the section and goes out at the chosen effort', async () => {
    const f = await started(s => {
      s.frontier.enabled = true
      s.frontier.effort = 'xhigh'
    })
    const { rt } = f
    const sent = await turn(f, rt, 40_000, 0)
    expect(sent.effort).toBe('xhigh')
    const first = rt.ledger.first
    expect(first).toMatchObject({ n: 1, method: 'system', effort: 'xhigh', effortAsked: 'xhigh', frontierOn: true, frontierDelivered: true, sessionId: 'S1' })
    expect(first?.compose).toMatchObject({ frontier: true, effortLine: 'xhigh', isHeld: false, isLoaded: true })
    expect(first?.compose?.hash).toMatch(/^[0-9a-f]{8}$/)
    expect(Views.paneOf(rt).frontier.delivery).toMatchObject({ state: 'delivered', method: 'system', isFirstRequest: true, effort: 'xhigh' })
  })

  test("a turn's later requests carry the system prompt composed for it: Claude Code composes once per turn (seen live), and that is no missing delivery", async () => {
    const f = await started(s => void (s.frontier.enabled = true))
    const { rt } = f
    rt.composeSection(null, [])
    for (const index of [0, 1, 2]) {
      const e = { turnId: 'one', index, model: OPUS, effort: 'high' as const, messageCount: 2 + 2 * index }
      const sent = rt.stepRequest(e)
      rt.stepResponse(e, sent, { turnId: 'one', index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40_000 + index, cache_creation_input_tokens: 100, model: OPUS } })
    }
    expect(rt.ledger.records.map(r => [r.n, r.method, r.frontierDelivered])).toEqual([
      [3, 'system', true],
      [2, 'system', true],
      [1, 'system', true],
    ])
    expect(new Set(rt.ledger.records.map(r => r.compose?.hash)).size).toBe(1)
    expect(Views.paneOf(rt).frontier.delivery.state).toBe('delivered')
  })

  test('a composition that only measures the prompt (/context) is no evidence, and never fixes the held section', async () => {
    const f = await started(s => void (s.frontier.enabled = true))
    const { rt } = f
    const measured = rt.composeSection(null, ['analysis'])
    expect(measured?.text).toContain('## Frontier Max')
    expect(rt.compose.isReached).toBe(false)
    expect(rt.ledger.records).toEqual([])
    expect(rt.cache.deliveredPolicy()).toBeNull()
  })

  test('turned on mid-session while the cache is warm and held: the section stays, the note goes with the next tool results, and the request after it counts it as delivered', async () => {
    const f = await started(() => undefined, { memory: ONE_HOUR })
    const { rt } = f
    await turn(f, rt, 300_000, 0)
    expect(rt.ledger.records[0]).toMatchObject({ frontierOn: false, frontierDelivered: false, method: 'system' })
    // The person turns it on while Claude works.
    await rt.onTurnStart({ turnId: 'mid', text: 'Keep going.' })
    rt.update(s => {
      s.frontier.enabled = true
      s.frontier.effort = 'max'
    })
    await flush()
    // Effort applies at the very next request; the held section has no Frontier Max yet, and the note is waiting.
    const before = await request(f, rt, { turnId: 'mid', index: 0, prompt: 301_000, read: 300_000 })
    expect(before.effort).toBe('max')
    expect(rt.ledger.records[0]).toMatchObject({ method: 'held', frontierOn: true, frontierDelivered: false, effort: 'max' })
    expect(rt.ledger.records[0]?.compose?.frontier).toBe(false)
    expect(Views.paneOf(rt).frontier.delivery.state).toBe('missing')
    // The batch of tool results carries the note; the next request reads it.
    const notes = rt.notesForBatch()
    expect(notes.join(' ')).toContain('Frontier Max is now ON')
    expect(notes.join(' ')).toContain('frontier-level autonomous capability')
    await request(f, rt, { turnId: 'mid', index: 1, prompt: 302_000, read: 301_000 })
    expect(rt.ledger.records[0]).toMatchObject({ method: 'held+note', frontierDelivered: true })
    expect(Views.paneOf(rt).frontier.delivery).toMatchObject({ state: 'delivered', method: 'held+note', effort: 'max' })
    // The cache was never rebuilt for it.
    expect(rt.cache.state.misses).toEqual([])
  })

  test('turned off mid-session: Claude is told it no longer applies; until that note goes it is stale, never silently in force', async () => {
    const f = await started(s => void (s.frontier.enabled = true), { memory: ONE_HOUR })
    const { rt } = f
    await turn(f, rt, 300_000, 0)
    expect(rt.ledger.records[0]?.frontierDelivered).toBe(true)
    await rt.onTurnStart({ turnId: 'off', text: 'Keep going.' })
    rt.update(s => void (s.frontier.enabled = false))
    await flush()
    await request(f, rt, { turnId: 'off', index: 0, prompt: 301_000, read: 300_000 })
    expect(rt.ledger.records[0]).toMatchObject({ method: 'held', frontierOn: false, frontierStale: true })
    expect(Views.paneOf(rt).frontier.delivery.state).toBe('stale')
    const note = rt.notesForBatch().join(' ')
    expect(note).toContain('Frontier Max is now OFF')
    expect(note).toContain('take precedence over the Control Room sections of your system prompt')
    expect(note).not.toContain('## Frontier Max')
    await request(f, rt, { turnId: 'off', index: 1, prompt: 302_000, read: 301_000 })
    expect(rt.ledger.records[0]).toMatchObject({ method: 'held+note', frontierOn: false, frontierStale: false })
    expect(Views.paneOf(rt).frontier.delivery.state).toBe('off')
  })

  test('a fresh context after /clear composes the policies afresh: no held section and no waiting note survive', async () => {
    const f = await started(() => undefined, { memory: ONE_HOUR })
    const { rt } = f
    await turn(f, rt, 300_000, 0)
    rt.update(s => void (s.frontier.enabled = true))
    await flush()
    // Held: the note waits for the next prompt.
    expect(rt.notesBox.kinds()).toContain('policies')
    await rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    expect(rt.notesBox.count()).toBe(0)
    expect(rt.ledger.records).toEqual([])
    const sent = await turn(f, rt, 40_000, 0)
    expect(sent.effort).toBe('max')
    expect(rt.ledger.first).toMatchObject({ n: 1, method: 'system', frontierDelivered: true, sessionId: 'S2' })
    // The continuation's prompt carries nothing from the old context.
    expect(rt.onPromptSubmit('Context Autopilot continuation (session 2).', { kind: 'plugin', name: 'project-sentinel' })).toEqual([])
  })

  test('after a compaction the section is composed afresh, once: no held note about the old system prompt survives', async () => {
    const f = await started(() => undefined, { memory: ONE_HOUR })
    const { rt } = f
    await turn(f, rt, 300_000, 0)
    rt.update(s => void (s.frontier.enabled = true))
    await flush()
    expect(rt.notesBox.kinds()).toEqual(['policies'])
    rt.onCompacted('auto', { messages: [], tokensBefore: 300_000, tokensAfter: 30_000 })
    expect(rt.notesBox.count()).toBe(0)
    const section = rt.composeSection(null, [])
    expect(section?.text).toContain('## Frontier Max')
    expect(section?.text.match(/## Frontier Max/g)?.length).toBe(1)
  })

  test('a reload of the plugin keeps the held section the system prompt carries, instead of rebuilding the cache', async () => {
    const f = await started(() => undefined, { memory: ONE_HOUR })
    const { rt } = f
    await turn(f, rt, 300_000, 0)
    const carried = rt.cache.deliveredPolicy()
    expect(f.kept.policyMemo).toEqual({ sessionId: 'S1', text: carried })
    rt.update(s => void (s.frontier.enabled = true))
    await flush()
    // A reload: a new Runtime in the same session, with the settings now saying Frontier Max is on.
    await f.advance(2000)
    const g = await started(s => void (s.frontier.enabled = true), { memory: ONE_HOUR, fake: f })
    expect(g.rt.cache.deliveredPolicy()).toBe(carried)
  })

  test('a reload in the middle of a turn: its next request still carries the system prompt composed before it, and counts as delivered (seen live mid-handoff)', async () => {
    const f = await started(s => {
      s.frontier.enabled = true
      s.frontier.effort = 'xhigh'
    })
    const { rt } = f
    await rt.onTurnStart({ turnId: 'long', text: 'Write the handoff.' })
    await request(f, rt, { turnId: 'long', index: 0, prompt: 90_000, read: 0 })
    const section = rt.ledger.records[0]?.compose?.hash
    expect(rt.ledger.records[0]).toMatchObject({ method: 'system', frontierDelivered: true })
    // The plugin reloads while the turn runs: Claude Code composed the turn's system prompt before, and composes no new one.
    const g = await started(s => {
      s.frontier.enabled = true
      s.frontier.effort = 'xhigh'
    }, { fake: f })
    const e = { turnId: 'long', index: 1, model: OPUS, effort: 'xhigh' as const, messageCount: 6 }
    const sent = g.rt.stepRequest(e)
    g.rt.stepResponse(e, sent, { turnId: 'long', index: 1, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 200, model: OPUS } })
    expect(g.rt.ledger.records[0]).toMatchObject({ method: 'system', frontierOn: true, frontierDelivered: true, effort: 'xhigh' })
    expect(g.rt.ledger.records[0]?.compose?.hash).toBe(section)
    expect(Views.paneOf(g.rt).frontier.delivery.state).toBe('delivered')
  })
})

describe('notes for Claude', () => {
  test('never appended to the transcript: the Host has no way to, and every note leaves with tool results or a prompt', async () => {
    const f = await started(s => void (s.resources.level = 'medium'), { memory: ONE_HOUR })
    const { rt } = f
    expect('appendForModel' in f.host).toBe(false)
    await turn(f, rt, 300_000, 0)
    await rt.onTurnStart({ turnId: 'n1', text: 'Go on.' })
    rt.update(s => void (s.resources.level = 'low'))
    expect(rt.notesForBatch().join(' ')).toContain('## Resource Governor: LOW')
    expect(rt.notesBox.delivered.some(d => d.kind === 'resources' && d.channel === 'tool-batch')).toBe(true)
    // A note handed over while no batch comes waits for the next prompt.
    rt.update(s => void (s.answers.style = 'brief'))
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    expect(rt.onPromptSubmit('Next.', { kind: 'composer' }).join(' ')).toContain('the answer style is now Brief')
  })

  test('the machine at its ceiling: told once when it goes high, nothing while it holds, the all-clear only after a while and once', async () => {
    const f = await started(s => void (s.resources.level = 'medium'))
    const { rt, advance } = f
    await rt.onTurnStart({ turnId: 'p1', text: 'Build it.' })
    rt.monitor.pressure = { level: 'high', cpu: 40, ram: 86, driver: 'ram', overStreak: 2, clearStreak: 0 }
    expect(rt.notesForBatch().join(' ')).toContain('Resource pressure HIGH')
    expect(rt.notesForBatch()).toEqual([])
    // Back to calm a moment later: not said yet (no notice and all-clear back to back).
    rt.monitor.pressure = { level: 'elevated', cpu: 40, ram: 80, driver: 'ram', overStreak: 0, clearStreak: 2 }
    expect(rt.notesForBatch()).toEqual([])
    await advance(60_000)
    expect(rt.notesForBatch().join(' ')).toContain('back under the ceilings')
    expect(rt.notesForBatch()).toEqual([])
    // High and calm again between two batches: nothing at all is said.
    rt.monitor.pressure = { level: 'high', cpu: 40, ram: 86, driver: 'ram', overStreak: 2, clearStreak: 0 }
    rt.monitor.pressure = { level: 'ok', cpu: 20, ram: 60, driver: 'ram', overStreak: 0, clearStreak: 3 }
    expect(rt.notesForBatch()).toEqual([])
  })

  test("the background work list follows Claude Code's own: a job that ended by itself leaves it at the turn's stop", async () => {
    const f = await started(() => undefined)
    const { rt } = f
    await rt.onTurnStart({ turnId: 'b1', text: 'Start the watcher.' })
    for (const id of ['bg1', 'bg2']) {
      await rt.beforeTool('Bash', { command: `npm run watch-${id}`, run_in_background: true }, `tu-${id}`, undefined)
      rt.afterTool('Bash', { command: `npm run watch-${id}` }, `tu-${id}`, { result: { backgroundTaskId: id } })
    }
    expect([...rt.activity.background.keys()]).toEqual(['bg1', 'bg2'])
    await rt.onStop({ stopHookActive: false, lastMessage: 'Started.', background: [{ id: 'bg2', type: 'local_bash', description: 'npm run watch-bg2' }], wakeups: [], permissionMode: undefined })
    expect([...rt.activity.background.keys()]).toEqual(['bg2'])
  })
})
