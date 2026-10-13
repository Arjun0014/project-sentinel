import { describe, expect, test } from 'claude-code/testing'

import type { OpsView } from '../types'
import { COLD } from '../hooks/app/operations'
import { budgetText } from '../hooks/app/opsCommands'
import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { hudCells, hudSegments, tiersOf } from '../hooks/ui/hud'
import { classicSettings, defaultSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { fakeHost, flush } from './fixtures/fake-host'

const MIN = 60_000
const HOUR = 60 * MIN
const OPUS = 'claude-opus-5-5'
const FIVE_MINUTES = { v: 1, ttl: '5m', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }
const ONE_HOUR = { v: 1, ttl: '1h', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }

type Fake = ReturnType<typeof fakeHost>
type Started = Fake & { rt: Runtime }

/**
 * A session with Project Sentinel started. The handoff notes are healthy by default (4 kB, written
 * now); `tokens` is the context Claude Code reports; `memory` what earlier sessions learned of the cache.
 */
async function started(
  patch: (s: Settings) => void = () => undefined,
  options: { tokens?: number; memory?: Record<string, unknown>; host?: Parameters<typeof fakeHost>[0]; store?: Record<string, unknown>; at?: number } = {},
): Promise<Started> {
  const f = fakeHost({ handoffSize: () => 4000, handoffMtime: () => Date.now(), ...options.host })
  if (options.store !== undefined) f.kept.store = options.store
  if (options.at !== undefined) await f.advance(options.at - f.now())
  if (options.store === undefined) {
    const s = classicSettings()
    patch(s)
    f.kept.store['settings.v1'] = s
  }
  if (options.memory !== undefined) f.kept.store['cache.v1'] = options.memory
  if (options.tokens !== undefined) f.live.usage = { ...f.live.usage, context: { tokens: options.tokens, window: 1_000_000, percent: Math.round(options.tokens / 10_000) } }
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { rt, ...f }
}

/** A reload of the plugin in the same process: the old runtime's timers are cancelled, a new one takes the run on. */
async function reloaded(f: Started): Promise<Started> {
  f.rt.stopTimers()
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { ...f, rt }
}

let turns = 0

/**
 * One main turn: its prompt, one request of `prompt` tokens (`read` of them from the cache),
 * whatever `during` does while it runs, then its end.
 */
async function turn(f: Started, text: string, opts: { during?: () => Promise<void> | void; reason?: 'answer' | 'aborted'; message?: string; prompt?: number; read?: number } = {}): Promise<void> {
  const { rt } = f
  const turnId = `t${++turns}`
  await rt.onTurnStart({ turnId, text })
  const e = { turnId, index: 0, model: OPUS, messageCount: 3 }
  const sent = rt.stepRequest(e)
  await opts.during?.()
  rt.stepResponse(e, sent, {
    turnId,
    index: 0,
    answer: '',
    toolUses: [],
    stopReason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: opts.read ?? 0, cache_creation_input_tokens: opts.prompt ?? 2_000, model: OPUS },
  })
  await rt.onStop({ stopHookActive: false, lastMessage: opts.message ?? 'Done.', background: [], wakeups: [], permissionMode: undefined })
  await rt.onTurnComplete({ agentId: undefined, reason: opts.reason ?? 'answer', answer: 'done' })
  await f.advance(10)
}

/** Runs the turn the last prompt Project Sentinel submitted would start. */
async function runSubmitted(f: Started, opts: Parameters<typeof turn>[2] = {}): Promise<string> {
  const text = f.kept.submitted.at(-1)
  if (text === undefined) throw new Error('nothing was submitted')
  await turn(f, text, opts)
  return text
}

/** Claude Code's /clear, as it answers Project Sentinel's own: a new session, its SessionStart{clear}. */
function clears(f: Started): void {
  let n = 1
  f.host.clearContext = async () => {
    f.kept.commands.push('clear')
    const id = `C${++n}`
    f.live.sessionId = id
    void f.rt.onClassicSessionStart({ source: 'clear', sessionId: id })
    return { text: '' }
  }
}

/** A fresh context Project Sentinel starts for its own reasons (as a handoff, a fresh wake or Start fresh do). */
const ownFresh = (f: Started) => f.rt.freshStart({ why: 'a test.', then: 'Then carry on.', endNote: 'test fresh start', cause: 'for a test', watcherId: null })

const milestones = (rt: Runtime, list: readonly [string, string][]): string => rt.recordMilestones({ objective: 'Ship the orchestration layer', milestones: list.map(([title, status]) => ({ title, status })) }, undefined)

const view = (rt: Runtime): OpsView => rt.ops.view()

/** The status bar's model, as published. */
const hud = (rt: Runtime) => Views.hudOf(rt)

// ---------------------------------------------------------------------------
// Mission Queue

