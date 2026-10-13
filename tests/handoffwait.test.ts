import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { HANDOFF_CHOICE, Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { DEFAULT_WAIT_MS } from '../hooks/features/autopilot'
import { defaultSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import type { HandoffRecord } from '../hooks/features/handoff'
import { fakeHost } from './fixtures/fake-host'
import { SESSION, type World, world } from './fixtures/world'

// The Handoff Supervisor, Keep warm and the person's ways out (1.7.0).
//
// The repro (a real run on 1.6.3): the handoff was fully written, but Claude Code listed a Vite preview
// server among the background work in flight. Sentinel waited for it in `waiting-background` forever; Keep
// warm stood down because a handoff was "imminent", and two hours later the 775k-token cache went cold
// while the handoff still had not happened. Seen live on Claude Code 2.1.296: background shells survive
// /clear and their notifications reach the fresh context; a server started with no timeout ran 25 minutes
// with no notification at all (it never ends by itself).

const withAutopilot = (patch: (s: Settings) => void = () => undefined): Settings => {
  const s = defaultSettings()
  s.autopilot.enabled = true
  patch(s)
  return s
}

/** Background tasks as Claude Code's Stop lists them (the shape seen live: a shell's `command`, Claude's `description`). */
const VITE = { id: 'bvite01', type: 'shell', status: 'running', description: 'Start the Vite preview server', command: 'npx vite preview --port 4173' }
const SUITE = { id: 'btest01', type: 'shell', status: 'running', description: 'Run the full test suite', command: 'npm test' }
const ODD = { id: 'bodd01', type: 'shell', status: 'running', description: 'Run the nightly script', command: './scripts/nightly.sh' }

const report = (task: { id: string; description: string }, status = 'completed'): string =>
  ['<task-notification>', `<task-id>${task.id}</task-id>`, `<status>${status}</status>`, `<summary>Background command "${task.description}" ${status}</summary>`, '</task-notification>'].join('\n')

const MIN = 60_000

// ---------------------------------------------------------------------------
// The runtime over a fake engine (a manual clock: the supervisor's ticks, Keep warm's timers).

type Started = ReturnType<typeof fakeHost> & { rt: Runtime; current: { rt: Runtime } }

let turnSeq = 0

async function started(patch: (s: Settings) => void = () => undefined, host: Parameters<typeof fakeHost>[0] = {}): Promise<Started> {
  const f = fakeHost({ handoffSize: () => 4000, ...host })
  f.kept.store['settings.v1'] = withAutopilot(patch)
  const rt = new Runtime()
  const current = { rt }
  let n = 1
  f.host.clearContext = async () => {
    f.kept.commands.push('clear')
    const id = `C${++n}`
    f.live.sessionId = id
    void current.rt.onClassicSessionStart({ source: 'clear', sessionId: id })
    return { text: '' }
  }
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { ...f, rt, current }
}

async function reloaded(f: Started): Promise<Started> {
  f.rt.stopTimers()
  const rt = new Runtime()
  f.current.rt = rt
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { ...f, rt }
}

type Task = { id: string; type: string; description: string; command?: string }

async function turnOf(f: Started, text: string, opts: { origin?: 'composer' | 'task-notification' | 'own'; background?: readonly Task[]; message?: string } = {}): Promise<void> {
  const { rt } = f
  const turnId = `t${++turnSeq}`
  if (opts.origin !== 'own') rt.onPromptSubmit(text, opts.origin === 'task-notification' ? { kind: 'task-notification' } : { kind: 'composer' })
  await rt.onTurnStart({ turnId, text })
  await rt.onStop({ stopHookActive: false, lastMessage: opts.message ?? 'Done.', background: opts.background ?? [], wakeups: [], permissionMode: undefined })
  await rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: opts.message ?? 'Done.' })
  await f.advance(10)
}

async function handoffWith(f: Started, background: readonly Task[]): Promise<void> {
  expect(await f.rt.requestHandoff()).toBe('Handing off: Claude is writing the handoff notes.')
  await f.advance(400)
  const prompt = f.kept.submitted.find(t => t.includes('final handoff'))
  await turnOf(f, `The project-sentinel plugin sent a message:\n${prompt ?? ''}`, { origin: 'own', background, message: 'The handoff is written.' })
}

