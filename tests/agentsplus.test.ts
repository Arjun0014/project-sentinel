import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import { modelsCommand } from '../hooks/app/commands'
import * as Views from '../hooks/app/views'
import { classicSettings } from '../hooks/core/settings'
import { type AgentLedger, agentRows, bandOf, modelWord, noteCompaction, noteEnd, noteHookStart, noteHookStop, noteSpawn, noteStep, restoreLedger } from '../hooks/features/agents'
import { DOCUMENTED_MODELS, advisorLine, configuredOf, modelsFromHint, modelsFromReply, noFacts, pairing } from '../hooks/features/advisor'
import { emptyText } from '../hooks/ui/pane/agents'
import { fakeHost } from './fixtures/fake-host'

// 1.8.0: agents as Claude Code reports them through every channel it has. The spawn and the list (1.7.0), plus
// SubagentStart/Stop (an agent whose spawn this runtime never saw: one that began before a reload, or one a
// hook frame started), each agent's own compactions and effort, Resume (Claude Code resumes a finished
// subagent when it is sent a message), and "No subagents" said only when nothing at all was seen.

const spawn = (agentId: string, patch: Partial<Parameters<typeof noteSpawn>[1]> = {}) => ({
  agentId,
  at: 1000,
  model: 'claude-sonnet-5-5',
  isBackground: true,
  isFork: false,
  description: `Task ${agentId}`,
  type: 'general-purpose',
  name: null,
  parentId: null,
  ...patch,
})

describe('the agent ledger: more evidence', () => {
  test('SubagentStart makes a row for an agent whose spawn was never seen; one still starting runs from it', () => {
    const ledger: AgentLedger = new Map()
    expect(noteHookStart(ledger, { agentId: 'h1', type: 'Explore', at: 2000 })).toBe(true)
    expect(agentRows(ledger, [], 2500)[0]).toMatchObject({ id: 'h1', type: 'Explore', status: 'running', source: 'hook', startedAt: 2000 })
    noteSpawn(ledger, spawn('s1'))
    expect(noteHookStart(ledger, { agentId: 's1', type: 'general-purpose', at: 3000 })).toBe(false)
    expect(ledger.get('s1')?.status).toBe('running')
    expect(ledger.get('s1')?.source).toBe('spawn')
  })

  test('as seen live on 2.1.325: SubagentStart comes inside the spawn, before its id is known; the spawn then owns the row, still running', () => {
    const ledger: AgentLedger = new Map()
    expect(noteHookStart(ledger, { agentId: 'a7', type: 'general-purpose', at: 1000 })).toBe(true)
    noteSpawn(ledger, spawn('a7', { description: 'Review the README wording', at: 1001 }))
    expect(agentRows(ledger, [], 1500)[0]).toMatchObject({ id: 'a7', source: 'spawn', status: 'running', description: 'Review the README wording', startedAt: 1000 })
  })

  test('SubagentStop ends an agent whose end was not seen, with its last message; an end already seen stands', () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, spawn('a1'))
    expect(noteHookStop(ledger, { agentId: 'a1', type: 'general-purpose', lastMessage: '## Found it\nThe cache key misses the effort.', at: 5000 })).toBe(true)
    expect(ledger.get('a1')).toMatchObject({ status: 'completed', result: 'Found it', endedAt: 5000 })
    noteSpawn(ledger, spawn('a2'))
    noteEnd(ledger, 'a2', { at: 4000, reason: 'error', answer: '' })
    expect(noteHookStop(ledger, { agentId: 'a2', type: 'general-purpose', lastMessage: 'late', at: 6000 })).toBe(false)
    expect(ledger.get('a2')).toMatchObject({ status: 'failed', endedAt: 4000, result: 'Ended with an error' })
    // Never seen at all: an ended row, so the panel shows what ran.
    expect(noteHookStop(ledger, { agentId: 'x9', type: 'Plan', lastMessage: 'Plan written.', at: 7000 })).toBe(true)
    expect(ledger.get('x9')).toMatchObject({ status: 'completed', type: 'Plan', result: 'Plan written.', source: 'hook' })
  })

  test('an agent’s own compactions and effort are noted on its row; an unknown id (an engine fork) is left out', () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, spawn('a1'))
    expect(noteStep(ledger, 'a1', 1500, 'claude-sonnet-5-5', 'high')).toBe(true)
    expect(noteCompaction(ledger, 'a1', { at: 2000, tokensAfter: 41_000 })).toBe(true)
    expect(noteCompaction(ledger, 'a1', { at: 3000 })).toBe(true)
    expect(noteCompaction(ledger, 'fork-1', { at: 3000 })).toBe(false)
    expect(agentRows(ledger, [], 3500)[0]).toMatchObject({ effort: 'high', compactions: 2, compactedAt: 3000, compactedTo: null })
    expect(ledger.has('fork-1')).toBe(false)
  })

  test('Resume: a finished subagent this session saw end, never a workflow’s agent, a fork, a teammate or one no longer listed', () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, spawn('done'))
    noteEnd(ledger, 'done', { at: 2000, reason: 'answer', answer: 'Done.' })
    noteSpawn(ledger, spawn('fork', { isFork: true }))
    noteEnd(ledger, 'fork', { at: 2000, reason: 'answer', answer: 'Done.' })
    noteSpawn(ledger, spawn('wf', { workflow: { runId: 'wf_1', index: 0 } }))
    noteEnd(ledger, 'wf', { at: 2000, reason: 'answer', answer: 'Done.' })
    noteSpawn(ledger, spawn('live'))
    const rows = new Map(agentRows(ledger, [], 3000).map(r => [r.id, r]))
    expect(rows.get('done')?.canResume).toBe(true)
    expect(rows.get('fork')?.canResume).toBe(false)
    expect(rows.get('wf')?.canResume).toBe(false)
    expect(rows.get('live')?.canResume).toBe(false)
  })

  test('a reload keeps the new facts; the band names each agent’s model', () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, spawn('a1', { model: 'claude-haiku-4-5-20251001' }))
    noteStep(ledger, 'a1', 1500, undefined, 'medium')
    noteCompaction(ledger, 'a1', { at: 2000, tokensAfter: 30_000 })
    const again: AgentLedger = new Map()
    expect(restoreLedger(again, JSON.parse(JSON.stringify([...ledger.values()])))).toBe(1)
    expect(again.get('a1')).toMatchObject({ effort: 'medium', compactions: 1, compactedAt: 2000, compactedTo: 30_000, source: 'spawn' })
    expect(bandOf(agentRows(again, [], 2500), 2500)?.lines[0]?.model).toBe('Haiku')
    expect(modelWord('my-gateway')).toBe('my-gateway')
    expect(modelWord(null)).toBeNull()
  })

  test('“No subagents in this context” only when nothing was seen at all', () => {
    expect(emptyText({ unnamedLoops: 0 }, 0)).toBe('No subagents in this context.')
    expect(emptyText({ unnamedLoops: 0 }, 2)).toBe('No subagent is running now.')
    expect(emptyText({ unnamedLoops: 2 }, 0)).toContain('Claude Code reported calls from 2 loops it cannot name')
  })
})

