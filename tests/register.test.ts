import { describe, expect, test } from 'claude-code/testing'

import { defaultSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { SESSION, world } from './fixtures/world'

const PRESENTATION = { isFullscreen: true, columns: 120 }
const cmd = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: PRESENTATION })
const spawnInput = (prompt: string) => ({
  tool_use_id: 'tu-1',
  prompt,
  description: 'scan',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
})
/** A plugin's prompt as Claude Code starts the turn with it: framed by the engine (seen live on 2.1.293). */
const framed = (text: string | undefined) => `The project-sentinel plugin sent a message:\n${text ?? ''}`
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal' as const], tools: [], outputStyle: null, traits: [] }

const withSettings = (patch: (s: Settings) => void): Settings => {
  const s = defaultSettings()
  patch(s)
  return s
}

describe('register', () => {
  test('the start registers /control-room and the /cr alias', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    expect(w.kept.registered).toContain('control-room')
    expect(w.kept.registered).toContain('cr')
    const { text } = await $.command.run(cmd('control-room', 'status'))
    expect(text).toContain('◆ Control Room')
    expect(text).toContain('Run 1')
  })

  test('beside a Control Room that still runs in the session (an update loaded both), every hook passes its event on', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    // Control Room's status bar in this session's `$.state`, as 1.3.0 publishes it.
    const former = { isVisible: true, headline: {}, chips: [], ctx: { tokens: 1 }, profile: { id: 'normal', name: 'Normal', isModified: false }, autopilot: { isOn: true, state: 'idle', text: '', tone: 'ok' } }
    on('state.get', ($, e, next) => (e.plugin === 'control-room' ? { value: { value: former, version: 7 } } : next(e)))
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    const checked: string[] = []
    on('tool.check', ($, e) => {
      checked.push(String((e.input as { command?: string }).command))
      return { decision: 'allow' as const }
    })
    await $.session.start(SESSION)
    await w.clock.advance(2000)
    expect(w.kept.toasts).toEqual(['Project Sentinel is installed. Control Room keeps this session until it restarts.'])
    // Control Room keeps /control-room, /cr and its milestones tool: nothing of Project Sentinel's is registered.
    expect(w.kept.registered).toEqual([])
    await $.command.run(cmd('cr', 'status'))
    expect(w.kept.commandsRun).toEqual([{ command: 'cr', args: 'status' }])
    // Its defaults would ask before a push and refuse a force push: here Control Room's own settings decide.
    expect((await $.tool.call({ tool: 'Bash', command: 'git push origin main' })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })).deny).toBeUndefined()
    expect(w.kept.asked).toEqual([])
    expect(checked).toEqual([])
    // No policy section, no status bar, no run recorded, nothing carried over.
    const composed = await $.prompt.compose(COMPOSE)
    expect(composed.sections.map(s => s.id)).toEqual(['intro'])
    const band = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
    expect(await band.find({ text: /Context|Work|Cache/ })).toBeUndefined()
    await band.unmount()
    await w.clock.advance(5000)
    expect(Object.keys(w.store)).toEqual([])
  })

  test('/cr sub-commands change settings and persist them', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    const r = await $.command.run(cmd('cr', 'autopilot 65%'))
    expect(r.text).toBe('Autopilot on. Hands off at 65%.')
    await w.clock.advance(2000)
    const saved = w.store['settings.v1'] as Settings
    expect(saved.autopilot.enabled).toBe(true)
    expect(saved.autopilot.thresholdPercent).toBe(65)
    await $.command.run(cmd('cr', 'profile frontier'))
    await w.clock.advance(2000)
    expect((w.store['settings.v1'] as Settings).frontier.enabled).toBe(true)
  })

  test('/cr cache tells the cache in words and sets Keep warm, its idle limit and the other cache settings', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    const status = await $.command.run(cmd('cr', 'cache'))
    expect(status.text).toContain('◆ Prompt cache')
    expect(status.text).toContain('Nothing cached yet')
    expect(status.text).toContain('derived')
    expect((await $.command.run(cmd('cr', 'cache keep on'))).text).toContain('Keep warm on.')
    expect((await $.command.run(cmd('cr', 'cache idle 45m'))).text).toBe('Keep warm stops after 45 min idle.')
    expect((await $.command.run(cmd('cr', 'cache stable off'))).text).toBe('Keep policies stable off.')
    expect((await $.command.run(cmd('cr', 'cache guard off'))).text).toBe('Ask before a model switch off.')
    expect((await $.command.run(cmd('cr', 'cache sideways'))).text).toContain('Usage: /cr cache')
    await w.clock.advance(2000)
    expect((w.store['settings.v1'] as Settings).cache).toMatchObject({ keepWarm: true, maxIdleMinutes: 45, stablePolicies: false, guardModelSwitch: false })
    expect((await $.command.run(cmd('cr', 'status'))).text).toContain('Prompt cache')
  })

  test('a model switch that would lose a large warm cache is put to the person first, with what it re-sends', { timeoutMs: 30_000 }, async ($, on) => {
    world(on)
    on('classic.PreModelSwitch', () => ({}))
    on('classic.PostModelSwitch', () => ({}))
    await $.session.start(SESSION)
    const input = { from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command' as const, context_tokens: 412_000, prompt_cache_warm: true, cache_ttl: '1h' as const, estimated_cache_write_usd: 2.06, pricing: 'catalog' as const }
    const asked = await $.classic.PreModelSwitch(input)
    expect(asked.permissionDecision).toBe('ask')
    expect(asked.permissionDecisionReason).toContain('re-sends 412k cached tokens')
    expect(asked.permissionDecisionReason).toContain('about $2.06')
    const cold = await $.classic.PreModelSwitch({ ...input, prompt_cache_warm: false })
    expect(cold.permissionDecision).toBeUndefined()
    const scripted = await $.classic.PreModelSwitch({ ...input, source: 'sdk' as const })
    expect(scripted.permissionDecision).toBeUndefined()
    await $.classic.PostModelSwitch({ ...input, source: 'command' as const })
    expect((await $.command.run(cmd('cr', 'cache'))).text).toContain('1 hour (as Claude Code reports it)')
  })

  test('Deny categories are refused before anything runs', { timeoutMs: 30_000 }, async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    const dangerous = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~' })
    expect(dangerous.deny).toContain('Permission Policy')
    const force = await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
    expect(force.deny).toContain('Force push & destructive Git')
    const fine = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(fine.deny).toBeUndefined()
  })

  test('Ask: Control Room asks first where Claude Code would not ask, never answers a permission check, and a settings deny stands', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    let engine: 'allow' | 'ask' | 'deny' = 'allow'
    const checked: string[] = []
    on('tool.check', ($, e) => {
      checked.push(String((e.input as { command?: string }).command))
      return { decision: engine, rule: 'Bash' }
    })
    await $.session.start(SESSION)
    // Claude Code would run it without asking: Control Room asks, and a yes passes the call on.
    w.live.askAnswer = 'Run it'
    const yes = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    expect(yes.deny).toBeUndefined()
    expect(w.kept.asked.length).toBe(1)
    expect(w.kept.asked[0]).toContain('Git push is set to Ask')
    expect(checked).toEqual(['git push origin main'])
    // A no refuses it, and what the person typed reaches Claude.
    w.live.askAnswer = 'not from main'
    const no = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    expect(no.deny).toContain('the user declined "Git push"')
    expect(no.deny).toContain('The user said: "not from main"')
    // Claude Code will ask itself: its own dialog is the question, so Control Room adds none.
    engine = 'ask'
    await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    expect(w.kept.asked.length).toBe(2)
    // Claude Code refuses it (a settings deny): no question, and the call goes on to be refused there.
    engine = 'deny'
    await $.tool.call({ tool: 'Bash', command: 'npm install zod' })
    expect(w.kept.asked.length).toBe(2)
    // Default categories are never asked about.
    engine = 'allow'
    const plain = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(plain.deny).toBeUndefined()
    expect(w.kept.asked.length).toBe(2)
    // Control Room has no permission check of its own: a query gets Claude Code's verdict unchanged.
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git push origin main' } })).decision).toBe('allow')
    engine = 'deny'
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git push origin main' } })).decision).toBe('deny')
  })

  test('machine load on Windows runs typeperf by name with fixed arguments (no shell), and systeminfo once for the total memory', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { settings: withSettings(s => void (s.resources.level = 'medium')) })
    await $.session.start({ ...SESSION, cwd: 'C:\\work' })
    await w.clock.advance(500)
    expect(w.kept.spawned).toEqual([['typeperf.exe', '\\Processor(_Total)\\% Processor Time', '\\Memory\\Available Bytes', '-si', '2']])
    expect(w.kept.ran.filter(argv => argv[0] === 'systeminfo.exe')).toEqual([['systeminfo.exe', '/fo', 'csv', '/nh']])
  })

  test('machine load on macOS runs top by name with fixed arguments (no shell), and sysctl for the memory level at a reading', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, {
      settings: withSettings(s => void (s.resources.level = 'medium')),
      exists: ['/System/Library/CoreServices/SystemVersion.plist'],
      samplerLines: ['CPU usage: 5.26% user, 10.52% sys, 84.21% idle '],
    })
    await $.session.start({ ...SESSION, cwd: '/Users/a/work' })
    await w.clock.advance(500)
    expect(w.kept.spawned).toEqual([['top', '-l', '0', '-s', '2', '-n', '0']])
    expect(w.kept.ran.filter(argv => argv[0] === 'sysctl')).toEqual([['sysctl', '-n', 'kern.memorystatus_level']])
  })

  test('Subagent Control: Off blocks and hides, Max N counts, Ask asks', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { settings: withSettings(s => { s.subagents.mode = 'block' }) })
    on('agent.spawn', ($, e) => ({ model: e.model ?? 'claude-haiku-4-5', agentId: 'a1' }))
    on('agent.offer', () => ({ isOffered: true }))
    await $.session.start(SESSION)
    const offered = await $.agent.offer({ agent: 'Explore', description: 'x', source: 'built-in', provider: { plugin: 'engine', tier: 'core' } })
    expect(offered.isOffered).toBe(false)
    const spawned = await $.agent.spawn(spawnInput('look around'))
    expect(spawned.deny).toContain('disabled')
    await $.command.run(cmd('cr', 'agents ask'))
    w.live.askAnswer = 'Allow'
    const allowed = await $.agent.spawn(spawnInput('look around'))
    expect(allowed.deny).toBeUndefined()
    expect(w.kept.asked.length).toBe(1)
    w.live.askAnswer = 'Deny'
    const refused = await $.agent.spawn(spawnInput('again'))
    expect(refused.deny).toContain('did not approve')
  })

  test('Frontier Max: policy section and maximum effort; none invented for models without effort', { timeoutMs: 30_000 }, async ($, on) => {
    // Fresh installs run Frontier Max at Extra High (1.7.0); Maximum is one pick away.
    world(on, { settings: withSettings(s => { s.frontier.enabled = true; s.frontier.effort = 'max' }) })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
    const sent: unknown[] = []
    on('turn.step', async function* ($, e) {
      sent.push(e.effort)
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })
    await $.session.start(SESSION)
    const composed = await $.prompt.compose(COMPOSE)
    const policy = composed.sections.find(s => s.id === 'project-sentinel:policies')
    expect(policy?.scope).toBe('session')
    expect(policy?.text).toContain('frontier-level autonomous capability')
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 2 })) void _
    for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'claude-haiku-4-5', messageCount: 3 })) void _
    expect(sent).toEqual(['max', undefined])
  })

  test('the very first composition waits for the saved settings: Frontier Max is in the system prompt even when the prompt is composed before the session start settles', { timeoutMs: 30_000 }, async ($, on) => {
    world(on, { settings: withSettings(s => { s.frontier.enabled = true; s.frontier.effort = 'xhigh' }) })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
    const sent: unknown[] = []
    on('turn.step', async function* ($, e) {
      sent.push(e.effort)
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 30_000, model: 'claude-opus-5-5' } }
    })
    // No session.start, no prompt.submit first: the compose hook and the step load the settings themselves.
    const composed = await $.prompt.compose(COMPOSE)
    const policy = composed.sections.find(s => s.id === 'project-sentinel:policies')
    expect(policy?.text).toContain('## Frontier Max')
    expect(policy?.text).toContain('set to xhigh')
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })) void _
    expect(sent).toEqual(['xhigh'])
    // /cr diagnostics shows the evidence: the first request, how the policies travelled, the effort sent.
    await $.session.start(SESSION)
    const diag = (await $.command.run(cmd('cr', 'diagnostics'))).text
    expect(diag).toContain('Frontier Max     on · delivered via system')
    expect(diag).toContain('request 1 · turn t1 step 0 · section ')
    expect(diag).toContain('Frontier Max delivered')
    expect(diag).toContain('effort xhigh')
    expect(diag).not.toContain('SETTINGS NOT LOADED')
  })

  test('notes while Claude works go with the next batch of tool results (classic.PostToolBatch), on the main conversation only, and nothing is appended to the transcript', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    on('classic.PostToolBatch', () => ({}))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await $.session.start(SESSION)
    await $.turn.start({ text: 'Build the parser.', turnId: 't1' })
    await $.command.run(cmd('cr', 'resources low'))
    // A subagent's batch carries nothing of the main conversation's.
    const sub = await $.classic.PostToolBatch({ tool_calls: [], agent_id: 'agent-1' })
    expect(sub.additionalContext ?? []).toEqual([])
    const main = await $.classic.PostToolBatch({ tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu-1' }] })
    expect((main.additionalContext ?? []).join(' ')).toContain('## Resource Governor: LOW')
    // Once: the next batch carries nothing.
    expect((await $.classic.PostToolBatch({ tool_calls: [] })).additionalContext ?? []).toEqual([])
    expect(w.kept.appended).toEqual([])
  })

  test("Claude Code's thinking_drop row marks the next rebuild as a proven change of the earlier conversation; the row passes on unchanged", { timeoutMs: 30_000 }, async ($, on) => {
    world(on, { settings: withSettings(s => void (s.cache.keepWarm = false)) })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    let reads = [0, 3_000]
    on('turn.step', async function* ($, e) {
      const read = reads.shift() ?? 0
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: 300_000 - read, model: 'claude-opus-5-5' } }
    })
    await $.session.start(SESSION)
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 2 })) void _
    const row = { message: { type: 'attachment' as const, name: 'thinking_drop', content: [] }, door: 'attachment' as const, origin: { kind: 'engine' as const }, uuid: 'row-drop' }
    // Claude Code appends the row. Before 2.1.293 the test kit keeps no transcript beneath the
    // plugins for a test's own append (the plugins' hooks run, then nothing answers): only that is excused.
    const stored = await $.session.append(row).catch((err: unknown) => {
      if (/no implementation for session\.append/.test(String(err))) return { deny: undefined }
      throw err
    })
    expect(stored.deny).toBeUndefined()
    for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 4 })) void _
    const cache = (await $.command.run(cmd('cr', 'cache'))).text
    expect(cache).toContain('Earlier conversation changed')
    expect(cache).toContain('proven cause')
    reads = []
  })

  test('No-Lazy-Exit Guard continues a lazy stop once, then respects the loop guard', { timeoutMs: 30_000 }, async ($, on) => {
    world(on, { settings: withSettings(s => { s.guard.enabled = true; s.guard.modelCheck = false }) })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('classic.Stop', () => ({}))
    await $.session.start(SESSION)
    await $.prompt.submit({ text: 'Implement the CSV export and add tests.', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'Implement the CSV export and add tests.', turnId: 't1' })
    const lazy = "I added the button. You'll need to implement the serializer and write the tests yourself. TODO: quoting."
    const first = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: lazy })
    expect(first.block).toContain('No-Lazy-Exit Guard')
    const again = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: lazy })
    expect(again.block).toBeUndefined()
    const done = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'Implemented and all 12 tests pass.' })
    expect(done.block).toBeUndefined()
  })

  test('Context Autopilot: threshold → pending notice → handoff → verified → /clear → fresh context → continuation', { timeoutMs: 30_000 }, async ($, on) => {
    let fresh: { additionalContext?: string[] } | undefined
    on('command.run', { command: 'clear' }, async () => {
      w.live.sessionId = 'session-2'
      fresh = await $.classic.SessionStart({ source: 'clear', session_id: 'session-2' })
      return { text: '' }
    })
    const w = world(on, {
      settings: withSettings(s => {
        s.autopilot.enabled = true
        s.autopilot.thresholdMode = 'tokens'
        s.autopilot.thresholdTokens = 100_000
      }),
      tokens: 50_000,
    })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('turn.step', async function* ($, e) {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [{ name: 'Bash', input: { command: 'npm test' } }],
        stopReason: 'tool_use' as const,
        usage: { input_tokens: 10, output_tokens: 2000, cache_read_input_tokens: 110_000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
      }
    })
    await $.session.start(SESSION)
    await $.turn.start({ text: 'build the feature', turnId: 't1' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 4 })) void _
    await w.clock.settle()
    const pending = await $.command.run(cmd('cr', 'status'))
    expect(pending.text).toContain('Handoff soon')

    w.live.usage = { ...w.live.usage, context: { tokens: 112_000, window: 1_000_000, percent: 11 } }
    await $.turn.complete({ answer: 'Feature done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.advance(300)
    const handoff = w.kept.submitted.find(t => t.includes('final handoff'))
    expect(handoff).toBeDefined()
    expect(handoff).toContain('NEXT_SESSION_PROMPT.md')
    expect(handoff).not.toContain('must contain')

    await $.turn.start({ text: framed(handoff), turnId: 't2' })
    await $.turn.complete({ answer: 'Handoff written.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
    await w.clock.advance(2000)
    // The session's start is passed on as Claude Code made it; the fresh context's first message carries the notes.
    expect(fresh).toBeDefined()
    expect(fresh?.additionalContext).toBeUndefined()
    expect(w.kept.invalidated).toContain('prompt.context')
    const blocks = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'Today' }] })
    expect(blocks.blocks.map(b => b.name)).toEqual(['currentDate', 'contextAutopilot'])
    expect(blocks.blocks[1]?.text).toContain('fresh context')
    // Once: a later read of the conversation's context (a compaction) carries no stale notes.
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
    await w.clock.advance(1000)
    const continuation = w.kept.submitted.find(t => t.includes('Context Autopilot continuation'))
    expect(continuation).toBeDefined()
    expect(continuation).toContain('NEXT_SESSION_PROMPT.md')

    const status = await $.command.run(cmd('cr', 'status'))
    expect(status.text).toContain('Session 2')
  })

  test('Context Autopilot in the terminal: the reset lands after /clear returns, and the fresh session is still ours', { timeoutMs: 30_000 }, async ($, on) => {
    let fresh: { additionalContext?: string[] } | undefined
    let finishReset: (() => Promise<void>) | null = null
    on('command.run', { command: 'clear' }, async () => {
      // The interactive terminal resets the session after the command has returned.
      finishReset = async () => {
        w.live.sessionId = 'session-2'
        fresh = await $.classic.SessionStart({ source: 'clear', session_id: 'session-2' })
      }
      return { text: '' }
    })
    const w = world(on, { settings: withSettings(s => void (s.autopilot.enabled = true)) })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start(SESSION)
    await $.command.run(cmd('cr', 'handoff'))
    await w.clock.advance(400)
    // The handoff turn is recognised by the prompt it begins with.
    await $.turn.start({ text: framed(w.kept.submitted.find(t => t.includes('final handoff'))), turnId: 'h1' })
    await $.turn.complete({ answer: 'Handoff written.', durationMs: 1, isAborted: false, turnId: 'h1', reason: 'answer' })
    await w.clock.advance(3000)
    expect(finishReset).not.toBeNull()
    // Nothing is sent into the old context while the reset is still under way.
    expect(w.kept.submitted.some(t => t.includes('Context Autopilot continuation'))).toBe(false)

    await finishReset!()
    await w.clock.advance(1000)
    expect(fresh?.additionalContext).toBeUndefined()
    expect((await $.prompt.context({ blocks: [] })).blocks.map(b => b.text).join(' ')).toContain('fresh context')
    expect(w.kept.submitted.find(t => t.includes('Context Autopilot continuation'))).toContain('(session 2)')
    const runs = Object.entries(w.store).filter(([k]) => k.startsWith('run.v1.')).map(([, v]) => v as { sessions: { end: string | null }[] })
    expect(runs.at(-1)?.sessions.map(s => s.end)).toEqual(['handoff', null])
  })

  test('the handoff never clears the context when the notes were not written', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { settings: withSettings(s => { s.autopilot.enabled = true }), isHandoffWritten: false })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start(SESSION)
    await $.command.run(cmd('cr', 'handoff'))
    await w.clock.advance(400)
    await $.turn.start({ text: framed(w.kept.submitted.find(t => t.includes('final handoff'))), turnId: 'h1' })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'h1', reason: 'answer' })
    await w.clock.advance(400)
    await $.turn.start({ text: framed(w.kept.submitted.find(t => t.includes('could not find an updated'))), turnId: 'h2' })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'h2', reason: 'answer' })
    await w.clock.advance(3000)
    expect(w.kept.submitted.some(t => t.includes('could not find an updated'))).toBe(true)
    expect(w.kept.commandsRun.map(c => c.command)).not.toContain('clear')
  })

  test('a prompt the person queued behind the handoff runs first: the clear waits for its turn to end', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { settings: withSettings(s => void (s.autopilot.enabled = true)) })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start(SESSION)
    await $.command.run(cmd('cr', 'handoff'))
    await w.clock.advance(400)
    await $.turn.start({ text: framed(w.kept.submitted.find(t => t.includes('final handoff'))), turnId: 'h1' })
    await $.turn.complete({ answer: 'Handoff written.', durationMs: 1, isAborted: false, turnId: 'h1', reason: 'answer' })
    // The queued prompt starts the moment the handoff turn ends, before the clear would run.
    await $.turn.start({ text: 'Also rename the helper.', turnId: 'p1' })
    await w.clock.advance(5000)
    expect(w.kept.commandsRun.map(c => c.command)).not.toContain('clear')
    await $.turn.complete({ answer: 'Renamed.', durationMs: 1, isAborted: false, turnId: 'p1', reason: 'answer' })
    await w.clock.advance(3000)
    expect(w.kept.commandsRun.map(c => c.command)).toContain('clear')
  })

  test('a handoff turn that ends with background work running is not over: the notes are checked and the context cleared only after a turn ends with none in flight', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { settings: withSettings(s => void (s.autopilot.enabled = true)) })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('classic.Stop', () => ({}))
    await $.session.start(SESSION)
    await $.command.run(cmd('cr', 'handoff'))
    await w.clock.advance(400)
    await $.turn.start({ text: framed(w.kept.submitted.find(t => t.includes('final handoff'))), turnId: 'h1' })
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'The checks run in the background.', background_tasks: [{ id: 'bg1', type: 'local_bash', status: 'running', description: 'npm test' }] })
    await $.turn.complete({ answer: 'The checks run in the background.', durationMs: 1, isAborted: false, turnId: 'h1', reason: 'answer' })
    await w.clock.advance(5000)
    expect(w.kept.commandsRun.map(c => c.command)).not.toContain('clear')
    expect((await $.command.run(cmd('cr', 'status'))).text).toContain('Waiting for background work')
    // The job ends and a turn follows (here one whose prompt went unseen, its text empty); it ends with nothing running.
    // The real lifecycle (a task-notification prompt and turn) is in background.test.ts.
    await $.turn.start({ text: '', turnId: 'h2' })
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Checks pass. Handoff written.', background_tasks: [] })
    await $.turn.complete({ answer: 'Checks pass. Handoff written.', durationMs: 1, isAborted: false, turnId: 'h2', reason: 'answer' })
    await w.clock.advance(3000)
    expect(w.kept.commandsRun.map(c => c.command)).toContain('clear')
  })

  test('a turn of the person’s ending mid-handoff never counts as the handoff turn', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { settings: withSettings(s => void (s.autopilot.enabled = true)) })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start(SESSION)
    await $.command.run(cmd('cr', 'handoff'))
    // The person's own prompt starts and ends before the handoff prompt's turn begins.
    await $.turn.start({ text: 'One more thing first.', turnId: 'p1' })
    await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 'p1', reason: 'answer' })
    await w.clock.advance(3000)
    const status = await $.command.run(cmd('cr', 'status'))
    expect(status.text).toContain('Writing the handoff')
    expect(w.kept.submitted.some(t => t.includes('could not find an updated'))).toBe(false)
    expect(w.kept.commandsRun.map(c => c.command)).not.toContain('clear')
  })

  test('a resource level change reaches the system prompt; no sampler runs on an unknown platform', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start(SESSION)
    await $.command.run(cmd('cr', 'resources low'))
    await w.clock.settle()
    const composed = await $.prompt.compose(COMPOSE)
    expect(composed.sections.map(x => x.text).join(' ')).toContain('Resource Governor: LOW')
    expect(w.kept.spawned.length).toBe(0)
    const status = await $.command.run(cmd('cr', 'status'))
    expect(status.text).toMatch(/Machine load\s+Low/)
  })
})
