import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { defaultSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import type { HandoffRecord } from '../hooks/features/handoff'
import { fakeHost } from './fixtures/fake-host'
import { SESSION, type World, world } from './fixtures/world'

// A handoff turn that stops while background work still runs (1.6.3).
//
// Seen in a real 801k-token run on 1.6.2, and reproduced live on Claude Code 2.1.295 (the events below
// are in the order the engine raised them there): the handoff turn wrote its notes and stopped with a
// render running, its Stop listing the render in flight. When the render ended, Claude Code submitted
// its notification as a prompt (origin `task-notification`, no running turn), which started a turn whose
// text is the engine's `<task-notification>` report; Claude updated the notes and the turn ended with
// nothing in flight. 1.6.2 counted that turn as the person's, so the handoff stayed in `handoff`
// forever: no check, no /clear, no continuation; /cr fresh refused, /cr handoff said "Handing off" and
// did nothing.

const PRESENTATION = { isFullscreen: true, columns: 120 }
const cmd = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: PRESENTATION })
/** A plugin's prompt as Claude Code starts the turn with it: framed by the engine. */
const framed = (text: string | undefined) => `The project-sentinel plugin sent a message:\n${text ?? ''}`

const withAutopilot = (patch: (s: Settings) => void = () => undefined): Settings => {
  const s = defaultSettings()
  s.autopilot.enabled = true
  patch(s)
  return s
}

/** Background tasks as Claude Code's Stop lists them in flight (the two of the real run). */
const RENDER = { id: 'bgimotmfr', type: 'shell', status: 'running', description: 'Render the full-resolution 16:9 picture' }
const WAITER = { id: 'b22sjex6u', type: 'shell', status: 'running', description: 'Wait until the 16:9 master render finishes' }

/** A task's notification as Claude Code words it (seen live on 2.1.295). */
const report = (task: { id: string; description: string }, status = 'completed'): string =>
  [
    '<task-notification>',
    `<task-id>${task.id}</task-id>`,
    `<tool-use-id>toolu_${task.id}</tool-use-id>`,
    `<output-file>C:\\Users\\x\\tasks\\${task.id}.output</output-file>`,
    `<status>${status}</status>`,
    `<summary>Background command "${task.description}" ${status === 'completed' ? 'completed (exit code 0)' : status}</summary>`,
    '</task-notification>',
  ].join('\n')

/** A hook-level test replays a whole session (several turns, a clear, a continuation): more than the default 5 s on a busy machine. */
const LONG = { timeoutMs: 30_000 }

type Case = { w: World; clears: { n: number }; $: Engine }

/** A session with Autopilot on, its /clear answered as Claude Code answers it (a fresh session after it). */
function session($: Engine, on: Parameters<typeof world>[0], patch?: (s: Settings) => void): Case {
  const clears = { n: 0 }
  on('command.run', { command: 'clear' }, async () => {
    clears.n += 1
    w.live.sessionId = `session-${clears.n + 1}`
    await $.classic.SessionStart({ source: 'clear', session_id: w.live.sessionId })
    return { text: '' }
  })
  const w = world(on, { settings: withAutopilot(patch) })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  return { w, clears, $ }
}

const statusOf = async (c: Case): Promise<string> => (await c.$.command.run(cmd('cr', 'status'))).text ?? ''
const crText = async (c: Case, args: string): Promise<string> => (await c.$.command.run(cmd('cr', args))).text ?? ''

/** A turn stopping: Claude Code's Stop with the work it lists in flight, then the turn's end (the order seen live). */
async function turnEnds(c: Case, turnId: string, background: readonly (typeof RENDER)[], answer = 'Recorded the render in the notes.'): Promise<{ block?: string }> {
  const stop = await c.$.classic.Stop({ stop_hook_active: false, last_assistant_message: answer, background_tasks: [...background] })
  await c.$.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' })
  return stop
}

