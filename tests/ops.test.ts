import { describe, expect, test } from 'claude-code/testing'

import { agentRows, noteEnd, noteModel, noteSpawn, type AgentLedger } from '../hooks/features/agents'
import * as Ops from '../hooks/features/ops'
import { previewLine, resumeHealthOf, resumePreviewOf, type ResumeInput } from '../hooks/features/resume'
import { scoutOf, suggestionWords } from '../hooks/features/scout'
import { agoWords, clockAhead, parseDuration, parseWhen, splitWatchArgs, untilWords } from '../hooks/features/when'

const MIN = 60_000
const HOUR = 60 * MIN

/** A local time today (the grammar reads local times). */
const today = (h: number, m = 0): number => {
  const d = new Date(2026, 9, 7)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime()
}
const tomorrow = (h: number, m = 0): number => today(h, m) + 24 * HOUR

// ---------------------------------------------------------------------------
// The time grammar

describe('when: the watcher time grammar', () => {
  test('durations read in the forms a person types', () => {
    expect(parseDuration('2h')).toBe(2 * HOUR)
    expect(parseDuration('90m')).toBe(90 * MIN)
    expect(parseDuration('1h30m')).toBe(90 * MIN)
    expect(parseDuration('1.5 hours')).toBe(90 * MIN)
    expect(parseDuration('2 hours 15 minutes')).toBe(135 * MIN)
    expect(parseDuration('an hour')).toBe(HOUR)
    expect(parseDuration('half an hour')).toBe(30 * MIN)
    expect(parseDuration('an hour and a half')).toBe(90 * MIN)
    expect(parseDuration('two hours')).toBe(2 * HOUR)
    expect(parseDuration('1d')).toBe(24 * HOUR)
  })

  test('anything else is no duration: never a guess', () => {
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('soon')).toBeNull()
    expect(parseDuration('5 parsecs')).toBeNull()
    expect(parseDuration('30 seconds')).toBeNull()
    expect(parseDuration('2h and then some')).toBeNull()
    expect(parseDuration('0m')).toBeNull()
  })

  test('"in 2h" and a bare "2h" are two hours from now, said back in words', () => {
    const now = today(10)
    expect(parseWhen('in 2h', now)).toEqual({ kind: 'at', at: now + 2 * HOUR, words: 'in 2h' })
    expect(parseWhen('2h', now)).toEqual({ kind: 'at', at: now + 2 * HOUR, words: 'in 2h' })
    expect(parseWhen('after 90 minutes', now)).toEqual({ kind: 'at', at: now + 90 * MIN, words: 'in 1h 30m' })
  })

  test('a watcher wakes at least a minute and at most a week ahead', () => {
    const now = today(10)
    expect(parseWhen('in 1m', now).kind).toBe('at')
    expect(parseWhen('in 8 days', now)).toEqual({ kind: 'error', message: 'A watcher wakes within a week.', isRange: true })
    expect(parseWhen('in 30 seconds', now).kind).toBe('error')
    expect(parseWhen('in a while', now).kind).toBe('error')
    expect(parseWhen('', now).kind).toBe('error')
    expect(parseWhen('next tuesday', now).kind).toBe('error')
  })

  test('a 24-hour clock time is today, or tomorrow once it has passed', () => {
    expect(parseWhen('at 14:00', today(10))).toEqual({ kind: 'at', at: today(14), words: 'at 14:00' })
    expect(parseWhen('at 14:00', today(15))).toEqual({ kind: 'at', at: tomorrow(14), words: 'at tomorrow 14:00' })
    expect(parseWhen('at 09:15', today(8))).toMatchObject({ kind: 'at', at: today(9, 15) })
    expect(parseWhen('at 21', today(8))).toMatchObject({ kind: 'at', at: today(21) })
    expect(parseWhen('14.30', today(8))).toMatchObject({ kind: 'at', at: today(14, 30) })
  })

  test('am and pm settle the half of the day; noon and midnight read as such', () => {
    const now = today(8)
    expect(parseWhen('at 2:30pm', now)).toMatchObject({ kind: 'at', at: today(14, 30) })
    expect(parseWhen('at 2:30 p.m.', now)).toMatchObject({ kind: 'at', at: today(14, 30) })
    expect(parseWhen('at 9am', now)).toMatchObject({ kind: 'at', at: today(9) })
    expect(parseWhen('at 12am', now)).toMatchObject({ kind: 'at', at: tomorrow(0) })
    expect(parseWhen('at noon', now)).toMatchObject({ kind: 'at', at: today(12) })
    expect(parseWhen('at midnight', now)).toMatchObject({ kind: 'at', at: tomorrow(0) })
    expect(parseWhen('tomorrow at 9am', now)).toMatchObject({ kind: 'at', at: tomorrow(9) })
    expect(parseWhen('tomorrow 14:00', now)).toMatchObject({ kind: 'at', at: tomorrow(14) })
  })

  test('1 to 12 with no am or pm and no leading zero is ambiguous: both readings, nearest first, never a guess', () => {
    const result = parseWhen('at 2:30', today(10))
    expect(result.kind).toBe('ambiguous')
    if (result.kind !== 'ambiguous') return
    expect(result.options.map(o => o.at)).toEqual([today(14, 30), tomorrow(2, 30)])
    expect(result.options[0]!.label).toBe('14:30 (in 4h 30m)')
    expect(result.options[1]!.label).toBe('tomorrow 02:30 (in 16h 30m)')
    // Twelve is noon or midnight.
    const twelve = parseWhen('at 12', today(11, 30))
    expect(twelve.kind === 'ambiguous' ? twelve.options.map(o => o.at) : null).toEqual([today(12), tomorrow(0)])
  })

  test('times that are not times are refused with a reason', () => {
    const now = today(8)
    expect(parseWhen('at 25:00', now).kind).toBe('error')
    expect(parseWhen('at 14:75', now).kind).toBe('error')
    expect(parseWhen('at 13pm', now).kind).toBe('error')
    expect(parseWhen('at 0am', now).kind).toBe('error')
  })

  test('/cr watch arguments split into the time and what it waits for', () => {
    const now = today(10)
    expect(splitWatchArgs('in 2h S-002 result', now)).toMatchObject({ when: 'in 2h', label: 'S-002 result', result: { kind: 'at', at: now + 2 * HOUR } })
    expect(splitWatchArgs('at 14:00 Check the score', now)).toMatchObject({ when: 'at 14:00', label: 'Check the score', result: { kind: 'at', at: today(14) } })
    expect(splitWatchArgs('tomorrow at 9am the nightly run', now)).toMatchObject({ when: 'tomorrow at 9am', label: 'the nightly run' })
    expect(splitWatchArgs('in 90 minutes', now)).toMatchObject({ when: 'in 90 minutes', label: '' })
    expect(splitWatchArgs('at 2:30 the eval', now)?.result.kind).toBe('ambiguous')
    // A time read right but out of range is said as such.
    expect(splitWatchArgs('in 9 days the batch', now)).toMatchObject({ when: 'in 9 days', label: 'the batch', result: { kind: 'error', message: 'A watcher wakes within a week.' } })
    expect(splitWatchArgs('S-002 result', now)).toBeNull()
    expect(splitWatchArgs('', now)).toBeNull()
  })

  test('local times and countdowns read as a person says them', () => {
    const now = today(10)
    expect(clockAhead(today(14), now)).toBe('14:00')
    expect(clockAhead(tomorrow(9), now)).toBe('tomorrow 09:00')
    expect(clockAhead(today(9) + 3 * 24 * HOUR, now)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) 09:00$/)
    expect(untilWords(0)).toBe('now')
    expect(untilWords(30_000)).toBe('under a minute')
    // "in 1m", armed a few milliseconds after it was read.
    expect(untilWords(MIN - 7)).toBe('1m')
    expect(untilWords(2 * HOUR - 300)).toBe('2h')
    expect(untilWords(42.5 * MIN)).toBe('43m')
    expect(untilWords(42 * MIN)).toBe('42m')
    expect(untilWords(102 * MIN)).toBe('1h 42m')
    expect(untilWords(120 * MIN)).toBe('2h')
    expect(untilWords(50 * HOUR)).toBe('2d 2h')
    expect(agoWords(30_000)).toBe('just now')
    expect(agoWords(MIN)).toBe('1 minute ago')
    expect(agoWords(43 * MIN)).toBe('43 minutes ago')
    expect(agoWords(2 * HOUR)).toBe('2 hours ago')
    expect(agoWords(72 * HOUR)).toBe('3 days ago')
  })
})

