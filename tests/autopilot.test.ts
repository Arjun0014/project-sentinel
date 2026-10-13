import { describe, expect, test } from 'claude-code/testing'

import { backgroundResultNote, continuationPrompt, handoffPrompt, ownPromptKind } from '../hooks/features/prompts'
import {
  type Autopilot,
  type AutopilotConfig,
  type AutopilotEvent,
  type BackgroundTask,
  DEFAULT_WAIT_MS,
  type HandoffFacts,
  type TurnKind,
  freshVerdict,
  handoffPoint,
  handoffVerdict,
  initialAutopilot,
  isHandoffActive,
  notificationTask,
  recordOf,
  recover,
  resolveThreshold,
  roomOf,
  step,
} from '../hooks/features/autopilot'

const CFG: AutopilotConfig = { continuation: 'clear', fallbackToCompact: true, autoContinue: true }

function run(events: AutopilotEvent[], cfg: AutopilotConfig = CFG, start: Autopilot = initialAutopilot()) {
  let model = start
  const effects: string[] = []
  for (const event of events) {
    const out = step(model, event, cfg)
    model = out.model
    effects.push(...out.effects.filter(e => e.kind !== 'notify').map(e => e.kind))
  }
  return { model, effects }
}

const ARM: AutopilotEvent = { kind: 'configure', enabled: true, threshold: 700_000, isClamped: false }

/** A turn ending: by default the person's own, answered. */
const ended = (now: number, turn: TurnKind = 'person', reason: 'answer' | 'aborted' = 'answer'): AutopilotEvent => ({ kind: 'turnComplete', reason, turn, now })

describe("Control Room's own turns", () => {
  test("a turn is recognised by its prompt, framed as Claude Code frames a plugin's message or not", () => {
    const handoff = handoffPrompt({ tokens: 77_000, window: 1_000_000, handoffFile: 'NEXT_SESSION_PROMPT.md', runNumber: 1, sessionNumber: 1, planTool: 'mcp__project-sentinel__milestones' })
    // Seen live on 2.1.293: the turn's text is the engine's frame, then the prompt.
    expect(ownPromptKind(`The cr-test plugin sent a message:\n${handoff}`)).toBe('handoff')
    expect(ownPromptKind(`The project-sentinel plugin sent a message:\r\n${handoff}`)).toBe('handoff')
    expect(ownPromptKind(handoff)).toBe('handoff')
    const continuation = continuationPrompt({ sessionNumber: 2, handoffPath: 'C:\\Web UI\\x\\NEXT_SESSION_PROMPT.md' })
    expect(ownPromptKind(`The project-sentinel plugin sent a message:\n${continuation}`)).toBe('continuation')
    // A frame worded otherwise, or on the prompt's own line, still never stalls a handoff.
    expect(ownPromptKind(`[from plugin project-sentinel]\n\n${handoff}`)).toBe('handoff')
    expect(ownPromptKind(`The project-sentinel plugin sent a message: ${handoff}`)).toBe('handoff')
    // The person's own words are the person's, even when they quote the frame.
    expect(ownPromptKind('The project-sentinel plugin sent a message: what does it mean?')).toBeNull()
    expect(ownPromptKind('Please write the final handoff for this context window')).toBeNull()
  })
})

describe('threshold', () => {
  test('tokens and percentages resolve against the live window', () => {
    expect(resolveThreshold({ mode: 'tokens', tokens: 700_000, percent: 70, window: 1_000_000, autoCompactAt: undefined }).threshold).toBe(700_000)
    expect(resolveThreshold({ mode: 'percent', tokens: 0, percent: 70, window: 1_000_000, autoCompactAt: undefined }).threshold).toBe(700_000)
    expect(resolveThreshold({ mode: 'percent', tokens: 0, percent: 70, window: undefined, autoCompactAt: undefined }).threshold).toBeNull()
  })

  test('a threshold above the window is capped inside it', () => {
    expect(resolveThreshold({ mode: 'tokens', tokens: 900_000, percent: 0, window: 200_000, autoCompactAt: undefined }).threshold).toBe(194_000)
  })

  test("the threshold is kept under Claude Code's auto-compact point", () => {
    const r = resolveThreshold({ mode: 'percent', tokens: 0, percent: 95, window: 1_000_000, autoCompactAt: 967_000 })
    expect(r.isClamped).toBe(true)
    expect(r.threshold).toBe(917_000)
    expect(resolveThreshold({ mode: 'percent', tokens: 0, percent: 70, window: 1_000_000, autoCompactAt: 967_000 }).isClamped).toBe(false)
  })
})