/** `/cr handoff`, then the handoff turn writing its notes and stopping with `background` in flight. */
async function handoffStops(c: Case, background: readonly (typeof RENDER)[]): Promise<void> {
  expect(await crText(c, 'handoff')).toBe('Handing off: Claude is writing the handoff notes.')
  await c.w.clock.advance(400)
  await c.$.turn.start({ text: framed(c.w.kept.submitted.find(t => t.includes('final handoff'))), turnId: 'h1' })
  await turnEnds(c, 'h1', background, 'The handoff is written. The 16:9 master render is still running.')
  await c.w.clock.advance(100)
}

/** A task ends while the session is idle: Claude Code submits its notification, which starts a turn of its own. */
async function notified(c: Case, task: { id: string; description: string }, turnId: string, status = 'completed'): Promise<void> {
  const text = report(task, status)
  await c.$.prompt.submit({ text, wait: false, origin: { kind: 'task-notification' } })
  await c.$.turn.start({ text, turnId })
}

const count = (list: readonly string[], part: string): number => list.filter(t => t.includes(part)).length

/** The context the notification's prompt carried (what Claude reads beside it). */
const contextOf = (w: World, text: string): string => w.kept.contexts[w.kept.submitted.indexOf(text)]?.join('\n') ?? ''

describe('a handoff waiting for background work, as Claude Code raises it', () => {
  test("the 801k-run failure: the render's notification turn ends with nothing in flight; the notes are checked, the context cleared and the work continued by itself, once each", LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await handoffStops(c, [RENDER, WAITER])
    // Not "Claude is writing the handoff" for the length of a render: what it waits for, and that it runs.
    await c.w.clock.advance(10 * 60_000)
    expect(c.clears.n).toBe(0)
    const waiting = await statusOf(c)
    expect(waiting).toContain('Waiting for background work')
    expect(waiting).toContain('Handoff written. Waiting for background work: 2 background tasks')
    expect(c.w.kept.toasts.some(t => t.includes('The handoff waits for background work to finish (2 background tasks)'))).toBe(true)

    // The render ends: Claude Code submits its notification (origin task-notification), a turn of its own.
    await notified(c, RENDER, 'n1')
    // The waiter's ends while that turn runs: delivered into it (as in the real run).
    await $.prompt.submit({ text: report(WAITER), wait: false, origin: { kind: 'task-notification' }, turnId: 'n1' })
    await turnEnds(c, 'n1', [])
    await c.w.clock.advance(3000)
    expect(c.clears.n).toBe(1)
    await c.w.clock.advance(1000)

    // One handoff prompt, one clear, one continuation into the fresh session.
    expect(count(c.w.kept.submitted, 'final handoff for this context window')).toBe(1)
    expect(count(c.w.kept.submitted, 'Context Autopilot continuation')).toBe(1)
    expect(c.w.kept.submitted.find(t => t.includes('Context Autopilot continuation'))).toContain('(session 2)')
    // The notification's turn is known for what it is, and the trace says what moved the handoff on.
    expect(c.w.kept.logs).toContain('turn n1 started (notification)')
    expect(c.w.kept.logs).toContain('background: bgimotmfr ended (completed), as its notification says')
    expect(c.w.kept.logs).toContain('background: b22sjex6u ended (completed), as its notification says')
    expect(c.w.kept.logs).toContain('autopilot: turnComplete · handoff → waiting-background · checkNotes')
    expect(c.w.kept.logs).toContain('autopilot: turnComplete · waiting-background → verifying · verifyHandoff')
    expect(c.w.kept.logs.some(l => l.startsWith('autopilot: notes') && l.includes(' written (') && l.includes('; updated after the background work ended'))).toBe(true)
    // Claude was asked to record each result and end its turn, with the notification that brought it: the
    // render's while the waiter still ran, the waiter's (delivered into that turn) as the last one.
    expect(contextOf(c.w, report(RENDER))).toContain('the handoff is waiting for this background work')
    expect(contextOf(c.w, report(RENDER))).toContain('Other background work is still running (Wait until the 16:9 master render finishes)')
    expect(contextOf(c.w, report(WAITER))).toContain('The context is cleared after this turn')

    // The continuation's own turn: the run carries on in session 2, and nothing hands off again.
    await $.turn.start({ text: framed(c.w.kept.submitted.find(t => t.includes('Context Autopilot continuation'))), turnId: 'c1' })
    await turnEnds(c, 'c1', [], 'Picked up from the notes.')
    await c.w.clock.advance(20_000)
    expect(await statusOf(c)).toContain('Session 2')
    expect(c.clears.n).toBe(1)
    expect(count(c.w.kept.submitted, 'Context Autopilot continuation')).toBe(1)
    expect(count(c.w.kept.submitted, 'final handoff for this context window')).toBe(1)
  })

  test('two tasks ending separately: the first one’s turn leaves the handoff waiting; the second’s finishes it', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await handoffStops(c, [RENDER, WAITER])
    await notified(c, WAITER, 'n1')
    await turnEnds(c, 'n1', [RENDER], 'The waiter ended; the render still runs.')
    await c.w.clock.advance(5000)
    expect(c.clears.n).toBe(0)
    expect(await crText(c, 'handoff')).toBe(
      'Handoff notes are written; waiting for 1 background task to finish before starting fresh (Render the full-resolution 16:9 picture). /cr handoff now hands off without waiting (it keeps running for the fresh context).',
    )
    // The note riding the first notification says the other is still running.
    expect(contextOf(c.w, report(WAITER))).toContain('Other background work is still running (Render the full-resolution 16:9 picture)')
    await notified(c, RENDER, 'n2')
    await turnEnds(c, 'n2', [])
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
    expect(count(c.w.kept.submitted, 'Context Autopilot continuation')).toBe(1)
  })

  test('a render that failed ends the wait as one that completed: Claude records the failure, then the fresh context starts', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await handoffStops(c, [RENDER])
    await notified(c, RENDER, 'n1', 'failed')
    await turnEnds(c, 'n1', [], 'The render failed (exit code 1); recorded in the notes.')
    await c.w.clock.advance(4000)
    expect(c.w.kept.logs).toContain('background: bgimotmfr ended (failed), as its notification says')
    expect(c.clears.n).toBe(1)
    expect(count(c.w.kept.submitted, 'Context Autopilot continuation')).toBe(1)
  })

  test('a render that was stopped, by Claude (TaskStop) or the person (/tasks): the wait ends with it', LONG, async ($, on) => {
    // Claude stops it in a turn of the person's: the TaskStop itself says so, and the turn's Stop agrees.
    const c = session($, on)
    await $.session.start(SESSION)
    await handoffStops(c, [RENDER])
    await $.prompt.submit({ text: 'Stop the render, we will redo it in the next session.', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'Stop the render, we will redo it in the next session.', turnId: 'p1' })
    await $.tool.call({ tool: 'TaskStop', task_id: RENDER.id, tool_use_id: 'tu-stop' })
    await c.w.clock.advance(10)
    expect(c.w.kept.logs).toContain("background: bgimotmfr ended (killed), as Claude's TaskStop says")
    await turnEnds(c, 'p1', [], 'Stopped the render and noted it in the handoff.')
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
    expect(count(c.w.kept.submitted, 'Context Autopilot continuation')).toBe(1)
  })

  test('a render the person stopped from /tasks while idle: its notification (killed) starts a turn, and the handoff finishes after it', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await handoffStops(c, [RENDER])
    await notified(c, RENDER, 'n1', 'killed')
    expect(c.w.kept.logs).toContain('background: bgimotmfr ended (killed), as its notification says')
    await turnEnds(c, 'n1', [], 'The render was stopped; the notes say to run it again.')
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
    expect(count(c.w.kept.submitted, 'Context Autopilot continuation')).toBe(1)
  })

  test('the person typing while the handoff waits: their turn neither finishes it while the render runs nor meets the lazy-exit guard', LONG, async ($, on) => {
    const c = session($, on, s => {
      s.guard.enabled = true
      s.guard.modelCheck = false
    })
    await $.session.start(SESSION)
    await handoffStops(c, [RENDER])
    await $.prompt.submit({ text: 'is the handoff not done?', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'is the handoff not done?', turnId: 'p1' })
    // An answer the guard would keep going in any other turn: it stands down while a handoff waits.
    const stop = await turnEnds(c, 'p1', [RENDER], "Not yet. You'll need to wait for the render; TODO: mix and QA next session.")
    expect(stop.block).toBeUndefined()
    await c.w.clock.advance(5000)
    expect(c.clears.n).toBe(0)
    expect(await statusOf(c)).toContain('Waiting for background work')
    expect(count(c.w.kept.submitted, 'final handoff for this context window')).toBe(1)
    // The render ends: its own turn finishes the handoff, once.
    await notified(c, RENDER, 'n1')
    await turnEnds(c, 'n1', [])
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
    expect(count(c.w.kept.submitted, 'Context Autopilot continuation')).toBe(1)
  })

  test('the render ending during a turn of the person’s: that turn ends with nothing in flight and the handoff finishes after it', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await handoffStops(c, [RENDER])
    await $.prompt.submit({ text: 'Also note the render settings in the README.', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'Also note the render settings in the README.', turnId: 'p1' })
    await $.prompt.submit({ text: report(RENDER), wait: false, origin: { kind: 'task-notification' }, turnId: 'p1' })
    // The notification delivered into the person's turn carried the request to record it.
    expect(contextOf(c.w, report(RENDER))).toContain('the handoff is waiting for this background work')
    await turnEnds(c, 'p1', [], 'Noted the settings; the render finished and is recorded in the notes.')
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
    expect(count(c.w.kept.submitted, 'Context Autopilot continuation')).toBe(1)
  })
})