// ---------------------------------------------------------------------------
// Mission Queue

const add = (ops: Ops.RunOps, text: string, target: Ops.QueueTarget = 'boundary', milestone: { key: string; subject: string } | null = null, now = 1000) => {
  const r = Ops.addQueueItem(ops, { text, target, now, milestone })
  if ('error' in r) throw new Error(r.error)
  return r
}

describe('ops: Mission Queue', () => {
  test('items get ids in order, are trimmed and refused when empty or over the limit', () => {
    let ops = Ops.emptyOps()
    const a = add(ops, '  Update the README  ')
    expect(a.item).toMatchObject({ id: 'Q-1', text: 'Update the README', status: 'queued', target: 'boundary' })
    ops = a.ops
    ops = add(ops, 'Run the eval').ops
    expect(ops.queue.map(q => q.id)).toEqual(['Q-1', 'Q-2'])
    expect(Ops.addQueueItem(ops, { text: '   ', target: 'boundary', now: 1, milestone: null })).toEqual({ error: 'Nothing to queue: write what Claude should do later.' })
    for (let i = 0; i < 28; i++) ops = add(ops, `item ${i}`).ops
    expect('error' in Ops.addQueueItem(ops, { text: 'one too many', target: 'boundary', now: 1, milestone: null })).toBe(true)
    // Ids never repeat, even after deletion.
    ops = Ops.cancelQueueItem(ops, 'Q-30', 5)
    expect(add(ops, 'again').item.id).toBe('Q-31')
  })

  test('each target is due at its own boundary', () => {
    let ops = Ops.emptyOps()
    ops = add(ops, 'next', 'boundary').ops
    ops = add(ops, 'turn', 'turn').ops
    ops = add(ops, 'milestone', 'milestone', { key: 'm1', subject: 'Build it' }).ops
    ops = add(ops, 'fresh', 'fresh').ops
    // A milestone done mid-turn: the next safe boundary and that milestone's item.
    const mid = Ops.queueDueAt(ops, { kind: 'milestones', completed: ['m1'], planKeys: ['m1', 'm2'], current: 'm2' }, 2000)
    expect(mid.queue.map(q => q.status)).toEqual(['due', 'queued', 'due', 'queued'])
    // A different milestone done: only the next safe boundary.
    const other = Ops.queueDueAt(ops, { kind: 'milestones', completed: ['m0'], planKeys: ['m0', 'm1'], current: 'm1' }, 2000)
    expect(other.queue.map(q => q.status)).toEqual(['due', 'queued', 'queued', 'queued'])
    // The turn's end: the boundary and the turn, not a milestone still under way, never the handoff's.
    const end = Ops.queueDueAt(ops, { kind: 'turnEnd', completed: [], planKeys: ['m1'], current: 'm1' }, 2000)
    expect(end.queue.map(q => q.status)).toEqual(['due', 'due', 'queued', 'queued'])
    // A milestone that left the plan counts as done.
    const gone = Ops.queueDueAt(ops, { kind: 'turnEnd', completed: [], planKeys: ['m9'], current: null }, 2000)
    expect(gone.queue[2]!.status).toBe('due')
    // The fresh context: only the handoff's.
    const fresh = Ops.queueDueAt(ops, { kind: 'fresh' }, 2000)
    expect(fresh.queue.map(q => q.status)).toEqual(['queued', 'queued', 'queued', 'due'])
    // Idle: what waits only for the session to be free.
    const idle = Ops.queueDueAt(ops, { kind: 'idle', current: 'm1' }, 2000)
    expect(idle.queue.map(q => q.status)).toEqual(['due', 'due', 'queued', 'queued'])
    expect(idle.queue[0]!.dueAt).toBe(2000)
    // Nothing changes: the same object comes back.
    expect(Ops.queueDueAt(fresh, { kind: 'fresh' }, 3000).queue[3]!.dueAt).toBe(2000)
  })

  test('an "after the milestone" item added with no milestone under way waits for the next boundary', () => {
    const ops = add(Ops.emptyOps(), 'later', 'milestone', null).ops
    expect(ops.queue[0]).toMatchObject({ milestoneKey: null, milestone: null })
    expect(Ops.queueDueAt(ops, { kind: 'idle', current: null }, 1).queue[0]!.status).toBe('due')
    expect(Ops.queueDueAt(ops, { kind: 'turnEnd', completed: [], planKeys: [], current: null }, 1).queue[0]!.status).toBe('due')
  })

  test('items are edited, re-targeted, reordered and deleted; one on its way is left alone', () => {
    let ops = add(add(add(Ops.emptyOps(), 'a').ops, 'b').ops, 'c').ops
    ops = Ops.editQueueItem(ops, 'Q-2', { text: '  B  ' })
    expect(ops.queue[1]!.text).toBe('B')
    ops = Ops.editQueueItem(ops, 'Q-2', { text: '   ' })
    expect(ops.queue[1]!.text).toBe('B')
    ops = Ops.queueDueAt(ops, { kind: 'idle', current: null }, 5)
    ops = Ops.editQueueItem(ops, 'Q-1', { target: 'fresh' })
    expect(ops.queue[0]).toMatchObject({ target: 'fresh', status: 'queued', dueAt: null })
    ops = Ops.moveQueueItem(ops, 'Q-3', -1)
    expect(ops.queue.map(q => q.id)).toEqual(['Q-1', 'Q-3', 'Q-2'])
    expect(Ops.moveQueueItem(ops, 'Q-1', -1)).toBe(ops)
    expect(Ops.moveQueueItem(ops, 'Q-2', 1)).toBe(ops)
    ops = Ops.markQueue(ops, ['Q-3'], 'sending', 6, 'prompt')
    expect(Ops.cancelQueueItem(ops, 'Q-3', 7)).toBe(ops)
    expect(Ops.editQueueItem(ops, 'Q-3', { text: 'x' }).queue.find(q => q.id === 'Q-3')!.text).toBe('c')
    ops = Ops.cancelQueueItem(ops, 'Q-2', 7)
    expect(ops.queue.find(q => q.id === 'Q-2')!.status).toBe('cancelled')
    expect(ops.log[0]!.text).toBe('Q-2 deleted')
  })

  test('delivery is recorded with how it went, and finished items are pruned to the newest few', () => {
    let ops = Ops.emptyOps()
    for (let i = 0; i < 14; i++) ops = add(ops, `item ${i}`).ops
    const ids = ops.queue.map(q => q.id)
    ops = Ops.markQueue(ops, ids.slice(0, 13), 'sending', 10, 'note')
    expect(ops.queue[0]).toMatchObject({ status: 'sending', sentAt: 10, via: 'note' })
    ops = Ops.markQueue(ops, ids.slice(0, 13), 'delivered', 20)
    expect(ops.queue.filter(q => q.status === 'delivered')).toHaveLength(Ops.OPS_LIMITS.kept)
    expect(ops.queue.find(q => q.id === 'Q-13')).toMatchObject({ status: 'delivered', deliveredAt: 20, via: 'note' })
    expect(ops.queue.find(q => q.id === 'Q-14')!.status).toBe('queued')
    expect(ops.log[0]!.text).toContain('delivered')
  })

  test('Deliver now makes a queued or unsure item due at once', () => {
    let ops = add(Ops.emptyOps(), 'a', 'fresh').ops
    ops = Ops.forceDue(ops, 'Q-1', 9)
    expect(ops.queue[0]).toMatchObject({ status: 'due', dueAt: 9 })
  })
})

