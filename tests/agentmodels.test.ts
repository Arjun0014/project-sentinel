import { describe, expect, test } from 'claude-code/testing'

import { agentModelsOff, defaultSettings, normalizeSettings } from '../hooks/core/settings'
import { type Family, SUGGESTED, categoryOf, decideAgentModel, familyOf, policyFromRouter, tierOf } from '../hooks/features/agentModels'

const HAIKU = 'claude-haiku-4-5-20251001'
const FABLE = 'claude-fable-5-2'
const seen = new Map<Family, string>([
  ['haiku', HAIKU],
  ['sonnet', 'claude-sonnet-5-5'],
  ['opus', 'claude-opus-5-5'],
  ['fable', FABLE],
])
const nothingSeen = new Map<Family, string>()
const none = new Set<string>()
const on = { ...agentModelsOff(), ...SUGGESTED, enabled: true }
const spawn = (patch: Partial<Parameters<typeof decideAgentModel>[0]> = {}) =>
  decideAgentModel({
    policy: on,
    subagentType: 'general-purpose',
    description: 'Implement the parser',
    requested: undefined,
    isFork: false,
    isWorkflow: false,
    parentModel: 'claude-opus-5-5',
    unavailable: none,
    known: seen,
    ...patch,
  })

describe('Agent Model Policy', () => {
  test('a spawn’s kind of work: its agent type first, then the words of its description', () => {
    expect(categoryOf({ subagentType: 'Explore', description: 'Implement the parser' })).toBe('explore')
    expect(categoryOf({ subagentType: 'Plan', description: 'anything' })).toBe('planning')
    expect(categoryOf({ subagentType: 'claude-code-guide', description: 'x' })).toBe('research')
    expect(categoryOf({ subagentType: 'general-purpose', description: 'Security audit of the auth flow' })).toBe('security')
    expect(categoryOf({ subagentType: 'general-purpose', description: 'Find the root cause of the crash' })).toBe('debugging')
    expect(categoryOf({ subagentType: 'general-purpose', description: 'Review the diff' })).toBe('review')
    expect(categoryOf({ subagentType: 'general-purpose', description: 'Design the cache layer' })).toBe('planning')
    expect(categoryOf({ subagentType: 'general-purpose', description: 'Research the docs for /clear' })).toBe('research')
    expect(categoryOf({ subagentType: 'general-purpose', description: 'Locate the config loader' })).toBe('explore')
    expect(categoryOf({ subagentType: 'general-purpose', description: 'Implement the parser' })).toBe('implementation')
    expect(categoryOf({ subagentType: 'general-purpose', description: 'Hello' })).toBe('general')
  })

  test('tiers and families from ids; unknown ids are never assumed cheap', () => {
    expect(tierOf(HAIKU)).toBe(1)
    expect(tierOf('claude-sonnet-5-5')).toBe(2)
    expect(tierOf('claude-opus-5-5')).toBe(3)
    expect(tierOf(FABLE)).toBe(4)
    expect(tierOf('my-gateway-model')).toBe(3)
    expect(familyOf('claude-sonnet-5-5')).toBe('sonnet')
    expect(familyOf('my-gateway-model')).toBeNull()
  })

  test('off, a fork, a workflow’s agent and Claude’s own choice leave the spawn as Claude Code starts it', () => {
    expect(spawn({ policy: agentModelsOff() }).model).toBeNull()
    expect(spawn({ policy: agentModelsOff() }).why).toBe('Agent Model Policy off')
    expect(spawn({ isFork: true }).model).toBeNull()
    expect(spawn({ isWorkflow: true }).model).toBeNull()
    expect(spawn({ requested: 'opus' })).toMatchObject({ model: null, why: 'Claude chose opus for it' })
  })

  test('the suggested policy: search on Haiku, debugging on Opus, implementation on the session’s model, the rest by the agent', () => {
    expect(spawn({ subagentType: 'Explore', description: 'Scan the cache' })).toMatchObject({ model: 'claude-haiku-4-5-20251001', category: 'explore' })
    expect(spawn({ description: 'Debug the failing test' })).toMatchObject({ model: 'claude-opus-5-5', category: 'debugging' })
    expect(spawn({ description: 'Implement the parser', parentModel: 'claude-sonnet-5-5' })).toMatchObject({ model: 'claude-sonnet-5-5', category: 'implementation', why: 'Implementation → the session’s model' })
    expect(spawn({ description: 'Hello' })).toMatchObject({ model: null, category: 'general' })
  })

  test('an alias Claude Code takes at a spawn is used before its id is seen; Fable only once seen answering', () => {
    expect(spawn({ subagentType: 'Explore', known: nothingSeen }).model).toBe('haiku')
    const fable = { ...on, debugging: 'fable' as const }
    expect(spawn({ policy: fable, description: 'Debug it', known: nothingSeen })).toMatchObject({ model: null })
    expect(spawn({ policy: fable, description: 'Debug it', known: nothingSeen }).why).toContain('not seen answering')
    expect(spawn({ policy: fable, description: 'Debug it' }).model).toBe(FABLE)
  })

  test('a family Claude Code refused this session is not asked for again', () => {
    const r = spawn({ subagentType: 'Explore', unavailable: new Set(['haiku']) })
    expect(r.model).toBeNull()
    expect(r.why).toContain('refused by Claude Code this session')
  })

  test('a per-agent-type override outranks the kind of work, matched without case', () => {
    const policy = { ...on, overrides: [{ type: 'code-reviewer', model: 'opus' as const }] }
    expect(spawn({ policy, subagentType: 'Code-Reviewer', description: 'Review the diff' })).toMatchObject({ model: 'claude-opus-5-5', why: 'code-reviewer (your override) → opus' })
  })

  test('1.7’s Model router carries its subagent choices into the policy; its main-conversation routing is gone', () => {
    expect(policyFromRouter(undefined)).toBeNull()
    expect(policyFromRouter({ strategy: 'off' })).toBeNull()
    expect(policyFromRouter({ strategy: 'economy', subagents: false })).toBeNull()
    expect(policyFromRouter({ strategy: 'balanced', mainLoop: true, subagents: true })).toMatchObject({ enabled: true, explore: 'haiku', planning: 'session', general: 'sonnet', implementation: 'agent' })
    expect(policyFromRouter({ strategy: 'custom', custom: { explore: 'sonnet', plan: 'opus', general: 'nonsense' } })).toMatchObject({ explore: 'sonnet', planning: 'opus', general: 'agent' })
  })

  test('stored settings: a 1.7 store’s router migrates once; a 1.8 store’s policy is kept as it is', () => {
    const old = { ...(defaultSettings() as unknown as Record<string, unknown>), agentModels: undefined, router: { strategy: 'economy', mainLoop: true, subagents: true, custom: {} } }
    const migrated = normalizeSettings(old)
    expect(migrated.agentModels).toMatchObject({ enabled: true, explore: 'haiku', planning: 'sonnet', general: 'haiku' })
    expect('router' in migrated).toBe(false)
    const kept = normalizeSettings({ ...defaultSettings(), agentModels: { ...agentModelsOff(), review: 'sonnet', overrides: [{ type: 'x', model: 'opus' }, { type: '', model: 'opus' }, { type: 'y', model: 'gpt' }] } })
    expect(kept.agentModels).toMatchObject({ enabled: false, review: 'sonnet', overrides: [{ type: 'x', model: 'opus' }, { type: 'y', model: 'agent' }] })
    // A fresh install: the policy is off (the person did not ask for it); the suggestion is offered when it is turned on.
    expect(defaultSettings().agentModels.enabled).toBe(false)
  })
})