describe('Mission Queue', () => {
  test('added while nothing runs, it goes at once as a prompt of its own, once', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    const added = rt.ops.queueAdd('Update the README with the final cache findings', 'boundary')
    expect(added).toMatchObject({ ok: true, id: 'Q-1', when: 'Due: goes now' })
    expect(kept.submitted).toEqual([])
    await advance(800)
    expect(kept.submitted).toHaveLength(1)
    expect(kept.submitted[0]).toStartWith('Mission Queue · Q-1, queued by the user at')
    expect(kept.submitted[0]).toContain('Update the README with the final cache findings')
    expect(rt.ops.current().queue[0]).toMatchObject({ status: 'delivered', via: 'prompt' })
    await runSubmitted(f)
    expect(rt.turn.kind).toBe('queued')
    await advance(5 * MIN)
    expect(kept.submitted).toHaveLength(1)
  })

  test('added while Claude works, it never enters the running turn: it goes when the turn ends', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    await turn(f, 'Build the parser.', {
      during: async () => {
        expect(rt.ops.queueAdd('Then update the docs', 'boundary')).toMatchObject({ ok: true, when: 'Next safe boundary' })
        await advance(5 * MIN)
        expect(kept.submitted).toEqual([])
        // Nothing for Claude's tool results either: a queued item is not a mid-turn note.
        expect(rt.notesForBatch().some(n => n.includes('Then update the docs'))).toBe(false)
      },
    })
    await advance(800)
    expect(kept.submitted).toHaveLength(1)
    expect(kept.submitted[0]).toContain('Then update the docs')
  })

  test('an interrupted turn delivers nothing by itself: the person took over', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    await turn(f, 'Build it.', { during: () => void rt.ops.queueAdd('Later work', 'turn'), reason: 'aborted' })
    await advance(5 * MIN)
    expect(kept.submitted).toEqual([])
    expect(rt.ops.current().queue[0]!.status).toBe('queued')
    // The next turn's end is the boundary.
    await turn(f, 'Go on.')
    await advance(800)
    expect(kept.submitted[0]).toContain('Later work')
  })

  test('several items go in the order the person put them; a deleted one never goes', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    await turn(f, 'Work.', {
      during: () => {
        rt.ops.queueAdd('First thing', 'turn')
        rt.ops.queueAdd('Second thing', 'turn')
        rt.ops.queueAdd('Third thing', 'turn')
        rt.ops.queueMove('Q-3', -1)
        rt.ops.queueCancel('Q-1')
      },
    })
    await advance(800)
    expect(kept.submitted).toHaveLength(1)
    const text = kept.submitted[0]!
    expect(text).toStartWith('Mission Queue · 2 items the user queued for now, in their order.')
    expect(text).not.toContain('First thing')
    expect(text.indexOf('Third thing')).toBeLessThan(text.indexOf('Second thing'))
    expect(rt.ops.current().queue.find(q => q.id === 'Q-1')!.status).toBe('cancelled')
  })

  test('edited in place, its new words go; re-targeted to after the handoff, it waits', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    await turn(f, 'Work.', {
      during: () => {
        rt.ops.queueAdd('Draft', 'turn')
        rt.ops.queueAdd('Keep for the fresh context', 'turn')
        rt.ops.queueEdit('Q-1', { text: 'Final words' })
        rt.ops.queueEdit('Q-2', { target: 'fresh' })
      },
    })
    await advance(800)
    expect(kept.submitted).toHaveLength(1)
    expect(kept.submitted[0]).toContain('Final words')
    expect(kept.submitted[0]).not.toContain('Keep for the fresh context')
    expect(rt.ops.current().queue.find(q => q.id === 'Q-2')).toMatchObject({ status: 'queued', target: 'fresh' })
  })

  test('after the current milestone: it goes with the tool results that follow that milestone, not before, never twice', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    milestones(rt, [
      ['Write the parser', 'in_progress'],
      ['Write the tests', 'pending'],
    ])
    await turn(f, 'Build it.', {
      during: async () => {
        const added = rt.ops.queueAdd('Add the edge-case fixture', 'milestone')
        expect(added).toMatchObject({ ok: true, when: 'After the current milestone: Write the parser' })
        expect(rt.notesForBatch()).toEqual([])
        milestones(rt, [
          ['Write the parser', 'completed'],
          ['Write the tests', 'in_progress'],
        ])
        const batch = rt.notesForBatch()
        expect(batch.some(n => n.startsWith('Project Sentinel · Mission Queue: the user queued work for after the milestone you just completed'))).toBe(true)
        expect(batch.some(n => n.includes('Add the edge-case fixture'))).toBe(true)
        expect(rt.ops.current().queue[0]).toMatchObject({ status: 'delivered', via: 'note' })
        expect(rt.notesForBatch()).toEqual([])
      },
    })
    await advance(5 * MIN)
    expect(kept.submitted).toEqual([])
  })

  test('a note that never left (the turn made no more tool calls) goes as a prompt at the turn end instead', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    milestones(rt, [['Write the parser', 'in_progress']])
    await turn(f, 'Build it.', {
      during: () => {
        rt.ops.queueAdd('Add the fixture', 'milestone')
        milestones(rt, [['Write the parser', 'completed']])
        expect(rt.ops.current().queue[0]).toMatchObject({ status: 'sending', via: 'note' })
      },
    })
    await advance(800)
    expect(kept.submitted).toHaveLength(1)
    expect(kept.submitted[0]).toContain('Add the fixture')
  })

  test('the objective Claude stated holds through the person’s follow-ups while its milestones are open, and reaches the fresh context', async () => {
    const f = await started()
    const { rt } = f
    milestones(rt, [
      ['Read the notes', 'completed'],
      ['Summarise notes-a', 'in_progress'],
      ['Write the summary file', 'pending'],
    ])
    expect(rt.run).toMatchObject({ objective: 'Ship the orchestration layer', objectiveBy: 'claude' })
    // A follow-up long enough to read as a request (seen live: it took the run's objective, and the fresh context lost it).
    rt.onPromptSubmit('Rewrite NEXT_SESSION_PROMPT.md as a proper handoff of about ten lines, then reply DONE.', { kind: 'composer' })
    expect(rt.run).toMatchObject({ objective: 'Ship the orchestration layer', objectiveBy: 'claude' })
    expect(rt.ops.resumePreview().objective).toBe('Ship the orchestration layer')
    await rt.ops.refreshNotes(true)
    clears(f)
    expect(await ownFresh(f)).toEqual({ ok: true })
    expect(rt.takeFreshContext()).toContain(`toward the run's objective, "Ship the orchestration layer"`)
    // With every milestone done, the person's next substantial request is the new objective.
    milestones(rt, [
      ['Read the notes', 'completed'],
      ['Summarise notes-a', 'completed'],
      ['Write the summary file', 'completed'],
    ])
    rt.onPromptSubmit('Translate the summary into French and keep every heading as it is.', { kind: 'composer' })
    expect(rt.run).toMatchObject({ objective: 'Translate the summary into French and keep every heading as it is.', objectiveBy: 'person' })
  })

  test('an answer that waits while a watcher parks the run says it goes with the wake (seen live: it said only "your next message")', async () => {
    const f = await started()
    const { rt } = f
    milestones(rt, [['Wait for the reviewer', 'waiting']])
    rt.ops.decisionTool({ question: 'Include the version history?', options: ['Yes', 'No'] }, undefined)
    rt.ops.armFrom('the reviewer reply', 'in 3h', 'fresh')
    expect(rt.ops.answer('D-1', 'Yes')).toEqual({ ok: true })
    expect(view(rt).decisions[0]!.route).toStartWith("Goes with W-1's wake (")
    expect(view(rt).decisions[0]!.route).toEndWith('), or with your next message (or Send now)')
  })

  test('after the current milestone, while the run waits on a milestone: after that wait, not at once (seen live)', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    milestones(rt, [
      ['Draft the digest', 'completed'],
      ['Wait for the reviewer', 'waiting'],
      ['Publish the digest', 'pending'],
    ])
    const added = rt.ops.queueAdd('Note the reviewer verdict at the top of the digest.', 'milestone')
    expect(added).toMatchObject({ ok: true, when: 'After the current milestone: Wait for the reviewer' })
    await advance(2000)
    expect(kept.submitted).toEqual([])
    // A turn of the person's that leaves the wait as it is: still waiting.
    await turn(f, 'How long has the reviewer had it?')
    await advance(2000)
    expect(kept.submitted).toEqual([])
    // The wait resolves in a turn: the item goes at its end.
    await turn(f, 'The reviewer replied.', {
      during: () => void milestones(rt, [
        ['Draft the digest', 'completed'],
        ['Wait for the reviewer', 'completed'],
        ['Publish the digest', 'in_progress'],
      ]),
    })
    await advance(2000)
    expect(kept.submitted.at(-1)).toContain('Note the reviewer verdict at the top of the digest.')
  })

  test('the queue belongs to the run: it survives a reload, the person’s /clear, and goes into the next fresh context Project Sentinel starts', async () => {
    let f = await started()
    f.rt.ops.queueAdd('Carry this into the fresh context', 'fresh')
    await f.advance(800)
    expect(f.kept.submitted).toEqual([])
    f = await reloaded(f)
    expect(f.rt.ops.current().queue).toHaveLength(1)
    expect(f.rt.ops.current().queue[0]).toMatchObject({ id: 'Q-1', status: 'queued', target: 'fresh' })
    // The person clears: the run goes on in a new session, its queue with it, and nothing is sent.
    f.live.sessionId = 'S2'
    await f.rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    expect(f.rt.ops.current().queue[0]!.status).toBe('queued')
    expect(f.rt.takeFreshContext()).toBeNull()
    // Project Sentinel's own fresh context: it rides that context's first message.
    clears(f)
    expect(await ownFresh(f)).toEqual({ ok: true })
    const context = f.rt.takeFreshContext() ?? ''
    expect(context).toContain('The user queued this work for the fresh context, in order: (Q-1')
    expect(context).toContain('Carry this into the fresh context')
    expect(f.rt.ops.current().queue[0]).toMatchObject({ status: 'delivered', via: 'fresh' })
  })

  test('a prompt Claude Code refused is due again, never lost; one on its way during a reload reads as unsure, never resent by itself', async () => {
    const f = await started()
    const { rt, kept, live, advance } = f
    live.submitDrop = 'blocked by a settings hook'
    rt.ops.queueAdd('Something', 'boundary')
    await advance(800)
    expect(rt.ops.current().queue[0]!.status).toBe('due')
    expect(rt.ops.current().log[0]!.text).toContain('not sent: dropped: blocked by a settings hook')
    live.submitDrop = null
    // On its way when the plugin reloads: said, not repeated.
    rt.ops.current().queue[0]!.status = 'sending'
    rt.persistRun(true)
    await flush()
    const g = await reloaded(f)
    expect(g.rt.ops.current().queue[0]!.status).toBe('unsure')
    await g.advance(5 * MIN)
    expect(kept.submitted).toHaveLength(1)
    expect(view(g.rt).queue[0]!.when).toBe('Sent before a reload: check the transcript')
    g.rt.ops.queueNow('Q-1')
    await g.advance(800)
    expect(kept.submitted).toHaveLength(2)
  })

  test('the status bar shows no constant queue count: only "Queued N" while Claude works with items due', async () => {
    const f = await started()
    const { rt } = f
    rt.ops.queueAdd('For the fresh context', 'fresh')
    expect(hud(rt).chips.some(c => c.key === 'queued')).toBe(false)
    await turn(f, 'Work.', {
      during: () => {
        rt.ops.queueAdd('Due at the turn end', 'turn')
        expect(hud(rt).chips.some(c => c.key === 'queued')).toBe(false)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// Decision Inbox

describe('Decision Inbox', () => {
  test('the tool is offered by default; a decision waits in Needs review and Claude is told to carry on', async () => {
    const { rt, kept } = await started()
    expect(kept.registeredTools).toContain('decision_request')
    const answer = rt.ops.decisionTool({ question: 'Postgres or SQLite for the cache store?', context: 'SQLite keeps it one file.', options: ['Postgres', 'SQLite'] }, undefined)
    expect(answer).toBe("Recorded as D-1 in the user's Decision Inbox. Their answer will reach you with a later message (or with tool results while you work). It does not block: carry on with the work that does not depend on it.")
    expect(view(rt).decisions[0]).toMatchObject({ id: 'D-1', status: 'open', options: ['Postgres', 'SQLite'], route: null })
    expect(hud(rt).ops).toMatchObject({ review: 1, blocking: 0 })
    expect(hud(rt).chips.find(c => c.key === 'review')).toEqual({ key: 'review', text: 'Review 1', tone: 'warn', opens: 'ops' })
    expect(kept.toasts.at(-1)).toBe('Review: Postgres or SQLite for the cache store?')
    // Asked again while open: the same decision.
    expect(rt.ops.decisionTool({ question: 'Postgres or SQLite for the cache store?' }, undefined)).toStartWith("Already in the user's Decision Inbox as D-1")
    expect(rt.ops.current().decisions).toHaveLength(1)
  })

  test('a subagent, or the inbox turned off, is told to raise it another way', async () => {
    const { rt } = await started(s => void (s.ops.decisions = false))
    expect(rt.ops.decisionTool({ question: 'Which one?' }, undefined)).toContain('The Decision Inbox is off')
    const on = await started()
    expect(on.rt.ops.decisionTool({ question: 'Which one?' }, 'agent-7')).toContain('for the main conversation')
    expect(on.rt.ops.current().decisions).toHaveLength(0)
  })

  test('blocking: the headline says the run needs you; the answer goes to Claude as a prompt at once', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    rt.ops.decisionTool({ question: 'Which GPU configuration should S-004 use?', options: ['A100 x8', 'H100 x4'], blocking: true }, undefined)
    expect(hud(rt).headline).toMatchObject({ state: 'waitingUser', text: 'Needs you · 1 decision', detail: 'Which GPU configuration should S-004 use?' })
    // The headline says it: no Review chip on top of it while nothing runs.
    expect(hud(rt).chips.some(c => c.key === 'review')).toBe(false)
    expect(rt.ops.answer('D-1', 'H100 x4')).toEqual({ ok: true })
    expect(view(rt).decisions[0]!.route).toBe('Goes to Claude now')
    await advance(800)
    expect(kept.submitted).toHaveLength(1)
    expect(kept.submitted[0]).toStartWith('Decision Inbox · the user answered your decision:')
    expect(kept.submitted[0]).toContain('D-1')
    expect(kept.submitted[0]).toContain('H100 x4')
    expect(rt.ops.current().decisions[0]).toMatchObject({ status: 'delivered', via: 'prompt' })
    await runSubmitted(f)
    expect(rt.turn.kind).toBe('answer')
    await advance(5 * MIN)
    expect(kept.submitted).toHaveLength(1)
  })

  test('non-blocking: the answer rides the person’s next message, as context, once', async () => {
    const { rt, kept, advance } = await started()
    rt.ops.decisionTool({ question: 'Delete the generated screenshots?', options: ['Delete', 'Keep'] }, undefined)
    rt.ops.answer('D-1', 'Keep')
    await advance(5 * MIN)
    expect(kept.submitted).toEqual([])
    expect(view(rt).decisions[0]!.route).toBe('Goes with your next message (or Send now)')
    const context = rt.onPromptSubmit('Carry on.', { kind: 'composer' })
    expect(context.some(c => c.startsWith('Project Sentinel · Decision Inbox: the user answered:') && c.includes('Keep'))).toBe(true)
    expect(rt.ops.current().decisions[0]).toMatchObject({ status: 'delivered', via: 'context' })
    expect(rt.onPromptSubmit('More.', { kind: 'composer' }).some(c => c.includes('Decision Inbox'))).toBe(false)
  })

  test('Send now sends a non-blocking answer at once', async () => {
    const { rt, kept, advance } = await started()
    rt.ops.decisionTool({ question: 'Publish once CI passes?' }, undefined)
    rt.ops.answer('D-1', 'Yes, publish.')
    rt.ops.answerNow('D-1')
    await advance(800)
    expect(kept.submitted[0]).toContain('Yes, publish.')
  })

  test('answered while Claude works: it goes with the next batch of tool results', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    await turn(f, 'Work.', {
      during: () => {
        rt.ops.decisionTool({ question: 'Which experiment next?', options: ['S-005', 'S-006'] }, undefined)
        rt.ops.answer('D-1', 'S-006')
        expect(view(rt).decisions[0]!.route).toBe('Goes with Claude’s next tool results')
        const batch = rt.notesForBatch()
        expect(batch.some(n => n.includes('Which experiment next?') && n.includes('S-006'))).toBe(true)
        expect(rt.ops.current().decisions[0]).toMatchObject({ status: 'delivered', via: 'note' })
      },
    })
    await advance(5 * MIN)
    expect(kept.submitted).toEqual([])
  })

  test('several answers go together, in one prompt', async () => {
    const { rt, kept, advance } = await started()
    rt.ops.decisionTool({ question: 'First question here?' }, undefined)
    rt.ops.decisionTool({ question: 'Second question here?', blocking: true }, undefined)
    rt.ops.answer('D-1', 'one')
    await advance(800)
    expect(kept.submitted).toEqual([])
    rt.ops.answer('D-2', 'two')
    await advance(800)
    expect(kept.submitted).toHaveLength(1)
    expect(kept.submitted[0]).toContain('2 of your decisions')
    expect(kept.submitted[0]).toContain('one')
    expect(kept.submitted[0]).toContain('two')
  })

  test('/cr decide asks in Claude Code’s own dialog; Decide later leaves it open', async () => {
    const { rt, kept, live } = await started()
    rt.ops.decisionTool({ question: 'Which layout?', options: ['Grid', 'List'] }, undefined)
    live.answer = 'List'
    expect(await rt.runCommand('decide d-1')).toEqual({ text: 'D-1 answered: List. It reaches Claude with your next message (Send now in Operations sends it at once).' })
    expect(kept.asked.at(-1)).toMatchObject({ question: 'Which layout?', options: ['Grid', 'List'], header: 'D-1' })
    rt.ops.decisionTool({ question: 'Free words please?' }, undefined)
    live.answer = 'Decide later'
    expect((await rt.runCommand('decide D-2')).text).toBe('D-2 is still open.')
    expect(kept.asked.at(-1)!.options).toEqual(['Let Claude choose', 'Decide later'])
    // An answer typed after the id, by an option's number.
    rt.ops.decisionTool({ question: 'Which colour?', options: ['Red', 'Blue'] }, undefined)
    expect((await rt.runCommand('decide D-3 2')).text).toStartWith('D-3 answered: Blue.')
  })

  test('decisions belong to the run: they survive /clear and a reload, and the fresh context hears the open ones', async () => {
    let f = await started()
    f.rt.ops.decisionTool({ question: 'Keep the legacy API?' }, undefined)
    f.live.sessionId = 'S2'
    await f.rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    f = await reloaded(f)
    expect(f.rt.ops.current().decisions[0]).toMatchObject({ id: 'D-1', status: 'open' })
    clears(f)
    await ownFresh(f)
    expect(f.rt.takeFreshContext()).toContain("Still waiting in the user's Decision Inbox: D-1: Keep the legacy API?. Do not ask them again")
  })

  test('Claude Code’s permission prompts are never deferred: an Ask approval is asked at once, decisions or not', async () => {
    const { rt, kept } = await started(s => void (s.permissions.push = 'ask'))
    rt.ops.decisionTool({ question: 'Ship on Friday?', blocking: true }, undefined)
    rt.onTurnStart({ turnId: 'p1', text: 'Push it.' })
    const refusal = await rt.beforeTool('Bash', { command: 'git push origin main' }, 'b1', undefined)
    expect(kept.asked).toHaveLength(1)
    expect(kept.asked[0]!.header).toBe('Approve')
    expect(refusal).not.toBeNull()
    // The inbox did not answer it, and still holds only Claude's own question.
    expect(rt.ops.current().decisions.map(d => d.question)).toEqual(['Ship on Friday?'])
  })
})

// ---------------------------------------------------------------------------
// Watchers

describe('Watchers', () => {
  test('armed with a time and a label; local time, countdown, and Smart’s choice with its reason', async () => {
    const { rt } = await started()
    const armed = rt.ops.armFrom('S-002 result', 'in 2h', 'smart')
    expect(armed.ok).toBe(true)
    if (!armed.ok) return
    expect(armed.words).toMatch(/^W-1 wakes (tomorrow )?\d\d:\d\d \(in 2h\) for S-002 result: Smart, /)
    const w = view(rt).watchers[0]!
    expect(w).toMatchObject({ id: 'W-1', label: 'S-002 result', strategy: 'smart', status: 'armed', isCheckpointPending: false, source: 'person' })
    expect(w.decided?.reason).toContain('2h wait')
    expect(hud(rt).headline.state).toBe('sleeping')
    expect(hud(rt).headline.text).toMatch(/^Sleeping until (tomorrow )?\d\d:\d\d · S-002 result$/)
    expect(hud(rt).ops?.watcher).toMatchObject({ id: 'W-1', left: '2h', status: 'armed' })
    expect(Views.statusLineOf(hud(rt))).toContain('Sleeping until')
  })

  test('while a watcher parks the run, the cache says what becomes of it, never as a time left', async () => {
    const cacheWords = (rt: Runtime, columns: number) => {
      const segment = hudSegments(hud(rt), tiersOf(columns)[0]!).find(s => s.key === 'cache')
      const cell = hudCells(hud(rt), columns).find(c => c.key === 'cache')
      return {
        band: [...(segment?.spans ?? []), ...(segment?.after ?? [])].map(x => x.text).join(''),
        cell: (cell?.parts ?? []).flatMap(p => p.value).map(x => x.text).join(''),
      }
    }
    const f = await started(undefined, { tokens: 300_000 })
    await turn(f, 'Submit S-002.', { prompt: 300_000 })
    f.rt.ops.armFrom('S-002 result', 'in 2h', 'warm')
    expect(hud(f.rt).ops?.watcher?.isHeldWarm).toBe(true)
    expect(hud(f.rt).cache?.parked).toEqual({ text: 'held warm', short: 'held' })
    const warm = cacheWords(f.rt, 120)
    expect(warm.band).toContain(' held warm')
    expect(warm.cell).toBe('held warm · 300k')
    expect(cacheWords(f.rt, 90).cell).toBe('held warm')
    expect(cacheWords(f.rt, 64).cell).toBe('held')
    expect(`${warm.band} ${warm.cell}`).not.toContain('left')
    expect(Views.statusLineOf(hud(f.rt))).toContain('Cache held warm')
    // A fresh wake lets the cache lapse: said so, quietly.
    const g = await started(undefined, { tokens: 300_000 })
    await turn(g, 'Submit S-002.', { prompt: 300_000 })
    g.rt.ops.armFrom('S-002 result', 'in 6h', 'fresh')
    expect(hud(g.rt).cache).toMatchObject({ parked: { text: 'no keep-alive', short: 'lapses' }, tone: 'muted' })
    expect(cacheWords(g.rt, 120).cell).toBe('no keep-alive · 300k')
    expect(cacheWords(g.rt, 64).cell).toBe('lapses')
    expect(cacheWords(g.rt, 120).band).not.toContain('left')
  })

  test('an ambiguous time is not armed: both readings come back to be chosen', async () => {
    const { rt } = await started()
    const r = rt.ops.armFrom('the eval', 'at 2:30', 'smart')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.options).toHaveLength(2)
    expect(rt.ops.current().watchers).toEqual([])
    const picked = rt.ops.armAt('the eval', { kind: 'at', at: r.options![1]!.at, words: '' }, 'warm')
    expect(picked.ok).toBe(true)
  })

  test('a warm wake: at its time, with nothing changed, it wakes the run in this context; several wake in turn', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    rt.ops.armFrom('the first result', 'in 1h', 'warm')
    rt.ops.armFrom('the second result', 'in 2h', 'warm')
    expect(view(rt).watchers.map(w => w.id)).toEqual(['W-1', 'W-2'])
    await advance(HOUR - 5000)
    expect(kept.submitted).toEqual([])
    await advance(10_000)
    expect(kept.submitted).toHaveLength(1)
    expect(kept.submitted[0]).toStartWith('Project Sentinel watcher wake (W-1): the run was parked at')
    expect(kept.submitted[0]).toContain('waiting for the first result')
    expect(rt.ops.current().watchers.find(w => w.id === 'W-1')).toMatchObject({ status: 'done', outcome: 'Woke the run in this context' })
    // The wake's turn is Project Sentinel's own: W-2's run is parked again where it left it.
    await runSubmitted(f)
    await advance(HOUR)
    expect(kept.submitted).toHaveLength(2)
    expect(kept.submitted[1]).toStartWith('Project Sentinel watcher wake (W-2)')
    expect(kept.commands).toEqual([])
  })

  test('stale protection: a run that moved since the watcher was armed is never woken by itself, let alone cleared', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    rt.ops.armFrom('S-002 result', 'in 1h', 'fresh')
    await advance(10 * MIN)
    await turn(f, 'Actually, look at the logs first.')
    await advance(HOUR)
    expect(kept.submitted).toEqual([])
    expect(kept.commands).toEqual([])
    const w = rt.ops.current().watchers[0]!
    expect(w).toMatchObject({ status: 'stale', needs: 'This run changed since the watcher was armed: a turn ran.' })
    expect(kept.toasts.at(-1)).toBe('Watcher due: S-002 result. This run changed since it was armed, so it waits for you.')
    expect(kept.traces).toContain('ops: W-1 due, but the run changed since it was armed (a turn ran): waits for you; nothing sent, nothing cleared')
    // Waiting for the person reads amber (1.7.0: color is meaning; the brand's orange is only its mark).
    expect(hud(rt).alert).toMatchObject({ kind: 'watcher', ref: 'W-1', tone: 'warn' })
    expect(hud(rt).alert?.text).toContain('Watcher due: S-002 result')
    expect(hud(rt).headline).toMatchObject({ state: 'waitingUser', text: 'Watcher due: S-002 result' })
    // Check now: a prompt in this context, never a clear.
    await rt.ops.checkNow('W-1')
    expect(kept.submitted).toHaveLength(1)
    expect(kept.submitted[0]).toStartWith('Project Sentinel watcher wake (W-1)')
    expect(kept.commands).toEqual([])
  })

  test('changed milestones, or a cleared context, are a moved run too', async () => {
    const f = await started()
    const { rt, kept, live, advance } = f
    milestones(rt, [['Run S-002', 'waiting']])
    rt.ops.armFrom('S-002 result', 'in 1h', 'warm')
    milestones(rt, [['Run S-002', 'completed']])
    await advance(HOUR + MIN)
    expect(rt.ops.current().watchers[0]!.needs).toContain('its milestones changed')
    const g = await started()
    g.rt.ops.armFrom('S-003 result', 'in 1h', 'warm')
    g.live.sessionId = 'S2'
    await g.rt.onClassicSessionStart({ source: 'clear', sessionId: 'S2' })
    await g.advance(HOUR + MIN)
    expect(g.rt.ops.current().watchers[0]!.needs).toContain('the context was cleared')
    expect(kept.submitted).toEqual([])
    expect(g.kept.submitted).toEqual([])
    void live
  })

  test('due while Claude Code’s own wake-up runs a turn: it waits for that turn’s end, then wakes', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    rt.ops.armFrom('the nightly run', 'in 1h', 'warm')
    await advance(HOUR - MIN)
    // A turn with no typed prompt (a background job finished, a scheduled wake-up): not the person's.
    await turn(f, '', {
      during: async () => {
        await advance(2 * MIN)
        expect(rt.ops.current().watchers[0]).toMatchObject({ status: 'due', needs: null })
        expect(kept.toasts.at(-1)).toBe("Watcher due: the nightly run · waits for Claude's turn to end")
        expect(kept.submitted).toEqual([])
      },
    })
    await advance(800)
    expect(kept.submitted).toHaveLength(1)
    expect(kept.submitted[0]).toStartWith('Project Sentinel watcher wake (W-1)')
  })

  test('armed mid-turn, it parks the run where that turn leaves it', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    await turn(f, 'Start the eval, then wait for it.', {
      during: () => {
        rt.ops.armFrom('the eval', 'in 30m', 'warm')
        expect(view(rt).watchers[0]!.isCheckpointPending).toBe(true)
        expect(hud(rt).chips.find(c => c.key === 'watcher')).toMatchObject({ text: 'Watcher 30m', opens: 'ops' })
      },
    })
    expect(view(rt).watchers[0]!.isCheckpointPending).toBe(false)
    await advance(31 * MIN)
    expect(kept.submitted[0]).toStartWith('Project Sentinel watcher wake (W-1)')
  })

  test('a fresh wake: with healthy resume state and nothing changed, it clears and resumes in a fresh context that knows why', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    milestones(rt, [
      ['Submit S-002', 'completed'],
      ['Read the S-002 result', 'waiting'],
    ])
    await rt.ops.refreshNotes(true)
    clears(f)
    const armed = rt.ops.armFrom('S-002 result', 'in 3h', 'fresh')
    expect(armed.ok).toBe(true)
    await advance(3 * HOUR + MIN)
    expect(kept.commands).toEqual(['clear'])
    const fresh = kept.submitted.at(-1) ?? ''
    expect(fresh).toStartWith('Project Sentinel fresh resume (session 2): watcher W-1 woke the run, parked waiting for S-002 result.')
    expect(fresh).toContain('NEXT_SESSION_PROMPT.md')
    expect(fresh).toContain('Then check S-002 result and continue the work')
    const context = rt.takeFreshContext() ?? ''
    expect(context).toContain('cleared on purpose for a watcher\'s fresh wake')
    expect(context).toContain('This fresh context began because watcher W-1 woke the run: it was parked waiting for S-002 result')
    expect(rt.ops.current().watchers[0]).toMatchObject({ status: 'done', outcome: 'Woke the run in a fresh context' })
    expect(rt.run?.sessions.at(-2)?.endNote).toBe('fresh wake (W-1)')
  })

  test('a fresh wake whose resume state is not healthy asks instead of clearing', async () => {
    const f = await started(undefined, { host: { handoffSize: () => 50 } })
    const { rt, kept, advance } = f
    milestones(rt, [['Read the S-002 result', 'waiting']])
    rt.ops.armFrom('S-002 result', 'in 1h', 'fresh')
    await advance(HOUR + MIN)
    expect(kept.commands).toEqual([])
    expect(kept.submitted).toEqual([])
    expect(rt.ops.current().watchers[0]).toMatchObject({ status: 'due', needs: 'A fresh wake is not safe now: The handoff notes are nearly empty (NEXT_SESSION_PROMPT.md).' })
    expect(hud(rt).alert).toMatchObject({ kind: 'watcher', canFresh: false })
  })

  test('the cache went cold before a warm wake: it does not silently re-read it all; Smart uses a healthy fresh resume', async () => {
    // Keep warm off and the 5-minute cache: by the wake, the 300k context has lapsed.
    const f = await started(undefined, { tokens: 300_000, memory: FIVE_MINUTES })
    const { rt, kept, advance } = f
    await turn(f, 'Build it.', { prompt: 300_000 })
    f.live.forkRead = 0
    rt.ops.armFrom('the build', 'in 1h', 'warm')
    await advance(HOUR + MIN)
    expect(kept.forks.length).toBeGreaterThanOrEqual(2)
    expect(rt.cache.state.keepWarm.verified).toBe('no')
    expect(kept.submitted).toEqual([])
    expect(kept.commands).toEqual([])
    expect(rt.ops.current().watchers[0]!.needs).toMatch(/^The cache went cold before the wake \(idle .+; Keep warm paused itself \(.+\)\): waking here re-reads 300k tokens\.$/)
    // Smart, with healthy resume state: a fresh resume instead.
    const g = await started(undefined, { tokens: 300_000, memory: FIVE_MINUTES })
    milestones(g.rt, [['Build it', 'in_progress']])
    await g.rt.ops.refreshNotes(true)
    await turn(g, 'Build it.', { prompt: 300_000 })
    clears(g)
    g.live.forkRead = 0
    g.rt.ops.armAt('the build', { kind: 'at', at: g.now() + 30 * MIN, words: '' }, 'smart')
    // Smart chose a short hold of the 5-minute cache; Keep warm then fails to hold it.
    expect(g.rt.ops.current().watchers[0]!.decided).toMatchObject({ mode: 'warm', hold: true })
    await g.advance(31 * MIN)
    expect(g.kept.commands).toEqual(['clear'])
    expect(g.kept.submitted.at(-1)).toStartWith('Project Sentinel fresh resume (session 2): watcher W-1 woke the run, parked waiting for the build.')
    expect(g.rt.ops.current().watchers[0]!.decided?.reason).toContain('Keep warm could not hold this cache')
    // The API refuses the hold's refresh (seen live, a test proxy's 400): the cause is that, not "Keep warm was off".
    const h = await started(undefined, { tokens: 300_000, memory: FIVE_MINUTES })
    await turn(h, 'Build it.', { prompt: 300_000 })
    h.live.forkRefusal = 'unknown'
    h.rt.ops.armFrom('the build', 'in 9m', 'warm')
    await h.advance(10 * MIN)
    expect(h.kept.submitted).toEqual([])
    expect(h.rt.ops.current().watchers[0]).toMatchObject({ status: 'due' })
    const needs = h.rt.ops.current().watchers[0]!.needs ?? ''
    expect(needs).toStartWith('The cache went cold before the wake (idle 9m')
    expect(needs).toEndWith("; Keep warm's refresh failed (The API refused the refresh)): waking here re-reads 300k tokens.")
  })

  test('overdue after a reload: it waits for the person, said in words; Wake now wakes it', async () => {
    let f = await started()
    f.rt.ops.armFrom('S-002 result', 'in 1h', 'warm')
    // The process was not there at its time (a reload cancels the timers; the machine slept).
    f.rt.ops.stop()
    f.rt.cache.stop()
    await f.advance(HOUR + 43 * MIN)
    f = await reloaded(f)
    expect(f.kept.submitted).toEqual([])
    expect(f.rt.ops.current().watchers[0]).toMatchObject({ status: 'due', needs: 'Watcher was due 43 minutes ago.' })
    expect(hud(f.rt).alert).toMatchObject({ kind: 'watcher', text: 'Watcher due: S-002 result · Watcher was due 43 minutes ago.' })
    await f.rt.ops.wakeNow('W-1')
    await f.advance(10)
    expect(f.kept.submitted[0]).toStartWith('Project Sentinel watcher wake (W-1)')
    expect(f.kept.submitted[0]).toContain('It was due 43m')
  })

  test('closed Claude Code: nothing wakes; the run’s watchers are kept, and the session resumed shows them overdue', async () => {
    const f = await started()
    f.rt.ops.armFrom('the overnight run', 'in 2h', 'smart')
    await f.rt.onSessionEnd({ reason: 'prompt_input_exit' } as never)
    expect(f.rt.run?.status).toBe('ended')
    // Hours later, a new process resumes the session: the same store, a later clock.
    const g = await started(undefined, { store: f.kept.store, at: f.now() + 5 * HOUR })
    expect(g.kept.submitted).toEqual([])
    expect(g.rt.ops.current().watchers[0]).toMatchObject({ id: 'W-1', status: 'due' })
    expect(g.rt.ops.current().watchers[0]!.needs).toMatch(/^Watcher was due \d hours ago\.$/)
  })

  test('a watcher armed just after a turn is in the store at once, and a pending older copy of the run never puts it back', async () => {
    const f = await started()
    await turn(f, 'Submit S-002.')
    // The turn's end scheduled a later write of the run; the watcher's write goes now and supersedes it.
    f.rt.ops.armFrom('S-002 result', 'in 2h', 'warm')
    await f.advance(30_000)
    const stored = Object.entries(f.kept.store).find(([k]) => k.startsWith('run.v1.'))?.[1] as { ops?: { watchers?: unknown[] } } | undefined
    expect(stored?.ops?.watchers).toHaveLength(1)
  })

  test('pause, edit, reschedule and delete', async () => {
    const { rt, kept, advance } = await started()
    rt.ops.armFrom('A', 'in 1h', 'warm')
    rt.ops.pause('W-1')
    await advance(HOUR + MIN)
    expect(kept.submitted).toEqual([])
    rt.ops.resume('W-1')
    expect(rt.ops.current().watchers[0]).toMatchObject({ status: 'due' })
    expect(rt.ops.current().watchers[0]!.needs).toContain('while paused')
    expect(rt.ops.reschedule('W-1', 'in 30m')).toMatchObject({ ok: true })
    expect(rt.ops.current().watchers[0]).toMatchObject({ status: 'armed', needs: null })
    rt.ops.setStrategy('W-1', 'fresh')
    expect(view(rt).watchers[0]!.decided).toMatchObject({ mode: 'fresh' })
    rt.ops.dismiss('W-1')
    expect(rt.ops.current().watchers[0]).toMatchObject({ status: 'dismissed', outcome: 'Dismissed' })
    await advance(HOUR)
    expect(kept.submitted).toEqual([])
    expect(hud(rt).ops).toBeNull()
  })

  test('watchers are offered only while on; Claude Code’s own wake-ups show beside them, read only', async () => {
    const off = await started(s => void (s.ops.watchers = false))
    expect(off.rt.ops.armFrom('x', 'in 1h', 'smart')).toEqual({ ok: false, error: 'Watchers are off (Activity → Operations → Watchers).' })
    const f = await started()
    await f.rt.onStop({ stopHookActive: false, lastMessage: 'Scheduled.', background: [], wakeups: [{ schedule: '*/30 * * * *', recurring: true }], permissionMode: undefined })
    expect(view(f.rt).externalWakes).toEqual([expect.objectContaining({ schedule: '*/30 * * * *', isRecurring: true })])
  })

  test('the Scout suggests a watcher when Claude says when it will check; never arms by itself on Suggest; arms on Auto', async () => {
    const f = await started()
    const { rt, kept } = f
    await turn(f, 'Submit the eval.', { message: 'Submitted S-002. I will check the leaderboard again in two hours.' })
    expect(rt.ops.suggestion).toMatchObject({ label: 'Check the leaderboard again', isExplicit: true })
    expect(rt.ops.current().watchers).toEqual([])
    expect(hud(rt).alert).toMatchObject({ kind: 'suggest', hasTime: true })
    expect(hud(rt).alert?.text).toBe('Claude seems to be waiting for a future result. Check the leaderboard again in two hours?')
    expect(view(rt).suggestion).toMatchObject({ label: 'Check the leaderboard again', question: 'Check the leaderboard again in two hours?', isExplicit: true })
    expect(rt.ops.takeSuggestion()).toMatchObject({ ok: true })
    expect(rt.ops.current().watchers[0]).toMatchObject({ source: 'scout', label: 'Check the leaderboard again' })
    void kept
    const auto = await started(s => void (s.ops.scout = 'auto'))
    await turn(auto, 'Submit.', { message: 'Done. I will re-run the eval at 23:59.' })
    expect(auto.rt.ops.current().watchers[0]).toMatchObject({ source: 'scout' })
    expect(auto.kept.toasts.at(-1)).toContain('Watcher armed:')
    const off = await started(s => void (s.ops.scout = 'off'))
    await turn(off, 'Submit.', { message: 'I will check the leaderboard again in two hours.' })
    expect(off.rt.ops.suggestion).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Cold Resume Guard

/** A session whose 300k-token context has been idle past its 5-minute cache. */
async function coldSession(patch: (s: Settings) => void = () => undefined, host: Parameters<typeof fakeHost>[0] = {}): Promise<Started> {
  const f = await started(patch, { tokens: 300_000, memory: FIVE_MINUTES, host })
  await turn(f, 'Build it.', { prompt: 300_000 })
  await f.advance(20 * MIN)
  return f
}

const person = (text: string) => ({ text, origin: { kind: 'composer' as const } })

describe('Cold Resume Guard', () => {
  test('a small context is never asked about', async () => {
    const f = await started(undefined, { tokens: 50_000, memory: FIVE_MINUTES })
    await turn(f, 'Build it.', { prompt: 50_000 })
    await f.advance(20 * MIN)
    expect(await f.rt.ops.coldGuard(person('Carry on.'))).toBeNull()
    expect(f.kept.asked).toEqual([])
  })

  test('a warm cache is never called cold', async () => {
    const f = await started(undefined, { tokens: 300_000, memory: ONE_HOUR })
    await turn(f, 'Build it.', { prompt: 300_000 })
    await f.advance(20 * MIN)
    expect(await f.rt.ops.coldGuard(person('Carry on.'))).toBeNull()
    expect(f.kept.asked).toEqual([])
  })

  test('a large context whose cache surely lapsed: asked first, with why, in tokens when no price is known', async () => {
    const f = await coldSession()
    f.live.answer = COLD.continue
    expect(await f.rt.ops.coldGuard(person('Carry on.'))).toBeNull()
    const q = f.kept.asked[0]!
    expect(q.header).toBe('Cache cold')
    expect(q.question).toStartWith("300k tokens need to be reprocessed: the prompt cache expired, and continuing sends this session's earlier context again before the cache is warm. Why:")
    expect(q.question).toContain('Why: idle 20m 0s; Keep warm was off.')
    expect(q.question).not.toContain('$')
    expect(q.options).toEqual([COLD.continue, COLD.compact, COLD.cancel])
    expect(f.rt.ops.coldLast).toMatchObject({ choice: COLD.continue })
    expect(view(f.rt).cold).toMatchObject({ isOn: true, threshold: 100_000, isArmed: true, tokens: 300_000, usd: null })
  })

  test('Claude Code’s own request while the conversation idles (its away summary, seen live) keeps the cache warm: not called cold until that lapses too', async () => {
    const f = await started(undefined, { tokens: 300_000, memory: FIVE_MINUTES })
    await turn(f, 'Build it.', { prompt: 300_000 })
    await f.advance(3 * MIN)
    // The session's cost grows with no turn running: Claude Code read this conversation's cache for a request of its own.
    f.rt.onMeasure({ context: f.live.usage.context, cost: { usd: 0.6 }, changed: ['cost'] })
    await f.advance(3 * MIN)
    f.live.answer = COLD.continue
    expect(await f.rt.ops.coldGuard(person('Carry on.'))).toBeNull()
    expect(f.kept.asked).toEqual([])
    expect(view(f.rt).cold.isArmed).toBe(false)
    // Five minutes after that request too, it has surely lapsed.
    await f.advance(3 * MIN)
    await f.rt.ops.coldGuard(person('Carry on.'))
    expect(f.kept.asked).toHaveLength(1)
    // A measurement during a turn is the turn's own.
    const g = await started(undefined, { tokens: 300_000, memory: FIVE_MINUTES })
    await turn(g, 'Build it.', { prompt: 300_000, during: () => g.rt.onMeasure({ context: g.live.usage.context, cost: { usd: 0.6 }, changed: ['cost'] }) })
    await g.advance(6 * MIN)
    g.live.answer = COLD.continue
    await g.rt.ops.coldGuard(person('Carry on.'))
    expect(g.kept.asked).toHaveLength(1)
    // A resumed session whose cache Claude Code said had expired: its own request since re-cached it.
    const h = await started(undefined, { tokens: 616_000 })
    await h.rt.onClassicSessionStart({ source: 'resume', sessionId: 'S1', model: OPUS, secondsSince: 3 * 3600, contextTokens: 616_000, isCacheExpired: true, usd: 4.62 })
    await h.advance(4 * MIN)
    h.rt.onMeasure({ context: h.live.usage.context, cost: { usd: 1.2 }, changed: ['cost'] })
    h.live.answer = COLD.continue
    expect(await h.rt.ops.coldGuard(person('Where were we?'))).toBeNull()
    expect(h.kept.asked).toEqual([])
  })

  test('a dollar figure only from Claude Code’s own price for this model', async () => {
    const f = await coldSession()
    f.rt.cache.noteWriteRate({ model: OPUS, ttl: '5m', usd: 4, tokens: 1_000_000, pricing: 'catalog' })
    f.live.answer = COLD.continue
    await f.rt.ops.coldGuard(person('Carry on.'))
    // An estimate, and a floor: never a figure that reads as exact.
    expect(f.kept.asked[0]!.question).toContain("At Claude Code's cache-write price for opus-5-5 (list price")
    expect(f.kept.asked[0]!.question).toContain('that is at least ~$1.20.')
    expect(view(f.rt).cold).toMatchObject({ usd: 1.2 })
    // A default-tier estimate is no price.
    const g = await coldSession()
    g.rt.cache.noteWriteRate({ model: OPUS, ttl: '5m', usd: 4, tokens: 1_000_000, pricing: 'default' })
    g.live.answer = COLD.continue
    await g.rt.ops.coldGuard(person('Carry on.'))
    expect(g.kept.asked[0]!.question).not.toContain('$')
  })

  test('the threshold is the person’s, and the guard can be turned off', async () => {
    const f = await coldSession(s => void (s.cache.coldResumeTokens = 400_000))
    expect(await f.rt.ops.coldGuard(person('Carry on.'))).toBeNull()
    expect(f.kept.asked).toEqual([])
    const off = await coldSession(s => void (s.cache.coldResume = false))
    expect(await off.rt.ops.coldGuard(person('Carry on.'))).toBeNull()
    expect(off.kept.asked).toEqual([])
  })

  test('Cancel sends nothing and puts the message back in the prompt box; dismissing the dialog does the same', async () => {
    const f = await coldSession()
    f.live.answer = COLD.cancel
    expect(await f.rt.ops.coldGuard(person('Fix the parser bug.'))).toEqual({ drop: 'Not sent. Your message is back in the prompt box.' })
    await f.advance(500)
    expect(f.kept.filled).toEqual(['Fix the parser bug.'])
    f.live.answer = null
    expect(await f.rt.ops.coldGuard({ ...person('Second try.'), attachments: [{}] })).toEqual({ drop: 'Not sent. Your message is back in the prompt box (attachments were not kept).' })
    await f.advance(500)
    expect(f.kept.filled).toEqual(['Fix the parser bug.', 'Second try.'])
    expect(f.kept.submitted).toEqual([])
    expect(f.kept.traces.filter(t => t.startsWith('cold resume: ') && !t.includes('asking'))).toEqual([
      'cold resume: cancelled; nothing sent, the message goes back to the prompt box',
      'cold resume: the question was dismissed; nothing sent, the message goes back to the prompt box',
    ])
  })

  test('where the prompt box cannot take it back, the message is kept in Operations: Put back, Send now, Discard', async () => {
    const f = await coldSession()
    f.live.isPromptBox = false
    f.live.answer = COLD.cancel
    await f.rt.ops.coldGuard(person('Fix the parser bug.'))
    await f.advance(500)
    expect(view(f.rt).held).toMatchObject({ text: 'Fix the parser bug.', hasAttachments: false })
    expect(hud(f.rt).alert).toMatchObject({ kind: 'held' })
    expect(hud(f.rt).ops?.review).toBe(1)
    f.rt.ops.heldSend()
    await f.advance(10)
    expect(f.kept.submittedAsUser).toEqual(['Fix the parser bug.'])
    expect(view(f.rt).held).toBeNull()
  })

  test('Start fresh: offered only with healthy resume state; the message goes to the fresh context', async () => {
    const f = await coldSession()
    milestones(f.rt, [['Build it', 'in_progress']])
    await f.rt.ops.refreshNotes(true)
    clears(f)
    f.live.answer = COLD.fresh
    const held = await f.rt.ops.coldGuard(person('Fix the parser bug.'))
    expect(f.kept.asked[0]!.options).toEqual([COLD.continue, COLD.fresh, COLD.compact, COLD.cancel])
    expect(f.kept.asked[0]!.question).toContain("Start fresh: Claude restores run 1's 1 milestones")
    expect(held).toEqual({ drop: 'Starting fresh from the resume state: your message goes to the fresh context.' })
    // Claude Code puts a dropped prompt's text back in the box (seen live): one Enter would send it twice.
    f.live.box = 'Fix the parser bug.'
    await f.advance(1000)
    expect(f.live.box).toBe('')
    expect(f.kept.traces).toContain('cold resume: cleared the copy Claude Code put back in the prompt box; the message goes to the fresh context')
    expect(f.kept.commands).toEqual(['clear'])
    const first = f.kept.submitted.at(-1) ?? ''
    expect(first).toStartWith('Project Sentinel fresh resume (session 2): the user chose to start fresh instead of re-reading 300k tokens')
    expect(first).toContain('Fix the parser bug.')
    expect(f.rt.takeFreshContext()).toContain('to start fresh instead of re-reading a context whose prompt cache had expired')
  })

  test('with unhealthy resume state, Start fresh is not offered, and the question says why', async () => {
    const f = await coldSession(undefined, { handoffMtime: () => null })
    f.live.answer = COLD.continue
    await f.rt.ops.coldGuard(person('Carry on.'))
    expect(f.kept.asked[0]!.options).toEqual([COLD.continue, COLD.compact, COLD.cancel])
    expect(f.kept.asked[0]!.question).toContain('A fresh start is not offered: No run state')
  })

  test('Compact first: compaction reads it once, then the message goes as the person’s own', async () => {
    const f = await coldSession()
    f.live.answer = COLD.compact
    expect(await f.rt.ops.coldGuard(person('Fix the parser bug.'))).toEqual({ drop: 'Compacting first (it reads the conversation once now): your message is sent after.' })
    f.live.box = 'Fix the parser bug.'
    // Not asked from inside the prompt's own dispatch (Claude Code refuses it there): once it is dropped.
    expect(f.kept.compacted).toBe(0)
    expect(f.rt.ops.isFree()).toBe(false)
    // Claude Code does not run Project Sentinel's own session.compact hook for a compaction it asked for
    // ("skipped: re-entry", seen live: the message waited for a compaction it never heard of): its result says so.
    await f.advance(2000)
    expect(f.kept.compacted).toBe(1)
    expect(f.kept.submittedAsUser).toEqual(['Fix the parser bug.'])
    expect(f.rt.ops.isFree()).toBe(true)
    // Sent once: the copy Claude Code put back in the box was cleared before it.
    expect(f.live.box).toBe('')
    // Recorded as a compaction, and the cache's next rebuild is put down to it (a lifecycle cost).
    expect(f.rt.run?.sessions.at(-1)?.transitions.at(-1)).toMatchObject({ kind: 'compact', tokensBefore: 900_000, tokensAfter: 40_000 })
    expect(f.rt.cache.state.pending.map(p => p.cause)).toContain('compact')
    expect(f.kept.traces).toContain('cold resume: compacted (900k → 40k tokens)')
  })

  test('Compact first while Claude Code still counts the dropped prompt as a turn: asked again; any other refusal gives up and says why', async () => {
    const f = await coldSession()
    f.live.answer = COLD.compact
    f.live.compactRefusals = ['$.session.compact: a turn is running']
    await f.rt.ops.coldGuard(person('Fix the parser bug.'))
    await f.advance(5000)
    expect(f.kept.compacted).toBe(1)
    expect(f.kept.traces).toContain('cold resume: the compaction was refused ($.session.compact: a turn is running); trying again')
    expect(f.kept.submittedAsUser).toEqual(['Fix the parser bug.'])
    // A refusal that is not about a turn: no compaction, the message back in the box, the reason in the trace.
    const g = await coldSession()
    g.live.answer = COLD.compact
    g.live.compactRefusals = ['compaction is disabled by policy']
    await g.rt.ops.coldGuard(person('Fix the parser bug.'))
    await g.advance(5000)
    expect(g.kept.compacted).toBe(0)
    expect(g.kept.traces).toContain('cold resume: the compaction did not run (compaction is disabled by policy); the message goes back to the prompt box')
    expect(g.live.box).toBe('Fix the parser bug.')
    expect(g.kept.submittedAsUser).toEqual([])
    expect(g.rt.ops.isFree()).toBe(true)
  })

  test('the copy cleared after Start fresh or Compact first is only ever that message: a draft the person typed since stays', async () => {
    const f = await coldSession()
    f.live.answer = COLD.compact
    await f.rt.ops.coldGuard(person('Fix the parser bug.'))
    f.live.box = 'Fix the parser bug. And the lexer'
    await f.advance(1000)
    expect(f.live.box).toBe('Fix the parser bug. And the lexer')
    expect(f.kept.filled).toEqual([])
    // Cancel still puts the message back.
    const g = await coldSession()
    g.live.answer = COLD.cancel
    await g.rt.ops.coldGuard(person('Fix the parser bug.'))
    await g.advance(1000)
    expect(g.live.box).toBe('Fix the parser bug.')
  })

  test('Claude Code configured for the five-minute cache (FORCE_PROMPT_CACHING_5M, seen live): the plan’s hour is not assumed, and the guard asks after five idle minutes', async () => {
    const f = await started(undefined, { tokens: 300_000, host: { ttlConfig: { force5m: '1' } } })
    f.live.usage = { ...f.live.usage, rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-08T15:00:00Z' }] }
    await turn(f, 'Build it.', { prompt: 300_000 })
    expect(f.rt.cache.state.ttl).toEqual({ value: '5m', source: 'config' })
    await f.advance(6 * MIN)
    f.live.answer = COLD.continue
    expect(await f.rt.ops.coldGuard(person('Carry on.'))).toBeNull()
    expect(f.kept.asked[0]!.question).toContain('Why: idle 6m')
    // Read again each session, never remembered as learned.
    expect((f.kept.store['cache.v1'] as { ttl?: string } | undefined)?.ttl ?? null).toBeNull()
    // The promptCacheTtl setting, and the plan's default where nothing is configured.
    const g = await started(undefined, { tokens: 300_000, host: { ttlConfig: { setting: '1h' } } })
    expect(g.rt.cache.state.ttl).toEqual({ value: '1h', source: 'config' })
    const h = await started(undefined, { tokens: 300_000, host: { ttlConfig: { setting: '5m', enable1h: 'true' } } })
    expect(h.rt.cache.state.ttl).toEqual({ value: '5m', source: 'config' })
  })

  test('never for a prompt typed while Claude works, nor for Project Sentinel’s own prompts, nor where no one can be asked', async () => {
    const f = await coldSession()
    expect(await f.rt.ops.coldGuard({ ...person('mid-turn'), turnId: 't9' })).toBeNull()
    expect(await f.rt.ops.coldGuard({ text: 'Mission Queue · Q-1, queued by the user at 10:00 for next safe boundary.' })).toBeNull()
    f.rt.surfaces = []
    expect(await f.rt.ops.coldGuard(person('headless'))).toBeNull()
    expect(f.kept.asked).toEqual([])
  })

  test('a resumed session: Claude Code’s own word on the cache and its estimate', async () => {
    const f = await started(undefined, { tokens: 616_000 })
    await f.rt.onClassicSessionStart({ source: 'resume', sessionId: 'S1', model: OPUS, secondsSince: 3 * 3600, contextTokens: 616_000, isCacheExpired: true, usd: 4.62 })
    f.live.answer = COLD.continue
    await f.rt.ops.coldGuard(person('Where were we?'))
    const q = f.kept.asked[0]!.question
    expect(q).toStartWith('616k tokens need to be reprocessed')
    expect(q).toContain('Claude Code currently estimates at least ~$4.62.')
    expect(q).toContain('its last answer was 3 hours ago, longer than the cache lasts')
  })
})

// ---------------------------------------------------------------------------
// Agents

describe('Agent Command Center', () => {
  test('none: nothing shows; spawned and running: the row, the chip, the controls Claude Code accepts', async () => {
    const { rt, kept, live } = await started()
    expect(view(rt).agents).toEqual([])
    expect(hud(rt).ops).toBeNull()
    rt.ops.noteSpawn({ agentId: 'a1', model: 'claude-sonnet-5-5', isBackground: true, isFork: false, description: 'Explore the cache code', type: 'Explore', name: null, parentId: null })
    live.agents = [{ id: 'a1', type: 'Explore', description: 'Explore the cache code', status: 'running' }]
    await rt.refreshAgents()
    expect(view(rt).agents[0]).toMatchObject({ id: 'a1', status: 'running', model: 'claude-sonnet-5-5', isBackground: true, canStop: true, canMessage: true })
    expect(hud(rt).ops?.agents).toBe(1)
    // The chip opens Activity → Agents, the agents' own view.
    expect(hud(rt).chips.find(c => c.key === 'agents')).toMatchObject({ opens: 'agents' })
    await rt.ops.stopAgent('a1')
    expect(kept.stopped).toEqual(['a1'])
    expect(rt.ops.current().log[0]!.text).toBe('Stopped agent a1')
    await rt.ops.messageAgent('a1', 'Stop after this file')
    expect(kept.sentToAgents).toEqual([{ agentId: 'a1', text: 'Stop after this file' }])
  })

  test('/cr agents opens Activity → Agents, their own view; /cr decisions opens Operations at its card (seen live: a card off-screen below the watcher form)', async () => {
    const f = await started()
    const { rt, kept, advance } = f
    await rt.runCommand('agents')
    await advance(500)
    expect(rt.ui).toMatchObject({ tab: 'activity', activitySub: 'agents' })
    expect(kept.scrolledTo).toEqual([])
    await rt.runCommand('decisions')
    await advance(500)
    // By the key the card is drawn under (seen live: the card's own name found nothing, and the panel stayed at its top).
    expect(rt.ui).toMatchObject({ tab: 'activity', activitySub: 'ops' })
    expect(kept.scrolledTo).toEqual(['card-ops-review'])
  })

  test('a panel that has not drawn the card yet: the scroll is tried again a little later, the refusal traced; never past three tries, nor once the person moved it', async () => {
    const f = await started()
    const { rt, kept, live, advance } = f
    live.paneRefusals = ['no element keyed card-ops-watchers in control-room']
    await rt.runCommand('watchers')
    await advance(350)
    expect(kept.scrolledTo).toEqual([])
    expect(kept.traces).toContain('ops: scroll to card-ops-watchers refused (try 1): no element keyed card-ops-watchers in control-room')
    await advance(650)
    expect(kept.scrolledTo).toEqual(['card-ops-watchers'])
    // Refused every time: three tries, then it stays where it is.
    kept.traces.length = 0
    live.paneRefusals = ['not drawn', 'not drawn', 'not drawn', 'not drawn']
    await rt.runCommand('decisions')
    await advance(5000)
    expect(kept.traces.filter(t => t.startsWith('ops: scroll to card-ops-review'))).toHaveLength(3)
    expect(live.paneRefusals).toEqual(['not drawn'])
    // The person scrolled meanwhile: theirs stands.
    kept.traces.length = 0
    live.paneRefusals = ['the window moved meanwhile', 'not drawn']
    await rt.runCommand('watchers')
    await advance(5000)
    expect(kept.traces.filter(t => t.startsWith('ops: scroll'))).toEqual(['ops: scroll to card-ops-watchers refused (try 1): the window moved meanwhile'])
    expect(kept.scrolledTo).toEqual(['card-ops-watchers'])
  })

  test('/cr queue and /cr watch alone focus their field, handing the open panel the keyboard first (seen live: the prompt box kept it, and the focus was refused)', async () => {
    const { rt, kept, live, advance } = await started()
    // The panel not open: it opens with the keyboard, and the field takes the focus.
    await rt.runCommand('queue')
    await advance(1000)
    expect(kept.opens).toEqual([{ id: 'control-room', isFocus: true }])
    expect(kept.focused).toEqual(['ops-queue-input'])
    // Open already, the prompt box holding the keys: opened again with the keyboard, then focused.
    live.isPaneOpen = true
    await rt.runCommand('watch')
    await advance(1000)
    expect(kept.opens).toEqual([
      { id: 'control-room', isFocus: true },
      { id: 'control-room', isFocus: true },
    ])
    expect(kept.focused).toEqual(['ops-queue-input', 'ops-watch-label'])
    // Claude Code waits for a field not drawn yet itself: a refusal is traced, not tried again.
    live.paneRefusals = ['that site does not hold the keyboard']
    await rt.runCommand('queue')
    await advance(3000)
    expect(kept.traces.filter(t => t.startsWith('ops: focus'))).toEqual(['ops: focus ops-queue-input refused (try 1): that site does not hold the keyboard'])
    expect(kept.focused).toEqual(['ops-queue-input', 'ops-watch-label'])
    // A chip with the panel open moves nothing of the keyboard: no open, only the scroll.
    await rt.runCommand('decisions')
    await advance(1000)
    expect(kept.opens).toHaveLength(3)
    expect(kept.scrolledTo).toEqual(['card-ops-review'])
  })

  test('completed and failed: the answer’s first line, or why it ended; Claude Code’s refusal is shown as it words it', async () => {
    const { rt, kept, live } = await started()
    rt.ops.noteSpawn({ agentId: 'a1', model: null, isBackground: true, isFork: false, description: 'Find it', type: 'Explore', name: null, parentId: null })
    rt.ops.noteSpawn({ agentId: 'a2', model: null, isBackground: true, isFork: false, description: 'Break it', type: 'general-purpose', name: null, parentId: null })
    await rt.onTurnComplete({ agentId: 'a1', reason: 'answer', answer: 'Found 3 call sites.\nDetails...' })
    await rt.onTurnComplete({ agentId: 'a2', reason: 'error', answer: '' })
    live.agents = [
      { id: 'a1', type: 'Explore', description: 'Find it', status: 'completed' },
      { id: 'a2', type: 'general-purpose', description: 'Break it', status: 'failed' },
    ]
    await rt.refreshAgents()
    expect(view(rt).agents.map(a => [a.id, a.result, a.isFailed, a.canStop]).sort()).toEqual([
      ['a1', 'Found 3 call sites.', false, false],
      ['a2', 'Ended with an error', true, false],
    ])
    live.stopResult = { deny: 'No task a1 is running.' }
    await rt.ops.stopAgent('a1')
    expect(kept.toasts.at(-1)).toBe('Could not stop the agent: No task a1 is running.')
  })

  test('a reload keeps what the session saw of its agents: a running background agent keeps Stop and Message, its time and model (seen live: they were lost)', async () => {
    const f = await started()
    const { kept, live, advance } = f
    f.rt.ops.noteSpawn({ agentId: 'g1', model: 'claude-sonnet-5-5', isBackground: true, isFork: false, description: 'gamma sleeper', type: 'general-purpose', name: null, parentId: null })
    // Claude Code 2.1.295 lists a background agent with no name (seen live), so only the spawn says it takes TaskStop.
    live.agents = [{ id: 'g1', type: 'general-purpose', description: 'gamma sleeper', status: 'running' }]
    await advance(30_000)
    const g = await reloaded(f)
    await g.rt.refreshAgents()
    expect(view(g.rt).agents[0]).toMatchObject({ id: 'g1', status: 'running', model: 'claude-sonnet-5-5', isBackground: true, canStop: true, canMessage: true })
    expect(view(g.rt).agents[0]!.startedAt).not.toBeNull()
    expect(kept.traces).toContain('ops: 1 agent carried across the reload')
    // Claude Code tells the main conversation a plugin's TaskStop as "stopped by Claude" (seen live): Claude hears it was the user.
    await g.rt.ops.messageAgent('g1', 'Codeword PINEAPPLE')
    await g.rt.ops.stopAgent('g1')
    const note = g.rt.notesForBatch().find(n => n.startsWith('Project Sentinel · From the Agents panel'))
    expect(note).toBe(`Project Sentinel · From the Agents panel, the user sent the agent "gamma sleeper" (g1) this message: "Codeword PINEAPPLE"; then the user stopped the agent "gamma sleeper" (g1). These were the user's actions, not yours.`)
    // Told once.
    expect(g.rt.notesForBatch().some(n => n.includes('Agents panel'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Run Budget

describe('Run Budget', () => {
  test('off by default: no chip, no row in the status bar', async () => {
    const { rt } = await started()
    expect(rt.ops.current().budget).toBeNull()
    expect(hud(rt).chips.some(c => c.key === 'budget')).toBe(false)
    expect(view(rt).budget).toMatchObject({ isSet: false, state: 'off' })
  })

  test('said once near a limit, once at it; at Ask, automation waits for the person at the next boundary', async () => {
    const f = await started()
    const { rt, kept, live, advance } = f
    rt.ops.setBudget({ costUsd: 30 })
    live.usage = { ...live.usage, cost: { usd: 25 } }
    await turn(f, 'Work.')
    expect(kept.toasts.filter(t => t.startsWith('Run budget near'))).toEqual(['Run budget near: Cost $25.00 of $30'])
    expect(hud(rt).chips.find(c => c.key === 'budget')).toMatchObject({ text: 'Cost $25.00 of $30', tone: 'warn', opens: 'ops' })
    live.usage = { ...live.usage, cost: { usd: 31 } }
    await turn(f, 'More work.', { during: () => void rt.ops.queueAdd('Then this', 'turn') })
    await advance(800)
    expect(kept.toasts.filter(t => t.startsWith('Run budget reached'))).toHaveLength(1)
    expect(kept.submitted).toEqual([])
    expect(rt.ops.budgetHeld).toBe('queued work')
    expect(hud(rt).alert).toMatchObject({ kind: 'budget', text: 'Run budget reached: queued work waits for you' })
    // Never "goes now" while it waits (seen live: /cr queue answered "Due: goes now." at the limit).
    expect(view(rt).queue[0]?.when).toBe('Waits for you: the run budget is reached (Continue the run, or /cr budget continue)')
    expect(rt.ops.queueAdd('And this', 'turn')).toMatchObject({ ok: true, when: 'Waits for you: the run budget is reached (Continue the run, or /cr budget continue)' })
    expect(budgetText(view(rt))).toContain('Reached: Cost $31.00 of $30. Queued work waits for you: /cr budget continue')
    expect(budgetText(view(rt))).toContain('Cost $31.00 of $30\n')
    rt.ops.approveBudget()
    await advance(800)
    expect(kept.submitted[0]).toContain('Then this')
  })

  test('a cost limit crossed mid-turn is seen as Claude works, not only when Claude Code measures the session after the turn (seen live)', async () => {
    const f = await started()
    const { rt, live, advance } = f
    rt.ops.setBudget({ costUsd: 10, atLimit: 'finish' })
    await rt.onTurnStart({ turnId: 'tb', text: 'Work through the milestones.' })
    const step = (index: number) => {
      const e = { turnId: 'tb', index, model: OPUS, messageCount: 3 + index }
      const sent = rt.stepRequest(e)
      rt.stepResponse(e, sent, { turnId: 'tb', index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 500, model: OPUS } })
    }
    step(0)
    await flush()
    expect(rt.notesForBatch()).toEqual([])
    // The session's cost grows past the limit; Claude Code raises no measurement until the turn ends.
    live.usage = { ...live.usage, cost: { usd: 12 } }
    await advance(6000)
    step(1)
    await flush()
    expect(rt.notesForBatch().some(n => n.startsWith('Project Sentinel · Run budget reached (Cost $12.00 of $10). Finish the milestone you are on'))).toBe(true)
    expect(rt.turn.isRunning).toBe(true)
  })

  test('Finish the milestone, then pause: Claude is told with its next tool results; nothing stops a tool call or the turn', async () => {
    const f = await started()
    const { rt, live } = f
    rt.ops.setBudget({ costUsd: 10, atLimit: 'finish' })
    await turn(f, 'Work.', {
      during: () => {
        rt.onMeasure({ context: live.usage.context, cost: { usd: 12 } })
        rt.ops.checkBudget()
        const batch = rt.notesForBatch()
        expect(batch.some(n => n.startsWith('Project Sentinel · Run budget reached (Cost $12.00 of $10). Finish the milestone you are on'))).toBe(true)
        expect(rt.turn.isRunning).toBe(true)
      },
    })
    expect(rt.turn.isRunning).toBe(false)
  })

  test('at Ask, the person’s next message asks once: Not now keeps the message; Continue lets the run go on', async () => {
    const f = await started()
    const { rt, kept, live } = f
    rt.ops.setBudget({ handoffs: 1 })
    rt.run = { ...rt.run!, sessions: rt.run!.sessions.map(s => ({ ...s, end: 'handoff' as const })) }
    live.answer = 'Not now'
    expect(await rt.ops.budgetGuard(person('Keep going.'))).toMatchObject({ drop: expect.stringContaining('the run budget is reached') })
    await f.advance(500)
    expect(kept.filled).toEqual(['Keep going.'])
    expect(kept.asked[0]).toMatchObject({ header: 'Budget', options: ['Continue the run', 'Not now'] })
    live.answer = 'Continue the run'
    expect(await rt.ops.budgetGuard(person('Keep going.'))).toBeNull()
    expect(await rt.ops.budgetGuard(person('And more.'))).toBeNull()
    expect(kept.asked).toHaveLength(2)
  })

  test('a cost limit reads as money (seen live: "Cost $1.43 of $1.2")', async () => {
    const { rt } = await started()
    rt.ops.setBudget({ costUsd: 1.2 })
    expect(budgetText(view(rt))).toContain(' of $1.20')
    rt.ops.setBudget({ costUsd: 30 })
    expect(budgetText(view(rt))).toContain(' of $30')
  })

  test('Notify only: a toast, and nothing else changes', async () => {
    const f = await started()
    const { rt, kept, live, advance } = f
    rt.ops.setBudget({ costUsd: 1, atLimit: 'notify' })
    live.usage = { ...live.usage, cost: { usd: 2 } }
    await turn(f, 'Work.', { during: () => void rt.ops.queueAdd('Then this', 'turn') })
    await advance(800)
    expect(kept.toasts.some(t => t.startsWith('Run budget reached: Cost $2.00 of $1'))).toBe(true)
    expect(kept.submitted[0]).toContain('Then this')
  })

  test('the budget is kept with the run across a reload', async () => {
    let f = await started()
    f.rt.ops.setBudget({ costUsd: 30, durationMs: 6 * HOUR, atLimit: 'finish' })
    f = await reloaded(f)
    expect(f.rt.ops.current().budget).toMatchObject({ costUsd: 30, durationMs: 6 * HOUR, atLimit: 'finish' })
  })
})

// ---------------------------------------------------------------------------
// Ended runs never leak

describe('ended runs', () => {
  test('a new run of the same project is offered an ended run’s open operations; nothing moves without Bring them here', async () => {
    const f = await started()
    f.rt.ops.armFrom('S-002 result', 'in 1h', 'warm')
    f.rt.ops.queueAdd('Later', 'fresh')
    await f.rt.onSessionEnd({ reason: 'prompt_input_exit' } as never)
    // A new session in the same project (not a resume): a new run.
    const fresh = new Runtime()
    const h = fakeHost({ handoffSize: () => 4000, handoffMtime: () => Date.now() })
    h.kept.store = f.kept.store
    h.live.sessionId = 'S9'
    await h.advance(f.now() + 3 * HOUR - h.now())
    fresh.bind(h.host)
    await fresh.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await h.advance(200)
    expect(fresh.run?.number).not.toBe(f.rt.run?.number)
    expect(fresh.ops.current().watchers).toEqual([])
    expect(fresh.ops.current().queue).toEqual([])
    expect(fresh.ops.foreign).toMatchObject({ watchers: 1, queued: 1, decisions: 0 })
    expect(fresh.ops.foreign?.overdue).toContain('S-002 result, due')
    expect(h.kept.submitted).toEqual([])
    await fresh.ops.bringForeign()
    expect(fresh.ops.current().queue[0]).toMatchObject({ text: 'Later', target: 'fresh' })
    expect(fresh.ops.current().watchers[0]).toMatchObject({ label: 'S-002 result', source: 'carried', status: 'due' })
    expect(fresh.ops.foreign).toBeNull()
    // The ended run keeps its record, its operations marked moved: offered once.
    const ended = fresh.history.find(r => r.id === f.rt.run?.id)
    expect(ended?.ops?.watchers[0]).toMatchObject({ status: 'dismissed' })
    expect(ended?.ops?.queue[0]).toMatchObject({ status: 'cancelled' })
  })
})