const clears = (f: Started): number => f.kept.commands.filter(c => c === 'clear').length

describe('the repro: a persistent server never holds a written handoff', () => {
  test('a Vite preview server in flight: the handoff goes on at once, the server is left running, the fresh context told to reuse it, and Health records it', async () => {
    const f = await started(s => void (s.cache.keepWarm = true))
    await handoffWith(f, [VITE])
    await f.advance(4000)
    expect(clears(f)).toBe(1)
    expect(f.kept.traces).toContain('background: not waited for (bvite01: a Vite dev or preview server)')
    expect(f.kept.traces).toContain('autopilot: turnComplete · handoff → verifying · verifyHandoff')
    expect(f.kept.traces.some(t => t.startsWith('autopilot: turnComplete · handoff → waiting-background'))).toBe(false)
    // The fresh context is told what still runs, and to reuse it.
    const block = f.rt.takeFreshContext() ?? ''
    expect(block).toContain('Still running from the previous context: Start the Vite preview server (task bvite01). It is a long-running service: reuse it, and do not start another on the same port')
    expect(f.kept.traces).toContain('autopilot: the fresh context is told what still runs (bvite01 persistent)')
    // The run's record: what was left running, and that it is a service (never good or missing).
    const h = f.rt.run?.lastHandoff as HandoffRecord
    expect(h.leftRunning).toEqual([{ id: 'bvite01', description: 'Start the Vite preview server', class: 'persistent', endedAt: null, status: null }])
    expect(h.health.find(c => c.id === 'leftRunning')).toEqual({ id: 'leftRunning', label: 'Left running', state: 'none', detail: '1 service · fresh context told' })
    expect(h.health.some(c => c.id === 'background')).toBe(false)
    expect(Views.paneOf(f.rt).handoff?.leftRunning).toEqual([{ id: 'bvite01', description: 'Start the Vite preview server', isService: true, endedAt: null, status: null }])
  })

  test('the server in the session never parks the Mission Queue, the Scout, the guard or the headline as "waiting"', async () => {
    const f = await started()
    await turnOf(f, 'Start the preview server and check the page.', { background: [VITE], message: 'The preview is up on port 4173.' })
    // A server does not bring a turn back: the session is free, and nothing says it waits for a result.
    expect(f.rt.blockingInFlight()).toEqual([])
    expect(f.rt.ops.isFree()).toBe(true)
    expect(Views.hudOf(f.rt).headline.state).not.toBe('waitingExternal')
    const queued = f.rt.ops.queueAdd('Now write the README section', 'boundary')
    expect(queued.ok).toBe(true)
    await f.advance(2000)
    expect(f.kept.submitted.some(t => t.startsWith('Mission Queue'))).toBe(true)
    // Finite work does: the session is not free, and the headline says what it waits for.
    await turnOf(f, 'Run the tests in the background.', { background: [VITE, SUITE] })
    expect(f.rt.ops.isFree()).toBe(false)
    expect(Views.hudOf(f.rt).headline).toMatchObject({ state: 'waitingExternal', text: 'Waiting for Run the full test suite' })
  })
})