describe('/cr handoff and /cr fresh while a handoff waits or is stuck', () => {
  test('/cr handoff never claims a handoff it did not start: already writing, waiting for background work, checking, starting fresh', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    expect(await crText(c, 'handoff')).toBe('Handing off: Claude is writing the handoff notes.')
    expect(await crText(c, 'handoff')).toBe('A handoff is already starting: Claude writes the notes next.')
    await c.w.clock.advance(400)
    await $.turn.start({ text: framed(c.w.kept.submitted.find(t => t.includes('final handoff'))), turnId: 'h1' })
    expect(await crText(c, 'handoff')).toBe('A handoff is already in progress. Claude is writing the notes.')
    await turnEnds(c, 'h1', [RENDER], 'Handoff written; the render still runs.')
    await c.w.clock.advance(100)
    expect(await crText(c, 'handoff')).toBe(
      'Handoff notes are written; waiting for 1 background task to finish before starting fresh (Render the full-resolution 16:9 picture). /cr handoff now hands off without waiting (it keeps running for the fresh context).',
    )
    await c.w.clock.advance(60_000)
    // Nothing was sent again for any of them.
    expect(count(c.w.kept.submitted, 'final handoff for this context window')).toBe(1)
    expect(c.clears.n).toBe(0)
  })

  test('/cr fresh while the render genuinely runs: kept, with what runs; once it ends, the handoff finishes by itself', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await handoffStops(c, [RENDER])
    expect(await crText(c, 'fresh')).toBe(
      '1 background task is still running (Render the full-resolution 16:9 picture). Fresh context was not started: the handoff finishes by itself when it ends, or when its wait runs out (then it keeps running for the fresh context). /cr fresh now starts it at once and leaves it running; /cr handoff stop stops it first.',
    )
    await c.w.clock.advance(5000)
    expect(c.clears.n).toBe(0)
    await notified(c, RENDER, 'n1')
    await turnEnds(c, 'n1', [])
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
  })

  test('/cr fresh with stale or missing notes: the context is kept, and the reason said', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    // A handoff turn that ended unseen (as 1.6.2 left one): the notes predate it.
    c.w.live.notesAt = c.w.clock.now() - 3_600_000
    await crText(c, 'handoff')
    await c.w.clock.advance(400)
    await $.turn.start({ text: framed(c.w.kept.submitted.find(t => t.includes('final handoff'))), turnId: 'h1' })
    await turnEnds(c, 'h1', [RENDER], 'The render still runs.')
    await notified(c, RENDER, 'n1')
    // The notification's turn is interrupted: the handoff waits for the person.
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'n1', reason: 'aborted' })
    await c.w.clock.advance(2000)
    expect(await crText(c, 'fresh')).toBe('NEXT_SESSION_PROMPT.md has not been updated for this handoff, so the context was kept. Run /cr handoff to have Claude write it.')
    c.w.live.isHandoffWritten = false
    expect(await crText(c, 'fresh')).toBe('NEXT_SESSION_PROMPT.md was not found, so the context was kept. Run /cr handoff to have Claude write it.')
    await c.w.clock.advance(5000)
    expect(c.clears.n).toBe(0)
    // Notes written now: the same command starts the fresh context, through the clear and the continuation.
    c.w.live.isHandoffWritten = true
    c.w.live.notesAt = null
    expect(await crText(c, 'fresh')).toBe('Handoff notes are valid. Starting the fresh context.')
    await c.w.clock.advance(4000)
    expect(c.clears.n).toBe(1)
    expect(count(c.w.kept.submitted, 'Context Autopilot continuation')).toBe(1)
  })
})