describe('state machine', () => {
  test('the full happy path: pending → handoff → verified → clear → resume → armed', () => {
    const r = run([
      ARM,
      { kind: 'context', tokens: 650_000, window: 1_000_000, isInTurn: true, now: 1 },
      { kind: 'context', tokens: 702_000, window: 1_000_000, isInTurn: true, now: 2 },
      ended(3),
      { kind: 'handoffStarted', now: 4 }, ended(5, 'handoff'),
      { kind: 'handoffVerified', isOk: true, now: 6 },
      { kind: 'clearDone', now: 7 },
      { kind: 'continuationStarted', now: 8 },
    ])
    expect(r.effects).toEqual(['appendPending', 'submitHandoff', 'verifyHandoff', 'clear', 'submitContinuation'])
    expect(r.model.state).toBe('armed')
    expect(r.model.completed).toBe(1)
  })

  test('a fresh context that starts near the threshold gets room to work instead of handing off after every turn', () => {
    // Seen live: a 64k handoff point and a 60k base; session 2 handed off after its first turn.
    const arm: AutopilotEvent = { kind: 'configure', enabled: true, threshold: 64_000, isClamped: false }
    const handoff: AutopilotEvent[] = [
      { kind: 'context', tokens: 66_000, window: 1_000_000, isInTurn: true, now: 1 },
      ended(2),
      { kind: 'handoffStarted', now: 3 }, ended(4, 'handoff'),
      { kind: 'handoffVerified', isOk: true, now: 5 },
      { kind: 'clearDone', now: 6 },
      { kind: 'continuationStarted', now: 7 },
    ]
    const after = run([arm, ...handoff])
    expect(after.model.isFreshContext).toBe(true)
    // Reading itself in (44k at the first request, then the notes, docs and code): no handoff yet.
    const reading = run(
      [
        { kind: 'context', tokens: 44_000, window: 1_000_000, isInTurn: true, now: 8 },
        { kind: 'context', tokens: 66_000, window: 1_000_000, isInTurn: true, now: 9 },
      ],
      CFG,
      after.model,
    )
    expect(reading.model.state).toBe('armed')
    expect(handoffPoint(reading.model)).toBe(84_000)
    // It starts working at 66k: room from there, said once.
    const working = step(reading.model, { kind: 'oriented', tokens: 66_000 }, CFG)
    expect(handoffPoint(working.model)).toBe(86_000)
    expect(working.effects.map(e => e.kind)).toEqual(['notify'])
    expect(JSON.stringify(working.effects)).toContain('hands off at 86k')
    expect(step(working.model, { kind: 'oriented', tokens: 70_000 }, CFG).model).toBe(working.model)
    const busy = run([{ kind: 'context', tokens: 80_000, window: 1_000_000, isInTurn: true, now: 10 }, ended(11)], CFG, working.model)
    expect(busy.model.state).toBe('armed')
    expect(busy.effects).toEqual([])
    const due = run([{ kind: 'context', tokens: 87_000, window: 1_000_000, isInTurn: true, now: 12 }], CFG, busy.model)
    expect(due.model.state).toBe('pending')
    // A fresh context that starts working with room to spare keeps the threshold as set, silently.
    const roomy = step(after.model, { kind: 'oriented', tokens: 30_000 }, CFG)
    expect(handoffPoint(roomy.model)).toBe(64_000)
    expect(roomy.effects).toEqual([])
    // One that fills past the threshold and its room before any work began waits for the person: no loop.
    const stuck = step(after.model, { kind: 'context', tokens: 85_000, window: 1_000_000, isInTurn: true, now: 8 }, CFG)
    expect(stuck.model.state).toBe('awaiting')
    expect(stuck.effects.map(e => e.kind)).toEqual(['notify'])
    expect(JSON.stringify(stuck.effects)).toContain('Raise the handoff point')
    // The room grows with the threshold: a tenth of it, at least 20k.
    expect(roomOf(64_000)).toBe(20_000)
    expect(roomOf(800_000)).toBe(80_000)
    // The first context of a session is not held back (a reload mid-context must not move a due handoff).
    expect(run([arm, { kind: 'context', tokens: 66_000, window: 1_000_000, isInTurn: true, now: 1 }]).model.state).toBe('pending')
  })

  test('below the threshold nothing happens', () => {
    const r = run([ARM, { kind: 'context', tokens: 699_999, window: 1_000_000, isInTurn: true, now: 1 }, ended(2)])
    expect(r.model.state).toBe('armed')
    expect(r.effects).toEqual([])
  })

  test('crossing between turns starts the handoff at once', () => {
    const r = run([ARM, { kind: 'context', tokens: 710_000, window: 1_000_000, isInTurn: false, now: 1 }])
    expect(r.model.state).toBe('requested')
    expect(r.effects).toEqual(['submitHandoff'])
  })

  test('an interrupted turn does not start the handoff', () => {
    const r = run([ARM, { kind: 'context', tokens: 710_000, window: 1_000_000, isInTurn: true, now: 1 }, ended(2, 'person', 'aborted')])
    expect(r.model.state).toBe('pending')
    expect(r.effects).toEqual(['appendPending'])
  })

  test('a missing handoff file is retried once, then the context is NOT cleared', () => {
    const r = run([
      ARM,
      { kind: 'manualHandoff', now: 1 },
      { kind: 'handoffStarted', now: 2 }, ended(3, 'handoff'),
      { kind: 'handoffVerified', isOk: false, now: 4 },
      ended(5, 'retry'),
      { kind: 'handoffVerified', isOk: false, now: 6 },
    ])
    expect(r.effects).toEqual(['submitHandoff', 'verifyHandoff', 'submitRetry', 'verifyHandoff'])
    expect(r.effects).not.toContain('clear')
    expect(r.model.state).toBe('awaiting')
  })

  test('a refused /clear falls back to compaction only when allowed', () => {
    const toClearing: AutopilotEvent[] = [ARM, { kind: 'manualHandoff', now: 1 }, { kind: 'handoffStarted', now: 2 }, ended(3, 'handoff'), { kind: 'handoffVerified', isOk: true, now: 4 }]
    const withFallback = run([...toClearing, { kind: 'clearFailed', error: 'refused' }, { kind: 'compactDone', now: 5 }, { kind: 'continuationStarted', now: 6 }])
    expect(withFallback.effects).toEqual(['submitHandoff', 'verifyHandoff', 'clear', 'compact', 'submitContinuation'])
    expect(withFallback.model.state).toBe('armed')
    const noFallback = run([...toClearing, { kind: 'clearFailed', error: 'refused' }], { ...CFG, fallbackToCompact: false })
    expect(noFallback.model.state).toBe('awaiting')
    const fresh = step(noFallback.model, { kind: 'manualFresh', now: 9 }, CFG)
    expect(fresh.effects.map(e => e.kind)).toEqual(['clear'])
  })

  test('compaction is used directly when chosen, and manual mode waits for the person', () => {
    const path: AutopilotEvent[] = [ARM, { kind: 'manualHandoff', now: 1 }, { kind: 'handoffStarted', now: 2 }, ended(3, 'handoff'), { kind: 'handoffVerified', isOk: true, now: 4 }]
    expect(run(path, { ...CFG, continuation: 'compact' }).effects.at(-1)).toBe('compact')
    expect(run(path, { ...CFG, continuation: 'manual' }).model.state).toBe('awaiting')
  })

  test('Claude Code compacting first cancels a pending handoff', () => {
    const r = run([ARM, { kind: 'context', tokens: 710_000, window: 1_000_000, isInTurn: true, now: 1 }, { kind: 'engineCompacted' }])
    expect(r.model.state).toBe('armed')
  })

  test('snooze waits for further growth', () => {
    const r = run([ARM, { kind: 'context', tokens: 710_000, window: 1_000_000, isInTurn: true, now: 1 }, { kind: 'snooze', tokens: 710_000, window: 1_000_000 }, { kind: 'context', tokens: 750_000, window: 1_000_000, isInTurn: true, now: 2 }])
    expect(r.model.state).toBe('armed')
    expect(r.model.snoozeUntil).toBe(810_000)
    const later = step(r.model, { kind: 'context', tokens: 811_000, window: 1_000_000, isInTurn: true, now: 3 }, CFG)
    expect(later.model.state).toBe('pending')
  })

  test('the person clearing resets the machine; disabling stops everything', () => {
    const pending = run([ARM, { kind: 'context', tokens: 710_000, window: 1_000_000, isInTurn: true, now: 1 }]).model
    expect(step(pending, { kind: 'externalClear' }, CFG).model.state).toBe('armed')
    expect(step(pending, { kind: 'configure', enabled: false, threshold: null, isClamped: false }, CFG).model.state).toBe('off')
  })

  test('only the handoff turn moves the handoff on: a prompt the person queued in between does not', () => {
    // The person's queued prompt runs first and ends while the handoff prompt waits behind it.
    const requested = run([ARM, { kind: 'manualHandoff', now: 1 }, ended(2, 'person')])
    expect(requested.model.state).toBe('requested')
    expect(requested.effects).toEqual(['submitHandoff'])
    // The handoff turn starts (recognised by its prompt); a person's turn ending meanwhile is not its end.
    const handing = run([{ kind: 'handoffStarted', now: 3 }, ended(4, 'person')], CFG, requested.model)
    expect(handing.model.state).toBe('handoff')
    expect(handing.effects).toEqual([])
    const done = step(handing.model, ended(5, 'handoff'), CFG)
    expect(done.model.state).toBe('verifying')
    expect(done.model.handoffSince).toBe(3)
    // Neither a continuation nor an unrelated turn ends a handoff.
    expect(step(handing.model, ended(6, 'continuation'), CFG).model.state).toBe('handoff')
  })

  test('the handoff starts when its own turn begins, also after a reload left it waiting', () => {
    const awaiting = recover(run([ARM]).model, recordOf(run([ARM, { kind: 'manualHandoff', now: 1 }]).model, 'S1', 2)!, { sessionId: 'S1' }).model
    expect(awaiting.state).toBe('awaiting')
    const started = step(awaiting, { kind: 'handoffStarted', now: 3 }, CFG)
    expect(started.model.state).toBe('handoff')
    expect(started.model.lastError).toBeNull()
    // A handoff turn beginning while nothing was asked for changes nothing.
    expect(step(run([ARM]).model, { kind: 'handoffStarted', now: 4 }, CFG).model.state).toBe('armed')
  })

  test('the person typing in the fresh context first takes over: no continuation is waited for', () => {
    const resuming = run([ARM, { kind: 'manualHandoff', now: 1 }, { kind: 'handoffStarted', now: 2 }, ended(3, 'handoff'), { kind: 'handoffVerified', isOk: true, now: 4 }, { kind: 'clearDone', now: 5 }])
    expect(resuming.model.state).toBe('resuming')
    const taken = step(resuming.model, { kind: 'personTookOver', now: 6 }, CFG)
    expect(taken.model.state).toBe('armed')
    expect(taken.model.completed).toBe(1)
    expect(step(run([ARM]).model, { kind: 'personTookOver', now: 7 }, CFG).model.completed).toBe(0)
  })

  test('handoff states are the ones that suspend the guard', () => {
    expect(isHandoffActive('pending')).toBe(true)
    expect(isHandoffActive('handoff')).toBe(true)
    // A written handoff waiting for background work is still a handoff: the guard stays stood down, nothing queued goes out.
    expect(isHandoffActive('waiting-background')).toBe(true)
    expect(isHandoffActive('armed')).toBe(false)
    expect(isHandoffActive('awaiting')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The handoff turn stops while background work runs (1.6.3). Seen in a real 801k-token run on 1.6.2:
// the handoff turn ended with a render running; Claude Code then submitted the render's notification
// (origin `task-notification`, its text the engine's `<task-notification>` report) as a turn of its
// own; that turn ended with nothing in flight, and the handoff never moved on.

const RENDER: BackgroundTask = { id: 'bgimotmfr', description: 'Render the full-resolution 16:9 picture' }
const WAITER: BackgroundTask = { id: 'b22sjex6u', description: 'Wait until the 16:9 master render finishes' }

/** A task as the machine keeps it: one given without a class is `unknown`, which is waited for (as every task was before 1.7.0). */
const kept = (t: BackgroundTask): BackgroundTask => ({ ...t, class: t.class ?? 'unknown' })

/** A turn's end as Claude Code reports it: the work its Stop listed in flight (null: no Stop seen, as for an interrupt). */
const stopped = (now: number, turn: TurnKind, background: BackgroundTask[] | null, reason: 'answer' | 'aborted' | 'error' = 'answer'): AutopilotEvent => ({
  kind: 'turnComplete',
  reason,
  turn,
  now,
  background,
})

/** The handoff turn under way (started at 2). */
const handing = (): Autopilot => run([ARM, { kind: 'manualHandoff', now: 1 }, { kind: 'handoffStarted', now: 2, turnId: 'h1' }]).model

const facts = (patch: Partial<HandoffFacts> = {}): HandoffFacts => ({ isTurnRunning: false, inFlight: [], notes: 'fresh', handoffFile: 'NEXT_SESSION_PROMPT.md', ...patch })

describe('a handoff that waits for background work', () => {
  test('the handoff turn stopping with work in flight waits for it: no notes checked, nothing cleared', () => {
    const out = step(handing(), stopped(3, 'handoff', [RENDER]), CFG)
    expect(out.model.state).toBe('waiting-background')
    expect(out.model.background).toEqual([kept(RENDER)])
    expect(out.model.waitedFor).toBe(1)
    // The wait is bounded: from the turn's end, for the patience (20 minutes by default).
    expect(out.model.waitSince).toBe(3)
    expect(out.model.waitUntil).toBe(3 + DEFAULT_WAIT_MS)
    expect(out.model.handoffTurnId).toBe('h1')
    expect(out.effects.map(e => e.kind)).toEqual(['checkNotes', 'notify'])
    expect(JSON.stringify(out.effects)).toContain('Render the full-resolution 16:9 picture')
    expect(out.model.note).toBe('Waiting for background work: Render the full-resolution 16:9 picture')
    // Notes found written for this handoff: said so.
    const seen = step(out.model, { kind: 'notesSeen', isWritten: true }, CFG)
    expect(seen.model.note).toBe('Handoff written. Waiting for background work: Render the full-resolution 16:9 picture')
    // A handoff turn stopping with nothing in flight is checked at once, as before.
    expect(step(handing(), stopped(3, 'handoff', []), CFG).model.state).toBe('verifying')
    expect(step(handing(), stopped(3, 'handoff', null), CFG).model.state).toBe('verifying')
  })

  test("the regression: the notification's turn ends with nothing in flight and the handoff finishes, whatever that turn is called", () => {
    const waiting = step(handing(), stopped(3, 'handoff', [RENDER]), CFG).model
    const ended = step(waiting, { kind: 'backgroundEnded', id: RENDER.id, status: 'completed', now: 9 }, CFG)
    expect(ended.model.state).toBe('waiting-background')
    expect(ended.model.background).toEqual([])
    expect(ended.model.backgroundEndedAt).toBe(9)
    expect(ended.effects).toEqual([])
    // 1.6.2 called this turn the person's (its text is the engine's report) and never moved on.
    for (const turn of ['notification', 'person', 'other', 'unknown', 'queued', 'handoff'] as TurnKind[]) {
      const done = step(ended.model, stopped(10, turn, []), CFG)
      expect(done.model.state).toBe('verifying')
      expect(done.effects.map(e => e.kind)).toEqual(['verifyHandoff'])
      expect(done.model.backgroundEndedAt).toBe(9)
    }
    // Without the notification seen (a reload swallowed it), the turn's Stop alone is enough.
    const direct = step(waiting, stopped(11, 'notification', []), CFG)
    expect(direct.model.state).toBe('verifying')
    expect(direct.model.backgroundEndedAt).toBe(11)
  })

  test('the whole path runs each step once: one handoff prompt, one check, one clear, one continuation', () => {
    const r = run([
      ARM,
      { kind: 'context', tokens: 801_000, window: 1_000_000, isInTurn: true, now: 1 },
      ended(2),
      { kind: 'handoffStarted', now: 3, turnId: 'h1' },
      stopped(4, 'handoff', [RENDER, WAITER]),
      { kind: 'backgroundEnded', id: RENDER.id, status: 'completed', now: 5 },
      stopped(6, 'notification', [WAITER]),
      { kind: 'backgroundEnded', id: WAITER.id, status: 'completed', now: 7 },
      stopped(8, 'notification', []),
      { kind: 'handoffVerified', isOk: true, now: 9 },
      // Late events of the finished wait change nothing.
      { kind: 'backgroundEnded', id: RENDER.id, status: 'completed', now: 10 },
      stopped(11, 'notification', []),
      { kind: 'clearDone', now: 12 },
      { kind: 'continuationStarted', now: 13 },
    ])
    expect(r.effects).toEqual(['appendPending', 'submitHandoff', 'checkNotes', 'checkNotes', 'verifyHandoff', 'clear', 'submitContinuation'])
    expect(r.model.state).toBe('armed')
    expect(r.model.completed).toBe(1)
    expect(r.model.background).toEqual([])
    expect(r.model.waitedFor).toBe(0)
  })

  test('two tasks ending separately: the first ending leaves the handoff waiting for the second', () => {
    const waiting = step(handing(), stopped(3, 'handoff', [RENDER, WAITER]), CFG).model
    expect(waiting.note).toBe('Waiting for background work: 2 background tasks')
    const one = step(waiting, { kind: 'backgroundEnded', id: WAITER.id, status: 'completed', now: 4 }, CFG).model
    expect(one.background).toEqual([kept(RENDER)])
    expect(one.backgroundEndedAt).toBeNull()
    // Its turn ends with the render still in flight: still waiting.
    const still = step(one, stopped(5, 'notification', [RENDER]), CFG)
    expect(still.model.state).toBe('waiting-background')
    expect(still.effects.map(e => e.kind)).toEqual(['checkNotes'])
    const done = step(step(still.model, { kind: 'backgroundEnded', id: RENDER.id, status: 'completed', now: 6 }, CFG).model, stopped(7, 'notification', []), CFG)
    expect(done.model.state).toBe('verifying')
    expect(done.model.waitedFor).toBe(2)
    expect(done.model.backgroundEndedAt).toBe(6)
  })

  test('a task that failed or was stopped ends the wait as one that completed: its result is still taken in', () => {
    for (const status of ['failed', 'killed', null]) {
      const waiting = step(handing(), stopped(3, 'handoff', [RENDER]), CFG).model
      const ended = step(waiting, { kind: 'backgroundEnded', id: RENDER.id, status, now: 4 }, CFG).model
      expect(ended.background).toEqual([])
      expect(step(ended, stopped(5, 'notification', []), CFG).model.state).toBe('verifying')
    }
    // Some other task's end changes nothing.
    const waiting = step(handing(), stopped(3, 'handoff', [RENDER]), CFG).model
    expect(step(waiting, { kind: 'backgroundEnded', id: 'elsewhere', status: 'completed', now: 4 }, CFG).model).toBe(waiting)
    // Inside the handoff turn a task's end changes nothing: that turn's Stop decides.
    expect(step(handing(), { kind: 'backgroundEnded', id: RENDER.id, status: 'completed', now: 4 }, CFG).model.state).toBe('handoff')
  })

  test("the person typing while the handoff waits: their turn never finishes it while work runs, nor starts a second handoff", () => {
    const waiting = step(handing(), stopped(3, 'handoff', [RENDER]), CFG).model
    const asked = step(waiting, stopped(4, 'person', [RENDER]), CFG)
    expect(asked.model.state).toBe('waiting-background')
    expect(asked.effects.map(e => e.kind)).toEqual(['checkNotes'])
    // Their turn started more work: that is waited for too.
    const more = step(waiting, stopped(4, 'person', [RENDER, WAITER]), CFG)
    expect(more.model.background).toEqual([kept(RENDER), kept(WAITER)])
    expect(more.model.waitedFor).toBe(2)
    // Interrupted with work still in flight: still waiting. Interrupted after it ended: the person decides.
    expect(step(waiting, stopped(5, 'person', null, 'aborted'), CFG).model.state).toBe('waiting-background')
    const ended = step(waiting, { kind: 'backgroundEnded', id: RENDER.id, status: 'completed', now: 5 }, CFG).model
    const cut = step(ended, stopped(6, 'notification', null, 'aborted'), CFG)
    expect(cut.model.state).toBe('awaiting')
    expect(cut.effects.map(e => e.kind)).toEqual(['notify'])
    // Nothing else moves it: no second handoff prompt, no snooze, no context crossing, no engine compaction.
    for (const event of [
      { kind: 'manualHandoff', now: 7 },
      { kind: 'snooze', tokens: 900_000, window: 1_000_000 },
      { kind: 'context', tokens: 950_000, window: 1_000_000, isInTurn: false, now: 7 },
      { kind: 'engineCompacted' },
      { kind: 'handoffStarted', now: 7 },
      { kind: 'continuationStarted', now: 7 },
      { kind: 'clearDone', now: 7 },
    ] as AutopilotEvent[]) {
      const out = step(waiting, event, CFG)
      expect(out.model.state).toBe('waiting-background')
      expect(out.effects).toEqual([])
    }
    // The person clearing the context themselves ends it.
    expect(step(waiting, { kind: 'externalClear' }, CFG).model).toMatchObject({ state: 'armed', background: [] })
  })

  test('a reload while waiting keeps waiting for the same work; the next turn to end with none in flight finishes it', () => {
    const waiting = step(handing(), stopped(3, 'handoff', [RENDER, WAITER]), CFG).model
    const record = recordOf(waiting, 'S1', 9)!
    expect(record).toMatchObject({ state: 'waiting-background', background: [kept(RENDER), kept(WAITER)], waitedFor: 2, handoffTurnId: 'h1', waitSince: 3, waitUntil: 3 + DEFAULT_WAIT_MS })
    const back = recover(run([ARM]).model, JSON.parse(JSON.stringify(record)), { sessionId: 'S1' })
    expect(back.model).toMatchObject({ state: 'waiting-background', background: [kept(RENDER), kept(WAITER)], waitedFor: 2, handoffSince: 2, handoffTurnId: 'h1', waitUntil: 3 + DEFAULT_WAIT_MS })
    expect(back.effects.map(e => e.kind)).toEqual(['checkNotes'])
    // The turn under way across the reload (its start unseen) ends with nothing in flight: no second handoff, just the check.
    expect(step(back.model, stopped(10, 'unknown', []), CFG).effects.map(e => e.kind)).toEqual(['verifyHandoff'])
    // A record from before 1.6.3 lists nothing: the next Stop says what is in flight.
    const old = recover(run([ARM]).model, { ...record, background: undefined, waitedFor: undefined, backgroundEndedAt: undefined, handoffTurnId: undefined }, { sessionId: 'S1' })
    expect(old.model.background).toEqual([])
    expect(step(old.model, stopped(10, 'unknown', [RENDER]), CFG).model.background).toEqual([kept(RENDER)])
    // A list changed by hand never throws; a task kept without a class is classified again by its words.
    expect(recover(run([ARM]).model, { ...record, background: [{ id: 3 }, 'x', RENDER] as unknown as BackgroundTask[] }, { sessionId: 'S1' }).model.background).toEqual([
      { ...RENDER, class: 'unknown', why: 'a command these rules do not recognise', by: 'rule' },
    ])
  })

  test("Claude Code's notification is read for its task and status; any other text is not one", () => {
    // As delivered on 2.1.295 (seen live).
    const text =
      '<task-notification>\n<task-id>bgimotmfr</task-id>\n<tool-use-id>toolu_015tbqomnDNoS59qyGVUsJc8</tool-use-id>\n<output-file>C:\\Users\\x\\tasks\\bgimotmfr.output</output-file>\n<status>completed</status>\n<summary>Background command "Render the full-resolution 16:9 picture" completed (exit code 0)</summary>\n</task-notification>'
    // With the tool call that started the task: a workflow run's task ends its agents.
    expect(notificationTask(text)).toEqual({ id: 'bgimotmfr', status: 'completed', toolUseId: 'toolu_015tbqomnDNoS59qyGVUsJc8' })
    expect(notificationTask(text.replace('completed</status>', 'failed</status>'))).toMatchObject({ id: 'bgimotmfr', status: 'failed' })
    expect(notificationTask('<task-notification>\n<task-id>a1</task-id>\n</task-notification>')).toEqual({ id: 'a1', status: null })
    expect(notificationTask('Please look at <task-notification><task-id>x</task-id>')).toBeNull()
    expect(notificationTask('is the handoff not done?')).toBeNull()
    expect(notificationTask('<task-notification>\n<summary>no id</summary>')).toBeNull()
  })

  test('the note riding a notification asks for the result in the notes, then the end of the turn', () => {
    const last = backgroundResultNote({ handoffFile: 'NEXT_SESSION_PROMPT.md', planTool: 'mcp__project-sentinel__milestones', left: [] })
    expect(last).toContain('`NEXT_SESSION_PROMPT.md`')
    expect(last).toContain('`mcp__project-sentinel__milestones`')
    expect(last).toContain('then end your turn')
    expect(last).toContain('The context is cleared after this turn')
    const more = backgroundResultNote({ handoffFile: 'NEXT_SESSION_PROMPT.md', planTool: null, left: [RENDER.description] })
    expect(more).toContain('Other background work is still running (Render the full-resolution 16:9 picture)')
    expect(more).not.toContain('milestones')
    // The handoff prompt says what happens to work left running.
    const prompt = handoffPrompt({ tokens: 801_000, window: 1_000_000, handoffFile: 'NEXT_SESSION_PROMPT.md', runNumber: 43, sessionNumber: 1 })
    expect(prompt).toContain('The fresh context starts after it finishes and you have recorded its result, or after 20 minutes at most')
    // A server is never waited for: the notes name it, so the fresh session reuses it.
    expect(prompt).toContain('A server or watcher you started (a dev or preview server, a --watch) is never waited for')
    expect(handoffPrompt({ tokens: undefined, window: undefined, handoffFile: 'N.md', runNumber: null, sessionNumber: 1, waitMinutes: 0 })).toContain('the fresh context starts at once and its result reaches the fresh session instead')
  })
})

// ---------------------------------------------------------------------------
// A background process is not automatically a handoff blocker (1.7.0). Seen in a real run: a written
// handoff waited for a Vite preview server Claude Code listed in flight, forever; Keep warm stood down
// and a 775k-token cache went cold two hours later. Live on Claude Code 2.1.296: background work keeps
// running across /clear and its notification reaches the fresh context.

const VITE: BackgroundTask = { id: 'bvite01', description: 'Start the Vite preview server', class: 'persistent', why: 'a Vite dev or preview server', by: 'rule', command: 'npx vite preview --port 4173' }
const SUITE: BackgroundTask = { id: 'btest01', description: 'Run the full test suite', class: 'finite', why: 'a test run', by: 'rule', command: 'npm test' }
const ODD: BackgroundTask = { id: 'bodd01', description: './scripts/go.sh', class: 'unknown', why: 'a command these rules do not recognise', by: 'rule', command: './scripts/go.sh' }

describe('a background process is not automatically a handoff blocker', () => {
  test('a server in flight never holds the written handoff: the notes are checked at once, and it is left running for the fresh context', () => {
    const out = step(handing(), stopped(3, 'handoff', [VITE]), CFG)
    expect(out.model.state).toBe('verifying')
    expect(out.effects.map(e => e.kind)).toEqual(['verifyHandoff'])
    expect(out.model.background).toEqual([])
    expect(out.model.leftRunning).toEqual([VITE])
    expect(out.model.waitedFor).toBe(0)
    // The fresh context is told; until then it is kept through the check and the clear.
    const clearing = step(out.model, { kind: 'handoffVerified', isOk: true, now: 4 }, CFG).model
    const resuming = step(clearing, { kind: 'clearDone', now: 5 }, CFG).model
    expect(resuming.leftRunning).toEqual([VITE])
    expect(step(resuming, { kind: 'leftRunningTold' }, CFG).model.leftRunning).toEqual([])
    expect(step(resuming, { kind: 'continuationStarted', now: 6 }, CFG).model.leftRunning).toEqual([])
  })

  test('finite and persistent work together: it waits for the finite work only, then leaves the server running', () => {
    const waiting = step(handing(), stopped(3, 'handoff', [VITE, SUITE]), CFG).model
    expect(waiting.state).toBe('waiting-background')
    expect(waiting.waitedFor).toBe(1)
    expect(waiting.note).toBe('Waiting for background work: Run the full test suite')
    const ended = step(waiting, { kind: 'backgroundEnded', id: SUITE.id, status: 'completed', now: 7 }, CFG).model
    expect(ended.background).toEqual([VITE])
    expect(ended.backgroundEndedAt).toBe(7)
    expect(ended.note).toBe('Background work finished. Claude records its result')
    const done = step(ended, stopped(8, 'notification', [VITE]), CFG)
    expect(done.model.state).toBe('verifying')
    expect(done.model.leftRunning).toEqual([VITE])
    expect(done.model.backgroundEndedAt).toBe(7)
    // The server's later Stops never hold anything either.
    expect(step(waiting, stopped(8, 'person', [VITE, SUITE]), CFG).model.state).toBe('waiting-background')
  })

  test('a wait is bounded: past its patience the handoff goes on and leaves the work running; under a running turn, when that turn ends', () => {
    const waiting = step(handing(), stopped(3, 'handoff', [SUITE]), CFG).model
    expect(step(waiting, { kind: 'waitExpired', now: 3 + DEFAULT_WAIT_MS - 1 }, CFG).model).toBe(waiting)
    const over = step(waiting, { kind: 'waitExpired', now: 3 + DEFAULT_WAIT_MS }, CFG)
    expect(over.model.state).toBe('verifying')
    expect(over.model.leftRunning).toEqual([SUITE])
    expect(over.model.note).toBe('Waited long enough: checking the handoff notes, leaving the work running')
    expect(over.effects.map(e => e.kind)).toEqual(['verifyHandoff'])
    // A turn running (Claude recording a result): never moved under it; its end moves it on.
    const held = step(waiting, { kind: 'waitExpired', now: 3 + DEFAULT_WAIT_MS, isTurnRunning: true }, CFG).model
    expect(held).toMatchObject({ state: 'waiting-background', skipWait: true })
    const after = step(held, stopped(4 + DEFAULT_WAIT_MS, 'notification', [SUITE]), CFG).model
    expect(after).toMatchObject({ state: 'verifying', leftRunning: [SUITE] })
    // The patience is the person's setting: none at all, or another length.
    expect(step(handing(), stopped(3, 'handoff', [SUITE]), { ...CFG, waitMs: 0 }).model).toMatchObject({ state: 'verifying', leftRunning: [SUITE] })
    expect(step(handing(), stopped(3, 'handoff', [SUITE]), { ...CFG, waitMs: 5 * 60_000 }).model.waitUntil).toBe(3 + 5 * 60_000)
  })

  test("the person's ways out: hand off now, keep waiting, call it off", () => {
    const waiting = step(handing(), stopped(3, 'handoff', [SUITE]), CFG).model
    // Hand off now, the session idle: the notes are checked at once, the work left running.
    const now = step(waiting, { kind: 'skipWait', now: 4, isTurnRunning: false }, CFG)
    expect(now.model).toMatchObject({ state: 'verifying', leftRunning: [SUITE] })
    // Typed mid-turn: when that turn ends, whatever still runs.
    const later = step(waiting, { kind: 'skipWait', now: 4, isTurnRunning: true }, CFG).model
    expect(later).toMatchObject({ state: 'waiting-background', skipWait: true })
    expect(step(later, stopped(5, 'person', [SUITE]), CFG).model).toMatchObject({ state: 'verifying', leftRunning: [SUITE] })
    // Asked before the handoff turn ended: that turn's end does not wait.
    const early = step(handing(), { kind: 'skipWait', now: 2, isTurnRunning: true }, CFG).model
    expect(step(early, stopped(3, 'handoff', [SUITE]), CFG).model).toMatchObject({ state: 'verifying', leftRunning: [SUITE] })
    const asked = run([ARM, { kind: 'manualHandoff', now: 1, skipWait: true }, { kind: 'handoffStarted', now: 2, turnId: 'h1' }]).model
    expect(asked.skipWait).toBe(true)
    expect(step(asked, stopped(3, 'handoff', [SUITE]), CFG).model.state).toBe('verifying')
    // Keep waiting: longer, from the wait's end (or now, past it); a word not to wait is taken back.
    const longer = step(waiting, { kind: 'keepWaiting', now: 10, ms: 30 * 60_000 }, CFG).model
    expect(longer.waitUntil).toBe(3 + DEFAULT_WAIT_MS + 30 * 60_000)
    expect(step(later, { kind: 'keepWaiting', now: 3 + 2 * DEFAULT_WAIT_MS, ms: 60_000 }, CFG).model).toMatchObject({ skipWait: false, waitUntil: 3 + 2 * DEFAULT_WAIT_MS + 60_000 })
    // Call it off: this context carries on, and the context's growth decides the next handoff.
    const off = step(waiting, { kind: 'cancelHandoff', tokens: 800_000, window: 1_000_000 }, CFG)
    expect(off.model).toMatchObject({ state: 'armed', snoozeUntil: 900_000, background: [], leftRunning: [], waitUntil: null, skipWait: false, note: 'Handoff called off. Watching the context' })
    expect(off.effects.map(e => e.kind)).toEqual(['notify'])
    // Past the point of calling off (the fresh context starting): nothing changes.
    const clearing = step(now.model, { kind: 'handoffVerified', isOk: true, now: 5 }, CFG).model
    expect(step(clearing, { kind: 'cancelHandoff', tokens: 1, window: undefined }, CFG).model).toBe(clearing)
  })

  test('a task the isolated classifier calls a service ends a wait it alone held; a finite verdict keeps it', () => {
    const waiting = step(handing(), stopped(3, 'handoff', [ODD]), CFG).model
    const service = { kind: 'reclassified', id: ODD.id, class: 'persistent', why: 'a long-running service, by a small isolated classification', by: 'classifier' } as const
    const idle = step(waiting, { ...service, isTurnRunning: false }, CFG)
    expect(idle.model.state).toBe('verifying')
    expect(idle.model.leftRunning).toEqual([{ ...ODD, class: 'persistent', why: service.why, by: 'classifier' }])
    // A turn running: it ends the wait at its end.
    const busy = step(waiting, { ...service, isTurnRunning: true }, CFG).model
    expect(busy.state).toBe('waiting-background')
    expect(busy.background[0]?.class).toBe('persistent')
    expect(step(busy, stopped(4, 'notification', busy.background), CFG).model.state).toBe('verifying')
    expect(step(waiting, { ...service, class: 'finite', by: 'classifier', isTurnRunning: false }, CFG).model.state).toBe('waiting-background')
  })

  test('the supervisor’s unblocked: a wait left holding only services moves on; one still holding work does not', () => {
    const waiting = step(handing(), stopped(3, 'handoff', [SUITE, VITE]), CFG).model
    expect(step(waiting, { kind: 'unblocked', now: 4 }, CFG).model).toBe(waiting)
    const ended = step(waiting, { kind: 'backgroundEnded', id: SUITE.id, status: 'killed', now: 5 }, CFG).model
    const moved = step(ended, { kind: 'unblocked', now: 40_000 }, CFG)
    expect(moved.model).toMatchObject({ state: 'verifying', leftRunning: [VITE], backgroundEndedAt: 5, note: 'Only long-running services left: checking the handoff notes' })
  })

  test('a 1.6.3 record stuck on a dev server: after the update the server no longer holds it, and its wait is bounded', () => {
    const record = {
      sessionId: 'S1',
      state: 'waiting-background',
      triggeredTokens: 775_000,
      triggeredAt: 1000,
      handoffSince: 1000,
      retries: 0,
      snoozeUntil: null,
      lastError: null,
      note: 'Handoff written. Waiting for background work: npx vite preview --port 4173',
      at: 2000,
      handoffTurnId: 'h1',
      background: [{ id: 'bvite01', description: 'npx vite preview --port 4173' }],
      waitedFor: 1,
      backgroundEndedAt: null,
    }
    const back = recover(run([ARM]).model, record, { sessionId: 'S1', now: 9_000_000, waitMs: DEFAULT_WAIT_MS })
    expect(back.model.state).toBe('waiting-background')
    expect(back.model.background).toEqual([{ id: 'bvite01', description: 'npx vite preview --port 4173', class: 'persistent', why: 'a Vite dev or preview server', by: 'rule' }])
    expect(back.model.waitUntil).toBe(2000 + DEFAULT_WAIT_MS)
    // Nothing it must wait for: the supervisor's unblocked (or any turn's end) moves it on.
    expect(step(back.model, { kind: 'unblocked', now: 9_000_000 }, CFG).model).toMatchObject({ state: 'verifying', leftRunning: [{ id: 'bvite01' }] })
    expect(step(back.model, stopped(9_000_001, 'unknown', [{ id: 'bvite01', description: 'npx vite preview --port 4173', class: 'persistent' }]), CFG).model.state).toBe('verifying')
  })

  test('/cr fresh with only a server running starts the fresh context and says it keeps running; /cr fresh now leaves finite work running too', () => {
    expect(freshVerdict(handing(), facts({ inFlight: [VITE] }))).toEqual({
      action: 'start-fresh',
      text: 'Handoff notes are valid and only long-running services are running. Starting the fresh context. Left running for the fresh context, which is told: Start the Vite preview server.',
    })
    expect(freshVerdict(handing(), facts({ inFlight: [SUITE] })).action).toBe('none')
    expect(freshVerdict(handing(), facts({ inFlight: [SUITE], isForced: true })).text).toBe(
      'Handoff notes are valid and you chose not to wait for the background work. Starting the fresh context. Left running for the fresh context, which is told: Run the full test suite.',
    )
    // Forced never skips the notes: stale notes still keep the context.
    expect(freshVerdict(handing(), facts({ inFlight: [SUITE], isForced: true, notes: 'stale' })).action).toBe('none')
    const waiting = step(handing(), stopped(3, 'handoff', [SUITE]), CFG).model
    expect(handoffVerdict(waiting, facts({ isForced: true }))).toEqual({ action: 'start-fresh', text: 'The handoff turn has ended and its notes are current. Starting the fresh context. Left running for the fresh context, which is told: Run the full test suite.' })
    // What the person leaves running goes with the clear: the fresh context is told.
    expect(step(handing(), { kind: 'manualFresh', now: 9, left: [VITE] }, CFG).model).toMatchObject({ state: 'clearing', leftRunning: [VITE] })
    expect(step(waiting, { kind: 'manualFresh', now: 9 }, CFG).model).toMatchObject({ state: 'clearing', leftRunning: [SUITE] })
  })
})

describe('/cr handoff and /cr fresh say what really happens', () => {
  const waiting = () => step(handing(), stopped(3, 'handoff', [RENDER]), CFG).model
  const finished = () => step(waiting(), { kind: 'backgroundEnded', id: RENDER.id, status: 'completed', now: 4 }, CFG).model

  test('/cr handoff hands off only when no handoff is under way, and otherwise says what the one under way is doing', () => {
    expect(handoffVerdict(run([ARM]).model, facts())).toEqual({ action: 'hand-off', text: 'Handing off: Claude is writing the handoff notes.' })
    expect(handoffVerdict(run([ARM]).model, facts({ isTurnRunning: true })).text).toBe('Handing off: Claude writes the handoff notes when the current turn ends.')
    expect(handoffVerdict(run([ARM, { kind: 'manualHandoff', now: 1 }]).model, facts())).toEqual({ action: 'none', text: 'A handoff is already starting: Claude writes the notes next.' })
    expect(handoffVerdict(handing(), facts({ isTurnRunning: true }))).toEqual({ action: 'none', text: 'A handoff is already in progress. Claude is writing the notes.' })
    // What it waits for, and the way out of the wait.
    expect(handoffVerdict(waiting(), facts())).toEqual({
      action: 'none',
      text: 'Handoff notes are written; waiting for 1 background task to finish before starting fresh (Render the full-resolution 16:9 picture). /cr handoff now hands off without waiting (it keeps running for the fresh context).',
    })
    const unwritten = step(waiting(), { kind: 'notesSeen', isWritten: false }, CFG).model
    expect(handoffVerdict(unwritten, facts()).text).toBe(
      'The handoff is waiting for 1 background task to finish before starting fresh (Render the full-resolution 16:9 picture); the notes are not written yet. /cr handoff now hands off without waiting (it keeps running for the fresh context).',
    )
    expect(handoffVerdict(finished(), facts({ isTurnRunning: true })).text).toBe('The background work has finished and Claude is recording its result. The fresh context starts when this turn ends.')
    const verifying = step(finished(), stopped(5, 'notification', []), CFG).model
    expect(handoffVerdict(verifying, facts())).toEqual({ action: 'none', text: 'Handoff is complete; Sentinel is checking the notes.' })
    const clearing = step(verifying, { kind: 'handoffVerified', isOk: true, now: 6 }, CFG).model
    expect(handoffVerdict(clearing, facts())).toEqual({ action: 'none', text: 'Handoff is complete; Sentinel is starting the fresh context.' })
  })

  test('/cr handoff on a handoff whose end went unseen finishes it when safe, and begins it again only without notes', () => {
    // 1.6.2's stranded state: a handoff whose turn ended, nothing running, the notes current.
    expect(handoffVerdict(handing(), facts()).action).toBe('start-fresh')
    expect(handoffVerdict(finished(), facts()).action).toBe('start-fresh')
    expect(handoffVerdict(handing(), facts({ inFlight: [RENDER] }))).toEqual({ action: 'none', text: 'Handoff notes are written; waiting for 1 background task to finish before starting fresh (Render the full-resolution 16:9 picture).' })
    const again = handoffVerdict(handing(), facts({ notes: 'stale' }))
    expect(again.action).toBe('hand-off')
    // The machine takes that restart from a stranded handoff only.
    const restarted = step(handing(), { kind: 'manualHandoff', now: 9, isRestart: true }, CFG)
    expect(restarted.model.state).toBe('requested')
    expect(restarted.effects.map(e => e.kind)).toEqual(['submitHandoff'])
    expect(step(handing(), { kind: 'manualHandoff', now: 9 }, CFG).effects).toEqual([])
    expect(step(step(finished(), stopped(5, 'notification', []), CFG).model, { kind: 'manualHandoff', now: 9, isRestart: true }, CFG).effects).toEqual([])
  })

  test('/cr fresh recovers a stranded handoff with valid notes, and refuses with the reason otherwise', () => {
    // The real failure: state handoff, the notes current, nothing in flight: started, through the clear.
    const stuck = freshVerdict(handing(), facts())
    expect(stuck).toEqual({ action: 'start-fresh', text: 'Handoff notes are valid and no background work is running. Starting the fresh context.' })
    expect(step(handing(), { kind: 'manualFresh', now: 9 }, CFG).effects.map(e => e.kind)).toEqual(['clear'])
    expect(freshVerdict(finished(), facts()).text).toBe('Handoff notes are valid and the background work has finished. Starting the fresh context.')
    expect(step(finished(), { kind: 'manualFresh', now: 9 }, CFG).model.state).toBe('clearing')
    // Unseen since a reload: said so, and still recovered.
    expect(freshVerdict(handing(), facts({ inFlight: null })).text).toContain('has not seen Claude Code’s list of background work since it reloaded')
    // Work genuinely still running: kept, with what runs.
    expect(freshVerdict(waiting(), facts())).toEqual({
      action: 'none',
      text: '1 background task is still running (Render the full-resolution 16:9 picture). Fresh context was not started: the handoff finishes by itself when it ends, or when its wait runs out (then it keeps running for the fresh context). /cr fresh now starts it at once and leaves it running; /cr handoff stop stops it first.',
    })
    expect(freshVerdict(handing(), facts({ inFlight: [RENDER, WAITER] })).text).toMatch(/^2 background tasks are still running \(Render the full-resolution 16:9 picture; Wait until/)
    // Notes stale, empty or missing: kept, and said why.
    expect(freshVerdict(finished(), facts({ notes: 'stale' })).text).toBe('NEXT_SESSION_PROMPT.md has not been updated for this handoff, so the context was kept. Run /cr handoff to have Claude write it.')
    expect(freshVerdict(handing(), facts({ notes: 'missing' })).text).toBe('NEXT_SESSION_PROMPT.md was not found, so the context was kept. Run /cr handoff to have Claude write it.')
    expect(freshVerdict(handing(), facts({ notes: 'empty' })).action).toBe('none')
    // A turn running in the handoff: it finishes by itself.
    expect(freshVerdict(handing(), facts({ isTurnRunning: true })).action).toBe('none')
    expect(freshVerdict(finished(), facts({ isTurnRunning: true })).text).toBe('The background work has finished and Claude is recording its result. The fresh context starts when this turn ends.')
  })

  test('/cr fresh outside a handoff never clears, and waiting for the person checks the notes first', () => {
    expect(freshVerdict(run([ARM]).model, facts())).toEqual({ action: 'none', text: 'No handoff is under way. Run /cr handoff first (it writes the notes, then continues fresh), or /clear to discard this context.' })
    expect(freshVerdict(initialAutopilot(), facts()).text).toContain('Context Autopilot is off')
    expect(freshVerdict(run([ARM, { kind: 'context', tokens: 710_000, window: 1_000_000, isInTurn: true, now: 1 }]).model, facts()).text).toContain('A handoff is due')
    // Waiting for the person after a refused clear: the notes this handoff wrote, still current.
    const refused = run([ARM, { kind: 'manualHandoff', now: 1 }, { kind: 'handoffStarted', now: 2 }, ended(3, 'handoff'), { kind: 'handoffVerified', isOk: true, now: 4 }, { kind: 'clearFailed', error: 'refused' }], { ...CFG, fallbackToCompact: false }).model
    expect(freshVerdict(refused, facts())).toEqual({ action: 'start-fresh', text: 'Handoff notes are valid. Starting the fresh context.' })
    expect(freshVerdict(refused, facts({ notes: 'stale' })).action).toBe('none')
    expect(freshVerdict(refused, facts({ inFlight: [RENDER] })).action).toBe('none')
    // A reload stopped the handoff before its turn: no notes were written in this context, so nothing is cleared.
    const interrupted = recover(run([ARM]).model, recordOf(run([ARM, { kind: 'manualHandoff', now: 1 }]).model, 'S1', 2)!, { sessionId: 'S1' }).model
    expect(freshVerdict(interrupted, facts({ notes: 'present' })).text).toBe('No handoff notes were written in this context, so it was kept. Run /cr handoff to have Claude write NEXT_SESSION_PROMPT.md.')
    // A fresh context that filled up before work began starts again from the notes it was handed.
    const filled = step(step(run([ARM, { kind: 'externalClear' }]).model, { kind: 'configure', enabled: true, threshold: 64_000, isClamped: false }, CFG).model, { kind: 'context', tokens: 90_000, window: 1_000_000, isInTurn: true, now: 3 }, CFG).model
    expect(filled.state).toBe('awaiting')
    expect(freshVerdict(filled, facts({ notes: 'present' })).action).toBe('start-fresh')
    // The machine never starts a fresh context outside a handoff the person may finish.
    for (const model of [run([ARM]).model, run([ARM, { kind: 'manualHandoff', now: 1 }]).model, step(finished(), stopped(5, 'notification', []), CFG).model]) {
      expect(step(model, { kind: 'manualFresh', now: 9 }, CFG).effects).toEqual([])
    }
  })
})

describe('a reload mid-handoff', () => {
  const armed = () => run([ARM]).model
  const at = (events: AutopilotEvent[]) => run([ARM, ...events]).model
  const crossing: AutopilotEvent = { kind: 'context', tokens: 710_000, window: 1_000_000, isInTurn: true, now: 1 }

  test('nothing is recorded while plainly watching; a snooze and every handoff step are', () => {
    expect(recordOf(armed(), 'S1', 5)).toBeNull()
    expect(recordOf(initialAutopilot(), 'S1', 5)).toBeNull()
    expect(recordOf(at([crossing]), null, 5)).toBeNull()
    expect(recordOf(at([crossing]), 'S1', 5)?.state).toBe('pending')
    expect(recordOf(at([crossing, { kind: 'snooze', tokens: 710_000, window: 1_000_000 }]), 'S1', 5)?.snoozeUntil).toBe(810_000)
  })

  test('steps that cannot be half-done resume as they were, and the turn under way moves them on', () => {
    for (const events of [[crossing], [crossing, ended(2), { kind: 'handoffStarted', now: 3 }]] as AutopilotEvent[][]) {
      const before = at(events)
      const back = recover(armed(), recordOf(before, 'S1', 9)!, { sessionId: 'S1' })
      expect(back.model.state).toBe(before.state)
      expect(back.effects).toEqual([])
      expect(back.model.handoffSince).toBe(before.handoffSince)
    }
    // The handoff turn ends after the reload (its start was never seen): the notes are checked, not asked for again.
    const handoff = recover(armed(), recordOf(at([crossing, ended(2), { kind: 'handoffStarted', now: 3 }]), 'S1', 9)!, { sessionId: 'S1' }).model
    expect(step(handoff, ended(4, 'unknown'), CFG).effects.map(e => e.kind)).toEqual(['verifyHandoff'])
    // Context still above the threshold after the reload never starts a second handoff.
    expect(step(handoff, { kind: 'context', tokens: 800_000, window: 1_000_000, isInTurn: true, now: 5 }, CFG).effects).toEqual([])
  })

  test('a check or a clear that was owed is carried out; an unsure step waits for the person', () => {
    const verifying = at([crossing, ended(2), { kind: 'handoffStarted', now: 3 }, ended(4, 'handoff')])
    expect(recover(armed(), recordOf(verifying, 'S1', 9)!, { sessionId: 'S1' }).effects.map(e => e.kind)).toEqual(['verifyHandoff'])
    const clearing = step(verifying, { kind: 'handoffVerified', isOk: true, now: 5 }, CFG).model
    expect(recover(armed(), recordOf(clearing, 'S1', 9)!, { sessionId: 'S1' }).effects.map(e => e.kind)).toEqual(['clear'])
    // Requested: the handoff prompt may or may not have gone out, so it is not sent again.
    const requested = recover(armed(), recordOf(at([{ ...crossing, isInTurn: false }]), 'S1', 9)!, { sessionId: 'S1' })
    expect(requested.model.state).toBe('awaiting')
    expect(requested.effects.map(e => e.kind)).toEqual(['notify'])
  })

  test('a record from another session, or with Autopilot off, changes nothing', () => {
    const record = recordOf(at([crossing]), 'S1', 9)!
    expect(recover(armed(), record, { sessionId: 'S2' }).model.state).toBe('armed')
    expect(recover(initialAutopilot(), record, { sessionId: 'S1' }).model.state).toBe('off')
    expect(recover(armed(), { ...record, state: 'teleporting' }, { sessionId: 'S1' }).model.state).toBe('armed')
  })
})