describe('long finite work: a bounded wait, Keep warm on, then the work left to the fresh context', () => {
  test('the handoff waits within its patience with Keep warm on, goes on by itself at the limit, and the result reaches the fresh context, recorded there', async () => {
    const f = await started(s => {
      s.cache.keepWarm = true
      s.autopilot.waitMinutes = 20
    })
    await handoffWith(f, [SUITE])
    expect(f.rt.autopilot.state).toBe('waiting-background')
    // The supervisor looks, says what holds it; Keep warm does not stand down for it.
    await f.advance(19 * MIN)
    expect(f.rt.autopilot.state).toBe('waiting-background')
    expect(clears(f)).toBe(0)
    expect(f.rt.keepWarmStandDown()).toBeNull()
    expect(f.rt.supervisor).toMatchObject({ status: 'waiting', blocker: { kind: 'finite' } })
    expect(f.kept.traces.some(t => t.startsWith('supervisor: Waiting for background work for ') && t.endsWith(' · waiting · finite: waiting for Run the full test suite'))).toBe(true)
    expect(Views.paneOf(f.rt).autopilot.waitLeftMs).toBeLessThanOrEqual(1 * MIN + 400)
    // Past it: the handoff goes on, the suite left running.
    await f.advance(2 * MIN)
    await f.advance(4000)
    expect(clears(f)).toBe(1)
    expect(f.kept.traces.some(t => t.startsWith("supervisor: the wait's patience is over (20 min): the handoff goes on, leaving Run the full test suite running"))).toBe(true)
    const block = f.rt.takeFreshContext() ?? ''
    expect(block).toContain('Still running from the previous context, not waited for: Run the full test suite (task btest01). Its result arrives here as a task notification')
    // Its notification reaches the fresh context (seen live): the run's record notes its end.
    await turnOf(f, report(SUITE), { origin: 'task-notification' })
    const h = f.rt.run?.lastHandoff as HandoffRecord
    expect(h.leftRunning?.[0]).toMatchObject({ id: 'btest01', class: 'finite', status: 'completed' })
    expect(h.leftRunning?.[0]?.endedAt).not.toBeNull()
    expect(f.kept.traces).toContain('background: btest01, left running by the last handoff, ended here (completed)')
    expect(h.health.find(c => c.id === 'leftRunning')?.detail).toBe('1 task not waited for · fresh context told')
  })

  test('with a turn running at the limit, the handoff goes on when that turn ends, never under it', async () => {
    const f = await started()
    await handoffWith(f, [SUITE])
    // A notification turn runs across the limit (another task's result).
    f.rt.onPromptSubmit(report(ODD), { kind: 'task-notification' })
    await f.rt.onTurnStart({ turnId: 'n1', text: report(ODD) })
    await f.advance(21 * MIN)
    expect(f.rt.autopilot).toMatchObject({ state: 'waiting-background', skipWait: true })
    expect(clears(f)).toBe(0)
    await f.rt.onStop({ stopHookActive: false, lastMessage: 'Recorded.', background: [SUITE], wakeups: [], permissionMode: undefined })
    await f.rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Recorded.' })
    await f.advance(4000)
    expect(clears(f)).toBe(1)
  })

  test('a reload keeps the wait and its end; past it, the new runtime goes on', async () => {
    const f = await started()
    await handoffWith(f, [SUITE])
    const until = f.rt.autopilot.waitUntil
    expect(until).not.toBeNull()
    const g = await reloaded(f)
    expect(g.rt.autopilot).toMatchObject({ state: 'waiting-background', waitUntil: until })
    expect(g.kept.traces.some(t => t.startsWith('autopilot: recovered waiting-background after a reload (waiting for Run the full test suite, at most until'))).toBe(true)
    await g.advance(DEFAULT_WAIT_MS + MIN)
    expect(clears(g)).toBe(1)
  })

  test('a 1.6.3 record stuck on a dev server recovers as nothing to wait for, and goes on once the session is quiet', async () => {
    const f = await started()
    const began = f.now() - 2 * 3_600_000
    f.kept.autopilotRecord = {
      sessionId: 'S1',
      state: 'waiting-background',
      triggeredTokens: 775_000,
      triggeredAt: began,
      handoffSince: began,
      retries: 0,
      snoozeUntil: null,
      lastError: null,
      note: 'Handoff written. Waiting for background work: Start the Vite preview server',
      at: began + 60_000,
      handoffTurnId: 'h1',
      background: [{ id: 'bvite01', description: 'npx vite preview --port 4173' }],
      waitedFor: 1,
      backgroundEndedAt: null,
    }
    const g = await reloaded(f)
    expect(g.rt.autopilot.background[0]).toMatchObject({ id: 'bvite01', class: 'persistent' })
    await g.advance(65_000)
    expect(g.kept.traces).toContain('supervisor: nothing the handoff must wait for is left and the session is quiet: the handoff goes on')
    await g.advance(4000)
    expect(clears(g)).toBe(1)
    expect(g.rt.takeFreshContext()).toContain('Still running from the previous context: npx vite preview --port 4173 (task bvite01)')
  })

  test('an unrecognised command: after a minute the isolated classifier is asked once; a service verdict ends the wait', async () => {
    const f = await started()
    const asked: string[] = []
    f.host.classify = async (text, labels) => {
      asked.push(text)
      expect(labels).toEqual(['persistent_service', 'finite_job', 'unclear'])
      return 'persistent_service'
    }
    await handoffWith(f, [ODD])
    expect(f.rt.autopilot.state).toBe('waiting-background')
    await f.advance(45_000)
    expect(asked).toHaveLength(0)
    await f.advance(60_000)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('COMMAND: ./scripts/nightly.sh')
    expect(asked[0]).toContain('DESCRIPTION: Run the nightly script')
    await f.advance(4000)
    expect(clears(f)).toBe(1)
    expect(f.kept.traces.some(t => t.startsWith('supervisor: asked the isolated classifier about bodd01') && t.endsWith('persistent_service → persistent'))).toBe(true)
    await f.advance(5 * MIN)
    expect(asked).toHaveLength(1)
  })

  test('an unclear verdict keeps waiting, and nothing is asked twice', async () => {
    const f = await started()
    let calls = 0
    f.host.classify = async () => {
      calls += 1
      return 'unclear'
    }
    await handoffWith(f, [ODD])
    await f.advance(10 * MIN)
    expect(calls).toBe(1)
    expect(f.rt.autopilot.state).toBe('waiting-background')
    expect(clears(f)).toBe(0)
  })
})

