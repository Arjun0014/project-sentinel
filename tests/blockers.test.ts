import { describe, expect, test } from 'claude-code/testing'

import type { BackgroundTask } from '../hooks/features/autopilot'
import { CLASSIFIER_LABELS, classifierText, classifyTask, isBlocking, verdictOfLabel } from '../hooks/features/background'
import { handoffIntentOf, normalizeIntent } from '../hooks/features/intent'
import { QUIET_MS, type SupervisorInput, diagnose, dueStep, toClassify, traceLine } from '../hooks/features/supervisor'

// What a handoff waits for (features/background.ts), what holds it and for how long (features/supervisor.ts),
// and the person's words about it (features/intent.ts). Tasks are worded as Claude Code's Stop lists them
// (`background_tasks`, seen live on 2.1.296: a shell's `command`, and Claude's `description` or the command again).

const shell = (command: string, description = command) => ({ id: 'b1', type: 'shell', description, command })

describe('which background work holds a written handoff', () => {
  test('servers, watchers, tunnels and followers are persistent: never waited for', () => {
    const persistent = [
      'npx vite preview --port 4173',
      'vite',
      'npm run dev',
      'pnpm dev',
      'yarn start',
      'npm run preview -- --host',
      'bun run storybook',
      'next dev -p 3001',
      'python -m http.server 8766',
      'python3 -m http.server',
      'uvicorn app.main:app --reload',
      'flask run --port 5000',
      'python manage.py runserver',
      'rails s',
      'php -S localhost:8000',
      'npx http-server dist',
      'npx serve -s build',
      'tsc -w -p .',
      'vitest --watch',
      'jest --watchAll',
      'nodemon server.js',
      'node --watch index.js',
      'cargo watch -x run',
      'docker compose up',
      'ngrok http 3000',
      'kubectl port-forward svc/api 8080:80',
      'tail -f logs/app.log',
      'redis-server',
      'while true; do date; sleep 5; done',
      'jupyter lab --no-browser',
    ]
    for (const command of persistent) expect(classifyTask(shell(command)), command).toMatchObject({ class: 'persistent', by: 'rule' })
    expect(classifyTask(shell('npx vite preview --port 4173')).why).toBe('a Vite dev or preview server')
    // A watcher outranks the check it runs; a detached compose returns at once.
    expect(classifyTask(shell('vitest --watch')).class).toBe('persistent')
    expect(classifyTask(shell('docker compose up -d')).class).not.toBe('persistent')
    // Inside a shell's quoted command, as Claude sometimes runs it.
    expect(classifyTask(shell('bash -c "npm run dev"')).class).toBe('persistent')
  })

  test('tests, builds, type-checks, renders, installs, transfers and timed waits are finite: waited for', () => {
    const finite = ['npm test', 'pnpm vitest run', 'pytest -x', 'cargo test', 'npm run build', 'vite build', 'tsc --noEmit', 'ffmpeg -i in.mov out.mp4', 'npx remotion render', 'npm install', 'pip install -r requirements.txt', 'curl -O https://example.com/a.zip', 'git clone https://x/y', 'sleep 120; echo DONE > done.txt', 'docker build -t app .']
    for (const command of finite) expect(classifyTask(shell(command)), command).toMatchObject({ class: 'finite', by: 'rule' })
    expect(classifyTask(shell('vite build')).class).toBe('finite')
  })

  test('agents and workflows report back: waited for; a monitor watches a stream: never waited for', () => {
    expect(classifyTask({ id: 'a1', type: 'subagent', description: 'Slow agent', agentType: 'general-purpose' })).toEqual({ class: 'agent', why: 'a background agent (general-purpose)', by: 'rule' })
    expect(classifyTask({ id: 'w1', type: 'workflow', description: 'review', name: 'review-changes' })).toEqual({ class: 'agent', why: 'a workflow (review-changes)', by: 'rule' })
    expect(classifyTask({ id: 'm1', type: 'monitor', description: 'errors in deploy.log' }).class).toBe('persistent')
  })

  test("Claude's own words for an unrecognised command decide when they say server or watcher; otherwise unknown, which is waited for", () => {
    expect(classifyTask(shell('./bin/run.sh --port 9000', 'Start the local API server on port 9000')).class).toBe('persistent')
    expect(classifyTask(shell('./scripts/go.sh', 'Run the migration script'))).toEqual({ class: 'unknown', why: 'a command these rules do not recognise', by: 'rule' })
    // A description never makes a known finite command persistent.
    expect(classifyTask(shell('npm test', 'Run the tests while the dev server keeps serving')).class).toBe('finite')
    // Words inside quotes are data, not the command.
    expect(classifyTask(shell('echo "npm run dev"')).class).toBe('unknown')
    expect(isBlocking('persistent')).toBe(false)
    for (const c of ['finite', 'agent', 'unknown'] as const) expect(isBlocking(c)).toBe(true)
  })

  test('the isolated classifier is given the command and description only, and its labels map to classes', () => {
    const text = classifierText(shell('./serve.sh', 'Serve the docs'))
    expect(text).toContain('COMMAND: ./serve.sh')
    expect(text).toContain('DESCRIPTION: Serve the docs')
    expect(CLASSIFIER_LABELS).toEqual(['persistent_service', 'finite_job', 'unclear'])
    expect(verdictOfLabel('persistent_service')?.class).toBe('persistent')
    expect(verdictOfLabel('finite_job')).toMatchObject({ class: 'finite', by: 'classifier' })
    expect(verdictOfLabel('unclear')).toBeNull()
    expect(verdictOfLabel(undefined)).toBeNull()
  })
})

