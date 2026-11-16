import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import { modelsCommand } from '../hooks/app/commands'
import * as Views from '../hooks/app/views'
import { classicSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { compareModels, effortRebuilds, requestChange, switchVerdict } from '../hooks/features/modelGuard'
import { fakeHost } from './fixtures/fake-host'

const MIN = 60_000
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const OLD_OPUS = 'claude-opus-4-1-20250805'

type Fake = ReturnType<typeof fakeHost>

const ONE_HOUR = { v: 1, ttl: '1h', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }

async function started(patch: (s: Settings) => void = () => undefined) {
  const f = fakeHost()
  const s = classicSettings()
  patch(s)
  f.kept.store['settings.v1'] = s
  f.kept.store['cache.v1'] = ONE_HOUR
  f.live.usage = { ...f.live.usage, context: { tokens: 300_000, window: 1_000_000, percent: 30 } }
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { rt, ...f }
}

let turns = 0

/** One main turn of one request, `prompt` tokens long, `read` of them from the cache, on `model` at `effort`. */
async function turn(f: Fake, rt: Runtime, r: { prompt: number; read: number; model?: string; effort?: 'low' | 'medium' | 'high' }): Promise<void> {
  const turnId = `m${++turns}`
  rt.onTurnStart({ turnId, text: 'Carry on.' })
  const e = { turnId, index: 0, model: r.model ?? OPUS, effort: r.effort ?? ('high' as const), messageCount: 3 }
  const sent = rt.stepRequest(e)
  await f.advance(2000)
  rt.stepResponse(e, sent, {
    turnId,
    index: 0,
    answer: '',
    toolUses: [],
    stopReason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: r.read, cache_creation_input_tokens: Math.max(0, r.prompt - r.read - 100), model: r.model ?? OPUS },
  })
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
  await f.advance(10)
}

const switchEvent = (source: 'command' | 'picker' | 'sdk', to = SONNET) => ({
  from_model: OPUS,
  to_model: to,
  requested_model: null,
  source,
  context_tokens: 300_000,
  prompt_cache_warm: true,
  cache_ttl: '1h' as const,
  estimated_cache_write_usd: 1.2,
  pricing: 'catalog' as const,
})

const message = (text: string, kind: 'composer' | 'sdk' | 'task-notification' = 'sdk') => ({ text, origin: { kind } as never })