describe("the person's ways out, by command and button", () => {
  test('/cr handoff now leaves the work running and starts the fresh context; /cr handoff wait gives it longer; /cr handoff cancel carries on here', async () => {
    const f = await started()
    await handoffWith(f, [SUITE])
    expect(await f.rt.runCommand('handoff wait 30m').then(r => r.text)).toMatch(/^The handoff keeps waiting for Run the full test suite, until \d\d:\d\d at most; it goes on as soon as that work ends\.$/)
    expect(f.rt.autopilot.waitUntil).toBe((f.kept.autopilotRecord?.waitSince ?? 0) + DEFAULT_WAIT_MS + 30 * MIN)
    expect(await f.rt.runCommand('handoff now').then(r => r.text)).toBe(
      'Not waiting for the background work: checking the notes, then starting the fresh context. Run the full test suite keeps running for the fresh context, which is told.',
    )
    await f.advance(4000)
    expect(clears(f)).toBe(1)
    expect(f.rt.takeFreshContext()).toContain('Run the full test suite (task btest01)')

    const g = await started()
    await handoffWith(g, [SUITE])
    expect((await g.rt.runCommand('handoff cancel')).text).toMatch(/^Handoff called off: Claude carries on in this context; the notes stay on disk\./)
    expect(g.rt.autopilot.state).toBe('armed')
    await g.advance(DEFAULT_WAIT_MS + MIN)
    expect(clears(g)).toBe(0)
  })

  test('/cr handoff stop stops the work the handoff waits for (never a server) and hands off; /cr fresh now leaves it running', async () => {
    const f = await started()
    await handoffWith(f, [SUITE, VITE])
    expect((await f.rt.runCommand('handoff stop')).text).toBe('Stopped Run the full test suite. The handoff goes on: checking the notes, then starting the fresh context.')
    expect(f.kept.stopped).toEqual(['btest01'])
    await f.advance(4000)
    expect(clears(f)).toBe(1)
    // The server stays, and the fresh context is told.
    expect(f.rt.takeFreshContext()).toContain('Start the Vite preview server (task bvite01)')

    const g = await started()
    await handoffWith(g, [SUITE])
    expect((await g.rt.runCommand('fresh')).text).toContain('/cr fresh now starts it at once and leaves it running')
    expect((await g.rt.runCommand('fresh now')).text).toBe(
      'Handoff notes are valid and you chose not to wait for the background work. Starting the fresh context. Left running for the fresh context, which is told: Run the full test suite.',
    )
    await g.advance(4000)
    expect(clears(g)).toBe(1)
  })

  test('a refused stop says so and keeps waiting', async () => {
    const f = await started()
    f.live.stopResult = { deny: 'no such task' } as never
    await handoffWith(f, [SUITE])
    expect((await f.rt.runCommand('handoff stop btest01')).text).toBe('Claude Code did not stop Run the full test suite (no such task): the handoff keeps waiting for it (Hand off now leaves it running).')
    expect(f.rt.autopilot.state).toBe('waiting-background')
    expect((await f.rt.runCommand('handoff stop nope')).text).toBe('No background task nope holds the handoff.')
  })

  test('the status bar line and Context carry the same ways out while it waits', async () => {
    const f = await started()
    await handoffWith(f, [SUITE, VITE])
    const pane = Views.paneOf(f.rt).autopilot
    expect(pane.background.map(t => [t.id, t.class, t.isBlocking])).toEqual([
      ['btest01', 'finite', true],
      ['bvite01', 'persistent', false],
    ])
    expect(pane.background[1]?.classWords).toBe('Keeps running · not waited for')
    expect(Views.hudOf(f.rt).alert).toMatchObject({ kind: 'waiting', canStop: true, canKeep: false })
    // Near the wait's end, Keep waiting is offered too.
    await f.advance(16 * MIN)
    expect(Views.hudOf(f.rt).alert).toMatchObject({ kind: 'waiting', canKeep: true })
  })
})

