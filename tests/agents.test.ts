import { describe, expect, test } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'

import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { type AgentLedger, OMIT_MS, agentRows, bandOf, doingWord, limitCount, noteCall, noteEnd, notePlan, noteSpawn, noteWorkflowEnd, reconcile, restoreLedger } from '../hooks/features/agents'
import { defaultSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { hierarchyOf } from '../hooks/ui/pane/agents'
import { fakeHost } from './fixtures/fake-host'
import { SESSION, world } from './fixtures/world'

// Agents as first-class citizens (1.7.0). The bugs, from the code and a live probe on Claude Code 2.1.296:
// Sentinel looked at `$.agent.list()` only, before a spawn (the agent not started yet) and polled only once
// the list already showed a running agent, so a foreground agent stayed invisible until its Agent call
// returned; a workflow's agents are never in the list at all; and two spawns at once both saw 0 running
// against a limit. Seen live: a background agent is listed right after its spawn resolves; a workflow agent
// never is, but its loop's events and its `turn.complete` carry its id; a nested agent's spawn carries
// `parentAgentId`; completed agents stay listed a while, then are dropped.

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

const listed = (id: string, status = 'running', patch: Partial<AgentInfo> = {}): AgentInfo => ({ id, type: 'general-purpose', description: `Task ${id}`, status: status as AgentInfo['status'], ...patch })

describe('the agent ledger', () => {
  test('a spawn shows at once, as starting, before Claude Code lists it; the list then takes over its status', () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, spawn('a1'))
    expect(agentRows(ledger, [], 1100)).toMatchObject([{ id: 'a1', status: 'starting', isListed: false, note: 'Starting: not listed by Claude Code yet', startedAt: 1000 }])
    reconcile(ledger, [listed('a1')], 2000)
    expect(agentRows(ledger, [listed('a1')], 2000)).toMatchObject([{ id: 'a1', status: 'running', isListed: true, note: null }])
  })

  test('an agent missing from the list for a moment keeps its status; gone only after several looks over several seconds', () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, spawn('a1'))
    reconcile(ledger, [listed('a1')], 2000)
    // Three quick looks within a second never drop it.
    for (const at of [2100, 2200, 2300]) reconcile(ledger, [], at)
    expect(agentRows(ledger, [], 2300)[0]).toMatchObject({ status: 'running', note: "Not in Claude Code's list for 3 looks" })
    // Back in the list: as if nothing happened.
    reconcile(ledger, [listed('a1')], 2400)
    expect(ledger.get('a1')).toMatchObject({ status: 'running', missed: 0, missingSince: null })
    // Missing for three looks over more than OMIT_MS: no longer listed, its end not seen.
    reconcile(ledger, [], 3000)
    reconcile(ledger, [], 5000)
    reconcile(ledger, [], 3000 + OMIT_MS)
    expect(agentRows(ledger, [], 3000 + OMIT_MS)[0]).toMatchObject({ status: 'gone', result: 'No longer listed by Claude Code (its end was not seen)', canStop: false })
    // Listed again after all: it never ended, so it is alive again.
    reconcile(ledger, [listed('a1')], 4000 + OMIT_MS)
    expect(agentRows(ledger, [listed('a1')], 4000 + OMIT_MS)[0]).toMatchObject({ status: 'running', result: null, endedAt: null, canStop: true })
  })

  test("a workflow's agents are never listed: running from their spawn, never dropped for it, ended by their own turn.complete or by their run's end", () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, spawn('w1', { workflow: { runId: 'wf_9', index: 1 }, toolUseId: 'tu-wf', isBackground: false }))
    noteSpawn(ledger, spawn('w2', { workflow: { runId: 'wf_9', index: 2 }, toolUseId: 'tu-wf', isBackground: false }))
    for (let i = 0; i < 6; i++) reconcile(ledger, [], 2000 + i * 10_000)
    expect(agentRows(ledger, [], 70_000).map(r => [r.id, r.status, r.canStop])).toEqual([
      ['w1', 'running', false],
      ['w2', 'running', false],
    ])
    noteEnd(ledger, 'w1', { at: 80_000, reason: 'answer', answer: 'Reviewed 4 files.' })
    expect(noteWorkflowEnd(ledger, 'tu-wf', 'completed', 90_000)).toBe(1)
    expect(agentRows(ledger, [], 91_000).map(r => [r.id, r.status, r.result])).toEqual([
      ['w2', 'gone', 'The workflow ended (completed) with no end of its own seen'],
      ['w1', 'completed', 'Reviewed 4 files.'],
    ])
    // Not counted against a subagent limit.
    noteSpawn(ledger, spawn('w3', { workflow: { runId: 'wf_9', index: 3 } }))
    expect(limitCount(agentRows(ledger, [], 92_000), true)).toBe(0)
  })

  test("an agent's loop: what it is doing, its calls, when it last acted; its own plan as a track, never a made-up percent", () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, spawn('a1'))
    expect(noteCall(ledger, 'a1', 'Reading src/cache.ts', 1500)).toBe(true)
    expect(noteCall(ledger, 'a1', 'Running tests', 1600)).toBe(true)
    // An id no spawn named (an engine fork: compaction, memory) is left out.
    expect(noteCall(ledger, 'fork-1', 'Reading x', 1600)).toBe(false)
    expect(ledger.has('fork-1')).toBe(false)
    notePlan(ledger, 'a1', { tool: 'TodoWrite', input: { todos: [{ content: 'Find the call sites', status: 'completed', activeForm: 'Finding the call sites' }, { content: 'Patch them', status: 'in_progress', activeForm: 'Patching them' }, { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' }] }, result: null, now: 1700 })
    const row = agentRows(ledger, [listed('a1')], 2000)[0]!
    expect(row).toMatchObject({ activity: 'Running tests', calls: 2, activeAt: 1600, plan: { done: 1, total: 3, current: 'Patching them', track: ['done', 'now', 'open'] } })
    // Its milestones (the milestones tool, called in its loop) are its plan too.
    noteSpawn(ledger, spawn('a2'))
    notePlan(ledger, 'a2', { milestones: { milestones: [{ title: 'Scan', status: 'completed' }, { title: 'Report', status: 'in_progress' }] }, now: 1800 })
    expect(agentRows(ledger, [listed('a2')], 2000).find(r => r.id === 'a2')!.plan).toMatchObject({ done: 1, total: 2, current: 'Report' })
  })

  test('an end: the first line of its answer, a failure, a stop; a message resumes it under the same id', () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, spawn('a1'))
    noteSpawn(ledger, spawn('a2'))
    noteEnd(ledger, 'a1', { at: 5000, reason: 'answer', answer: '\n## Found 3 call sites\nmore' })
    noteEnd(ledger, 'a2', { at: 5000, reason: 'error', answer: '' })
    expect(agentRows(ledger, [], 6000).map(r => [r.id, r.status, r.result, r.isFailed])).toEqual([
      ['a1', 'completed', 'Found 3 call sites', false],
      ['a2', 'failed', 'Ended with an error', true],
    ])
    // Listed running a moment after its end (the list behind): the end stands.
    reconcile(ledger, [listed('a1')], 5500)
    expect(agentRows(ledger, [listed('a1')], 5500).find(r => r.id === 'a1')).toMatchObject({ status: 'completed', result: 'Found 3 call sites' })
    // Its loop acting again (SendMessage resumed it under its id): alive, its old end gone.
    noteCall(ledger, 'a1', 'Reading src/a.ts', 6500)
    reconcile(ledger, [listed('a1')], 7000)
    expect(agentRows(ledger, [listed('a1')], 7000).find(r => r.id === 'a1')).toMatchObject({ status: 'running', result: null, endedAt: null })
    // A teammate's turn ends each time: idle with its last answer, never ended.
    noteSpawn(ledger, spawn('t1', { isTeammate: true, name: 'reviewer' }))
    noteEnd(ledger, 't1', { at: 8000, reason: 'answer', answer: 'Reviewed the diff.' })
    expect(agentRows(ledger, [], 8000).find(r => r.id === 't1')).toMatchObject({ status: 'idle', result: 'Reviewed the diff.', endedAt: null, canMessage: true })
  })

  test('the list first naming an agent (spawned before a reload): shown, its start not known', () => {
    const ledger: AgentLedger = new Map()
    reconcile(ledger, [listed('t1', 'idle', { teammateId: 'rev@team', name: 'reviewer', type: 'teammate' })], 1000)
    expect(agentRows(ledger, [listed('t1', 'idle', { teammateId: 'rev@team', name: 'reviewer', type: 'teammate' })], 1000)[0]).toMatchObject({ name: 'reviewer', startedAt: null, isTeammate: true, canStop: true, canMessage: true })
    expect(limitCount(agentRows(ledger, [listed('t1', 'idle', { teammateId: 'rev@team' })], 1000), false)).toBe(0)
  })

  test('a reload keeps the ledger whole (workflow, loop, plan), and a record from before 1.7.0 still reads', () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, spawn('w1', { workflow: { runId: 'wf_1', index: 2 }, toolUseId: 'tu-wf' }))
    noteCall(ledger, 'w1', 'Editing src/a.ts', 1500)
    notePlan(ledger, 'w1', { milestones: { milestones: [{ title: 'One', status: 'in_progress' }] }, now: 1600 })
    const back: AgentLedger = new Map()
    expect(restoreLedger(back, JSON.parse(JSON.stringify([...ledger.values()])))).toBe(1)
    expect(back.get('w1')).toMatchObject({ status: 'running', workflow: { runId: 'wf_1', index: 2 }, toolUseId: 'tu-wf', calls: 1, doing: 'Editing src/a.ts' })
    expect(back.get('w1')?.plan?.tasks).toHaveLength(1)
    const old: AgentLedger = new Map()
    restoreLedger(old, [{ id: 'g1', spawnedAt: 1000, model: null, isBackground: true, isFork: false, description: 'gamma', type: 'general-purpose', name: null, parentId: null, endedAt: null, result: null, isFailed: false }])
    expect(old.get('g1')).toMatchObject({ status: 'starting', workflow: null, calls: 0 })
  })

  test('the band: a line per agent up to three, past that one line counting them by what they do; nothing when none runs', () => {
    const ledger: AgentLedger = new Map()
    expect(bandOf(agentRows(ledger, [], 0), 0)).toBeNull()
    noteSpawn(ledger, spawn('a1', { description: 'Explore the cache' }))
    noteCall(ledger, 'a1', 'Reading src/cache.ts', 1500)
    expect(bandOf(agentRows(ledger, [], 61_000), 61_000)).toEqual({ lines: [{ id: 'a1', name: 'Explore the cache', status: 'starting', doing: 'Reading src/cache.ts', elapsedMs: 60_000, plan: null }], summary: null })
    for (const [id, doing] of [['a2', 'Reading src/b.ts'], ['a3', 'Editing src/c.ts'], ['a4', 'Running tests']] as const) {
      noteSpawn(ledger, spawn(id))
      noteCall(ledger, id, doing, 1500)
    }
    reconcile(ledger, ['a1', 'a2', 'a3', 'a4'].map(id => listed(id)), 2000)
    expect(bandOf(agentRows(ledger, ['a1', 'a2', 'a3', 'a4'].map(id => listed(id)), 3000), 3000)).toEqual({ lines: [], summary: '4 agents · 2 reading · 1 editing · 1 checking' })
    expect(doingWord({ status: 'running', activity: null })).toBe('thinking')
    expect(doingWord({ status: 'waiting', activity: 'Reading x' })).toBe('waiting')
  })

  test('the hierarchy: children under their parent, a workflow’s agents under their run in order', () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, spawn('p1', { at: 1000 }))
    noteSpawn(ledger, spawn('c1', { at: 2000, parentId: 'p1' }))
    noteSpawn(ledger, spawn('g1', { at: 3000, parentId: 'c1' }))
    noteSpawn(ledger, spawn('w2', { at: 4000, workflow: { runId: 'wf_1', index: 2 } }))
    noteSpawn(ledger, spawn('w1', { at: 4100, workflow: { runId: 'wf_1', index: 1 } }))
    const shape = hierarchyOf(agentRows(ledger, [], 5000)).map(e => (e.kind === 'agent' ? `${'  '.repeat(e.depth)}${e.row.id}` : `wf ${e.runId}: ${e.rows.map(r => r.id).join(',')}`))
    expect(shape).toEqual(['wf wf_1: w1,w2', 'p1', '  c1', '    g1'])
  })
})