describe('the model / effort cache guard, pure', () => {
  test('model ids compare without the window suffix; an alias of the same family is inconclusive, never asked on', () => {
    expect(compareModels('claude-opus-5-5[1m]', OPUS)).toBe('same')
    expect(compareModels(OPUS, SONNET)).toBe('different')
    expect(compareModels('opus', OPUS)).toBe('inconclusive')
    expect(compareModels('sonnet', OPUS)).toBe('different')
    expect(compareModels('', OPUS)).toBe('inconclusive')
  })

  test('effort: the models Claude Code documents as keeping their cache, what this machine learned, and the rest', () => {
    expect(effortRebuilds('claude-fable-5-2', false)).toBe('no')
    expect(effortRebuilds('claude-fable-5-1', false)).toBe('no')
    expect(effortRebuilds(OPUS, false)).toBe('no')
    expect(effortRebuilds('claude-haiku-5-5', false)).toBe('no')
    expect(effortRebuilds(OLD_OPUS, false)).toBe('likely')
    expect(effortRebuilds('claude-sonnet-4-5-20250929', false)).toBe('likely')
    expect(effortRebuilds('claude-fable-5-0', false)).toBe('likely')
    expect(effortRebuilds(OPUS, true)).toBe('yes')
  })

  test('layer 3 names what the request changes; layer 2 says in words why it did or did not arm', () => {
    const base = { cachedTokens: 300_000, isWarm: true, isEffortLearned: false, threshold: 100_000 }
    expect(requestChange({ ...base, last: { model: OPUS, effort: 'high' }, model: OPUS, effort: 'high' })).toBeNull()
    expect(requestChange({ ...base, last: { model: OPUS, effort: 'high' }, model: SONNET, effort: 'medium' })).toMatchObject({ cause: 'model', rebuilds: 'yes', isCostly: true })
    expect(requestChange({ ...base, last: { model: OPUS, effort: 'high' }, model: OPUS, effort: 'low' })).toMatchObject({ cause: 'effort', rebuilds: 'no', isCostly: false })
    expect(requestChange({ ...base, last: { model: OLD_OPUS, effort: 'high' }, model: OLD_OPUS, effort: 'low' })).toMatchObject({ cause: 'effort', rebuilds: 'likely', isCostly: true })
    const sw = { isOn: true, sessionModel: SONNET, cacheModel: OPUS, cachedTokens: 300_000, isWarm: true, threshold: 100_000, confirmed: null }
    expect(switchVerdict(sw)).toMatchObject({ isArmed: true, from: OPUS, to: SONNET })
    expect(switchVerdict({ ...sw, isOn: false }).line).toContain('the model switch guard is off')
    expect(switchVerdict({ ...sw, cacheModel: null }).line).toContain('no request in this context yet')
    expect(switchVerdict({ ...sw, sessionModel: '' }).line).toContain('unavailable')
    expect(switchVerdict({ ...sw, sessionModel: OPUS }).line).toContain('still on')
    expect(switchVerdict({ ...sw, sessionModel: 'opus' }).line).toContain('inconclusive')
    expect(switchVerdict({ ...sw, confirmed: { from: OPUS, to: SONNET } }).line).toContain('already confirmed')
    expect(switchVerdict({ ...sw, isWarm: false }).line).toContain('not warm')
    expect(switchVerdict({ ...sw, cachedTokens: 50_000 }).line).toContain('under 100k')
  })
})