async function started() {
  const f = fakeHost()
  f.kept.store['settings.v1'] = classicSettings()
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { rt, ...f }
}

describe('agents in the runtime: every channel', () => {
  test('a SubagentStart for an agent whose spawn was not seen shows it at once; its calls, effort and compaction follow', async () => {
    const { rt, kept, advance } = await started()
    rt.ops.noteSubagentStart('h1', 'Explore')
    expect(Views.hudOf(rt).agentBand?.lines[0]).toMatchObject({ id: 'h1', status: 'running' })
    expect(kept.traces).toContain('agents: SubagentStart for h1 (Explore), whose spawn was not seen here: shown from the hook')
    rt.stepRequest({ turnId: 't', index: 0, model: 'claude-haiku-4-5-20251001', effort: 'low', messageCount: 2, agentId: 'h1' } as never)
    rt.ops.noteAgentCompaction('h1', 25_000)
    const row = rt.ops.view().agents.find(a => a.id === 'h1')
    expect(row).toMatchObject({ model: 'claude-haiku-4-5-20251001', effort: 'low', compactions: 1, compactedTo: 25_000 })
    rt.ops.noteSubagentStop('h1', 'Explore', 'Three call sites.')
    expect(kept.traces).toContain('agents: SubagentStop for h1 (Explore): ended with its last message')
    await advance(10)
    expect(rt.ops.view().agents.find(a => a.id === 'h1')).toMatchObject({ status: 'completed', result: 'Three call sites.', canResume: true })
  })

  test('a SubagentStart while a spawn is settling is that spawn: no "not seen" claim in the debug log', async () => {
    const { rt, kept } = await started()
    rt.agents.inFlight = 1
    rt.ops.noteSubagentStart('a7', 'general-purpose')
    expect(kept.traces).toContain('agents: SubagentStart for a7 (general-purpose) while its spawn settles: shown from now')
    rt.agents.inFlight = 0
  })

  test('calls from a loop no record names are counted, never made into a row; the panel does not say “No subagents”', async () => {
    const { rt, kept } = await started()
    rt.ops.noteAgentCall('engine-fork-7', 'Reading src/a.ts')
    const view = rt.ops.view()
    expect(view.agents).toEqual([])
    expect(view.unnamedLoops).toBe(1)
    expect(emptyText(view, 0)).toContain('it cannot name')
    expect(kept.traces.some(t => t.includes('a call from loop engine-fork-7, which no spawn, list or SubagentStart named'))).toBe(true)
  })

  test('Resume sends the message to the finished agent’s id (Claude Code resumes it from its transcript)', async () => {
    const { rt, kept } = await started()
    rt.ops.noteSpawn({ agentId: 'a1', model: 'claude-sonnet-5-5', isBackground: false, isFork: false, description: 'Review the diff', type: 'general-purpose', name: null, parentId: null })
    rt.ops.noteAgentEnd('a1', 'answer', 'Two findings.')
    await rt.ops.messageAgent('a1', 'Also check the tests.')
    expect(kept.sentToAgents).toEqual([{ agentId: 'a1', text: 'Also check the tests.' }])
    expect(rt.ops.view().log.at(-1)?.text ?? JSON.stringify(rt.ops.view().log.at(-1))).toContain('Resumed agent a1')
  })
})