// ---------------------------------------------------------------------------
// Decision Inbox

const ask = (ops: Ops.RunOps, input: Partial<Parameters<typeof Ops.addDecision>[1]> = {}) => {
  const r = Ops.addDecision(ops, { question: 'Postgres or SQLite for the cache store?', now: 100, currentMilestone: 'Build the store', ...input })
  if ('error' in r) throw new Error(r.error)
  return r
}

describe('ops: Decision Inbox', () => {
  test('a decision keeps its question, context, options, urgency, blocking and milestone', () => {
    const { decision } = ask(Ops.emptyOps(), { context: 'Affects deployment', options: ['Postgres', 'SQLite', 'Postgres', '', 'Redis', 'Mongo', 'Dynamo'], urgency: 'high', blocking: true })
    expect(decision).toMatchObject({
      id: 'D-1',
      question: 'Postgres or SQLite for the cache store?',
      context: 'Affects deployment',
      options: ['Postgres', 'SQLite', 'Redis', 'Mongo'],
      allowText: false,
      urgency: 'high',
      isBlocking: true,
      milestone: 'Build the store',
      status: 'open',
    })
    // No options: a free answer.
    expect(ask(Ops.emptyOps(), { options: [] }).decision.allowText).toBe(true)
    // Its own milestone wins over the one under way; bad values fall back.
    expect(ask(Ops.emptyOps(), { milestone: 'Ship it', urgency: 'whenever', blocking: 'yes' }).decision).toMatchObject({ milestone: 'Ship it', urgency: 'normal', isBlocking: false })
  })

  test('the same open question again is the same decision; a non-question is refused', () => {
    const first = ask(Ops.emptyOps())
    const again = ask(first.ops, { question: 'postgres or sqlite for the cache store?' })
    expect(again.decision.id).toBe('D-1')
    expect(again.ops.decisions).toHaveLength(1)
    expect(Ops.addDecision(Ops.emptyOps(), { question: '', now: 1, currentMilestone: null })).toEqual({ error: 'A decision needs a question.' })
    expect(Ops.addDecision(Ops.emptyOps(), { question: 42, now: 1, currentMilestone: null })).toEqual({ error: 'A decision needs a question.' })
  })

  test('an answer moves it to answered, then on to Claude; one delivered cannot be answered again', () => {
    let ops = ask(Ops.emptyOps()).ops
    const answered = Ops.answerDecision(ops, 'D-1', '  SQLite  ', 200)
    if ('error' in answered) throw new Error(answered.error)
    expect(answered.decisions[0]).toMatchObject({ status: 'answered', answer: 'SQLite', answeredAt: 200 })
    expect(Ops.isAnswerWaiting(answered.decisions[0]!)).toBe(true)
    // Still waiting: it can be changed.
    const changed = Ops.answerDecision(answered, 'D-1', 'Postgres', 210)
    if ('error' in changed) throw new Error(changed.error)
    ops = Ops.markDecisions(changed, ['D-1'], 'delivered', 300, 'context')
    expect(ops.decisions[0]).toMatchObject({ status: 'delivered', answer: 'Postgres', deliveredAt: 300, via: 'context' })
    expect(Ops.answerDecision(ops, 'D-1', 'SQLite', 400)).toEqual({ error: 'D-1 was already answered and sent to Claude.' })
    expect(Ops.answerDecision(ops, 'D-9', 'x', 400)).toEqual({ error: 'No decision D-9.' })
    expect(Ops.answerDecision(ask(Ops.emptyOps()).ops, 'D-1', '   ', 400)).toEqual({ error: 'An answer needs some words.' })
  })

  test('the inbox holds twenty open questions at most', () => {
    let ops = Ops.emptyOps()
    for (let i = 0; i < 20; i++) ops = ask(ops, { question: `Question number ${i}?` }).ops
    expect('error' in Ops.addDecision(ops, { question: 'One more question?', now: 1, currentMilestone: null })).toBe(true)
    ops = Ops.markDecisions(ops, ['D-1'], 'withdrawn', 5)
    expect('error' in Ops.addDecision(ops, { question: 'One more question?', now: 1, currentMilestone: null })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Watchers

const arm = (ops: Ops.RunOps, input: Partial<Parameters<typeof Ops.addWatcher>[1]> = {}) => {
  const r = Ops.addWatcher(ops, { label: 'S-002 result', wakeAt: 10 * HOUR, strategy: 'smart', now: 0, milestone: null, checkpoint: null, source: 'person', decided: null, ...input })
  if ('error' in r) throw new Error(r.error)
  return r
}

describe('ops: Watchers', () => {
  test('a checkpoint is the run fingerprint: turns, milestones and context', () => {
    const tasks = [
      { key: 'a', status: 'completed' },
      { key: 'b', status: 'in_progress' },
    ]
    const cp = Ops.checkpointNow({ now: 1, sessionId: 'S1', turns: 3, tasks })
    expect(Ops.changedSince(cp, Ops.checkpointNow({ now: 9, sessionId: 'S1', turns: 3, tasks: [...tasks] }))).toBeNull()
    expect(Ops.changedSince(cp, Ops.checkpointNow({ now: 9, sessionId: 'S1', turns: 4, tasks }))).toBe('This run changed since the watcher was armed: a turn ran.')
    expect(Ops.changedSince(cp, Ops.checkpointNow({ now: 9, sessionId: 'S1', turns: 5, tasks }))).toContain('2 turns ran')
    expect(Ops.changedSince(cp, Ops.checkpointNow({ now: 9, sessionId: 'S1', turns: 3, tasks: [tasks[0]!, { key: 'b', status: 'completed' }] }))).toContain('its milestones changed')
    expect(Ops.changedSince(cp, Ops.checkpointNow({ now: 9, sessionId: 'S2', turns: 3, tasks }))).toContain('the context was cleared')
    expect(Ops.changesSince(cp, Ops.checkpointNow({ now: 9, sessionId: 'S2', turns: 4, tasks: [] }))).toEqual(['the context was cleared', 'a turn ran', 'its milestones changed'])
    expect(Ops.changesSince(cp, Ops.checkpointNow({ now: 9, sessionId: 'S1', turns: 3, tasks }))).toEqual([])
    expect(Ops.planKey([])).toBe(Ops.planKey([]))
    expect(Ops.planKey(tasks)).not.toBe(Ops.planKey([...tasks].reverse()))
  })

  test('several watchers: the earliest wakes first, the open ones are limited, finished ones pruned', () => {
    let ops = arm(Ops.emptyOps(), { label: 'late', wakeAt: 5 * HOUR }).ops
    ops = arm(ops, { label: 'early', wakeAt: 2 * HOUR }).ops
    expect(Ops.nextWakeAt(ops)).toBe(2 * HOUR)
    expect(Ops.holdingWatcher(ops)?.label).toBe('early')
    expect(Ops.dueWatchers(ops, 3 * HOUR).map(w => w.label)).toEqual(['early'])
    // One due and waiting holds the run ahead of an earlier armed one.
    ops = Ops.patchWatcher(ops, 'W-1', { status: 'stale', needs: 'changed' })
    expect(Ops.holdingWatcher(ops)?.id).toBe('W-1')
    for (let i = 0; i < 8; i++) ops = arm(ops, { label: `w${i}` }).ops
    expect('error' in Ops.addWatcher(ops, { label: 'eleventh', wakeAt: 1, strategy: 'smart', now: 0, milestone: null, checkpoint: null, source: 'person', decided: null })).toBe(true)
    expect(arm(Ops.emptyOps(), { label: '   ' }).watcher.label).toBe('the result')
  })

  test('a watcher acts on its own strategy, or on what Smart decided', () => {
    expect(Ops.modeOf({ strategy: 'warm', decided: null })).toEqual({ mode: 'warm', hold: true })
    expect(Ops.modeOf({ strategy: 'fresh', decided: null })).toEqual({ mode: 'fresh', hold: false })
    expect(Ops.modeOf({ strategy: 'smart', decided: null })).toEqual({ mode: 'warm', hold: false })
    expect(Ops.modeOf({ strategy: 'smart', decided: { mode: 'fresh', hold: false, reason: '', at: 0 } })).toEqual({ mode: 'fresh', hold: false })
  })
})

// ---------------------------------------------------------------------------
// Smart

const smart = (input: Partial<Ops.SmartInput>) =>
  Ops.smartChoice({ now: 0, wakeAt: 2 * HOUR, ttl: '1h', cachedTokens: 300_000, expiresAt: HOUR, contextShare: 0.3, isKeepWarmBroken: false, resume: { isHealthy: true, problem: null }, smallTokens: 100_000, ...input })

describe('ops: Smart', () => {
  test('no hold when the cache outlives the wait', () => {
    expect(smart({ wakeAt: 30 * MIN, expiresAt: HOUR })).toMatchObject({ mode: 'warm', hold: false, reason: '30m wait · the cache lasts past the wake' })
  })

  test('a small context comes back in this context with no hold: a cold read costs little', () => {
    expect(smart({ cachedTokens: 40_000 })).toMatchObject({ mode: 'warm', hold: false })
    expect(smart({ cachedTokens: 40_000 }).reason).toContain('a cold read costs little')
  })

  test('unhealthy resume state keeps the conversation (held while that is worth it)', () => {
    const held = smart({ resume: { isHealthy: false, problem: 'No handoff notes: NEXT_SESSION_PROMPT.md is missing' } })
    expect(held).toMatchObject({ mode: 'warm', hold: true })
    expect(held.reason).toContain('fresh resume not ready (no handoff notes')
    // The 5-minute cache is not held for hours: it comes back cold, but in this context.
    expect(smart({ ttl: '5m', wakeAt: 3 * HOUR, resume: { isHealthy: false, problem: null } })).toMatchObject({ mode: 'warm', hold: false })
  })

  test('a context near its handoff point wakes fresh', () => {
    expect(smart({ contextShare: 0.85 })).toMatchObject({ mode: 'fresh', hold: false })
    expect(smart({ contextShare: 0.85 }).reason).toContain('context 85% of its handoff point')
  })

  test('Keep warm that cannot hold this cache means fresh', () => {
    expect(smart({ isKeepWarmBroken: true })).toMatchObject({ mode: 'fresh', hold: false })
  })

  test('the 5-minute cache: a short hold, never past 45 minutes', () => {
    expect(smart({ ttl: '5m', wakeAt: 30 * MIN, expiresAt: 5 * MIN })).toMatchObject({ mode: 'warm', hold: true })
    expect(smart({ ttl: '5m', wakeAt: 46 * MIN, expiresAt: 5 * MIN })).toMatchObject({ mode: 'fresh', hold: false })
    expect(smart({ ttl: null, wakeAt: 2 * HOUR, expiresAt: null })).toMatchObject({ mode: 'fresh' })
  })

  test('the 1-hour cache: holds while a few refreshes cost less than fresh starts, else fresh', () => {
    // 2h of 300k: 3 refreshes × 30k = 90k ≤ 240k.
    expect(smart({ wakeAt: 2 * HOUR })).toMatchObject({ mode: 'warm', hold: true })
    expect(smart({ wakeAt: 2 * HOUR }).reason).toBe('2h wait · 300k context · about 3 refreshes, read from the cache')
    // 6h of 742k: 8 refreshes × 74k = 594k > 240k.
    const long = smart({ wakeAt: 6 * HOUR, cachedTokens: 742_000 })
    expect(long).toMatchObject({ mode: 'fresh', hold: false })
    expect(long.reason).toBe('6h wait · 742k context · resume state ready')
  })
})

// ---------------------------------------------------------------------------
// Run Budget

describe('ops: Run Budget', () => {
  const metrics = (m: Partial<Ops.BudgetMetrics>): Ops.BudgetMetrics => ({ costUsd: 0, isCostPartial: false, durationMs: 0, handoffs: 0, ...m })

  test('off by default; a limit of nothing is no budget', () => {
    expect(Ops.emptyOps().budget).toBeNull()
    expect(Ops.setBudget(Ops.emptyOps(), { atLimit: 'finish' }, 1).budget).toBeNull()
    expect(Ops.setBudget(Ops.emptyOps(), { costUsd: 0 }, 1).budget).toBeNull()
  })

  test('near at 80%, reached at 100%, each limit in words', () => {
    const ops = Ops.setBudget(Ops.emptyOps(), { costUsd: 30, durationMs: 6 * HOUR, handoffs: 5 }, 1)
    const b = ops.budget!
    expect(b).toMatchObject({ costUsd: 30, durationMs: 6 * HOUR, handoffs: 5, atLimit: 'ask' })
    expect(Ops.checkBudget(b, metrics({ costUsd: 16.2 }))).toEqual({ near: [], reached: [], words: { cost: 'Cost $16.20 of $30', time: 'Time 0m of 6h', handoffs: 'Handoffs 0 of 5' } })
    expect(Ops.checkBudget(b, metrics({ costUsd: 24, durationMs: 5 * HOUR, handoffs: 4 })).near).toEqual(['cost', 'time', 'handoffs'])
    const reached = Ops.checkBudget(b, metrics({ costUsd: 30.12, isCostPartial: true, durationMs: 6 * HOUR + 30 * MIN, handoffs: 5 }))
    expect(reached.reached).toEqual(['cost', 'time', 'handoffs'])
    expect(reached.words.cost).toBe('Cost $30.12+ of $30')
    expect(reached.words.time).toBe('Time 6h 30m of 6h')
    // An unknown cost reaches nothing.
    expect(Ops.checkBudget(b, metrics({ costUsd: null })).reached).toEqual([])
  })

  test('a limit raised is said again when next near or reached; its approval does not carry over', () => {
    let ops = Ops.setBudget(Ops.emptyOps(), { costUsd: 30, handoffs: 5 }, 1)
    ops = { ...ops, budget: { ...ops.budget!, warned: ['cost', 'handoffs'], reached: ['cost'], approved: ['cost'] } }
    ops = Ops.setBudget(ops, { costUsd: 50 }, 2)
    expect(ops.budget).toMatchObject({ costUsd: 50, warned: ['handoffs'], reached: [], approved: [] })
    expect(Ops.setBudget(ops, null, 3).budget).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Reading the store

describe('ops: the stored record is validated, never trusted', () => {
  test('a run from before 1.6.0 holds no operations; malformed entries are dropped', () => {
    expect(Ops.opsOf(undefined)).toEqual(Ops.emptyOps())
    expect(Ops.opsOf('junk')).toEqual(Ops.emptyOps())
    const ops = Ops.opsOf({
      seq: { q: 2.7, d: -4, w: 'x' },
      personTurns: 3,
      queue: [{ id: 'Q-1', text: 'ok', status: 'teleported', target: 'never' }, { id: 'Q-2', text: '  ' }, 'nope', null],
      decisions: [{ id: 'D-1', question: 'Which?', options: ['a', 3, '', 'b'], status: 'answered', answer: 'a' }],
      watchers: [{ id: 'W-1', label: '', wakeAt: 5, status: 'armed', strategy: 'turbo', checkpoint: { turns: 2, plan: 'p' } }, { id: 'W-2', label: 'no time' }],
      budget: { costUsd: -5, durationMs: 'long', handoffs: 2.6, atLimit: 'explode', warned: ['cost', 'bogus'] },
      log: [{ at: 1, text: 'hello' }, { at: 2 }],
    })
    expect(ops.seq).toEqual({ q: 2, d: 0, w: 0 })
    expect(ops.personTurns).toBe(3)
    expect(ops.queue).toHaveLength(1)
    expect(ops.queue[0]).toMatchObject({ id: 'Q-1', status: 'queued', target: 'boundary', via: null })
    expect(ops.decisions[0]).toMatchObject({ options: ['a', 'b'], status: 'answered', answer: 'a', allowText: false })
    expect(ops.watchers).toHaveLength(1)
    expect(ops.watchers[0]).toMatchObject({ label: 'the result', strategy: 'smart', checkpoint: { turns: 2, plan: 'p', sessionId: null } })
    expect(ops.budget).toMatchObject({ costUsd: null, durationMs: null, handoffs: 3, atLimit: 'ask', warned: ['cost'] })
    expect(ops.log).toEqual([{ at: 1, text: 'hello' }])
  })

  test('what a run holds round-trips through JSON (the run record)', () => {
    let ops = add(Ops.emptyOps(), 'a', 'milestone', { key: 'k', subject: 'Build' }).ops
    ops = ask(ops).ops
    ops = arm(ops, { checkpoint: Ops.checkpointNow({ now: 1, sessionId: 'S1', turns: 0, tasks: [] }), decided: { mode: 'fresh', hold: false, reason: 'r', at: 1 } }).ops
    ops = Ops.setBudget(ops, { costUsd: 12.5, atLimit: 'finish' }, 1)
    expect(Ops.opsOf(JSON.parse(JSON.stringify(ops)))).toEqual(ops)
  })
})

// ---------------------------------------------------------------------------
// Resume state

const resumeInput = (patch: Partial<ResumeInput> = {}): ResumeInput => ({
  runNumber: 41,
  objective: 'Project Sentinel 1.6.0',
  tasks: [
    { subject: 'Design it', status: 'completed', detail: null },
    { subject: 'Build it', status: 'in_progress', detail: null, activeForm: 'Building it' },
    { subject: 'Ship it', status: 'pending', detail: null },
  ],
  planUpdatedAt: 50 * MIN,
  notesPath: 'C:\\work\\NEXT_SESSION_PROMPT.md',
  notes: { size: 4000, mtimeMs: 49 * MIN },
  continuity: null,
  docs: ['README.md'],
  queued: 2,
  decisions: 1,
  ...patch,
})

describe('resume: health and the preview', () => {
  test('healthy: milestones, notes written since the milestones last changed, no failed pickup', () => {
    expect(resumeHealthOf(resumeInput())).toEqual({ isHealthy: true, problems: [] })
  })

  test('each missing part is named', () => {
    expect(resumeHealthOf(resumeInput({ tasks: [] })).problems).toEqual(['No run state: Claude keeps no milestones for this run'])
    expect(resumeHealthOf(resumeInput({ notes: null })).problems).toEqual(['No handoff notes: NEXT_SESSION_PROMPT.md is missing'])
    expect(resumeHealthOf(resumeInput({ notes: undefined })).problems).toEqual(['NEXT_SESSION_PROMPT.md has not been checked yet'])
    expect(resumeHealthOf(resumeInput({ notes: { size: 120, mtimeMs: 49 * MIN } })).problems).toEqual(['The handoff notes are nearly empty (NEXT_SESSION_PROMPT.md)'])
    expect(resumeHealthOf(resumeInput({ notes: { size: 4000, mtimeMs: 30 * MIN } })).problems).toEqual(["NEXT_SESSION_PROMPT.md is older than the run's latest milestones"])
    // Within ten minutes either way is the same turn's writing.
    expect(resumeHealthOf(resumeInput({ notes: { size: 4000, mtimeMs: 41 * MIN } })).isHealthy).toBe(true)
  })

  test("a failed pickup by the last handoff's fresh context counts until the notes are written again", () => {
    const failed = { items: [{ id: 'notesRead', state: 'missing' as const }], at: 55 * MIN }
    expect(resumeHealthOf(resumeInput({ continuity: failed })).problems).toEqual(["The last handoff's fresh context did not pick up its notes or its run state"])
    expect(resumeHealthOf(resumeInput({ continuity: failed, notes: { size: 4000, mtimeMs: 56 * MIN } })).isHealthy).toBe(true)
  })

  test('the preview: the run, what is done and under way, what it reads and carries, the next action', () => {
    const p = resumePreviewOf(resumeInput())
    expect(p).toMatchObject({ isHealthy: true, run: 41, doneCount: 1, total: 3, current: 'Build it', next: 'Building it', queued: 2, decisions: 1 })
    expect(p.reads.map(r => r.isOk)).toEqual([true, true, true])
    expect(p.reads[0]!.label).toBe('Run state: 1 of 3 milestones')
    expect(previewLine(p)).toBe("Claude restores run 41's 3 milestones (1 done; now: Build it), reads NEXT_SESSION_PROMPT.md, README.md, 2 queued items, 1 open decision")
    const waiting = resumePreviewOf(resumeInput({ tasks: [{ subject: 'Run S-002', status: 'waiting', detail: 'the S-002 score' }] }))
    expect(waiting).toMatchObject({ current: 'Waiting for the S-002 score', next: 'Check the S-002 score, then continue' })
    const done = resumePreviewOf(resumeInput({ tasks: [{ subject: 'All', status: 'completed', detail: null }] }))
    expect(done.next).toBe('Every milestone is done: check the work and wrap up')
  })
})

// ---------------------------------------------------------------------------
// Watcher Scout

describe('scout: a wait read only from what is explicit', () => {
  const now = today(10)

  test('a milestone marked waiting is the plainest signal; its blocker may say when', () => {
    const s = scoutOf({ now, message: '', waiting: [{ subject: 'Run S-002', detail: 'S-002 result, check at 14:00' }] })
    expect(s).toMatchObject({ source: 'milestone', isExplicit: true, when: { kind: 'at', at: today(14) }, whenText: 'at 14:00' })
    // The check is what the watcher does, not what it waits for.
    expect(s!.label).toBe('S-002 result')
    expect(suggestionWords(s!, now)).toBe('Check S-002 result again at 14:00?')
    const vague = scoutOf({ now, message: '', waiting: [{ subject: 'Run S-002', detail: 'the leaderboard to update' }] })
    expect(vague).toMatchObject({ isExplicit: false, when: null, label: 'The leaderboard to update' })
    // Seen live in the Desktop app: the blocker "the window reset at 14:50 local" was asked as "Check The window reset
    // local again at 14:50?". "local" belongs to the time, and the label's article is lowercase inside the question.
    const reset = scoutOf({ now, message: '', waiting: [{ subject: 'Verify the 14:50 five-hour reset on Desktop', detail: 'the window reset at 14:50 local' }] })
    expect(reset).toMatchObject({ isExplicit: true, when: { kind: 'at', at: today(14) + 50 * MIN }, whenText: 'at 14:50 local', label: 'The window reset' })
    expect(suggestionWords(reset!, now)).toBe('Check the window reset again at 14:50 local?')
    expect(scoutOf({ now, message: '', waiting: [{ subject: 'Run S-003', detail: 'S-003 result at 15:00 local time' }] })).toMatchObject({ label: 'S-003 result', whenText: 'at 15:00 local time' })
  })

  test("Claude's own sentence pairing a check with a time", () => {
    const s = scoutOf({ now, message: 'The eval is submitted. I will check the leaderboard again in two hours.', waiting: [] })
    expect(s).toMatchObject({ source: 'message', isExplicit: true, when: { kind: 'at', at: now + 2 * HOUR }, whenText: 'in two hours' })
    expect(s!.label).toBe('Check the leaderboard again')
    expect(s!.reason).toBe('Claude said it will check the leaderboard again in two hours')
    // In Claude's own time words, "again" said once.
    expect(suggestionWords(s!, now)).toBe('Check the leaderboard again in two hours?')
    expect(suggestionWords({ label: 'The eval', when: { kind: 'at', at: now + 90 * MIN, words: '' }, whenText: null }, now)).toBe('Check the eval again at 11:30 (in 1h 30m)?')
    expect(suggestionWords({ label: 'The leaderboard to update', when: null, whenText: null }, now)).toBe('Check the leaderboard to update later?')
    // Only an article or a determiner is lowercased: a name keeps its capital.
    expect(suggestionWords({ label: 'Vercel deploy', when: null, whenText: null }, now)).toBe('Check Vercel deploy later?')
  })

  test('advice to the person, a time with no check, a check with no time: no suggestion', () => {
    expect(scoutOf({ now, message: 'You can check back in an hour to see the results.', waiting: [] })).toBeNull()
    expect(scoutOf({ now, message: 'The build took 2 hours in total.', waiting: [] })).toBeNull()
    expect(scoutOf({ now, message: 'I will check the logs.', waiting: [] })).toBeNull()
    expect(scoutOf({ now, message: '```\nsleep in 2h check\n```', waiting: [] })).toBeNull()
  })

  test('an ambiguous time is suggested, never armed by itself', () => {
    const s = scoutOf({ now, message: "Let me re-run the eval at 2:30 once the queue drains.", waiting: [] })
    expect(s).toMatchObject({ isExplicit: false, when: { kind: 'ambiguous' } })
  })
})

// ---------------------------------------------------------------------------
// Agents

describe('agents: only what Claude Code reports', () => {
  const none = () => ({ label: null, calls: 0 })

  test('no agents: no rows', () => {
    expect(agentRows(new Map(), [], 0, none)).toEqual([])
  })

  test('a spawned agent running: its spawn facts, what it is doing, and stop/message only where Claude Code accepts them', () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, { agentId: 'a1', at: 1000, model: 'claude-sonnet-5-5', isBackground: true, isFork: false, description: 'Explore the cache code', type: 'Explore', name: null, parentId: null })
    noteSpawn(ledger, { agentId: 'a2', at: 2000, model: null, isBackground: false, isFork: false, description: 'Write tests', type: 'general-purpose', name: null, parentId: null })
    noteModel(ledger, 'a2', 'claude-haiku-5-5')
    const rows = agentRows(ledger, [{ id: 'a1', type: 'Explore', description: 'Explore the cache code', status: 'running' }, { id: 'a2', type: 'general-purpose', description: 'Write tests', status: 'running' }], 5000, id => (id === 'a1' ? { label: 'Reading cache.ts', calls: 4 } : { label: null, calls: 0 }))
    // Running ones newest first.
    expect(rows.map(r => r.id)).toEqual(['a2', 'a1'])
    expect(rows[1]).toMatchObject({ id: 'a1', status: 'running', model: 'claude-sonnet-5-5', isBackground: true, startedAt: 1000, activity: 'Reading cache.ts', calls: 4, canStop: true, canMessage: true })
    // A foreground agent with no name: TaskStop and SendMessage do not take it.
    expect(rows[0]).toMatchObject({ id: 'a2', model: 'claude-haiku-5-5', isBackground: false, canStop: false, canMessage: false })
  })

  test('completed and failed: the first line of the answer, or why it stopped; kept a while after Claude Code drops it', () => {
    const ledger: AgentLedger = new Map()
    noteSpawn(ledger, { agentId: 'a1', at: 0, model: null, isBackground: true, isFork: false, description: 'Find it', type: 'Explore', name: null, parentId: null })
    noteEnd(ledger, 'a1', { at: 60_000, reason: 'answer', answer: '\n## Found 3 call sites\nmore' })
    noteEnd(ledger, 'a2', { at: 60_000, reason: 'error', answer: '' })
    const rows = agentRows(ledger, [], 120_000, none)
    expect(rows.map(r => [r.id, r.status, r.result, r.isFailed, r.canStop])).toEqual([
      ['a1', 'completed', 'Found 3 call sites', false, false],
      ['a2', 'failed', 'Ended with an error', true, false],
    ])
    expect(agentRows(ledger, [], 60_000 + 11 * MIN, none)).toEqual([])
    // Listed by Claude Code as killed: stopped.
    expect(agentRows(new Map(), [{ id: 'x', type: 't', description: 'd', status: 'killed' }], 0, none)[0]).toMatchObject({ result: 'Stopped', isFailed: true, canStop: false })
  })

  test('never shown alive unless Claude Code lists it so; after a reload the spawn is not known', () => {
    const rows = agentRows(new Map(), [{ id: 't1', type: 'teammate', description: 'Reviewer', status: 'idle', teammateId: 'rev@team', name: 'reviewer' }], 0, none)
    expect(rows[0]).toMatchObject({ name: 'reviewer', startedAt: null, model: null, isBackground: true, canStop: true, canMessage: true })
  })
})

describe('watcher wording', () => {
  test('how a watcher resumes the run, without repeating its strategy (live: "Fresh: wakes fresh")', () => {
    expect(Ops.howWords({ strategy: 'warm', decided: null })).toBe('Keep warm · cache held to the wake')
    expect(Ops.howWords({ strategy: 'fresh', decided: null })).toBe('Fresh · nothing spent while it sleeps')
    expect(Ops.howWords({ strategy: 'smart', decided: null })).toBe('Smart · decides at the wake')
    expect(Ops.howWords({ strategy: 'smart', decided: { mode: 'warm', hold: true } })).toBe('Smart · holds the cache warm')
    expect(Ops.howWords({ strategy: 'smart', decided: { mode: 'fresh', hold: false } })).toBe('Smart · wakes fresh')
  })
})