describe('the model / effort cache guard in the runtime', () => {
  test('Desktop’s model picker (a set_model switch, source sdk) is caught at the next message, before it re-sends the warm cache', async () => {
    // 1.7.0: a switch from Desktop, Remote Control or an IDE reaches PreModelSwitch as `sdk`, which was let through
    // unasked, and nothing else looked: a 300k warm cache was re-sent to the other model with no word.
    const f = await started()
    const { rt, kept, live, advance } = f
    await turn(f, rt, { prompt: 300_000, read: 0 })
    expect(rt.onPreModelSwitch(switchEvent('sdk'))).toBeNull()
    expect(kept.traces.some(t => t.includes('PreModelSwitch') && t.includes('not asked: a sdk switch has no documented dialog'))).toBe(true)
    rt.onPostModelSwitch(switchEvent('sdk'))
    live.model = SONNET
    live.answer = 'Cancel'
    const held = await rt.ops.coldGuard(message('Now wire the parser in.'))
    expect(held).toEqual({ drop: 'Not sent. Your message is back in the prompt box.' })
    const q = kept.asked.at(-1)
    expect(q?.header).toBe('Model switch')
    expect(q?.question).toContain('The model changed from opus-5-5 to sonnet-5-5 while this context’s 300k-token prompt cache is warm on opus-5-5')
    expect(q?.options).toEqual(expect.arrayContaining(['Switch back', 'Send anyway', 'Cancel']))
    expect(kept.traces.some(t => t.startsWith('model guard: at the message: armed'))).toBe(true)
    await advance(500)
    expect(kept.filled).toContain('Now wire the parser in.')
    // Send anyway: the message goes on the new model, and the same switch is not asked about again.
    live.answer = 'Send anyway'
    expect(await rt.ops.coldGuard(message('Now wire the parser in.'))).toBeNull()
    const asked = kept.asked.length
    expect(await rt.ops.coldGuard(message('And the tests.'))).toBeNull()
    expect(kept.asked.length).toBe(asked)
  })

  test('Switch back runs Claude Code’s /model, then sends the message exactly once, as the person’s', async () => {
    const f = await started()
    const { rt, kept, live, advance } = f
    await turn(f, rt, { prompt: 300_000, read: 0 })
    live.model = SONNET
    live.answer = 'Switch back'
    const held = await rt.ops.coldGuard(message('Keep going.'))
    expect(held?.drop).toBe('Switching back to opus-5-5 (the warm cache’s model): your message is sent after.')
    expect(kept.submittedAsUser).toEqual([])
    await advance(2000)
    expect(kept.commands).toContain(`model ${OPUS}`)
    expect(live.model).toBe(OPUS)
    expect(kept.submittedAsUser).toEqual(['Keep going.'])
    await advance(5000)
    expect(kept.submittedAsUser).toEqual(['Keep going.'])
    // Back on the cache's model: the next message is not asked about.
    const asked = kept.asked.length
    expect(await rt.ops.coldGuard(message('Next.'))).toBeNull()
    expect(kept.asked.length).toBe(asked)
  })

  test('a /model switch confirmed in Claude Code’s own dialog is not asked about again at the message', async () => {
    const f = await started()
    const { rt, kept, live } = f
    await turn(f, rt, { prompt: 300_000, read: 0 })
    expect(rt.onPreModelSwitch(switchEvent('command'))).toContain('re-sends 300k cached tokens uncached')
    rt.onPostModelSwitch(switchEvent('command'))
    live.model = SONNET
    expect(await rt.ops.coldGuard(message('Go on.', 'composer'))).toBeNull()
    expect(kept.asked).toEqual([])
    expect(kept.traces.some(t => t.includes('already confirmed'))).toBe(true)
  })

  test('the main request’s model or effort, before it goes: traced, and a large rebuild nobody confirmed is said once', async () => {
    const f = await started(s => void (s.ui.toasts = true))
    const { rt, kept } = f
    await turn(f, rt, { prompt: 300_000, read: 0 })
    // An effort change on a model Claude Code documents as keeping its cache: traced, nothing said.
    await turn(f, rt, { prompt: 301_000, read: 300_000, effort: 'low' })
    expect(kept.traces.some(t => t.startsWith('model guard: before the request: effort high → low on claude-opus-5-5: Claude Code documents'))).toBe(true)
    const toasts = kept.toasts.length
    // A model change no layer could ask about (a queued message, a scheduled run): said as it goes.
    rt.onTurnStart({ turnId: 'q1', text: 'scheduled' })
    expect(rt.stepRequest({ turnId: 'q1', index: 0, model: SONNET, effort: 'low', messageCount: 3 }).model).toBeUndefined()
    expect(kept.traces.some(t => t.startsWith('model guard: before the request: the request goes to claude-sonnet-5-5'))).toBe(true)
    expect(kept.toasts.slice(toasts)).toEqual(['Model changed to sonnet-5-5 where Control Room could not ask first: this request re-sends 301k cached tokens uncached.'])
    expect(Views.paneOf(rt).models.guard?.line).toContain('a prompt cache belongs to one model')
  })

  test('Cold Resume audit: every message says why the guard did or did not arm, and a host that attached late is looked at again', async () => {
    const f = await started()
    const { rt, kept, live, advance } = f
    await turn(f, rt, { prompt: 300_000, read: 0 })
    const last = () => kept.traces.filter(t => t.startsWith('cold resume:')).at(-1) ?? ''
    expect(await rt.ops.coldGuard(message('A task ended.', 'task-notification'))).toBeNull()
    expect(last()).toContain('did not arm: a task-notification message is not the person’s own')
    expect(await rt.ops.coldGuard(message('Warm still.'))).toBeNull()
    expect(kept.traces.some(t => t.startsWith('cold resume: did not arm: the cache is not known to have lapsed') && t.includes('warm until'))).toBe(true)
    // Desktop: no surface was known at load; the guard reads them again rather than giving up.
    rt.surfaces = []
    live.surfaces = ['desktop']
    await advance(70 * MIN)
    live.answer = 'Cancel'
    expect((await rt.ops.coldGuard(message('Back again.'))) ?.drop).toBe('Not sent. Your message is back in the prompt box.')
    expect(kept.traces).toContain('cold resume: surfaces read again: desktop')
    expect(kept.traces.some(t => t.startsWith('cold resume: armed: 300100 tokens to re-read') || t.startsWith('cold resume: armed:'))).toBe(true)
    expect(kept.asked.at(-1)?.header).toBe('Cache cold')
    // Lapsed and switched: one question, the cold one, which says the model changed too.
    live.model = SONNET
    await rt.ops.coldGuard(message('Again.'))
    expect(kept.asked.at(-1)?.question).toContain('The model also changed (opus-5-5 → sonnet-5-5)')
    // Headless: nobody to ask, said so.
    rt.surfaces = []
    live.surfaces = []
    expect(await rt.ops.coldGuard(message('Headless.'))).toBeNull()
    expect(last()).toBe('cold resume: guard did not arm: no surface to ask on (a headless session)')
  })

  test('agents: the policy sets a spawn’s model by its kind of work, records the decision, and learns a refused family', async () => {
    const f = await started(s => void (s.agentModels = { ...s.agentModels, enabled: true, explore: 'haiku', debugging: 'opus' }))
    const { rt, kept } = f
    const spawn = (patch: Record<string, unknown> = {}) =>
      ({ tool_use_id: 'tu-1', prompt: 'p', description: 'Scan the cache', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: OPUS, background: true, fork: false, ...patch }) as never
    const one = await rt.onAgentSpawn(spawn())
    expect(one.model).toBe('haiku')
    expect(rt.models.decisions.at(-1)).toMatchObject({ agent: 'Explore: Scan the cache', model: 'haiku', why: 'Explore / search → haiku' })
    expect(kept.traces).toContain('agent models: Explore: Scan the cache → haiku (Explore / search → haiku)')
    // A fork runs on its parent's model whatever the policy says.
    expect((await rt.onAgentSpawn(spawn({ tool_use_id: 'tu-2', fork: true, subagentType: 'fork' }))).model).toBeUndefined()
    // The engine refused the model it was given: that family is not asked for again this session.
    rt.onAgentSpawned(spawn(), { model: 'haiku', agentId: 'a1' } as never, true, 'haiku')
    rt.stepResponse({ turnId: 'x', index: 0, model: 'haiku', messageCount: 1, agentId: 'a1' } as never, {}, { turnId: 'x', index: 0, answer: '', toolUses: [], stopReason: null, usage: null } as never)
    expect([...rt.models.unavailable]).toEqual(['haiku'])
    expect((await rt.onAgentSpawn(spawn({ tool_use_id: 'tu-3' }))).model).toBeUndefined()
    expect(rt.models.decisions.at(-1)?.why).toContain('refused by Claude Code this session')
  })

  test('/cr models reads the main model (never switched) and sets the policy; /cr router says it was removed', async () => {
    const f = await started()
    const { rt } = f
    expect(modelsCommand(rt, [])).toContain('Main conversation: claude-opus-5-5. Control Room never switches it')
    expect(modelsCommand(rt, ['on'])).toContain('Agent Model Policy on')
    expect(rt.settings.agentModels).toMatchObject({ enabled: true, explore: 'haiku', debugging: 'opus', implementation: 'session' })
    expect(modelsCommand(rt, ['review', 'opus'])).toBe('Review / QA agents: opus.')
    expect(modelsCommand(rt, ['type', 'code-reviewer', 'sonnet'])).toBe('Agents of type code-reviewer run on sonnet.')
    expect(rt.settings.agentModels.overrides).toEqual([{ type: 'code-reviewer', model: 'sonnet' }])
    expect(modelsCommand(rt, ['type', 'code-reviewer', 'clear'])).toContain('follow the policy')
    expect(modelsCommand(rt, ['nonsense', 'x'])).toContain('Usage: /cr models')
    expect((await rt.runCommand('router economy')).text).toContain('The model router was removed in 1.8')
  })
})