describe('Context while a handoff waits for background work', () => {
  const paneProps = { title: 'Control Room', isFocused: true, bodyColumns: 66, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

  test('the held task is listed with Stop on every surface; stopping it with no turn to follow offers Start fresh, which finishes the handoff', LONG, async ($, on) => {
    const c = session($, on)
    await $.session.start(SESSION)
    await handoffStops(c, [RENDER])
    await c.w.clock.advance(300)
    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps })
      await ui.press({ key: 'tab-context' })
      await c.w.clock.advance(300)
      expect(await ui.find({ text: /Render the full-resolution 16:9 picture/ }), surface).toBeDefined()
      // The card's title (the terminal draws titles in capitals).
      expect(await ui.find({ text: /Handoff · waiting for background work/i }), surface).toBeDefined()
      expect(await ui.find({ type: 'Button', key: `ap-stop-${RENDER.id}` }), surface).toBeDefined()
      // Nothing to start yet: the render runs, and a handoff is under way.
      expect(await ui.find({ type: 'Button', key: 'ap-fresh' }), surface).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'ap-handoff' }), surface).toBeUndefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps })
    await ui.press({ key: 'tab-context' })
    await c.w.clock.advance(300)
    // Stop: Claude Code's TaskStop. Here no notification turn follows, so no event would finish the handoff.
    await ui.press({ key: `ap-stop-${RENDER.id}` })
    await c.w.clock.advance(300)
    expect(c.w.kept.logs).toContain('background: bgimotmfr ended (killed), as your Stop says')
    expect(c.clears.n).toBe(0)
    // Start fresh context is offered, checks, and finishes it through the clear and the continuation.
    expect(await ui.find({ type: 'Button', key: 'ap-fresh' })).toBeDefined()
    await ui.press({ key: 'ap-fresh' })
    await c.w.clock.advance(4000)
    expect(c.w.kept.toasts).toContain('Handoff notes are valid and the background work has finished. Starting the fresh context.')
    expect(c.clears.n).toBe(1)
    expect(count(c.w.kept.submitted, 'Context Autopilot continuation')).toBe(1)
    await ui.unmount()
  })
})