const SUITE: BackgroundTask = { id: 'btest01', description: 'Run the full test suite', class: 'finite' }
const VITE: BackgroundTask = { id: 'bvite01', description: 'Start the Vite preview server', class: 'persistent' }
const ODD: BackgroundTask = { id: 'bodd01', description: './scripts/go.sh', class: 'unknown', by: 'rule' }

const look = (patch: Partial<SupervisorInput>): SupervisorInput => ({
  now: 100_000,
  state: 'waiting-background',
  stateSince: 40_000,
  isTurnRunning: false,
  isHandoffTurn: false,
  background: [SUITE],
  waitSince: 40_000,
  waitUntil: 40_000 + 20 * 60_000,
  skipWait: false,
  notesWritten: true,
  questionsOpen: 0,
  quietMs: 60_000,
  lastError: null,
  continuation: 'clear',
  ...patch,
})

describe('the Handoff Supervisor', () => {
  test('a wait for finite work: waiting, with the time it goes on by itself and every way out', () => {
    const d = diagnose(look({}))
    expect(d).toMatchObject({ status: 'waiting', phase: 'Waiting for background work', forMs: 60_000, goesOnAt: 40_000 + 20 * 60_000 })
    expect(d.blocker).toEqual({ kind: 'finite', text: 'waiting for Run the full test suite' })
    expect(d.actions).toEqual(['handoff-now', 'stop-and-handoff', 'keep-waiting', 'cancel'])
    expect(traceLine(d)).toBe('supervisor: Waiting for background work for 1m · waiting · finite: waiting for Run the full test suite')
    // Only unrecognised work: said so.
    expect(diagnose(look({ background: [ODD] })).blocker?.kind).toBe('unknown')
    // Notes not written yet: said so.
    expect(diagnose(look({ notesWritten: false })).blocker?.text).toBe('Notes not written yet; waiting for Run the full test suite')
  })

  test('a server beside the handoff holds nothing: moving, and said to keep running', () => {
    expect(diagnose(look({ background: [VITE] }))).toMatchObject({ status: 'moving', blocker: { kind: 'persistent', text: 'Start the Vite preview server keeps running and is not waited for' } })
  })

  test('past the patience: stalled (long finite work), and the one step it takes by itself is due', () => {
    const over = look({ now: 40_000 + 20 * 60_000 })
    expect(diagnose(over)).toMatchObject({ status: 'stalled', blocker: { kind: 'long-finite' } })
    expect(dueStep({ ...over, quietMs: 0 })).toBe('waitExpired')
    // Under a running turn too: the machine waits for that turn's end itself.
    expect(dueStep({ ...over, isTurnRunning: true, quietMs: 0 })).toBe('waitExpired')
    // Already told not to wait: nothing more is due.
    expect(dueStep({ ...over, skipWait: true, quietMs: 0 })).toBeNull()
    expect(dueStep({ ...look({}), quietMs: 10 * QUIET_MS })).toBeNull()
  })

  test('a wait holding only services moves on once the session is quiet, never under a turn or a recent call', () => {
    const servers = look({ background: [VITE] })
    expect(dueStep({ ...servers, quietMs: QUIET_MS })).toBe('unblocked')
    expect(dueStep({ ...servers, quietMs: QUIET_MS - 1 })).toBeNull()
    expect(dueStep({ ...servers, quietMs: null })).toBeNull()
    expect(dueStep({ ...servers, isTurnRunning: true, quietMs: 10 * QUIET_MS })).toBeNull()
    expect(dueStep({ ...look({ background: [] }), quietMs: QUIET_MS })).toBe('unblocked')
    expect(dueStep({ ...look({ state: 'handoff' }), quietMs: QUIET_MS })).toBeNull()
  })

  test('a question open to the person holds any handoff turn: needs you', () => {
    expect(diagnose(look({ state: 'handoff', isTurnRunning: true, isHandoffTurn: true, questionsOpen: 1 }))).toMatchObject({ status: 'needs-you', blocker: { kind: 'decision-blocking' } })
    expect(diagnose(look({ state: 'armed', isTurnRunning: true, questionsOpen: 1 })).status).toBe('idle')
  })

  test('steps whose event never came are called stalled after their time, never sooner', () => {
    expect(diagnose(look({ state: 'requested', stateSince: 100_000 - 60_000 })).status).toBe('moving')
    expect(diagnose(look({ state: 'requested', stateSince: 100_000 - 2 * 60_000 }))).toMatchObject({ status: 'stalled', blocker: { kind: 'turn' }, actions: ['hand-off', 'cancel'] })
    // A handoff state with no turn running and a quiet session: its turn's end went unseen.
    expect(diagnose(look({ state: 'handoff' }))).toMatchObject({ status: 'stalled', actions: ['start-fresh', 'hand-off', 'cancel'] })
    // Activity a moment ago (a turn a reload hid, still calling tools): it is still writing.
    expect(diagnose(look({ state: 'handoff', quietMs: 5_000 })).status).toBe('moving')
    expect(diagnose(look({ state: 'handoff', quietMs: null })).status).toBe('moving')
    expect(diagnose(look({ state: 'handoff', isTurnRunning: true })).status).toBe('moving')
    expect(diagnose(look({ state: 'verifying', stateSince: 100_000 - 61_000 })).status).toBe('stalled')
    expect(diagnose(look({ state: 'clearing', isTurnRunning: true, stateSince: 0 }))).toMatchObject({ status: 'moving', blocker: { kind: 'turn' } })
    expect(diagnose(look({ state: 'awaiting', lastError: 'handoff file not written' }))).toMatchObject({ status: 'needs-you', blocker: { text: 'The handoff stopped: handoff file not written' } })
    expect(diagnose(look({ state: 'armed' })).status).toBe('idle')
  })

  test('the isolated classifier is asked about an unrecognised task once, after a minute of waiting', () => {
    const asked = new Set<string>()
    expect(toClassify({ now: 40_000 + 59_000, waitSince: 40_000, background: [ODD, SUITE, VITE], asked })).toEqual([])
    expect(toClassify({ now: 40_000 + 60_000, waitSince: 40_000, background: [ODD, SUITE, VITE], asked })).toEqual([ODD])
    asked.add(ODD.id)
    expect(toClassify({ now: 40_000 + 120_000, waitSince: 40_000, background: [ODD], asked })).toEqual([])
    // Never one the classifier or the person already decided.
    expect(toClassify({ now: 1e9, waitSince: 0, background: [{ ...ODD, by: 'classifier' }], asked: new Set() })).toEqual([])
  })
})