// ---------------------------------------------------------------------------
// The person's words while a handoff waits, as Claude Code raises them (prompt.submit, before the Cold
// Resume Guard). A dropped prompt is never sent: Claude Code shows the reason and puts the text back,
// which Sentinel clears again when it acted on it.

const PRESENTATION = { isFullscreen: true, columns: 120 }
const cmd = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: PRESENTATION })
const framed = (text: string | undefined) => `The project-sentinel plugin sent a message:\n${text ?? ''}`
const LONG = { timeoutMs: 30_000 }

type Case = { w: World; clears: { n: number }; $: Engine }

function session($: Engine, on: Parameters<typeof world>[0], patch?: (s: Settings) => void): Case {
  const n = { n: 0 }
  on('command.run', { command: 'clear' }, async () => {
    n.n += 1
    w.live.sessionId = `session-${n.n + 1}`
    await $.classic.SessionStart({ source: 'clear', session_id: w.live.sessionId })
    return { text: '' }
  })
  const w = world(on, { settings: withAutopilot(patch) })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  return { w, clears: n, $ }
}

async function turnEnds(c: Case, turnId: string, background: readonly Task[], answer = 'Done.'): Promise<void> {
  await c.$.classic.Stop({ stop_hook_active: false, last_assistant_message: answer, background_tasks: background.map(b => ({ status: 'running', ...b })) })
  await c.$.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

async function waitingFor(c: Case, background: readonly Task[]): Promise<void> {
  await c.$.command.run(cmd('cr', 'handoff'))
  await c.w.clock.advance(400)
  await c.$.turn.start({ text: framed(c.w.kept.submitted.find(t => t.includes('final handoff'))), turnId: 'h1' })
  await turnEnds(c, 'h1', background, 'The handoff is written; the suite still runs.')
  await c.w.clock.advance(100)
}

const typed = (c: Case, text: string, turnId?: string) => c.$.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...(turnId === undefined ? {} : { turnId }) })

describe('the ways out on every surface', () => {
  const bandProps = (bodyColumns: number) => ({ hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns, scroll: { offset: 0, bodyRows: 6 }, view: {} })
  const paneProps = { title: 'Control Room', isFocused: true, bodyColumns: 66, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} }

  test('Context lists each task with what it is, and offers Hand off now, Stop & hand off, Keep waiting and Call off; the status bar line offers them too', LONG, async ($, on) => {
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    const c = session($, on)
    await $.session.start(SESSION)
    await waitingFor(c, [SUITE, VITE])
    await c.w.clock.advance(300)
    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps })
      await ui.press({ key: 'tab-context' })
      await c.w.clock.advance(300)
      expect(await ui.find({ text: /Keeps running · not waited for/ }), surface).toBeDefined()
      expect(await ui.find({ text: /Waited for · its result goes in the notes/ }), surface).toBeDefined()
      for (const key of ['ap-now', 'ap-stop-all', 'ap-wait', 'ap-cancel']) expect(await ui.find({ type: 'Button', key }), `${surface} ${key}`).toBeDefined()
      await ui.unmount()
    }
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'AbovePrompt', props: bandProps(140) })
      expect(await band.find({ text: /Handoff written, waits for Run the full test suite · goes on in 20m at most/ }), surface).toBeDefined()
      for (const key of ['handoff-go', 'handoff-stop', 'handoff-cancel']) expect(await band.find({ type: 'Button', key }), `${surface} ${key}`).toBeDefined()
      await band.unmount()
    }
    // Pressed on the status bar: hand off now, the suite left running.
    const band = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(140) })
    await band.press({ key: 'handoff-go' })
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
    expect(c.w.kept.toasts).toContain('Not waiting for the background work: checking the notes, then starting the fresh context. Run the full test suite keeps running for the fresh context, which is told.')
    await band.unmount()
  })
})