// ---------------------------------------------------------------------------
// The runtime over a fake engine.

async function started(patch: (s: Settings) => void = () => undefined) {
  const f = fakeHost()
  const s = defaultSettings()
  patch(s)
  f.kept.store['settings.v1'] = s
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { ...f, rt }
}

const input = (patch: Record<string, unknown> = {}) =>
  ({ tool_use_id: 'tu-1', prompt: 'p', description: 'Scan the cache', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false, ...patch }) as never

describe('agents in the runtime', () => {
  test('a spawn is visible at once, the band shows it, the list is looked at every two seconds while it runs, and stops after', async () => {
    const f = await started()
    const { rt, live, advance } = f
    const decision = await rt.onAgentSpawn(input())
    expect(decision).toEqual({ isReserved: true })
    rt.onAgentSpawned(input(), { model: 'claude-sonnet-5-5', agentId: 'a1' } as never, true)
    // Not listed yet (the bug: invisible until its call returned): it shows, the status bar counts it, the band draws it.
    expect(rt.runningSubagents()).toBe(1)
    expect(Views.hudOf(rt).agentBand?.lines[0]).toMatchObject({ id: 'a1', name: 'Scan the cache', status: 'starting' })
    expect(Views.hudOf(rt).chips.find(c => c.key === 'agents')).toMatchObject({ text: '1 agent', opens: 'agents' })
    expect(f.kept.traces).toContain('agents: a1 started (Explore: Scan the cache)')
    live.agents = [listed('a1', 'running', { type: 'Explore', description: 'Scan the cache' })]
    await advance(2100)
    expect(Views.opsOf(rt).agents[0]).toMatchObject({ id: 'a1', status: 'running', isListed: true })
    // Its calls: what it is doing.
    await rt.beforeTool('Read', { file_path: '/work/src/cache.ts' }, 'tu-r1', 'a1')
    expect(Views.hudOf(rt).agentBand?.lines[0]?.doing).toBe('Reading cache.ts')
    // Its end: the band is gone, the poll stops.
    await rt.onTurnComplete({ agentId: 'a1', reason: 'answer', answer: 'Found 3 call sites.' })
    live.agents = [listed('a1', 'completed')]
    await advance(2100)
    expect(Views.hudOf(rt).agentBand).toBeNull()
    expect(rt.runningSubagents()).toBe(0)
    const looks = f.kept.traces.length
    await advance(10_000)
    expect(rt.agents.poll).toBeNull()
    expect(f.kept.traces.length).toBe(looks)
    expect(Views.opsOf(rt).agents[0]).toMatchObject({ id: 'a1', status: 'completed', result: 'Found 3 call sites.' })
  })

  test('two spawns at once against a limit of one: the second is refused (the race: both saw none running)', async () => {
    const f = await started(s => {
      s.subagents.mode = 'limit'
      s.subagents.limit = 1
    })
    const [one, two] = await Promise.all([f.rt.onAgentSpawn(input()), f.rt.onAgentSpawn(input({ tool_use_id: 'tu-2' }))])
    expect(one.deny).toBeUndefined()
    expect(two.deny).toBe('Control Room: the subagent limit is 1 and 1 is already running. Wait for one to finish, or do this part directly.')
    // The first settles: its slot passes to the ledger, still counted.
    f.rt.onAgentSpawned(input(), { model: 'm', agentId: 'a1' } as never, true)
    expect(f.rt.agents.reserved).toBe(0)
    expect((await f.rt.onAgentSpawn(input({ tool_use_id: 'tu-3' }))).deny).toBeDefined()
    // A start that failed releases its slot.
    const g = await started(s => {
      s.subagents.mode = 'limit'
      s.subagents.limit = 1
    })
    const d = await g.rt.onAgentSpawn(input())
    g.rt.onAgentSpawned(input(), { model: 'm', deny: 'refused below' } as never, d.isReserved === true)
    expect((await g.rt.onAgentSpawn(input())).deny).toBeUndefined()
    // A workflow's agents are not counted or held against the limit.
    const wf = await g.rt.onAgentSpawn(input({ workflow: { runId: 'wf_1', agentIndex: 1 } }))
    expect(wf).toEqual({ isReserved: false })
  })

  test("a workflow's agents and a nested agent: shown from their spawns, their loops' calls, grouped and indented; the run's end ends them", async () => {
    const f = await started()
    const { rt } = f
    for (const i of [1, 2]) {
      const e = input({ tool_use_id: 'tu-wf', subagentType: 'workflow-subagent', description: `review part ${i}`, background: false, workflow: { runId: 'wf_7', agentIndex: i } })
      const d = await rt.onAgentSpawn(e)
      rt.onAgentSpawned(e, { model: 'claude-sonnet-5-5', agentId: `w${i}` } as never, d.isReserved === true)
    }
    const nested = input({ tool_use_id: 'tu-n', description: 'child scan', parentAgentId: 'w1' })
    rt.onAgentSpawned(nested, { model: 'claude-haiku-5-5', agentId: 'n1' } as never, false)
    await rt.beforeTool('Grep', { pattern: 'cache' }, 'tu-g', 'w2')
    await f.advance(10_000)
    const rows = Views.opsOf(rt).agents
    expect(rows.map(r => [r.id, r.status])).toEqual(expect.arrayContaining([['w1', 'running'], ['w2', 'running']]))
    expect(rows.find(r => r.id === 'w2')).toMatchObject({ workflow: { runId: 'wf_7', index: 2 }, activity: 'Searching the code', calls: 1, canStop: false })
    expect(rows.find(r => r.id === 'n1')).toMatchObject({ parentId: 'w1' })
    expect(f.kept.traces).toContain('agents: w1 started (workflow-subagent: review part 1, workflow wf_7 #1)')
    // w1's own end; then the Workflow call's task notification ends the rest.
    await rt.onTurnComplete({ agentId: 'w1', reason: 'answer', answer: 'Part 1 reviewed.' })
    rt.onPromptSubmit('<task-notification>\n<task-id>wfTask1</task-id>\n<tool-use-id>tu-wf</tool-use-id>\n<status>completed</status>\n</task-notification>', { kind: 'task-notification' })
    expect(Views.opsOf(rt).agents.find(r => r.id === 'w2')).toMatchObject({ status: 'gone' })
    expect(f.kept.traces).toContain('agents: the workflow of tu-wf ended (completed); 1 of its agents with no end seen end with it')
  })

  test("an agent's own task list and milestones are its plan; never the run's", async () => {
    const f = await started()
    const { rt } = f
    rt.onAgentSpawned(input(), { model: 'm', agentId: 'a1' } as never, false)
    rt.afterTool('TodoWrite', { todos: [{ content: 'A', status: 'completed', activeForm: 'Doing A' }, { content: 'B', status: 'in_progress', activeForm: 'Doing B' }] }, 'tu-t', { result: {} } as never, 'a1')
    expect(Views.opsOf(rt).agents[0]?.plan).toMatchObject({ done: 1, total: 2, current: 'Doing B' })
    expect(rt.recordMilestones({ milestones: [{ title: 'X', status: 'in_progress' }] }, 'a1')).toBe('Recorded as your own plan.')
    expect(rt.plan().tasks).toEqual([])
  })

  test('Stop and Message: Claude Code’s TaskStop and SendMessage; a stopped agent ends; Claude hears it was the person', async () => {
    const f = await started()
    const { rt, kept, live } = f
    rt.onAgentSpawned(input(), { model: 'm', agentId: 'a1' } as never, false)
    live.agents = [listed('a1')]
    await rt.refreshAgents()
    expect(Views.opsOf(rt).agents[0]).toMatchObject({ canStop: true, canMessage: true })
    await rt.ops.messageAgent('a1', 'Stop after this file')
    expect(kept.sentToAgents).toEqual([{ agentId: 'a1', text: 'Stop after this file' }])
    live.agents = [listed('a1', 'killed')]
    await rt.ops.stopAgent('a1')
    expect(kept.stopped).toEqual(['a1'])
    expect(Views.opsOf(rt).agents[0]).toMatchObject({ status: 'killed', result: 'Stopped', canStop: false })
  })

  test('a reload during agents: the new runtime shows them at once and keeps polling', async () => {
    const f = await started()
    f.rt.onAgentSpawned(input(), { model: 'claude-sonnet-5-5', agentId: 'a1' } as never, false)
    f.live.agents = [listed('a1')]
    await f.advance(2100)
    f.rt.stopTimers()
    await f.advance(3000)
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    expect(rt.runningSubagents()).toBe(1)
    expect(Views.opsOf(rt).agents[0]).toMatchObject({ id: 'a1', status: 'running', model: 'claude-sonnet-5-5', canStop: true })
    expect(rt.agents.poll).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// As Claude Code raises it: agent.spawn, the agent's loop, its end; the panel open meanwhile.

describe('agents as Claude Code raises them', () => {
  const paneProps = { title: 'Control Room', isFocused: true, bodyColumns: 70, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} }
  const bandProps = { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} }
  const full = (patch: Record<string, unknown> = {}) => ({ tool_use_id: 'tu-1', prompt: 'p', description: 'Scan the cache code', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false, ...patch })

  test('a foreground agent shows while its call runs; the band and Activity → Agents follow it; it ends while the panel is open', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    let n = 0
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `ag${++n}` }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start(SESSION)
    // A foreground agent (not listed until it is: the list is empty here).
    const spawned = await $.agent.spawn(full({ background: false }))
    expect(spawned.agentId).toBe('ag1')
    await w.clock.advance(300)
    const band = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect(await band.find({ text: /Scan the cache code · Starting/ })).toBeDefined()
    const pane = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps })
    // The band's line opens Activity → Agents.
    await band.press({ key: 'band-ag1-open' })
    await w.clock.advance(500)
    expect(await pane.find({ text: /RUNNING NOW/ })).toBeDefined()
    expect(await pane.find({ text: /Scan the cache code/ })).toBeDefined()
    // Its loop: a call (its agentId), then the list naming it.
    await $.tool.call({ tool: 'Read', file_path: '/work/src/cache.ts', tool_use_id: 'tu-r', agentId: 'ag1' } as never)
    w.live.agents = [{ id: 'ag1', type: 'Explore', description: 'Scan the cache code', status: 'running' }]
    await w.clock.advance(2500)
    await band.redraw()
    expect(await band.find({ text: /Reading cache\.ts/ })).toBeDefined()
    // Its end, while the panel is open: it moves to Earlier, and the band is gone.
    await $.turn.complete({ answer: 'Found 3 call sites.', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer', agentId: 'ag1' } as never)
    w.live.agents = [{ id: 'ag1', type: 'Explore', description: 'Scan the cache code', status: 'completed' }]
    await w.clock.advance(2500)
    await pane.redraw()
    expect(await pane.find({ text: /EARLIER/ })).toBeDefined()
    expect(await pane.find({ text: /Found 3 call sites\./ })).toBeDefined()
    await band.redraw()
    expect(await band.find({ text: /Scan the cache code ·/ })).toBeUndefined()
    await band.unmount()
    await pane.unmount()
  })

  test('on Desktop: a line per agent above the status bar, one counting line past three, each opening Activity → Agents; drawable by the app', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    let n = 0
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `ag${++n}` }))
    await $.session.start(SESSION)
    await $.agent.spawn(full({ description: 'Count A' }))
    await $.agent.spawn(full({ description: 'Count B', tool_use_id: 'tu-2' }))
    w.live.agents = [
      { id: 'ag1', type: 'Explore', description: 'Count A', status: 'running' },
      { id: 'ag2', type: 'Explore', description: 'Count B', status: 'running' },
    ]
    await $.tool.call({ tool: 'Bash', command: 'node -e "setTimeout(()=>{},50000)"', tool_use_id: 'tu-b', agentId: 'ag1' } as never)
    await w.clock.advance(2500)
    const band = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    const drawn = await band.drawn()
    expect(await band.find({ text: /Count A · Running node/ })).toBeDefined()
    expect(await band.find({ text: /Count B ·/ })).toBeDefined()
    expect(desktopKeys(drawn)).toEqual(expect.arrayContaining(['band-ag1-open', 'band-ag2-open']))
    // What the app's page refuses: a Button with anything but one string inside, a text it would draw as a table.
    expect(richDesktopButtons(drawn)).toEqual([])
    expect(tabularTexts(drawn)).toEqual([])
    // Pressed, a line opens Activity → Agents on Desktop too.
    const pane = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'Pane', requestId: 'control-room', props: paneProps })
    await band.press({ key: 'band-ag2-open' })
    await w.clock.advance(500)
    await pane.redraw()
    expect(await pane.find({ text: /RUNNING NOW/ })).toBeDefined()
    expect(await pane.find({ key: 'sub:agents' })).toBeDefined()
    // Five at once: past three, one line counts them by what they do.
    for (const d of ['Count C', 'Count D', 'Count E']) await $.agent.spawn(full({ description: d, tool_use_id: `tu-${d}` }))
    w.live.agents = [1, 2, 3, 4, 5].map(i => ({ id: `ag${i}`, type: 'Explore', description: `Count ${'ABCDE'[i - 1]}`, status: 'running' }))
    await w.clock.advance(2500)
    await band.redraw()
    expect(await band.find({ text: /^5 agents · / })).toBeDefined()
    expect(await band.find({ text: /Count E ·/ })).toBeUndefined()
    expect(richDesktopButtons(await band.drawn())).toEqual([])
    await band.unmount()
    await pane.unmount()
  })
})

