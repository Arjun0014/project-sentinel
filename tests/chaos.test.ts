/**
 * The integrated chaos test (1.8.0): one deliberately ugly run across three fresh contexts, driven through the
 * runtime as Claude Code raises its events (a fake host, no model calls). It holds, at once: a large main
 * context, Autopilot handoffs, a persistent Vite server, a finite test run, a multi-hour render, two subagents
 * on different models, a queued item, a non-blocking decision, a blocking dependency (the render the first
 * handoff waits for), a watcher, Keep warm, a milestone completed and then its file changed, /clear, a plugin
 * reload, a stale usage reading from the previous context, a 1M → 200k window change (as Fable 5.2 on an older
 * bundled engine), and a model switch over a warm cache.
 *
 * It checks the request's list: no handoff loop, no stale token carryover, no lost milestone, objective or
 * decision, no duplicate queued work or continuation, the server never blocks, the long work's policy, the cache
 * kept warm while Sentinel only waits, a truthful Keep warm timer, agents visible and their controls on the
 * right agent, evidence staleness found, plan usage read as Claude Code reports it, and the UI saying what is
 * happening.
 */

import { describe, expect, test } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'

import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { defaultSettings } from '../hooks/core/settings'
import { SUGGESTED } from '../hooks/features/agentModels'
import { fakeHost } from './fixtures/fake-host'

const MIN = 60_000
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const FABLE = 'claude-fable-5-2'
const SOURCE = '/work/src/pressure.ts'

const VITE = { id: 'vite1', type: 'shell', description: 'Vite preview server', command: 'npx vite preview --port 4181' }
const TESTS = { id: 'unit1', type: 'shell', description: 'Run the unit tests', command: 'npm test' }
const RENDER = { id: 'r4k', type: 'shell', description: 'Render the 4K master', command: 'blender -b film.blend -a' }

