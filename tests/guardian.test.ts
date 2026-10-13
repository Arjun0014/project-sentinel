import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { classicSettings, defaultSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { fakeHost, flush } from './fixtures/fake-host'

const MIN = 60_000
const OPUS = 'claude-opus-5-5'
const HAIKU = 'claude-haiku-4-5-20251001'

type Fake = ReturnType<typeof fakeHost>

/** A session with Control Room started, the context at 300k tokens; `memory` is what earlier sessions learned (store `cache.v1`). */
async function started(patch: (s: Settings) => void, memory?: Record<string, unknown>) {
  const f = fakeHost()
  // Classic: every optional system off, the baseline these tests were written against (1.7.0 made Normal opinionated).
  const s = classicSettings()
  patch(s)
  f.kept.store['settings.v1'] = s
  if (memory !== undefined) f.kept.store['cache.v1'] = memory
  f.live.usage = { ...f.live.usage, context: { tokens: 300_000, window: 1_000_000, percent: 30 } }
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { rt, ...f }
}

let turns = 0

/** One main turn: each request `prompt` tokens long, `read` of them from the cache, two seconds apart. */
async function turn(f: Fake, rt: Runtime, requests: readonly { prompt: number; read: number; model?: string }[]): Promise<void> {
  const turnId = `t${++turns}`
  rt.onTurnStart({ turnId, text: 'Carry on with the parser.' })
  for (const [index, r] of requests.entries()) {
    const e = { turnId, index, model: OPUS, effort: 'high' as const, messageCount: 3 + index }
    const sent = rt.stepRequest(e)
    await f.advance(2000)
    rt.stepResponse(e, sent, {
      turnId,
      index,
      answer: '',
      toolUses: [],
      stopReason: index === requests.length - 1 ? 'end_turn' : 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: r.read, cache_creation_input_tokens: Math.max(0, r.prompt - r.read - 100), model: r.model ?? sent.model ?? OPUS },
    })
  }
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
  await f.advance(10)
}

const ONE_HOUR = { v: 1, ttl: '1h', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }
const FIVE_MINUTES = { v: 1, ttl: '5m', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }

