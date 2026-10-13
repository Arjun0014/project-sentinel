import { describe, expect, test } from 'claude-code/testing'

import type { ToolCallResult } from 'claude-code'

import type { ResourcesView } from '../types'
import { withAllowRemoved } from '../hooks/app/persist'
import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { classicSettings, defaultSettings, systemsOf } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { fakeHost, flush, typeperfLine } from './fixtures/fake-host'

async function started(patch: (s: Settings) => void, options: Parameters<typeof fakeHost>[0] = {}) {
  const f = fakeHost(options)
  const s = classicSettings()
  patch(s)
  f.kept.store['settings.v1'] = s
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: options.cwd ?? '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { rt, ...f }
}

const step = (tokens: number, stop: 'tool_use' | 'end_turn') => ({
  turnId: 't1',
  index: 0,
  answer: '',
  toolUses: [],
  stopReason: stop,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
})

describe('runtime', () => {
  test('crossing the threshold mid-turn tells Claude to finish the current unit, with the next batch of tool results', async () => {
    const { rt } = await started(s => {
      s.autopilot.enabled = true
      s.autopilot.thresholdMode = 'tokens'
      s.autopilot.thresholdTokens = 100_000
    })
    rt.onTurnStart({ turnId: 't1', text: 'build it' })
    const e = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }
    rt.stepResponse(e, {}, step(120_000, 'tool_use'))
    await flush()
    expect(rt.autopilot.state).toBe('pending')
    // It waits for the tool results the crossing step asked for, and goes once.
    expect(rt.notesBox.kinds()).toEqual(['autopilot'])
    const batch = rt.notesForBatch()
    expect(batch.some(t => t.includes('Finish the logical unit of work'))).toBe(true)
    expect(rt.notesForBatch()).toEqual([])
    expect(rt.notesBox.delivered[0]).toMatchObject({ kind: 'autopilot', channel: 'tool-batch' })
  })

  test('the final step of a turn does not send a pointless notice; the turn end starts the handoff', async () => {
    const { rt, kept, live, advance } = await started(s => {
      s.autopilot.enabled = true
      s.autopilot.thresholdMode = 'tokens'
      s.autopilot.thresholdTokens = 100_000
    })
    rt.onTurnStart({ turnId: 't1', text: 'build it' })
    rt.stepResponse({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }, {}, step(120_000, 'end_turn'))
    expect(rt.notesBox.count()).toBe(0)
    live.usage = { ...live.usage, context: { tokens: 120_000, window: 1_000_000, percent: 12 } }
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await advance(300)
    expect(kept.submitted.some(t => t.includes('final handoff'))).toBe(true)
  })

  test('changing the resource level or modes between turns tells Claude with the next prompt', async () => {
    const { rt } = await started(() => undefined)
    rt.update(s => {
      s.resources.level = 'low'
    })
    rt.update(s => {
      s.frontier.enabled = true
    })
    await flush()
    const context = rt.onPromptSubmit('Carry on.', { kind: 'composer' })
    expect(context.some(t => t.includes('## Resource Governor: LOW'))).toBe(true)
    expect(context.some(t => t.includes('Frontier Max is now ON'))).toBe(true)
    // Said once: the next prompt carries nothing more.
    expect(rt.onPromptSubmit('And this.', { kind: 'composer' }).some(t => t.includes('Frontier Max'))).toBe(false)
  })

  test('machine pressure from the sampler reaches Claude with the next tool results, and extra heavy jobs are held back', async () => {
    const { rt, kept, advance } = await started(
      s => {
        s.resources.level = 'medium'
      },
      { cwd: 'C:\\work', samplerLines: [typeperfLine(96, 1000)] },
    )
    await advance(500)
    expect(kept.spawned[0]?.[0]).toBe('windows')
    expect(rt.monitor.pressure.level).toBe('critical')
    rt.onTurnStart({ turnId: 't1', text: 'build it' })
    expect(rt.notesForBatch().some(t => t.includes('Resource pressure CRITICAL'))).toBe(true)
    // Told once: the next batch says nothing while the level holds.
    expect(rt.notesForBatch()).toEqual([])
    expect(await rt.beforeTool('Bash', { command: 'npm run build' }, 'b1', undefined)).toBeNull()
    const refusal = await rt.beforeTool('Bash', { command: 'npm test' }, 'b2', undefined)
    expect(refusal).toContain('not starting another heavy job')
    expect(await rt.beforeTool('Bash', { command: 'git status' }, 'b3', undefined)).toBeNull()
  })

  test('live readings without a limit still reach the panel; the status line names them only when high', async () => {
    const { rt, kept, advance } = await started(
      s => {
        s.resources.level = 'off'
        s.ui.liveLoad = true
      },
      { cwd: 'C:\\work', samplerLines: [typeperfLine(42, 4000)] },
    )
    await advance(500)
    // No ceilings, so no pressure is evaluated; the readings themselves still show.
    expect(rt.monitor.pressure.level).toBe('unknown')
    const view = kept.published.resources as ResourcesView
    expect(view.status).toBe('live')
    expect(view.cpu).toBe(42)
    expect(view.ram).toBe(60)
    expect(view.ceilings).toBeNull()
    // Calm readings stay in the panel; the status line keeps to the run.
    expect(Views.statusLineOf(Views.hudOf(rt))).not.toContain('CPU')
    expect(Views.hudOf(rt).load?.cpu).toBe(42)
    expect(rt.notesForBatch().some(t => t.includes('Resource pressure'))).toBe(false)
  })

  test('a busy machine shows in the status line while it is busy', async () => {
    const { rt, advance } = await started(
      s => {
        s.resources.level = 'off'
        s.ui.liveLoad = true
      },
      { cwd: 'C:\\work', samplerLines: [typeperfLine(42, 800)] },
    )
    await advance(500)
    expect(Views.statusLineOf(Views.hudOf(rt))).toContain('RAM 92%')
    expect(Views.statusLineOf(Views.hudOf(rt))).not.toContain('CPU')
  })

  test('Windows reads the total memory once, from systeminfo; typeperf\'s header and closing words are no reading', async () => {
    const { rt, kept, advance } = await started(
      s => {
        s.resources.level = 'off'
        s.ui.liveLoad = true
      },
      { cwd: 'C:\\work', samplerLines: ['', '"(PDH-CSV 4.0)","\\\\PC\\Processor(_Total)\\% Processor Time","\\\\PC\\Memory\\Available Bytes"', typeperfLine(18, 2500)] },
    )
    await advance(500)
    expect(kept.ran).toEqual(['systeminfo'])
    const view = kept.published.resources as ResourcesView
    expect([view.status, view.cpu, view.ram]).toEqual(['live', 18, 75])
  })

  test('Windows without a readable total: the CPU still shows, memory reads as unknown', async () => {
    const { kept, advance } = await started(
      s => {
        s.resources.level = 'off'
        s.ui.liveLoad = true
      },
      { cwd: 'C:\\work', systemInfo: 'ERROR: Access denied.\r\n', samplerLines: [typeperfLine(18, 2500)] },
    )
    await advance(500)
    const view = kept.published.resources as ResourcesView
    expect([view.status, view.cpu, view.ram]).toEqual(['live', 18, null])
  })

  const MAC = { cwd: '/Users/a/work', dirs: ['/System/Library/CoreServices/SystemVersion.plist'] }
  const TOP = ['Processes: 512 total, 3 running, 509 sleeping, 2489 threads', 'PhysMem: 15G used (2588M wired, 1092M compressor), 1G unused.', 'CPU usage: 5.26% user, 10.52% sys, 84.21% idle ']

  test('macOS: top gives the CPU, the kernel\'s memory level the memory', async () => {
    const { kept, advance } = await started(
      s => {
        s.resources.level = 'off'
        s.ui.liveLoad = true
      },
      { ...MAC, samplerLines: TOP },
    )
    await advance(500)
    expect(kept.spawned[0]?.[0]).toBe('macos')
    expect(kept.ran).toEqual(['sysctl'])
    const view = kept.published.resources as ResourcesView
    expect([view.status, view.cpu, view.ram]).toEqual(['live', 15.8, 37])
  })

  test('macOS without the kernel\'s memory level: top\'s PhysMem stands in', async () => {
    const { kept, advance } = await started(
      s => {
        s.resources.level = 'off'
        s.ui.liveLoad = true
      },
      { ...MAC, memoryLevel: 'sysctl: unknown oid', samplerLines: TOP },
    )
    await advance(500)
    const view = kept.published.resources as ResourcesView
    expect([view.status, view.cpu, view.ram]).toEqual(['live', 15.8, 93.8])
  })

  test('a person\'s /clear rolls the chain over and resets the turn state; ours carries the continuation context', async () => {
    const { rt, live } = await started(s => {
      s.autopilot.enabled = true
    })
    live.sessionId = 'S2'
    await rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    expect(rt.takeFreshContext()).toBeNull()
    expect(rt.run?.sessions.map(s => s.end)).toEqual(['clear', null])
    rt.autopilot = { ...rt.autopilot, state: 'clearing' }
    await rt.onClassicSessionStart({ source: 'clear', sessionId: 'S3' })
    // The fresh context's first message carries the notes, once.
    expect(rt.takeFreshContext()).toContain('NEXT_SESSION_PROMPT.md')
    expect(rt.takeFreshContext()).toBeNull()
    expect(rt.run?.sessions.map(s => s.start)).toEqual(['startup', 'clear', 'handoff'])
  })

  test('a /clear that never resets the session is a failed clear: compaction takes over', async () => {
    const { rt, kept, advance } = await started(s => {
      s.autopilot.enabled = true
    })
    // A handoff waiting for the person, its notes written (Start fresh checks them first).
    rt.autopilot = { ...rt.autopilot, state: 'awaiting', handoffSince: rt.clock() }
    void rt.startFreshContext()
    await advance(2000)
    expect(kept.commands).toContain('clear')
    expect(rt.autopilot.state).toBe('clearing')
    await advance(16_000)
    expect(rt.autopilot.lastError).toBe('the context was not cleared')
    expect(kept.compacted).toBe(1)
    // Its own compaction never reaches its own session.compact hook: the context meter still takes the compacted size.
    expect(rt.run?.sessions.at(-1)?.transitions.at(-1)).toMatchObject({ kind: 'handoff-compact' })
    expect(rt.usage.tokens).toBe(40_000)
  })

  test('a session that compacts only inside a turn (headless, SDK: seen live): the handoff runs /compact as a command, and carries on once the engine has compacted', async () => {
    const { rt, kept, live, advance } = await started(s => {
      s.autopilot.enabled = true
    })
    live.isCompactTurnOnly = true
    // A handoff waiting for the person, its notes written (Start fresh checks them first).
    rt.autopilot = { ...rt.autopilot, state: 'awaiting', handoffSince: rt.clock() }
    void rt.startFreshContext()
    await advance(2000)
    // The /clear does not take: compaction takes over, as the /compact command (never a prompt: a plugin's prompt may not run a command).
    await advance(16_000)
    expect(rt.autopilot.state).toBe('compacting')
    const compact = kept.commands.find(c => c.startsWith('compact '))
    expect(compact).toContain('Context Autopilot handoff')
    expect(compact).toContain('NEXT_SESSION_PROMPT.md')
    expect(kept.submitted.some(t => t.startsWith('/'))).toBe(false)
    // The engine compacts (the command's own trigger): the handoff carries on in the compacted context.
    rt.onCompacted('manual', { messages: [], tokensBefore: 900_000, tokensAfter: 40_000 })
    expect(rt.autopilot.state).toBe('resuming')
    // Recorded as the handoff's compaction, not as one the person ran.
    expect(rt.run?.sessions.at(-1)?.transitions.at(-1)).toMatchObject({ kind: 'handoff-compact', tokensBefore: 900_000, tokensAfter: 40_000 })
    await advance(1000)
    expect(kept.submitted.some(t => t.includes('Context Autopilot continuation'))).toBe(true)
  })

  test('a /compact that never compacts leaves the handoff waiting for the person, never hanging', async () => {
    const { rt, live, advance } = await started(s => {
      s.autopilot.enabled = true
    })
    live.isCompactTurnOnly = true
    // A handoff waiting for the person, its notes written (Start fresh checks them first).
    rt.autopilot = { ...rt.autopilot, state: 'awaiting', handoffSince: rt.clock() }
    void rt.startFreshContext()
    await advance(18_000)
    expect(rt.autopilot.state).toBe('compacting')
    await advance(10 * 60_000)
    expect(rt.autopilot).toMatchObject({ state: 'awaiting', lastError: '/compact did not compact the context' })
  })

  test('a /clear whose fresh session start goes unseen still counts once the session id changed', async () => {
    const { rt, kept, live, advance } = await started(s => {
      s.autopilot.enabled = true
    })
    // A handoff waiting for the person, its notes written (Start fresh checks them first).
    rt.autopilot = { ...rt.autopilot, state: 'awaiting', handoffSince: rt.clock() }
    void rt.startFreshContext()
    await advance(2000)
    live.sessionId = 'S2'
    await advance(16_000)
    expect(kept.compacted).toBe(0)
    expect(kept.submitted.some(t => t.includes('Context Autopilot continuation'))).toBe(true)
  })

  test('a handoff waiting by choice reads amber (waiting for you, nothing wrong); one that went wrong reads red', async () => {
    const { rt } = await started(s => {
      s.autopilot.enabled = true
    })
    rt.autopilot = { ...rt.autopilot, state: 'awaiting', lastError: null }
    expect(Views.hudOf(rt).alert).toMatchObject({ kind: 'awaiting', tone: 'warn' })
    expect(Views.autopilotStatus(rt).tone).toBe('warn')
    rt.autopilot = { ...rt.autopilot, lastError: 'the context was not cleared' }
    expect(Views.hudOf(rt).alert).toMatchObject({ kind: 'awaiting', tone: 'bad' })
    expect(Views.autopilotStatus(rt).tone).toBe('bad')
  })

  test('the guard blocks at most the configured number of times per turn', async () => {
    const { rt } = await started(s => {
      s.guard.enabled = true
      s.guard.modelCheck = false
      s.guard.maxPerTurn = 1
    })
    rt.onPromptSubmit('Implement the parser and tests', { kind: 'composer' })
    rt.onTurnStart({ turnId: 't1', text: 'Implement the parser and tests' })
    const lazy = "You'll need to implement the rest yourself. TODO: errors."
    expect(await rt.onStop({ stopHookActive: false, lastMessage: lazy, background: [], wakeups: [], permissionMode: 'default' })).toContain('No-Lazy-Exit Guard')
    expect(await rt.onStop({ stopHookActive: true, lastMessage: `${lazy} Also docs.`, background: [], wakeups: [], permissionMode: 'default' })).toBeNull()
  })

  test('the guard stands down while a handoff is pending', async () => {
    const { rt } = await started(s => {
      s.guard.enabled = true
      s.guard.modelCheck = false
      s.autopilot.enabled = true
      s.autopilot.thresholdMode = 'tokens'
      s.autopilot.thresholdTokens = 50_000
    })
    rt.onTurnStart({ turnId: 't1', text: 'Implement the parser and tests' })
    rt.stepResponse({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }, {}, step(60_000, 'tool_use'))
    expect(rt.autopilot.state).toBe('pending')
    expect(await rt.onStop({ stopHookActive: false, lastMessage: "You'll need to finish it yourself. TODO.", background: [], wakeups: [], permissionMode: 'default' })).toBeNull()
  })

  test('settings survive a new Runtime (persistence) and invalid stored values are repaired', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { frontier: { enabled: true, effort: 'ludicrous' }, permissions: { dangerous: 'allow' } }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(rt.settings.frontier.enabled).toBe(true)
    expect(rt.settings.frontier.effort).toBe('max')
    // Allow was removed in 1.4.0: a saved one reads as Default (Claude Code decides), never Ask.
    expect(rt.settings.permissions.dangerous).toBe('default')
    expect(rt.notes.join(' ')).toContain('reset to safe defaults')
  })

  test('stored settings that leave groups out are not a repair: what is missing takes its default, quietly', async () => {
    const f = fakeHost()
    f.kept.store['settings.v1'] = { version: 1, profile: 'normal', cache: { keepWarm: false, coldResume: true }, ui: { companion: true }, ops: { scout: 'suggest' } }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(rt.settings.ui.companion).toBe(true)
    expect(rt.settings.permissions).toEqual(defaultSettings().permissions)
    expect(rt.notes.join(' ')).not.toContain('reset to safe defaults')
    expect(withAllowRemoved({ ui: {} }).value).toEqual({ ui: {} })
  })

  test('a saved Allow reads as Default, in the settings and custom profiles alike, is named once and saved so', async () => {
    const f = fakeHost()
    const custom = { id: 'fast', name: 'Fast', createdAt: 1, systems: { ...systemsOf(defaultSettings()), permissions: { ...defaultSettings().permissions, delete: 'allow', install: 'allow' } } }
    f.kept.store['settings.v1'] = { ...defaultSettings(), permissions: { ...defaultSettings().permissions, delete: 'allow', network: 'allow' }, customProfiles: [custom] }
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(rt.settings.permissions.delete).toBe('default')
    expect(rt.settings.permissions.network).toBe('default')
    expect(rt.settings.customProfiles[0]?.systems.permissions.delete).toBe('default')
    expect(rt.settings.customProfiles[0]?.systems.permissions.install).toBe('default')
    await f.advance(2000)
    // Said once as a toast, and in Guardrails for the session; not a warning at the top of the panel.
    const toast = f.kept.toasts.join(' ')
    expect(toast).toContain('Allow was removed')
    expect(toast).toContain('Deleting files')
    expect(toast).toContain('Network access')
    expect(toast).toContain('Package installs')
    expect(rt.notes.join(' ')).not.toContain('Allow was removed')
    expect(rt.notes.join(' ')).not.toContain('reset to safe defaults')
    expect(Views.paneOf(rt).allowRemoved).toEqual(['Network access', 'Deleting files', 'Package installs'])
    const saved = f.kept.store['settings.v1'] as Settings
    expect(saved.permissions.delete).toBe('default')
    expect(saved.customProfiles[0]?.systems.permissions.install).toBe('default')
    // Saved once: the next session has nothing to say about it.
    const next = new Runtime()
    next.bind(f.host)
    await next.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(2000)
    expect(f.kept.toasts.filter(t => t.includes('Allow was removed')).length).toBe(1)
    expect(next.allowRemoved).toEqual([])
  })

  test('a reload in the middle of a handoff carries it on instead of starting a second one', async () => {
    const { rt, kept, live, advance, host } = await started(s => {
      s.autopilot.enabled = true
      s.autopilot.thresholdMode = 'tokens'
      s.autopilot.thresholdTokens = 100_000
    })
    rt.onTurnStart({ turnId: 't1', text: 'build it' })
    live.usage = { ...live.usage, context: { tokens: 120_000, window: 1_000_000, percent: 12 } }
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await advance(300)
    expect(rt.autopilot.state).toBe('requested')
    // The handoff moves on when its own turn begins, recognised by its prompt, not when the prompt was sent.
    await rt.onTurnStart({ turnId: 't2', text: kept.submitted.at(-1)! })
    expect(rt.autopilot.state).toBe('handoff')
    expect(kept.submitted.filter(t => t.includes('final handoff')).length).toBe(1)
    expect(kept.autopilotRecord?.state).toBe('handoff')

    // The plugin reloads while Claude writes the notes: a fresh Runtime over the same engine state.
    const reloaded = new Runtime()
    reloaded.bind(host)
    await reloaded.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await advance(200)
    expect(reloaded.autopilot.state).toBe('handoff')
    // The handoff turn ends with the context still past the threshold: no second handoff prompt.
    await reloaded.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'notes written' })
    await advance(3000)
    expect(kept.submitted.filter(t => t.includes('final handoff')).length).toBe(1)
    expect(kept.commands).toContain('clear')
  })

  test('a new objective with new milestones counts from nothing; the same objective keeps finished milestones', async () => {
    const { rt } = await started(() => undefined)
    rt.onTurnStart({ turnId: 't1', text: 'release it' })
    const release = ['Pass the checks', 'Rename the plugin', 'Ship the release'].map(title => ({ title, status: 'completed' }))
    rt.recordMilestones({ objective: 'Release 1.4.0 with the rename', milestones: release }, undefined)
    expect([rt.progress().done, rt.progress().total]).toEqual([3, 3])
    // Mid-run, a list that leaves out finished milestones still counts them.
    rt.recordMilestones({ objective: 'Release 1.4.0 with the rename', milestones: [{ title: 'Write the report', status: 'in_progress' }] }, undefined)
    expect([rt.progress().done, rt.progress().total]).toEqual([3, 4])
    // Another objective with milestones of its own: 0 of 2, not 4 of 6.
    rt.recordMilestones({ objective: 'Make the launch video', milestones: [{ title: 'Storyboard the video', status: 'in_progress' }, { title: 'Render both formats', status: 'pending' }] }, undefined)
    expect([rt.progress().done, rt.progress().total]).toEqual([0, 2])
    expect(rt.run?.objective).toBe('Make the launch video')
  })

  test('after a reload, milestones finished earlier are not counted as this turn’s', async () => {
    const { rt, advance, host } = await started(() => undefined)
    rt.onTurnStart({ turnId: 't1', text: 'build it' })
    rt.recordMilestones({ milestones: [{ title: 'A', status: 'completed' }, { title: 'B', status: 'completed' }, { title: 'C', status: 'in_progress' }] }, undefined)
    expect(Views.activityOf(rt).turnSummary.lines).toContain('Finished 2 milestones')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await advance(3000)
    const reloaded = new Runtime()
    reloaded.bind(host)
    await reloaded.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await advance(200)
    expect(reloaded.progress().done).toBe(2)
    expect(Views.activityOf(reloaded).turnSummary.lines.join(' ')).not.toContain('Finished')
  })

  test('across a fresh context the context meter starts over; work progress and the run cost carry on', async () => {
    const { rt, kept, advance } = await started(() => undefined)
    rt.onPromptSubmit('Rebuild the renderer and keep the tests green.', { kind: 'composer' })
    rt.onTurnStart({ turnId: 't1', text: 'Rebuild the renderer and keep the tests green.' })
    const todos = [
      { content: 'Profile the renderer', status: 'completed', activeForm: 'Profiling the renderer' },
      { content: 'Rewrite the hot loop', status: 'in_progress', activeForm: 'Rewriting the hot loop' },
      { content: 'Run the regression suite', status: 'pending', activeForm: 'Running the regression suite' },
    ]
    await rt.beforeTool('TodoWrite', { todos }, 'u1', undefined)
    rt.afterTool('TodoWrite', { todos }, 'u1', { result: { oldTodos: [], newTodos: todos } } as unknown as ToolCallResult)
    expect(Views.hudOf(rt).work).toEqual({ done: 1, total: 3, current: 'Rewriting the hot loop', track: ['done', 'now', 'open'] })
    expect(Views.hudOf(rt).now?.text).toBe('Rewriting the hot loop')
    // The headline says it in Claude's words, with where it sits in the plan.
    expect(Views.hudOf(rt).headline).toEqual({ state: 'working', text: 'Rewriting the hot loop', detail: 'step 2 of 3', tone: 'info' })
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'done' })
    await advance(2000)
    const runKey = Object.keys(kept.store).find(k => k.startsWith('run.v1.'))!
    expect((kept.store[runKey] as { plan: { tasks: unknown[] } }).plan.tasks).toHaveLength(3)

    await rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    expect(rt.usage.tokens).toBeUndefined()
    const hud = Views.hudOf(rt)
    expect(hud.work).toEqual({ done: 1, total: 3, current: 'Rewriting the hot loop', track: ['done', 'now', 'open'] })
    // The first session's $0.50 stays in the run's cost while the fresh session starts at nothing.
    expect(hud.cost.runUsd).toBe(0.5)
    expect(Views.missionOf(rt).objective).toBe('Rebuild the renderer and keep the tests green.')
    expect(Views.missionOf(rt).session).toBe(2)
  })

  test('without a task list in Claude Code, Claude gets the milestones tool and a policy; with one, nothing is added', async () => {
    const { rt, kept } = await started(() => undefined)
    // The Decision Inbox's tool is offered beside it (Behavior → Decisions, on by default).
    expect(kept.registeredTools).toEqual(['milestones', 'decision_request'])
    expect(rt.planSource).toBe('milestones')
    expect(rt.policies().map(s => s.name)).toContain('Run progress')
    const answer = rt.recordMilestones({ milestones: [{ title: 'Fix the parser', status: 'completed' }, { title: 'Add tests', status: 'in_progress', doing: 'Adding tests' }] }, undefined)
    expect(answer).toContain('1 of 2 milestones done')
    expect(Views.hudOf(rt).work).toEqual({ done: 1, total: 2, current: 'Adding tests', track: ['done', 'now'] })
    // A subagent's list is its own.
    rt.recordMilestones({ milestones: [{ title: 'Other', status: 'pending' }] }, 'agent-1')
    expect(Views.hudOf(rt).work?.total).toBe(2)

    const f = fakeHost()
    f.live.tools = ['Bash', 'TodoWrite']
    const withTasks = new Runtime()
    withTasks.bind(f.host)
    await withTasks.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(f.kept.registeredTools).toEqual(['decision_request'])
    expect(withTasks.planSource).toBe('tasks')
    expect(withTasks.policies().map(s => s.name)).not.toContain('Run progress')
  })

  test('a fresh context that starts near the handoff point gets room to work: the live loop, replayed', async () => {
    // Live on 2.1.293: hands off at 64k, a base of about 60k; every fresh context handed off after its first turn.
    const { rt, kept, live, advance } = await started(s => {
      s.autopilot.enabled = true
      s.autopilot.thresholdMode = 'tokens'
      s.autopilot.thresholdTokens = 64_000
    })
    const at = (turnId: string, index: number, tokens: number, stop: 'tool_use' | 'end_turn') => rt.stepResponse({ turnId, index, model: 'claude-opus-5-5', messageCount: 3 }, {}, { ...step(tokens, stop), turnId, index })
    rt.onTurnStart({ turnId: 't1', text: 'Work through the roadmap.' })
    at('t1', 0, 66_000, 'tool_use')
    await flush()
    expect(rt.autopilot.state).toBe('pending')
    live.usage = { ...live.usage, context: { tokens: 69_000, window: 1_000_000, percent: 7 } }
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'step 1 done' })
    await advance(300)
    const handoff = kept.submitted.at(-1) ?? ''
    await rt.onTurnStart({ turnId: 'h1', text: `The project-sentinel plugin sent a message:\n${handoff}` })
    expect(rt.autopilot.state).toBe('handoff')
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'handoff written' })
    await advance(2000)
    expect(kept.commands).toContain('clear')
    live.sessionId = 'S2'
    await rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    await advance(1000)
    const continuation = kept.submitted.at(-1) ?? ''
    expect(continuation).toContain('Context Autopilot continuation')
    await rt.onTurnStart({ turnId: 'c1', text: `The project-sentinel plugin sent a message:\n${continuation}` })
    expect(rt.autopilot.state).toBe('armed')
    // Reading itself in, as seen live: 44k at the first request, 66k after the notes, the docs and the code.
    at('c1', 0, 44_000, 'tool_use')
    at('c1', 1, 66_000, 'tool_use')
    await flush()
    expect(rt.autopilot.state).toBe('armed')
    // It starts working by sending its milestones: room from 66k, so it hands off at 86k, said once.
    rt.recordMilestones({ milestones: [{ title: 'Temperature module', status: 'completed' }, { title: 'Pressure module', status: 'in_progress', doing: 'Writing the pressure module' }] }, undefined)
    await flush()
    expect(Views.hudOf(rt).ctx.threshold).toBe(86_000)
    expect(kept.toasts.some(t => t.includes('hands off at 86k'))).toBe(true)
    at('c1', 2, 74_000, 'tool_use')
    await flush()
    expect(rt.autopilot.state).toBe('armed')
    live.usage = { ...live.usage, context: { tokens: 78_000, window: 1_000_000, percent: 8 } }
    await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'steps 2 and 3 done' })
    await advance(300)
    expect(rt.autopilot.state).toBe('armed')
    expect(kept.submitted.filter(t => t.includes('final handoff')).length).toBe(1)
  })

  test('views are published for every render site', async () => {
    const { kept } = await started(() => undefined)
    for (const key of ['hud', 'pane', 'resources', 'chain', 'activity', 'permissions', 'focus', 'spinner']) {
      expect(kept.published[key], key).toBeDefined()
    }
  })
})