describe('handoff-control words while a handoff waits', () => {
  test('"handoff now" is acted on before the Cold Resume Guard: never sent into the old context, the work left running', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await waitingFor(c, [SUITE])
    const answer = await typed(c, 'handoff now')
    expect(answer.drop).toBe('Not waiting for the background work: checking the notes, then starting the fresh context. Run the full test suite keeps running for the fresh context, which is told.')
    expect(c.w.kept.submitted).not.toContain('handoff now')
    expect(c.w.kept.logs).toContain('handoff guard: "handoff now" read as "hand off now" (waiting-background)')
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
    expect(c.w.kept.submitted.filter(t => t.includes('Context Autopilot continuation'))).toHaveLength(1)
    // No question was asked: an instruction is acted on.
    expect(c.w.kept.asked).toHaveLength(0)
  })

  test('"don\'t wait for the background process" and "start the fresh session now" do the same; "keep waiting" waits longer; "cancel the handoff" carries on here', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await waitingFor(c, [SUITE])
    expect((await typed(c, 'keep waiting')).drop).toMatch(/^The handoff keeps waiting for Run the full test suite, until \d\d:\d\d at most/)
    expect((await typed(c, 'start the fresh session now')).drop).toBe('Handoff notes are valid and you chose not to wait for the background work. Starting the fresh context. Left running for the fresh context, which is told: Run the full test suite.')
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
  })

  test('typed mid-turn (Claude recording a result): dropped, and the handoff goes on when that turn ends', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await waitingFor(c, [SUITE, ODD])
    await $.prompt.submit({ text: report(ODD), wait: false, origin: { kind: 'task-notification' } })
    await $.turn.start({ text: report(ODD), turnId: 'n1' })
    expect((await typed(c, "don't wait for the background process", 'n1')).drop).toBe('Not waiting for the background work: the handoff goes on when this turn ends. Run the full test suite keeps running for the fresh context, which is told.')
    await turnEnds(c, 'n1', [SUITE], 'Recorded the nightly result.')
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
  })

  test('"cancel the handoff": this context carries on, nothing cleared', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await waitingFor(c, [SUITE])
    expect((await typed(c, 'cancel the handoff')).drop).toMatch(/^Handoff called off: Claude carries on in this context/)
    await c.w.clock.advance(DEFAULT_WAIT_MS + MIN)
    expect(c.clears.n).toBe(0)
  })

  test('other words while it waits are not let into the old context unasked: carried to the fresh context, or sent here, as the person chooses', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await waitingFor(c, [SUITE])
    c.w.live.askAnswer = HANDOFF_CHOICE.carry
    const answer = await typed(c, 'Next, add a dark mode toggle to the settings page.')
    expect(answer.drop).toBe(
      'Handing off: your message waits as Q-1 and goes to the fresh context first thing. Not waiting for the background work: checking the notes, then starting the fresh context. Run the full test suite keeps running for the fresh context, which is told.',
    )
    expect(c.w.kept.asked).toHaveLength(1)
    expect(c.w.kept.asked[0]).toContain('Hand off now and give your message to the fresh context first thing')
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
    // The fresh context's first message carries it (its context block).
    const blocks = await $.prompt.context({ blocks: [] })
    expect(blocks.blocks.map(b => b.text).join(' ')).toContain('Next, add a dark mode toggle to the settings page.')
  })

  test('"Send it here" lets the message go into this context; dismissing keeps it in the box; Claude writing the notes queues it for the fresh context', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await waitingFor(c, [SUITE])
    c.w.live.askAnswer = HANDOFF_CHOICE.here
    expect((await typed(c, 'What does the suite cover?')).drop).toBeUndefined()
    expect(c.w.kept.submitted).toContain('What does the suite cover?')
    c.w.live.askAnswer = HANDOFF_CHOICE.box
    expect((await typed(c, 'Also refactor the router.')).drop).toBe('Not sent: your message is back in the prompt box. The handoff keeps waiting for the background work.')
    expect(c.w.kept.submitted).not.toContain('Also refactor the router.')
  })
})