describe('Cache Guardian', () => {
  test('Keep warm refreshes the one-hour cache ten minutes before it lapses, unseen, and proves itself on the next request', async () => {
    const f = await started(s => void (s.cache.keepWarm = true), ONE_HOUR)
    const { rt, kept, advance } = f
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    const t0 = rt.cache.state.lastRequestAt ?? 0
    expect(rt.cache.plan).toEqual({ at: t0 + 50 * MIN, isProbe: false })
    await advance(49 * MIN)
    expect(kept.forks).toEqual([])
    await advance(2 * MIN)
    expect(kept.forks).toEqual([t0 + 50 * MIN])
    expect(rt.cache.state.keepWarm).toMatchObject({ refreshes: 1, lastHit: true, verified: 'unknown', provingAfter: t0 + 60 * MIN })
    // Its record: the fork read the whole prompt, the cache now lasts an hour from the fork, and the conversation's next request will tell.
    expect(rt.cache.state.keepWarm.log[0]).toMatchObject({ at: t0 + 50 * MIN, isHit: true, read: 300_000, oldExpiry: t0 + 60 * MIN, newExpiry: t0 + 110 * MIN, status: 'awaiting', expected: 300_000 })
    expect(Views.paneOf(rt).cache.keepWarm.main).toBe('awaiting')
    // Nothing reaches Claude or the person for a refresh.
    expect(rt.notesBox.count()).toBe(0)
    expect(kept.toasts).toEqual([])
    // The person is back after the old expiry: the cache is still there, which proves the method.
    await advance(20 * MIN)
    await turn(f, rt, [{ prompt: 301_000, read: 300_000 }])
    expect(rt.cache.state.keepWarm.verified).toBe('yes')
    expect(rt.cache.state.keepWarm.log[0]).toMatchObject({ status: 'verified', main: { phase: 'after-old-expiry', read: 300_000, changed: [] } })
    expect(Views.paneOf(rt).cache.keepWarm.main).toBe('verified')
    expect(rt.cache.state.misses).toEqual([])
    expect(kept.toasts.some(t => t.startsWith('Keep warm verified'))).toBe(true)
    expect((kept.store['cache.v1'] as { verified: string }).verified).toBe('yes')
  })

  test('the debug log gets one line per refresh plan, not one per look at it', async () => {
    // Seen live (1.7.0): a turn's end and the Autopilot step it caused each wrote the same plan.
    const f = await started(s => void (s.cache.keepWarm = true), ONE_HOUR)
    const { rt, kept } = f
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    const plans = () => kept.traces.filter(t => t.startsWith('keep warm: next refresh at') || t.startsWith('keep warm: no refresh planned'))
    const before = plans().length
    rt.cache.schedule()
    rt.cache.schedule()
    expect(plans().length).toBe(before)
    // A plan that changes is written again.
    rt.update(s => void (s.cache.keepWarm = false))
    rt.cache.schedule()
    expect(plans().at(-1)).toBe('keep warm: no refresh planned (Off)')
  })

  test('Keep warm stands down only once the old context is about to be discarded: never for a handoff that is due, written, waiting or stuck', async () => {
    // Seen in a real run (1.6.3): a written handoff held by a Vite preview server stood Keep warm down
    // ("a handoff will start a fresh context") for two hours, and a 775k-token cache went cold.
    const f = await started(s => {
      s.cache.keepWarm = true
      s.autopilot.enabled = true
    }, ONE_HOUR)
    const { rt, kept, advance } = f
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    const t0 = rt.cache.state.lastRequestAt ?? 0
    const warm = { at: t0 + 50 * MIN, isProbe: false }
    // Every state whose next turn reads the old context again keeps it warm: the step that crossed the
    // threshold, the handoff turn, each notification's turn while it waits, the person's own message.
    for (const state of ['armed', 'pending', 'requested', 'handoff', 'waiting-background', 'awaiting', 'compacting'] as const) {
      rt.autopilot = { ...rt.autopilot, state }
      rt.cache.schedule()
      expect(rt.cache.plan, state).toEqual(warm)
    }
    // Past the handoff point too: the handoff turn re-reads the whole context.
    rt.autopilot = { ...rt.autopilot, state: 'armed' }
    rt.usage = { ...rt.usage, tokens: 950_000 }
    rt.cache.schedule()
    expect(rt.cache.plan).toEqual(warm)
    // About to be discarded: the notes checked before the clear, the clear, the fresh context resuming.
    const verifying = { at: null, reason: 'The handoff notes are being checked before the clear, so this cache is about to be discarded' }
    const discarding = { at: null, reason: 'A handoff is starting a fresh context, so this cache is about to be discarded' }
    for (const [state, plan] of [['verifying', verifying], ['clearing', discarding], ['resuming', discarding]] as const) {
      rt.autopilot = { ...rt.autopilot, state }
      rt.cache.schedule()
      expect(rt.cache.plan, state).toEqual(plan)
    }
    // A handoff that compacts reads the whole conversation once more: its check keeps the cache warm.
    rt.update(s => void (s.autopilot.continuation = 'compact'))
    rt.autopilot = { ...rt.autopilot, state: 'verifying' }
    rt.cache.schedule()
    expect(rt.cache.plan).toEqual(warm)
    // A written handoff waiting for background work for 70 minutes: the cache was refreshed, never left to lapse.
    rt.autopilot = { ...rt.autopilot, state: 'waiting-background' }
    rt.cache.schedule()
    await advance(70 * MIN)
    expect(kept.forks.length).toBeGreaterThan(0)
    expect(kept.forks[0]).toBe(t0 + 50 * MIN)
  })

  test('a chain of refreshes is proven by the conversation reading the cache after the expiry the first one replaced (seen live: a wake six seconds after the third refresh read as unproven)', async () => {
    const f = await started(s => void (s.cache.keepWarm = true), FIVE_MINUTES)
    const { rt, kept, advance } = f
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    const t0 = rt.cache.state.lastRequestAt ?? 0
    // Three refreshes, four minutes apart; the conversation is back six seconds after the third.
    await advance(12 * MIN + 6_000)
    expect(kept.forks.map(at => Math.round((at - t0) / MIN))).toEqual([4, 8, 12])
    await turn(f, rt, [{ prompt: 300_500, read: 300_000 }])
    const newest = rt.cache.state.keepWarm.log[0]!
    expect(newest.status).toBe('verified')
    expect(newest.note).toContain("when it would have lapsed without Keep warm's refreshes")
    expect(rt.cache.state.keepWarm.verified).toBe('yes')
    // A new chain starts with the next refresh: back early after one refresh proves nothing yet.
    await advance(4 * MIN + 6_000)
    await turn(f, rt, [{ prompt: 301_000, read: 300_500 }])
    expect(rt.cache.state.keepWarm.log[0]!.status).toBe('consistent')
  })

  test('a refresh sent in time but answered after the expiry (Claude Code retried it through an outage, seen live) is no failure of Keep warm', async () => {
    const f = await started(s => void (s.cache.keepWarm = true), FIVE_MINUTES)
    const { rt, live, advance } = f
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    // Sent at four minutes; its reply comes two minutes later, after the five-minute expiry, having rebuilt the cache.
    live.forkDelayMs = 2 * MIN
    live.forkRead = 0
    await advance(6 * MIN + 10_000)
    const r = rt.cache.state.keepWarm.log[0]!
    expect(r.status).toBe('missed')
    expect(r.note).toStartWith('Sent before the expiry, answered after it (2 min later: Claude Code retried it)')
    expect(rt.cache.state.keepWarm.failures).toBe(0)
    expect(rt.cache.state.keepWarm.verified).toBe('unknown')
  })

  test('the five-minute cache is refreshed every four minutes, for 45 idle minutes at most', async () => {
    const f = await started(s => void (s.cache.keepWarm = true), FIVE_MINUTES)
    const { rt, kept, advance } = f
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    const t0 = rt.cache.state.lastRequestAt ?? 0
    await advance(90 * MIN)
    expect(kept.forks.map(at => Math.round((at - t0) / MIN))).toEqual([4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44])
    expect(rt.cache.plan.at).toBeNull()
    expect(rt.cache.plan.at === null ? rt.cache.plan.reason : '').toContain('costs more than rebuilding it')
  })

  test('with the lifetime unknown, one refresh at six idle minutes learns it, and later sessions remember it', async () => {
    const f = await started(s => void (s.cache.keepWarm = true))
    const { rt, kept, advance } = f
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    const t0 = rt.cache.state.lastRequestAt ?? 0
    expect(rt.cache.plan).toEqual({ at: t0 + 6 * MIN, isProbe: true })
    await advance(7 * MIN)
    expect(kept.forks).toEqual([t0 + 6 * MIN])
    expect(rt.cache.state.ttl).toEqual({ value: '1h', source: 'probe' })
    expect(kept.store['cache.v1']).toMatchObject({ ttl: '1h', ttlSource: 'probe' })
    expect(rt.cache.plan).toEqual({ at: t0 + 56 * MIN, isProbe: false })

    const later = new Runtime()
    later.bind(f.host)
    await later.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(later.cache.state.ttl).toEqual({ value: '1h', source: 'stored' })
  })

  test('Keep warm stops itself when its refreshes do not hold the cache, and tries afresh when turned on again', async () => {
    const f = await started(s => void (s.cache.keepWarm = true), ONE_HOUR)
    const { rt, kept, live, advance } = f
    live.forkRead = 0
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    // The lifetime as Claude Code reports it in this context (a model switch's hook), not one remembered from before.
    rt.cache.noteTtl('1h')
    rt.cache.schedule()
    await advance(101 * MIN)
    expect(kept.forks.length).toBe(2)
    expect(rt.cache.state.ttl).toEqual({ value: '1h', source: 'engine' })
    expect(rt.cache.state.keepWarm.verified).toBe('no')
    expect(rt.cache.plan).toEqual({ at: null, reason: 'Paused: its last check failed' })
    expect(rt.notes.join(' ')).toContain('Keep warm paused itself: Two refreshes sent before the expiry found the cache gone')
    expect(kept.toasts.some(t => t.startsWith('Keep warm paused: refreshes found the cache gone'))).toBe(true)
    expect(rt.cache.state.keepWarm.log.map(r => r.status)).toEqual(['missed', 'missed'])
    expect((kept.store['cache.v1'] as { verified: string }).verified).toBe('no')
    rt.update(s => void (s.cache.keepWarm = false))
    rt.update(s => void (s.cache.keepWarm = true))
    expect(rt.cache.state.keepWarm.verified).toBe('unknown')
    expect((kept.store['cache.v1'] as { verified: string }).verified).toBe('unknown')
  })

  test('a remembered hour that proves wrong is corrected: Keep warm does not blame itself, and pauses at the five-minute idle limit', async () => {
    const f = await started(s => void (s.cache.keepWarm = true), ONE_HOUR)
    const { rt, kept, live, advance } = f
    live.forkRead = 0
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    await advance(101 * MIN)
    expect(kept.forks.length).toBe(1)
    expect(rt.cache.state.ttl).toEqual({ value: '5m', source: 'observed' })
    expect(rt.cache.state.keepWarm.verified).toBe('unknown')
    expect(rt.cache.plan.at).toBeNull()
  })

  test('stable policies: while the cache is warm a settings change reaches Claude as a note, and the system prompt keeps its section', async () => {
    const f = await started(() => undefined, ONE_HOUR)
    const { rt, kept, advance } = f
    const original = rt.composeSection(null)?.text
    expect(original).toBeDefined()
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    rt.update(s => void (s.frontier.enabled = true))
    await flush()
    // Between turns, the note goes with the next prompt: never appended to the transcript.
    const note = rt.onPromptSubmit('Carry on.', { kind: 'composer' }).join(' ')
    expect(note).toContain('To keep the prompt cache')
    expect(note).toContain('Frontier Max is now ON')
    expect(note).toContain('frontier-level autonomous capability')
    expect(rt.composeSection(null)?.text).toBe(original)
    expect(Views.paneOf(rt).cache.policies).toEqual({ isStable: true, isHolding: true })
    // Back to what the system prompt already says: Claude is told the note no longer applies.
    rt.update(s => void (s.frontier.enabled = false))
    await flush()
    expect(rt.onPromptSubmit('Carry on.', { kind: 'composer' }).join(' ')).toContain('apply again as written')
    // Once the cache is cold there is nothing to keep: the system prompt takes the change.
    await advance(70 * MIN)
    rt.update(s => void (s.frontier.enabled = true))
    expect(rt.composeSection(null)?.text).toContain('frontier-level autonomous capability')
  })

  test('a policy change while warm, with stable policies off, is named as the cause of the miss it brings', async () => {
    const f = await started(s => void (s.cache.stablePolicies = false), ONE_HOUR)
    const { rt } = f
    rt.composeSection(null)
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    rt.update(s => void (s.qa.enabled = true))
    expect(rt.composeSection(null)?.text).toContain('Release / QA mode')
    await turn(f, rt, [{ prompt: 301_000, read: 2_000 }])
    const miss = Views.paneOf(rt).cache.misses[0]
    expect(miss).toMatchObject({ cause: 'policy', kind: 'preventable', severity: 'warn' })
    expect(miss?.detail).toContain('Release/QA mode is now ON')
    expect(miss?.advice).toContain('Turn on Keep policies stable')
  })

  test('a model switch the person makes is confirmed first when a large warm cache would be lost', async () => {
    const { rt } = await started(() => undefined)
    const ask = { from_model: OPUS, to_model: 'claude-sonnet-5-5', source: 'command', context_tokens: 412_000, prompt_cache_warm: true, cache_ttl: '1h' as const, estimated_cache_write_usd: 2.06 }
    const reason = rt.onPreModelSwitch(ask) ?? ''
    // Seen live: Claude Code draws the reason on one line and cuts it at the width, so the figure comes first and it stays short.
    expect(reason).toBe('Control Room: this re-sends 412k cached tokens uncached (about $2.06). A fresh context avoids it.')
    expect(reason.length).toBeLessThanOrEqual(100)
    expect(rt.cache.state.ttl).toEqual({ value: '1h', source: 'engine' })
    expect(rt.onPreModelSwitch({ ...ask, source: 'sdk' })).toBeNull()
    expect(rt.onPreModelSwitch({ ...ask, prompt_cache_warm: false })).toBeNull()
    expect(rt.onPreModelSwitch({ ...ask, context_tokens: 40_000 })).toBeNull()
    rt.update(s => void (s.cache.guardModelSwitch = false))
    expect(rt.onPreModelSwitch(ask)).toBeNull()
  })

  test('a switch the person made, then a miss: a toast says what it cost; a compaction is expected and stays quiet', async () => {
    const f = await started(() => undefined, ONE_HOUR)
    const { rt, kept } = f
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    rt.onPostModelSwitch({ from_model: OPUS, to_model: 'claude-sonnet-5-5', cache_ttl: '1h', source: 'command' })
    await turn(f, rt, [{ prompt: 301_000, read: 0, model: 'claude-sonnet-5-5' }])
    expect(kept.toasts.at(-1)).toBe('Cache rebuilt: 300k tokens · Model changed')
    const toasts = kept.toasts.length
    rt.onCompacted('manual', { messages: [], tokensBefore: 301_000, tokensAfter: 30_000 })
    await turn(f, rt, [{ prompt: 30_000, read: 0, model: 'claude-sonnet-5-5' }])
    expect(rt.cache.state.misses[0]).toMatchObject({ cause: 'compact', kind: 'lifecycle' })
    expect(kept.toasts.length).toBe(toasts)
    expect(Views.hudOf(rt).cache?.recentMiss).toBeNull()
  })

  test('the router keeps a warm cache, and a miss its own switch causes is put down to it', async () => {
    const f = await started(s => void (s.router.strategy = 'economy'), ONE_HOUR)
    const { rt, advance } = f
    rt.router.known.set('haiku', HAIKU)
    // A context small enough for the router to consider a switch at all.
    f.live.usage = { ...f.live.usage, context: { tokens: 30_000, window: 1_000_000, percent: 3 } }
    await turn(f, rt, [{ prompt: 30_000, read: 0 }])
    rt.onPromptSubmit('Where is the config read?', { kind: 'composer' })
    expect(rt.router.turnModel).toBeNull()
    expect(rt.router.lastDecision).toContain('keeps the warm cache (30k tokens)')
    // A small warm cache is not worth keeping: the router switches, and owns the rebuild.
    const g = await started(s => void (s.router.strategy = 'economy'), ONE_HOUR)
    g.rt.router.known.set('haiku', HAIKU)
    g.live.usage = { ...g.live.usage, context: { tokens: 10_000, window: 1_000_000, percent: 1 } }
    await turn(g, g.rt, [{ prompt: 10_000, read: 0 }])
    g.rt.onPromptSubmit('Where is the config read?', { kind: 'composer' })
    expect(g.rt.router.turnModel).toBe(HAIKU)
    await turn(g, g.rt, [{ prompt: 10_200, read: 0 }])
    const miss = Views.paneOf(g.rt).cache.misses[0]
    expect(miss).toMatchObject({ cause: 'model', kind: 'preventable' })
    expect(miss?.detail).toContain('Model router: opus-5-5 → haiku-4-5')
    expect(miss?.advice).toContain('model router')
    // Once the cache has lapsed, nothing is lost by a switch.
    await advance(70 * MIN)
    rt.onPromptSubmit('Where is the config read?', { kind: 'composer' })
    expect(rt.router.turnModel).toBe(HAIKU)
  })

  test('a fresh context starts the cache over; the lifetime it learned carries', async () => {
    const f = await started(s => void (s.cache.keepWarm = true), ONE_HOUR)
    const { rt } = f
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    expect(Views.hudOf(rt).cache).toMatchObject({ warmth: 'warm', ttl: '1h', cachedTokens: 300_000, keepWarm: true })
    await rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    expect(rt.cache.state.requests).toBe(0)
    expect(rt.cache.state.ttl).toEqual({ value: '1h', source: 'stored' })
    expect(rt.cache.plan).toEqual({ at: null, reason: 'Nothing cached yet' })
    expect(Views.hudOf(rt).cache).toBeNull()
  })

  test('a long tool call inside a turn keeps the cache warm in the status bar and the panel, the lifetime unknown', async () => {
    const f = await started(() => undefined)
    const { rt, advance } = f
    await turn(f, rt, [{ prompt: 345_000, read: 0 }])
    // The next turn: one request, then a nine-minute command runs.
    rt.onTurnStart({ turnId: 'long', text: 'Run the full simulation.' })
    const e = { turnId: 'long', index: 0, model: OPUS, effort: 'high' as const, messageCount: 5 }
    const sent = rt.stepRequest(e)
    await advance(1000)
    rt.stepResponse(e, sent, { turnId: 'long', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 344_000, cache_creation_input_tokens: 900, model: OPUS } })
    await advance(9 * MIN + 22_000)
    expect(rt.cache.state.ttl).toBeNull()
    const hud = Views.hudOf(rt).cache
    expect(hud?.warmth).toBe('warm')
    expect(hud?.text).toBe('warm')
    expect(rt.cache.view(rt.clock()).warmth).toBe('warm')
    // After the turn, idle with the lifetime still unknown, it may have lapsed: said so, not hidden.
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await advance(6 * MIN)
    expect(Views.hudOf(rt).cache?.text).toBe('lapsed?')
  })

  test("a claude.ai plan's session takes the one-hour cache as the plan's default, named so; a miss after a long gap corrects it", async () => {
    const f = await started(() => undefined)
    const { rt, advance } = f
    f.live.usage = { ...f.live.usage, rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-08T15:00:00Z' }] }
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    expect(rt.cache.state.ttl).toEqual({ value: '1h', source: 'plan' })
    expect(rt.cache.view(rt.clock()).ttlSource).toBe('plan')
    await advance(20 * MIN)
    expect(Views.hudOf(rt).cache?.text).toBe('40m')
    // Not remembered as if learned: the plan's default is derived again in each session.
    expect(f.kept.store['cache.v1']).toBeUndefined()
    // A fresh context keeps the plan's default.
    rt.cache.resetForContext()
    expect(rt.cache.state.ttl).toEqual({ value: '1h', source: 'plan' })
    // A setting or an environment variable gave this session five minutes: the first long gap shows it.
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    await advance(7 * MIN)
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    expect(rt.cache.state.ttl).toEqual({ value: '5m', source: 'observed' })
  })

  test('the 06:13 case: a fork HIT, then the conversation rebuilds before the old expiry with nothing changed — Keep warm FAILED and pauses, no blame on the server', async () => {
    const f = await started(s => void (s.cache.keepWarm = true), ONE_HOUR)
    const { rt, kept, live, advance } = f
    live.forkRead = 408_000
    await turn(f, rt, [{ prompt: 408_000, read: 0 }])
    const t0 = rt.cache.state.lastRequestAt ?? 0
    await advance(51 * MIN)
    expect(rt.cache.state.keepWarm.log[0]).toMatchObject({ isHit: true, status: 'awaiting', newExpiry: t0 + 110 * MIN })
    // The person is back 55 minutes after the last request: before the old expiry, and the fork said the cache was there.
    await advance(4 * MIN)
    await turn(f, rt, [{ prompt: 412_000, read: 47_633 }])
    const r = rt.cache.state.keepWarm.log[0]
    expect(r).toMatchObject({ status: 'failed', main: { phase: 'before-old-expiry', read: 47_633, changed: [] } })
    expect(rt.cache.state.keepWarm.verified).toBe('no')
    expect(rt.cache.plan).toEqual({ at: null, reason: 'Paused: its last check failed' })
    const miss = Views.paneOf(rt).cache.misses[0]
    expect(miss).toMatchObject({ cause: 'refresh', certainty: 'unknown', severity: 'warn', isPartial: false })
    expect(miss?.label).toBe('Keep warm did not hold it')
    expect(miss?.detail).toContain('cause unknown')
    expect(`${miss?.detail} ${miss?.advice}`.toLowerCase()).not.toContain('server')
    expect(Views.paneOf(rt).cache.keepWarm.main).toBe('failed')
    expect(kept.toasts.some(t => t.startsWith('Keep warm paused: the conversation rebuilt its cache though a refresh had kept it warm'))).toBe(true)
    expect(rt.notes.join(' ')).toContain('Keep warm paused itself: Rebuilt')
    // Turned on again, it tries afresh.
    rt.update(s => void (s.cache.keepWarm = false))
    rt.update(s => void (s.cache.keepWarm = true))
    expect(rt.cache.state.keepWarm.pausedReason).toBeNull()
    expect(rt.cache.plan.at).not.toBeNull()
  })

  test("Claude Code's report that the earlier conversation changed makes the rebuild a proven history change, and leaves Keep warm untested, not failed", async () => {
    const f = await started(s => void (s.cache.keepWarm = true), ONE_HOUR)
    const { rt, live, advance } = f
    live.forkRead = 400_000
    await turn(f, rt, [{ prompt: 400_000, read: 0 }])
    await advance(55 * MIN)
    rt.cache.noteHistoryChanged(rt.clock())
    await turn(f, rt, [{ prompt: 404_000, read: 47_000 }])
    const miss = Views.paneOf(rt).cache.misses[0]
    expect(miss).toMatchObject({ cause: 'history', certainty: 'proven', label: 'Earlier conversation changed' })
    expect(miss?.advice).toContain('Project Sentinel no longer does this itself')
    expect(rt.cache.state.keepWarm.log[0]).toMatchObject({ status: 'untested', main: { changed: ['earlier conversation'] } })
    expect(rt.cache.state.keepWarm.verified).toBe('unknown')
    expect(rt.cache.plan.at).not.toBeNull()
  })

  test('back before the old expiry and the cache read: consistent, not yet a proof; a model change first leaves it untested', async () => {
    const f = await started(s => void (s.cache.keepWarm = true), ONE_HOUR)
    const { rt, advance } = f
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    await advance(52 * MIN)
    await turn(f, rt, [{ prompt: 301_000, read: 300_000 }])
    expect(rt.cache.state.keepWarm.log[0]).toMatchObject({ status: 'consistent', main: { phase: 'before-old-expiry' } })
    expect(rt.cache.state.keepWarm.verified).toBe('unknown')
    expect(Views.paneOf(rt).cache.keepWarm.main).toBe('consistent')
    // Next idle stretch: a refresh, then the person switches model before coming back.
    await advance(52 * MIN)
    expect(rt.cache.state.keepWarm.log[0]?.status).toBe('awaiting')
    rt.onPostModelSwitch({ from_model: OPUS, to_model: 'claude-sonnet-5-5', cache_ttl: '1h', source: 'command' })
    await turn(f, rt, [{ prompt: 301_500, read: 0, model: 'claude-sonnet-5-5' }])
    expect(rt.cache.state.keepWarm.log[0]).toMatchObject({ status: 'untested' })
    expect(rt.cache.state.keepWarm.log[0]?.main?.changed).toContain('model')
    expect(rt.cache.state.keepWarm.verified).toBe('unknown')
  })

  test('a rebuild part-way is called partial, with what it still read; a small shortfall is no rebuild at all', async () => {
    const f = await started(() => undefined, ONE_HOUR)
    const { rt } = f
    await turn(f, rt, [{ prompt: 600_000, read: 0 }])
    // 2,000 tokens short of 600k: under 5% and under the floor that counts.
    await turn(f, rt, [{ prompt: 601_000, read: 598_000 }])
    expect(rt.cache.state.misses).toEqual([])
    await turn(f, rt, [{ prompt: 602_000, read: 255_000 }])
    const miss = Views.paneOf(rt).cache.misses[0]
    expect(miss).toMatchObject({ isPartial: true, read: 255_000, prefix: 601_000, recached: 346_000, cause: 'unexplained', certainty: 'unknown' })
    expect(miss?.label).toBe('Cause unknown')
    expect(`${miss?.detail} ${miss?.advice}`.toLowerCase()).not.toContain('evicted')
  })

  test('each request is fingerprinted: a change of the tools offered between the fork and the next request is named', async () => {
    const f = await started(s => void (s.cache.keepWarm = true), ONE_HOUR)
    const { rt, live, advance } = f
    await turn(f, rt, [{ prompt: 300_000, read: 0 }])
    await flush()
    const before = rt.cache.state.fingerprint
    expect(before).toMatchObject({ model: OPUS, effort: 'high' })
    expect(before?.tools).toMatch(/^[0-9a-f]{8}$/)
    await advance(52 * MIN)
    live.tools = [...live.tools, 'mcp__new__tool']
    await advance(14 * MIN)
    await turn(f, rt, [{ prompt: 302_000, read: 2_000 }])
    expect(rt.cache.state.keepWarm.log[0]).toMatchObject({ status: 'untested' })
    expect(rt.cache.state.keepWarm.log[0]?.main?.changed).toContain('tools offered')
  })
})