// ---------------------------------------------------------------------------
// Runtime level: a reload, the run's work and decisions, Handoff Health, a handoff 1.6.2 left stuck.

/** The runtime with a fake engine; `current` is whichever runtime is loaded now (a reload replaces it). */
type Started = ReturnType<typeof fakeHost> & { rt: Runtime; current: { rt: Runtime } }

let turnSeq = 0

async function started(patch: (s: Settings) => void = () => undefined, host: Parameters<typeof fakeHost>[0] = {}): Promise<Started> {
  const f = fakeHost({ handoffSize: () => 4000, ...host })
  f.kept.store['settings.v1'] = withAutopilot(patch)
  const rt = new Runtime()
  const current = { rt }
  // Claude Code's /clear, as it answers Project Sentinel's own: a new session, its SessionStart{clear}.
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

/** A reload of the plugin in the same process: the old runtime's timers stop, a new one takes the run (and the handoff) on. */
async function reloaded(f: Started): Promise<Started> {
  f.rt.stopTimers()
  const rt = new Runtime()
  f.current.rt = rt
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { ...f, rt }
}

/** One main turn: its prompt (with its origin), what happens in it, its Stop listing `background`, its end. */
async function turnOf(
  f: Started,
  text: string,
  opts: { origin?: 'composer' | 'task-notification' | 'own'; background?: readonly { id: string; type: string; description: string }[]; during?: () => Promise<void> | void; message?: string; reason?: 'answer' | 'aborted'; turnId?: string } = {},
): Promise<string | null> {
  const { rt } = f
  const turnId = opts.turnId ?? `t${++turnSeq}`
  if (opts.origin !== 'own') rt.onPromptSubmit(text, opts.origin === 'task-notification' ? { kind: 'task-notification' } : { kind: 'composer' })
  await rt.onTurnStart({ turnId, text })
  await opts.during?.()
  const block = opts.reason === 'aborted' ? null : await rt.onStop({ stopHookActive: false, lastMessage: opts.message ?? 'Done.', background: opts.background ?? [], wakeups: [], permissionMode: undefined })
  await rt.onTurnComplete({ agentId: undefined, reason: opts.reason ?? 'answer', answer: opts.message ?? 'Done.' })
  await f.advance(10)
  return block
}

/** The handoff: asked for, its turn writing the notes and stopping with `background` in flight. */
async function handoffWith(f: Started, background: readonly typeof RENDER[]): Promise<void> {
  expect(await f.rt.requestHandoff()).toBe('Handing off: Claude is writing the handoff notes.')
  await f.advance(400)
  const prompt = f.kept.submitted.find(t => t.includes('final handoff'))
  await turnOf(f, `The project-sentinel plugin sent a message:\n${prompt ?? ''}`, { origin: 'own', background, message: 'Handoff written; the render still runs.' })
}

const milestones = (rt: Runtime) =>
  rt.recordMilestones({ objective: 'Ship the v2 film', milestones: [{ title: 'Render the 16:9 master', status: 'in_progress' }, { title: 'Mix and QA', status: 'pending' }] }, undefined)

describe('the run survives a background wait', () => {
  test('a reload while the handoff waits keeps waiting for the same render; its notification turn after the reload finishes the handoff, once', async () => {
    const f = await started()
    await handoffWith(f, [RENDER])
    expect(f.rt.autopilot.state).toBe('waiting-background')
    expect(f.kept.autopilotRecord).toMatchObject({ state: 'waiting-background', background: [{ id: RENDER.id, description: RENDER.description }], waitedFor: 1 })
    const g = await reloaded(f)
    expect(g.rt.autopilot).toMatchObject({ state: 'waiting-background', background: [{ id: RENDER.id }] })
    // Context still past any threshold after the reload: no second handoff.
    expect(g.kept.submitted.filter(t => t.includes('final handoff'))).toHaveLength(1)
    await turnOf(g, report(RENDER), { origin: 'task-notification' })
    await g.advance(4000)
    expect(g.kept.commands.filter(c => c === 'clear')).toHaveLength(1)
    expect(g.kept.submitted.filter(t => t.includes('Context Autopilot continuation'))).toHaveLength(1)
    expect(g.kept.traces).toContain('autopilot: turnComplete · waiting-background → verifying · verifyHandoff')
  })

  test('a reload during the notification’s own turn: that turn (its start unseen) ends with nothing in flight and finishes the handoff', async () => {
    const f = await started()
    await handoffWith(f, [RENDER])
    f.rt.onPromptSubmit(report(RENDER), { kind: 'task-notification' })
    await f.rt.onTurnStart({ turnId: 'n1', text: report(RENDER) })
    const g = await reloaded(f)
    await g.rt.onStop({ stopHookActive: false, lastMessage: 'Recorded.', background: [], wakeups: [], permissionMode: undefined })
    await g.rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Recorded.' })
    await g.advance(4000)
    expect(g.kept.traces.some(t => t.startsWith('turn ? completed (unknown, answer; background in flight: none)'))).toBe(true)
    expect(g.kept.commands.filter(c => c === 'clear')).toHaveLength(1)
    expect(g.kept.submitted.filter(t => t.includes('Context Autopilot continuation'))).toHaveLength(1)
  })

  test('the stuck state 1.6.2 left (a handoff record, its turn long over): after the update /cr fresh recovers it through the verified clear', async () => {
    const f = await started()
    // What 1.6.2 kept in `$.state`: state handoff, no background list, the handoff begun an hour ago.
    const began = f.now() - 3_600_000
    f.kept.autopilotRecord = { sessionId: 'S1', state: 'handoff', triggeredTokens: 801_000, triggeredAt: began, handoffSince: began, retries: 0, snoozeUntil: null, lastError: null, note: 'Claude is writing the handoff', at: began }
    const g = await reloaded(f)
    expect(g.rt.autopilot.state).toBe('handoff')
    // The person's questions never finish it (as in the real run)...
    await turnOf(g, 'is the handoff not done?')
    expect(g.rt.autopilot.state).toBe('handoff')
    // ...but /cr handoff no longer claims to start one, and /cr fresh recovers it.
    expect(await g.rt.startFreshContext()).toBe('Handoff notes are valid and no background work is running. Starting the fresh context.')
    await g.advance(4000)
    expect(g.kept.commands.filter(c => c === 'clear')).toHaveLength(1)
    expect(g.kept.submitted.filter(t => t.includes('Context Autopilot continuation'))).toHaveLength(1)
    expect(g.kept.submitted.filter(t => t.includes('final handoff'))).toHaveLength(0)
    expect(g.rt.run?.lastHandoff?.health.find(c => c.id === 'notes')?.state).toBe('ok')
  })

  test('queued work, open decisions and the milestones come through the wait intact, into the fresh context', async () => {
    const f = await started()
    milestones(f.rt)
    const queued = f.rt.ops.queueAdd('Render the 9:16 cut next', 'fresh')
    expect(queued.ok).toBe(true)
    const asked = f.rt.ops.decisionTool({ question: 'Keep the soft chuckle at 0:58?', options: ['Keep it', 'Cut it'], urgency: 'normal' }, undefined)
    expect(asked).toContain('D-1')
    await handoffWith(f, [RENDER])
    // A boundary-queued item added during the wait does not go out into a context about to be cleared.
    f.rt.ops.queueAdd('Check the loudness report', 'boundary')
    await f.advance(60_000)
    expect(f.kept.submitted.filter(t => t.startsWith('Mission Queue'))).toHaveLength(0)
    await turnOf(f, report(RENDER), { origin: 'task-notification' })
    await f.advance(4000)
    expect(f.kept.commands.filter(c => c === 'clear')).toHaveLength(1)
    // The fresh context is handed the run: its milestones, the work queued for it, the open decision.
    const notes = f.rt.takeFreshContext() ?? ''
    expect(notes).toContain('Render the 16:9 master')
    expect(notes).toContain('Q-1')
    expect(notes).toContain('D-1')
    expect(f.rt.plan().tasks.map(t => t.subject)).toEqual(['Render the 16:9 master', 'Mix and QA'])
    expect(f.rt.ops.current().decisions[0]).toMatchObject({ id: 'D-1', status: 'open' })
    expect(f.rt.ops.current().queue.find(q => q.text === 'Check the loudness report')?.status).not.toBe('delivered')
  })

  test('Handoff Health says whether the notes were written again after the background work ended', async () => {
    // Unset: written a moment ago, at every look.
    const notes = { at: null as number | null }
    const f = await started(() => undefined, { handoffMtime: () => notes.at ?? Number.MAX_SAFE_INTEGER })
    milestones(f.rt)
    await handoffWith(f, [RENDER])
    // Notes written during the handoff turn, never after the render ended.
    notes.at = f.now()
    await f.advance(60_000)
    await turnOf(f, report(RENDER), { origin: 'task-notification' })
    await f.advance(4000)
    const h = f.rt.run?.lastHandoff as HandoffRecord
    expect(h.health.find(c => c.id === 'background')).toMatchObject({ state: 'missing', detail: '1 task finished · notes not updated after' })
    expect(f.kept.traces.some(t => t.includes('not updated after the background work ended'))).toBe(true)

    // Written again in the notification's turn: recorded as such.
    const g = await started()
    await handoffWith(g, [RENDER, WAITER])
    await turnOf(g, report(WAITER), { origin: 'task-notification', background: [RENDER] })
    await turnOf(g, report(RENDER), { origin: 'task-notification' })
    await g.advance(4000)
    expect((g.rt.run?.lastHandoff as HandoffRecord).health.find(c => c.id === 'background')).toMatchObject({ state: 'ok', detail: '2 tasks finished · notes updated after' })
  })

  test('while the handoff waits the status bar and Context say what it waits for; then that it checks the notes; then that it starts fresh', async () => {
    const f = await started()
    await handoffWith(f, [RENDER])
    await f.advance(10)
    // Handing off is the run's current activity (blue), with how long it waits at most.
    expect(Views.hudOf(f.rt).headline).toEqual({ state: 'handoff', text: 'Handoff written · waiting for background work', detail: 'Render the full-resolution 16:9 picture · running · goes on in 20m at most', tone: 'info' })
    expect(Views.paneOf(f.rt).autopilot).toMatchObject({
      state: 'waiting-background',
      background: [{ id: RENDER.id, description: RENDER.description, class: 'unknown', classWords: 'Waited for · not recognised', isBlocking: true }],
      canFresh: false,
      canHandoff: false,
      waitMinutes: 20,
    })
    // The status bar's line above the headline: what it waits for, and the ways out.
    expect(Views.hudOf(f.rt).alert).toMatchObject({ kind: 'waiting', text: 'Handoff written, waits for Render the full-resolution 16:9 picture · goes on in 20m at most', tone: 'info', canStop: true, canKeep: false })
    expect(Views.statusOf(f.rt).autopilot.text).toBe('Waiting for background work')
    // The render's notification arrives; its turn runs.
    f.rt.onPromptSubmit(report(RENDER), { kind: 'task-notification' })
    await f.rt.onTurnStart({ turnId: 'n1', text: report(RENDER) })
    expect(Views.hudOf(f.rt).headline).toMatchObject({ text: 'Handoff · background work finished', detail: 'Claude records the result, then the notes are checked' })
    // Held at the check (the notes' look not answered yet): checking the notes.
    const held: (() => void)[] = []
    const stat = f.host.stat
    f.host.stat = async (path, resolve) => {
      if (path.endsWith('NEXT_SESSION_PROMPT.md')) await new Promise<void>(r => void held.push(r))
      return stat(path, resolve)
    }
    await f.rt.onStop({ stopHookActive: false, lastMessage: 'Recorded.', background: [], wakeups: [], permissionMode: undefined })
    await f.rt.onTurnComplete({ agentId: undefined, reason: 'answer', answer: 'Recorded.' })
    expect(f.rt.autopilot.state).toBe('verifying')
    expect(Views.hudOf(f.rt).headline.text).toBe('Handoff complete · checking the notes')
    f.host.stat = stat
    for (const release of held) release()
    await f.advance(10)
    expect(f.rt.autopilot.state).toBe('clearing')
    expect(Views.hudOf(f.rt).headline.text).toBe('Handoff complete · starting the fresh context')
    // The person's Stop on a held task (Context's Stop button) ends the wait for it too.
    const g = await started()
    await handoffWith(g, [RENDER])
    await g.rt.stopBackgroundTask(RENDER.id)
    expect(g.kept.stopped).toEqual([RENDER.id])
    expect(g.rt.autopilot.background).toEqual([])
    expect(g.kept.traces).toContain('background: bgimotmfr ended (killed), as your Stop says')
  })
})