describe('Advisor', () => {
  test('what /advisor offers, from its hint; the setting; pairing with the main model', () => {
    expect(modelsFromHint('[fable|opus|sonnet|off]')).toEqual(['fable', 'opus', 'sonnet'])
    expect(modelsFromHint('<model|off>')).toBeNull()
    expect(modelsFromHint(undefined)).toBeNull()
    expect(configuredOf({ advisorModel: 'opus' })).toBe('opus')
    expect(configuredOf({ advisorModel: 'off' })).toBeNull()
    expect(configuredOf({})).toBeNull()
    expect(pairing('opus', 'claude-sonnet-5-5')).toMatchObject({ isPaired: true })
    expect(pairing('sonnet', 'claude-opus-5-5')).toMatchObject({ isPaired: false })
    expect(pairing('gateway-x', 'claude-opus-5-5')).toBeNull()
    expect(advisorLine(noFacts(), '')).toBe('Not looked at yet')
    expect(modelsFromReply('Advisor: off\nUsage: /advisor <fable|opus|sonnet|off>')).toEqual(['fable', 'opus', 'sonnet'])
    expect(modelsFromReply('Advisor: opus')).toBeNull()
  })

  test('as Claude Code lists it (2.1.325, seen live): no hint for plugins: the documented models, unconfirmed, until /advisor’s reply names them', async () => {
    const f = fakeHost()
    f.live.commandList = [{ name: 'advisor', description: 'Let Claude consult a stronger model at key moments', source: 'builtin' as never }]
    f.kept.store['settings.v1'] = classicSettings()
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    expect(rt.advisor).toMatchObject({ available: [...DOCUMENTED_MODELS], isConfirmed: false })
    expect((await rt.runCommand('advisor')).text).toContain('it does not tell plugins which models this account has')
    // The reply to a choice names this account's models: confirmed from then on.
    f.live.advisorTakes = false
    f.host.runAdvisor = async () => ({ text: '/advisor isn’t available for that model.\nUsage: /advisor <opus|sonnet|off>' }) as never
    expect(await rt.setAdvisor('fable')).toContain('Claude Code did not take /advisor fable here')
    expect(rt.advisor).toMatchObject({ available: ['opus', 'sonnet'], isConfirmed: true })
    expect(Views.paneOf(rt).models.advisor.isConfirmed).toBe(true)
  })

  test('read at load; set through Claude Code’s own /advisor and read back; consults counted per context', async () => {
    const f = fakeHost()
    f.live.commandList = [{ name: 'advisor', description: 'Let Claude consult a stronger model at key moments', source: 'builtin' as never, argumentHint: '[fable|opus|sonnet|off]' }]
    f.kept.store['settings.v1'] = classicSettings()
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    expect(rt.advisor).toMatchObject({ isListed: true, available: ['fable', 'opus', 'sonnet'], configured: null })
    expect(Views.paneOf(rt).models.advisor.line).toBe('Off')
    expect(await rt.setAdvisor('haiku')).toBe('Claude Code’s /advisor offers fable, opus, sonnet, off here.')
    expect(await rt.setAdvisor('opus')).toContain('Advisor: opus.')
    expect(f.kept.commands).toContain('advisor opus')
    expect(rt.advisor.configured).toBe('opus')
    // Consulted: a request whose server tool calls include the advisor, in the main loop and in an agent's.
    const result = (n: number) => ({ turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null, serverToolUses: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: 'advisor', input: {} })) }) as never
    rt.stepResponse({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 2 } as never, {}, result(2))
    rt.stepResponse({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 2, agentId: 'a1' } as never, {}, result(1))
    expect(Views.paneOf(rt).models.advisor).toMatchObject({ uses: 2, agentUses: 1, line: 'opus · used 3× in this context' })
    // Where Claude Code does not take it, the setting says so, and the person is told to run it.
    f.live.advisorTakes = false
    expect(await rt.setAdvisor('sonnet')).toContain('Claude Code did not take /advisor sonnet here')
    expect(rt.advisor.lastSet).toMatchObject({ to: 'sonnet', outcome: 'not-applied' })
    expect(rt.advisor.configured).toBe('opus')
  })

  test('not offered here: nothing is set, and it says so', async () => {
    const { rt, kept } = await started()
    expect(rt.advisor).toMatchObject({ isListed: true, available: null })
    expect(await rt.setAdvisor('opus')).toBe('Claude Code offers no advisor in this session (its /advisor command is not listed here).')
    expect(kept.commands.filter(c => c.startsWith('advisor'))).toEqual([])
    expect((await rt.runCommand('advisor')).text).toContain('Claude Code lists no /advisor in this session')
    expect(modelsCommand(rt, [])).toContain('Main conversation')
  })
})