describe("the person's words about a handoff", () => {
  test('the request’s own examples, and their usual variants, are handoff controls', () => {
    const cases: [string, string][] = [
      ['handoff now', 'handoff-now'],
      ['Hand off now.', 'handoff-now'],
      ['hand-off', 'handoff-now'],
      ['ok, do the handoff', 'handoff-now'],
      ['please proceed with the handoff', 'handoff-now'],
      ["don't wait for the background process", 'skip-wait'],
      ['Do not wait for the server!', 'skip-wait'],
      ['stop waiting', 'skip-wait'],
      ['skip the wait', 'skip-wait'],
      ['ignore the dev server', 'skip-wait'],
      ['leave it running and hand off', 'skip-wait'],
      ['start the fresh session now', 'fresh-now'],
      ['Start a new context', 'fresh-now'],
      ['fresh session', 'fresh-now'],
      ['clear the context', 'fresh-now'],
      ['keep waiting', 'keep-waiting'],
      ['wait for the tests to finish', 'keep-waiting'],
      ['let it finish', 'keep-waiting'],
      ['stop the server and hand off', 'stop-and-handoff'],
      ['kill the render then handoff', 'stop-and-handoff'],
      ['cancel the handoff', 'cancel'],
      ["don't hand off yet", 'cancel'],
      ['call off the handoff', 'cancel'],
      ['stay in this session', 'cancel'],
    ]
    for (const [text, intent] of cases) expect(handoffIntentOf(text), text).toBe(intent)
  })

  test('work for Claude is never a control: longer requests, bare yes or go ahead, questions about the handoff', () => {
    for (const text of [
      'go ahead',
      'continue',
      'yes',
      'is the handoff not done?',
      'Also note the render settings in the README before you hand off.',
      'Fix the failing test, then hand off when it passes and update the notes with the result please',
      'wait',
      'stop',
      'What does the handoff wait for?',
      'start the dev server again',
      'line one\nhandoff now',
    ]) {
      expect(handoffIntentOf(text), text).toBeNull()
    }
    expect(normalizeIntent('  OK, please Hand off NOW!! ')).toBe('hand off')
  })
})