const framed = (text: string | undefined) => `The project-sentinel plugin sent a message:\n${text ?? ''}`
const count = (list: readonly string[], part: string): number => list.filter(t => t.includes(part)).length
const notification = (id: string, status: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${id} ${status}</summary>\n</task-notification>`

const usageOf = (tokens: number, model = OPUS) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, model })

function stepAt(rt: Runtime, turnId: string, index: number, tokens: number, stop: 'tool_use' | 'end_turn'): void {
  const e = { turnId, index, model: OPUS, effort: 'xhigh' as const, messageCount: 3 }
  const sent = rt.stepRequest(e)
  rt.stepResponse(e, sent, { turnId, index, answer: '', toolUses: [], stopReason: stop, usage: usageOf(tokens) })
}

let ids = 0
/** A tool call and its result, as the engine raises them (a few real milliseconds apart: evidence orders by the clock). */
async function call(rt: Runtime, tool: string, input: Record<string, unknown>, result: unknown = { stdout: 'ok', stderr: '', interrupted: false }): Promise<void> {
  const id = `x${++ids}`
  const until = Date.now() + 3
  while (Date.now() < until) {
    // a real gap
  }
  await rt.beforeTool(tool, input, id, undefined)
  rt.afterTool(tool, input, id, { result } as ToolCallResult)
}

const PLAN = (m1: string, m2: string, m3 = 'pending', extra: Record<string, unknown> = {}) => ({
  objective: 'Ship the pressure-aware renderer',
  milestones: [
    { title: 'Build the pressure module', status: m1, ...extra },
    { title: 'Wire the renderer', status: m2 },
    { title: 'Validate the release build', status: m3 },
    { title: 'Document the findings', status: 'pending' },
  ],
})

const agentSpawn = (id: string, type: string, description: string) =>
  ({ tool_use_id: `tu-${id}`, prompt: 'p', description, subagentType: type, provider: { plugin: 'engine', tier: 'core' }, parentModel: OPUS, background: true, fork: false }) as never

describe('the integrated chaos test', () => {
  test('one run, three fresh contexts, everything at once: nothing lost, nothing doubled, nothing stuck', { timeoutMs: 60_000 }, async () => {
    const f = fakeHost()
    const { kept, live, advance } = f
    live.repo = '/work'
    const s = defaultSettings()
    s.cache = { ...s.cache, keepWarm: true, maxIdleMinutes: 180 }
    s.agentModels = { ...s.agentModels, ...SUGGESTED, enabled: true }
    kept.store['settings.v1'] = s
    kept.store['cache.v1'] = { v: 1, ttl: '1h', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }
    live.usage = { ...live.usage, context: { tokens: 20_000, window: 1_000_000, percent: 2 }, rateLimits: [{ kind: 'five_hour', percentUsed: 22, resetsAt: '2099-01-01T00:00:00Z' }] }
    let rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await advance(200)
    rt.onMeasure({ context: { tokens: 20_000, window: 1_000_000, percent: 2 }, cost: { usd: 0.1 }, changed: ['context'] })

    // ------------------------------------------------------------------ context 1: the work, and everything around it
    rt.onPromptSubmit('Ship the pressure-aware renderer.', { kind: 'composer' })
    rt.onTurnStart({ turnId: 'p0', text: 'Ship the pressure-aware renderer.' })
    rt.recordMilestones(PLAN('in_progress', 'pending'), undefined)
    stepAt(rt, 'p0', 0, 200_000, 'tool_use')
    live.workspace[SOURCE] = { content: 'export const pressure = 1', mtimeMs: 100 }
    await call(rt, 'Edit', { file_path: SOURCE, old_string: 'a', new_string: 'b' }, { filePath: SOURCE, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] })
    await call(rt, 'Bash', { command: 'npm test' })
    rt.recordMilestones(PLAN('completed', 'in_progress', 'pending', { evidence: 'npm test green' }), undefined)
    await advance(10)
    expect(rt.evidence().snapshots[0]).toMatchObject({ subject: 'Build the pressure module', status: 'current' })

    // Two subagents, on different models by the Agent Model Policy (search on Haiku, debugging on Opus).
    live.agents = []
    const d1 = await rt.onAgentSpawn(agentSpawn('a1', 'Explore', 'Scan the pressure call sites'))
    rt.onAgentSpawned(agentSpawn('a1', 'Explore', 'Scan the pressure call sites'), { model: 'claude-haiku-4-5-20251001', agentId: 'a1' } as never, d1.isReserved === true, d1.model)
    const d2 = await rt.onAgentSpawn(agentSpawn('a2', 'general-purpose', 'Debug the failing render test'))
    rt.onAgentSpawned(agentSpawn('a2', 'general-purpose', 'Debug the failing render test'), { model: OPUS, agentId: 'a2' } as never, d2.isReserved === true, d2.model)
    expect([d1.model, d2.model]).toEqual(['haiku', 'claude-opus-5-5'])
    live.agents = [
      { id: 'a1', type: 'Explore', description: 'Scan the pressure call sites', status: 'running', name: 'scout' },
      { id: 'a2', type: 'general-purpose', description: 'Debug the failing render test', status: 'running', name: 'debugger' },
    ]
    await rt.refreshAgents()
    expect(Views.hudOf(rt).agentBand?.lines.map(l => `${l.name} · ${l.model}`)).toEqual(['scout · Haiku', 'debugger · Opus'])

    // A queued item for the fresh context, a non-blocking decision, a watcher holding the cache for the render.
    expect(rt.ops.queueAdd('Re-run the visual diff against the golden frames', 'fresh')).toMatchObject({ ok: true })
    expect(rt.ops.decisionTool({ question: 'Keep the soft shadows in the HUD?', options: ['Keep', 'Drop'] }, undefined)).toContain('D-1')
    expect(rt.ops.armFrom('the 4K render', 'in 3h', 'warm')).toMatchObject({ ok: true, id: 'W-1' })
    stepAt(rt, 'p0', 1, 300_000, 'end_turn')
    await rt.onStop({ stopHookActive: false, lastMessage: 'Module built.', background: [VITE, TESTS, RENDER], wakeups: [], permissionMode: undefined })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Module built.' })
    await advance(300)

    // The context fills (705k of 1M, past 70%): the handoff turn writes the notes while the render, the tests and Vite run.
    rt.onTurnStart({ turnId: 'w1', text: 'Carry on.' })
    stepAt(rt, 'w1', 0, 705_000, 'tool_use')
    await rt.onStop({ stopHookActive: false, lastMessage: 'Step done.', background: [VITE, TESTS, RENDER], wakeups: [], permissionMode: undefined })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Step done.' })
    await advance(300)
    await rt.onTurnStart({ turnId: 'h1', text: framed(kept.submitted.at(-1)) })
    await call(rt, 'Write', { file_path: '/work/NEXT_SESSION_PROMPT.md', content: '# Next session' }, { type: 'create', filePath: '/work/NEXT_SESSION_PROMPT.md', content: '# Next session', structuredPatch: [], originalFile: null })
    stepAt(rt, 'h1', 0, 706_000, 'end_turn')
    await rt.onStop({ stopHookActive: false, lastMessage: 'Handoff written.', background: [VITE, TESTS, RENDER], wakeups: [], permissionMode: undefined })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Handoff written.' })
    await advance(500)
    // The server is never waited for; the finite work is. Keep warm keeps holding the cache while Sentinel only waits.
    expect(rt.autopilot.state).toBe('waiting-background')
    expect(rt.autopilot.background.map(t => `${t.id}:${t.class}`).sort()).toEqual(['r4k:finite', 'unit1:finite', 'vite1:persistent'])
    expect(rt.keepWarmStandDown()).toBeNull()
    expect(rt.cache.plan.at).not.toBeNull()
    const waiting = Views.paneOf(rt).cache.keepWarm.timing
    expect(waiting.phase).toBe('idle')
    const idleStart = waiting.idleSince
    // The tests end (Claude Code's notification): only the render is waited for now.
    rt.onPromptSubmit(notification('unit1', 'completed'), { kind: 'task-notification' })
    expect(rt.autopilot.background.map(t => t.id).sort()).toEqual(['r4k', 'vite1'])
    // The supervisor says what it waits for and what happens next; the status bar says it too.
    expect(Views.hudOf(rt).alert?.kind).toBe('waiting')
    expect(idleStart).not.toBeNull()
    // Ten minutes into the wait: Keep warm still holds the cache (a refresh planned), its idle clock still counts
    // from the handoff turn's end, and it still stops when it said it would.
    await advance(10 * MIN)
    const tenIn = Views.paneOf(rt).cache.keepWarm.timing
    expect(rt.autopilot.state).toBe('waiting-background')
    expect(rt.cache.plan.at).not.toBeNull()
    expect(tenIn).toMatchObject({ phase: 'idle', idleSince: idleStart, stopsAt: waiting.stopsAt })
    expect(tenIn.leftMs).toBe((waiting.leftMs ?? 0) - 10 * MIN)
    // Patience over (20 minutes): the render is left running, the context is cleared once.
    // (Small steps: Claude Code reports the fresh session's start right after its /clear, well inside the 15 s Sentinel allows.)
    for (let t = 0; t < 15 * MIN && !kept.commands.includes('clear'); t += 2000) await advance(2000)
    expect(kept.commands.filter(c => c === 'clear')).toHaveLength(1)

    // ------------------------------------------------------------------ context 2: the stale reading, a reload, a window change
    live.sessionId = 'S2'
    await rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    const block2 = rt.takeFreshContext() ?? ''
    // A late reading of the old context, before the fresh one made any request: no figure, no handoff.
    rt.onMeasure({ context: { tokens: 706_000, window: 1_000_000, percent: 71 }, cost: { usd: 3 }, changed: ['context'] })
    expect(Views.hudOf(rt).ctx.tokens).toBeNull()
    await advance(1000)
    expect(count(kept.submitted, 'Context Autopilot continuation')).toBe(1)
    await rt.onTurnStart({ turnId: 'c2', text: framed(kept.submitted.filter(t => t.includes('Context Autopilot continuation')).at(-1)) })
    stepAt(rt, 'c2', 0, 45_000, 'tool_use')
    rt.recordMilestones(PLAN('completed', 'in_progress'), undefined)
    // The same old figure again, as the session's own reading: set aside.
    live.usage = { ...live.usage, context: { tokens: 706_000, window: 1_000_000, percent: 71 } }
    rt.onMeasure({ context: { tokens: 706_000, window: 1_000_000, percent: 71 }, cost: { usd: 3 }, changed: ['context'] })
    stepAt(rt, 'c2', 1, 47_000, 'end_turn')
    await rt.onStop({ stopHookActive: false, lastMessage: 'Picked up.', background: [VITE, RENDER], wakeups: [], permissionMode: undefined })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Picked up.' })
    await advance(3000)
    expect(block2, kept.traces.filter(x => /handoff|fresh|clear|autopilot|context/i.test(x)).slice(-40).join('\n')).toContain('Render the 4K master')
    expect(block2).toContain('Vite preview server')
    expect(rt.autopilot.state).toBe('armed')
    expect(Views.hudOf(rt).ctx.tokens).toBe(47_000)
    expect(rt.run?.sessions.map(x => x.id)).toEqual(['S1', 'S2'])
    expect(rt.plan().tasks.map(t => `${t.subject}:${t.status}`)).toEqual(['Build the pressure module:completed', 'Wire the renderer:in_progress', 'Validate the release build:pending', 'Document the findings:pending'])
    // The queued item went to the fresh context, once: in its own context block, marked delivered, never sent again.
    await advance(2000)
    expect(block2).toContain('Re-run the visual diff against the golden frames')
    expect(rt.ops.current().queue.map(q => `${q.id}:${q.status}:${q.via}`)).toEqual(['Q-1:delivered:fresh'])
    expect(count(kept.submitted, 'Re-run the visual diff against the golden frames')).toBe(0)

    // The plugin reloads mid-context: the run, its plan, the decision, the watcher, the queue and the agents carry.
    rt.stopTimers()
    live.usage = { ...live.usage, context: { tokens: 47_000, window: 1_000_000, percent: 5 } }
    rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await advance(3000)
    expect(rt.run?.sessions.map(x => x.id)).toEqual(['S1', 'S2'])
    expect(rt.run?.objective ?? '').toContain('pressure-aware renderer')
    expect(rt.plan().tasks).toHaveLength(4)
    expect(rt.ops.current().decisions.map(d => `${d.id}:${d.status}`)).toEqual(['D-1:open'])
    expect(rt.ops.current().watchers.map(w => `${w.id}:${w.status}`)).toEqual(['W-1:armed'])
    expect(Views.hudOf(rt).ctx).toMatchObject({ tokens: 47_000, isProvisional: true })
    expect(count(kept.submitted, 'Context Autopilot continuation')).toBe(1)
    expect(rt.ops.current().queue.map(q => `${q.id}:${q.status}`)).toEqual(['Q-1:delivered'])
    // The agents are still there, and their controls reach the right one.
    const agents = rt.ops.view().agents
    expect(agents.filter(a => a.status === 'running').map(a => a.id).sort()).toEqual(['a1', 'a2'])
    await rt.ops.messageAgent('a1', 'Also list the call sites in tests.')
    expect(kept.sentToAgents.at(-1)).toEqual({ agentId: 'a1', text: 'Also list the call sites in tests.' })
    await rt.ops.stopAgent('a2')
    expect(kept.stopped.at(-1)).toBe('a2')
    // Plan usage: Claude Code's own five-hour reading, the same after the reload.
    expect(Views.hudOf(rt).plan.windows.find(w => w.key === 'five_hour')?.percent).toBe(22)

    // The context grows for real in this context.
    rt.onTurnStart({ turnId: 'g2', text: 'Wire it in.' })
    stepAt(rt, 'g2', 0, 300_000, 'tool_use')
    expect(Views.hudOf(rt).ctx).toMatchObject({ tokens: 300_000, isProvisional: false })
    // The pressure module's file changes outside Claude's tools: its verification is stale, never "wrong".
    live.workspace[SOURCE] = { content: 'export const pressure = 2 // by hand', mtimeMs: 900 }
    await rt.checkEvidence('test')
    expect(rt.staleEvidence().map(x => x.subject)).toEqual(['Build the pressure module'])

    // A switch to Fable that the host reports with a 200k window under a 300k context: held, no handoff.
    rt.onPostModelSwitch({ from_model: OPUS, to_model: FABLE, cache_ttl: '1h', source: 'sdk' })
    rt.onMeasure({ context: { tokens: 300_000, window: 200_000, percent: 100 }, cost: { usd: 3 }, changed: ['context'] })
    stepAt(rt, 'g2', 1, 302_000, 'tool_use')
    expect(rt.autopilot.state).toBe('armed')
    expect(Views.hudOf(rt).alert?.text).toContain('Model window changed unexpectedly')
    // The person switches back: Claude Code's own /model; the hold lifts once the host reports the old window.
    expect(await rt.revertWindowModel()).toContain('Switched back to claude-opus-5-5')
    expect(kept.commands).toContain(`model ${OPUS}`)
    rt.onPostModelSwitch({ from_model: FABLE, to_model: OPUS, cache_ttl: '1h', source: 'command' })
    rt.onMeasure({ context: { tokens: 302_000, window: 1_000_000, percent: 30 }, cost: { usd: 3 }, changed: ['context'] })
    expect(rt.windowHold).toBeNull()
    stepAt(rt, 'g2', 2, 305_000, 'end_turn')
    await rt.onStop({ stopHookActive: false, lastMessage: 'Wired.', background: [VITE, RENDER], wakeups: [], permissionMode: undefined })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Wired.' })
    await advance(2000)

    // A model switch from Desktop's picker over the warm 305k cache: caught at the message, Switch back, sent once.
    live.model = SONNET
    expect(rt.onPreModelSwitch({ from_model: OPUS, to_model: SONNET, source: 'sdk', context_tokens: 305_000, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 1.5, pricing: 'catalog' })).toBeNull()
    rt.onPostModelSwitch({ from_model: OPUS, to_model: SONNET, cache_ttl: '1h', source: 'sdk' })
    live.answer = 'Switch back'
    const held = await rt.ops.coldGuard({ text: 'Now validate the release build.', origin: { kind: 'sdk' } as never })
    expect(held?.drop).toContain('Switching back to opus-5-5')
    await advance(3000)
    expect(live.model).toBe(OPUS)
    expect(kept.submittedAsUser.filter(t => t === 'Now validate the release build.')).toHaveLength(1)
    live.answer = undefined

    // The context fills again (705k): the render is still running, from session 1: this handoff does not wait for it.
    rt.onTurnStart({ turnId: 'w2', text: 'Carry on.' })
    stepAt(rt, 'w2', 0, 705_000, 'tool_use')
    await rt.onStop({ stopHookActive: false, lastMessage: 'Step done.', background: [VITE, RENDER], wakeups: [], permissionMode: undefined })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Step done.' })
    await advance(300)
    const handoffPrompt = kept.submitted.at(-1) ?? ''
    expect(handoffPrompt).toContain('Verification gone stale since it was recorded')
    await rt.onTurnStart({ turnId: 'h2', text: framed(handoffPrompt) })
    await call(rt, 'Write', { file_path: '/work/NEXT_SESSION_PROMPT.md', content: '# Next session 3' }, { type: 'update', filePath: '/work/NEXT_SESSION_PROMPT.md', content: '# Next session 3', structuredPatch: [], originalFile: '# Next session' })
    stepAt(rt, 'h2', 0, 706_000, 'end_turn')
    await rt.onStop({ stopHookActive: false, lastMessage: 'Handoff written.', background: [VITE, RENDER], wakeups: [], permissionMode: undefined })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Handoff written.' })
    for (let t = 0; t < 5_000 && kept.commands.filter(c => c === 'clear').length < 2; t += 500) await advance(500)
    expect(rt.autopilot.state).not.toBe('waiting-background')
    expect(kept.commands.filter(c => c === 'clear')).toHaveLength(2)

    // ------------------------------------------------------------------ context 3
    live.sessionId = 'S3'
    await rt.onClassicSessionStart({ source: 'clear', sessionId: 'S3' })
    const block3 = rt.takeFreshContext() ?? ''
    await advance(1000)
    expect(count(kept.submitted, 'Context Autopilot continuation')).toBe(2)
    await rt.onTurnStart({ turnId: 'c3', text: framed(kept.submitted.filter(t => t.includes('Context Autopilot continuation')).at(-1)) })
    stepAt(rt, 'c3', 0, 50_000, 'tool_use')
    rt.recordMilestones(PLAN('completed', 'completed', 'in_progress'), undefined)
    stepAt(rt, 'c3', 1, 52_000, 'end_turn')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Validating.' })
    await advance(3000)
    expect(block3).toContain('Render the 4K master (since session 1)')
    expect(block3).toContain('Verification gone stale since it was recorded')
    // The render ends here, two contexts after it began: recorded where it arrived.
    rt.onPromptSubmit(notification('r4k', 'completed'), { kind: 'task-notification' })
    expect(rt.run?.dependencies?.find(d => d.id === 'r4k')).toMatchObject({ fromSession: 1, status: 'completed', endedIn: 3 })
    expect(rt.run?.dependencies?.find(d => d.id === 'vite1')?.endedAt).toBeNull()

    // ------------------------------------------------------------------ the verify list
    // No loop, no carryover: two handoffs, two clears, two continuations, three sessions, the breaker never tripped.
    expect(rt.run?.sessions.map(x => `${x.id}:${x.start}`)).toEqual(['S1:startup', 'S2:handoff', 'S3:handoff'])
    expect(rt.autopilot.loop).toBeNull()
    expect(rt.autopilot.state).toBe('armed')
    expect(Views.hudOf(rt).ctx.tokens).toBe(52_000)
    // The objective, every milestone with its status, the decision, the watcher: carried.
    expect(rt.run?.objective ?? '').toContain('pressure-aware renderer')
    expect(rt.plan().tasks.map(t => t.status)).toEqual(['completed', 'completed', 'in_progress', 'pending'])
    expect(rt.ops.current().decisions.map(d => `${d.id}:${d.status}`)).toEqual(['D-1:open'])
    expect(rt.ops.current().watchers.map(w => `${w.id}:${w.status}`)).toEqual(['W-1:armed'])
    // No duplicate queued work, no duplicate continuation.
    expect(count(kept.submitted, 'Re-run the visual diff against the golden frames')).toBe(0)
    expect(block3).not.toContain('Re-run the visual diff against the golden frames')
    expect(rt.ops.current().queue.map(q => `${q.id}:${q.status}`)).toEqual(['Q-1:delivered'])
    expect(count(kept.submitted, 'Context Autopilot continuation')).toBe(2)
    // The agent that is still running is still shown; the stopped one ended.
    expect(rt.ops.view().agents.find(a => a.id === 'a1')?.status).toBe('running')
    // Plan usage stays Claude Code's reading.
    expect(Views.hudOf(rt).plan.windows.find(w => w.key === 'five_hour')?.percent).toBe(22)
  })
})
