import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { classicSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { type CacheState, FIVE_MINUTE_IDLE_CAP_MS, emptyCache, keepWarmTiming, nextRefresh, observeRequest, withTtl } from '../hooks/features/cache'
import { keepWarmTimingLines } from '../hooks/ui/pane/cache'
import { fakeHost } from './fixtures/fake-host'

// 1.8.0: Keep warm's two clocks, said plainly. The cache's lifetime (TTL) is renewed by each request or refresh
// that reads it; the idle allowance ("Stop after 3 h") counts from the last turn's end and a refresh never resets
// it. While Claude works the allowance has not started. A 5-minute cache caps the allowance; a watcher can hold
// the cache past it. Both differences are said.

const MIN = 60_000
const T0 = 1_000_000_000

function cached(ttl: '5m' | '1h', at = T0): CacheState {
  const s = withTtl(emptyCache(), ttl, 'engine')
  return observeRequest(s, { at, input: 200, read: 0, written: 300_000, model: 'claude-opus-5-5', effort: 'high' }).state
}

const timing = (state: CacheState, input: Partial<Parameters<typeof keepWarmTiming>[1]> & { now: number }) => {
  const base = { isOn: true, isTurnRunning: false, idleSince: T0, maxIdleMinutes: 180, hold: null }
  const all = { ...base, ...input }
  const plan = input.plan ?? nextRefresh(state, { now: all.now, isOn: all.isOn, isTurnRunning: all.isTurnRunning, contextTokens: 300_000, minTokens: 20_000, idleSince: all.idleSince, maxIdleMs: all.maxIdleMinutes * MIN, standDown: null, holdUntil: all.hold?.until ?? null })
  return keepWarmTiming(state, { ...all, plan })
}

describe('Keep warm timing, pure', () => {
  test('while Claude works: ready, the countdown not started', () => {
    const t = timing(cached('1h'), { now: T0 + MIN, isTurnRunning: true, idleSince: null })
    expect(t.phase).toBe('ready')
    expect(t.headline).toBe('Ready: starts when this turn finishes, then holds the cache for up to 3 h of idle time. The countdown has not started.')
    expect(t.stopsAt).toBeNull()
    expect(t.leftMs).toBeNull()
  })

  test('idle: idle for, left, started at, stops at, the next refresh and the cache’s own expiry', () => {
    const t = timing(cached('1h'), { now: T0 + 20 * MIN })
    expect(t).toMatchObject({ phase: 'idle', idleSince: T0, idleForMs: 20 * MIN, stopsAt: T0 + 180 * MIN, leftMs: 160 * MIN, nextRefreshAt: T0 + 50 * MIN, expiresAt: T0 + 60 * MIN, ttl: '1h', capWhy: null })
    expect(t.headline).toBe('Holding the cache: idle 20 min, 2 h 40 min of Keep warm left')
    const lines = keepWarmTimingLines(t, T0 + 20 * MIN).map(l => [l.left, l.right ?? ''].join(' | '))
    expect(lines).toContain('Idle for 20 min | Keep warm left 2h 40m')
    expect(lines.some(l => l.startsWith('Next refresh') && l.includes('(in 30m)') && l.includes('Cache expires in 40m without one'))).toBe(true)
  })

  test('a refresh renews the cache’s lifetime; the idle allowance keeps counting from the turn’s end', () => {
    let s = cached('1h')
    s = observeRequest(s, { at: T0 + 50 * MIN, input: 200, read: 300_000, written: 0, model: 'claude-opus-5-5', effort: 'high', isRefresh: true }).state
    const t = timing(s, { now: T0 + 51 * MIN })
    expect(t.expiresAt).toBe(T0 + 110 * MIN)
    expect(t.idleSince).toBe(T0)
    expect(t.stopsAt).toBe(T0 + 180 * MIN)
    expect(t.leftMs).toBe(129 * MIN)
  })

  test('the 5-minute cache caps the allowance below the one asked for, and says why', () => {
    const t = timing(cached('5m'), { now: T0 + 10 * MIN, maxIdleMinutes: 480 })
    expect(t).toMatchObject({ requestedMs: 480 * MIN, effectiveMs: FIVE_MINUTE_IDLE_CAP_MS, stopsAt: T0 + FIVE_MINUTE_IDLE_CAP_MS })
    expect(t.capWhy).toContain('the cache lives 5 minutes')
    const lines = keepWarmTimingLines(t, T0 + 10 * MIN).map(l => l.left)
    expect(lines).toContain('Requested 8 h · Effective 45 min')
  })

  test('a watcher holding the cache past the allowance: stops at its wake, and says so', () => {
    const hold = { until: T0 + 200 * MIN, label: 'W-1: the render' }
    const t = timing(cached('1h'), { now: T0 + 130 * MIN, maxIdleMinutes: 120, hold })
    expect(t.phase).toBe('idle')
    expect(t.stopsAt).toBe(T0 + 201 * MIN)
    const lines = keepWarmTimingLines(t, T0 + 130 * MIN).map(l => l.left)
    expect(lines.some(l => l.startsWith('Requested idle limit 2 h · Watcher holds until'))).toBe(true)
    expect(lines).toContain('Reason: warm watcher resume (W-1: the render)')
  })

  test('past the allowance: stopped, with the plan’s own reason; off says off', () => {
    const t = timing(cached('1h'), { now: T0 + 181 * MIN })
    expect(t.phase).toBe('stopped')
    expect(t.headline).toContain('Stopped: paused after 3 h idle')
    expect(t.leftMs).toBe(0)
    expect(timing(cached('1h'), { now: T0, isOn: false }).phase).toBe('off')
  })
})

describe('Keep warm timing in the runtime', () => {
  test('the timer follows real turns and refreshes: idle from the turn’s end, unchanged by a refresh; the cache’s expiry moves', async () => {
    const f = fakeHost()
    const s: Settings = { ...classicSettings(), cache: { ...classicSettings().cache, keepWarm: true, maxIdleMinutes: 180 } }
    f.kept.store['settings.v1'] = s
    f.kept.store['cache.v1'] = { v: 1, ttl: '1h', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }
    f.live.usage = { ...f.live.usage, context: { tokens: 300_000, window: 1_000_000, percent: 30 } }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    rt.onTurnStart({ turnId: 'k1', text: 'Carry on.' })
    expect(Views.paneOf(rt).cache.keepWarm.timing.phase).toBe('ready')
    const e = { turnId: 'k1', index: 0, model: 'claude-opus-5-5', effort: 'high' as const, messageCount: 3 }
    const sent = rt.stepRequest(e)
    await f.advance(2000)
    rt.stepResponse(e, sent, { turnId: 'k1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 300_000, model: 'claude-opus-5-5' } })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    const ended = rt.clock()
    const before = Views.paneOf(rt).cache.keepWarm.timing
    expect(before).toMatchObject({ phase: 'idle', idleSince: ended, stopsAt: ended + 180 * MIN })
    const firstExpiry = before.expiresAt ?? 0
    await f.advance(51 * MIN)
    expect(f.kept.forks.length).toBe(1)
    const after = Views.paneOf(rt).cache.keepWarm.timing
    expect(after.idleSince).toBe(ended)
    expect(after.stopsAt).toBe(ended + 180 * MIN)
    expect(after.refreshes).toBe(1)
    expect(after.expiresAt).toBeGreaterThan(firstExpiry)
  })
})

describe('a context figure not yet proven in this context', () => {
  test('after a reload the last figure is drawn with “~” until a request of this context proves it', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = classicSettings()
    f.live.usage = { ...f.live.usage, context: { tokens: 300_000, window: 1_000_000, percent: 30 } }
    // A runtime loaded mid-session (a plugin reload): no boundary was seen, so the session's figure is not this context's proof.
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    const hud = Views.hudOf(rt)
    expect(hud.ctx).toMatchObject({ tokens: 300_000, isProvisional: true })
    // A request made and answered in this context proves its size: drawn plain from then on.
    rt.onTurnStart({ turnId: 'p1', text: 'Carry on.' })
    const e = { turnId: 'p1', index: 0, model: 'claude-opus-5-5', effort: 'high' as const, messageCount: 3 }
    const sent = rt.stepRequest(e)
    await f.advance(2000)
    rt.stepResponse(e, sent, { turnId: 'p1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 310_000, model: 'claude-opus-5-5' } })
    expect(Views.hudOf(rt).ctx).toMatchObject({ isProvisional: false, tokens: 310_150 })
  })
})