type DrawnNode = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
const isDrawnNode = (n: unknown): n is DrawnNode => typeof n === 'object' && n !== null && !Array.isArray(n)
function eachDrawn(n: unknown, visit: (n: DrawnNode) => void): void {
  if (Array.isArray(n)) return n.forEach(c => eachDrawn(c, visit))
  if (!isDrawnNode(n)) return
  visit(n)
  for (const c of n.children ?? []) eachDrawn(c, visit)
}
const desktopKeys = (tree: unknown): string[] => {
  const out: string[] = []
  eachDrawn(tree, n => void (typeof n.props?.key === 'string' && out.push(n.props.key)))
  return out
}
/** Buttons with children other than one string: Claude Code 2.1.289 refuses them and skips the whole tree. */
const richDesktopButtons = (tree: unknown): string[] => {
  const out: string[] = []
  eachDrawn(tree, n => void (n.type === 'Button' && (n.children ?? []).some(c => typeof c !== 'string') && out.push(String(n.props?.key ?? '?'))))
  return out
}
/** Texts Desktop would set in a monospace face (box drawing, aligned runs of spaces): the band must read as prose. */
const tabularTexts = (tree: unknown): string[] => {
  const out: string[] = []
  eachDrawn(tree, n => {
    if (n.type !== 'Text' || !(n.children ?? []).every(c => typeof c === 'string')) return
    const t = (n.children as string[]).join('')
    const runs = [...t.matchAll(/\S( {2,})(?=\S)/gu)].map(m => m[1]?.length ?? 0)
    if (t.trim() !== '' && (/[─-▟]/u.test(t) || /[-=_~]{3,}/u.test(t) || runs.length >= 2 || runs.some(r => r >= 3))) out.push(t)
  })
  return out
}
