import { describe, expect, test } from 'claude-code/testing'

import { type ActivityItem, ActivityTracker, changesOf, reasonOf } from '../hooks/features/activity'
import { attentionOf, groupOf, nowOf, turnSummaryOf } from '../hooks/features/digest'
import { emptyPlan, fromTodoWrite, progressOf } from '../hooks/features/plan'
import { summarize, validationKindOf } from '../hooks/features/validation'

const ROOT = 'C:/work/app'
const ctx = { root: ROOT, handoffFile: 'NEXT_SESSION_PROMPT.md' }

/** A tracker turn: each call started and finished in order, a second apart. */
function turnOf(calls: { tool: string; input: Record<string, unknown>; status: 'ok' | 'error'; text?: string; result?: unknown; ms?: number }[]): ActivityTracker {
  const t = new ActivityTracker()
  t.turnStarted(0)
  let now = 1000
  calls.forEach((c, i) => {
    t.started({ id: `c${i}`, tool: c.tool, input: c.input, agentId: undefined, now })
    now += c.ms ?? 1000
    t.finished({ id: `c${i}`, status: c.status, result: c.result ?? {}, text: c.text, now })
  })
  return t
}

describe('validation', () => {
  test('checks are recognised by their runner, the strongest naming a combined command', () => {
    const cases: [string, string | null][] = [
      ['npm test', 'tests'],
      ['npx vitest run src/a.test.ts', 'tests'],
      ['dotnet test Sim.Tests', 'tests'],
      ['claude plugin test plugins/project-sentinel', 'tests'],
      ['npx tsc -p plugins/project-sentinel', 'typecheck'],
      ['npm run typecheck && npm run validate && npm run test', 'tests'],
      ['npm run lint -- --fix', 'lint'],
      ['cargo clippy', 'lint'],
      ['npm run build', 'build'],
      ['dotnet build', 'build'],
      ['npm run check', 'check'],
      ['claude plugin validate .', 'check'],
      ['python sim.py --years 200', 'sim'],
      ['dotnet run --project PopulationSim', 'sim'],
      ['grep -r jest src', null],
      ['cat simulation.log', null],
      ['git commit -m "fix the tests"', null],
      ['echo "npm test"', null],
      ['ls tests/', null],
      ['git status', null],
    ]
    for (const [command, kind] of cases) expect(validationKindOf(command), command).toBe(kind)
  })

  test('the latest run decides; a pass after a failure reads as recovered', () => {
    const runs = [
      { kind: 'tests' as const, command: 'npm test', status: 'failed' as const, startedAt: 0, endedAt: 5000, turn: 1 },
      { kind: 'tests' as const, command: 'npm test', status: 'passed' as const, startedAt: 6000, endedAt: 9000, turn: 1 },
      { kind: 'lint' as const, command: 'eslint .', status: 'failed' as const, startedAt: 0, endedAt: 1000, turn: 1 },
    ]
    const [tests, lint] = summarize(runs, 10_000)
    expect(tests).toMatchObject({ label: 'Tests', status: 'passed', runs: 2, failures: 1, isRecovered: true, isFailing: false, durationMs: 3000 })
    expect(lint).toMatchObject({ label: 'Lint', isFailing: true })
  })
})

describe('changes', () => {
  test('real project changes are grouped; generated and temporary files are kept apart', () => {
    const cases: [string, string][] = [
      [`${ROOT}/src/render.ts`, 'code'],
      [`${ROOT}/src/render.test.ts`, 'tests'],
      [`${ROOT}/Core/LordshipTests.cs`, 'tests'],
      [`${ROOT}/Core/Contest.cs`, 'code'],
      [`${ROOT}/README.md`, 'docs'],
      [`${ROOT}/package.json`, 'config'],
      [`${ROOT}/.github/workflows/check.yml`, 'config'],
      [`${ROOT}/NEXT_SESSION_PROMPT.md`, 'generated'],
      [`${ROOT}/dist/app.js`, 'generated'],
      [`${ROOT}/.claude/settings.local.json`, 'generated'],
      ['C:/Users/me/AppData/Local/Temp/claude/scratchpad/cmp.py', 'generated'],
      ['D:/elsewhere/notes.txt', 'generated'],
      [`${ROOT}/assets/logo.png`, 'other'],
    ]
    for (const [path, group] of cases) expect(groupOf(path, ctx), path).toBe(group)
  })

  test('a file written whole counts its lines; a file a command created has no diff, never "+0 −0"', () => {
    const [created] = changesOf('Write', { type: 'create', filePath: `${ROOT}/a.ts`, content: 'one\ntwo\nthree\n', structuredPatch: [], originalFile: null })
    expect(created).toMatchObject({ hasDiff: true, added: 3, isCreated: true })
    const [made] = changesOf('Bash', { stdout: '', stderr: '', interrupted: false, bashEditDiff: { files: [{ filePath: `${ROOT}/b.sh`, hunks: [], created: true }], moreFiles: 0 } })
    expect(made).toMatchObject({ hasDiff: false, isCreated: true })
    const t = turnOf([{ tool: 'Write', input: { file_path: `${ROOT}/a.ts` }, status: 'ok', result: { type: 'create', filePath: `${ROOT}/a.ts`, content: 'x\ny', structuredPatch: [], originalFile: null } }])
    expect(t.changes.get(`${ROOT}/a.ts`)).toMatchObject({ added: 2, removed: 0, hasDiff: true })
  })
})

describe('attention', () => {
  test('a failure a later attempt fixed reads as recovered; one that keeps failing stays open with its tries', () => {
    const t = turnOf([
      { tool: 'Edit', input: { file_path: `${ROOT}/src/a.ts` }, status: 'error', text: 'String to replace not found in file.' },
      { tool: 'Edit', input: { file_path: `${ROOT}/src/a.ts` }, status: 'ok' },
      { tool: 'Bash', input: { command: 'npm test' }, status: 'error', text: 'Exit code 1\nFAIL src/a.test.ts' },
      { tool: 'Bash', input: { command: 'npm test' }, status: 'error', text: 'Exit code 1\nFAIL src/b.test.ts' },
    ])
    const list = attentionOf(t.items, 100_000)
    expect(list.map(a => `${a.kind}:${a.state}:${a.attempts}`)).toEqual(['failed:unresolved:2', 'failed:recovered:1'])
    expect(list[0]!.reason).toBe('FAIL src/b.test.ts')
    expect(list[1]!.reason).toBe('String to replace not found in file.')
  })

  test('the reason is the line that says why, not the exit status or the runner echoing its script', () => {
    expect(reasonOf('Exit code 1\nnpm error Missing script: "lint"\nnpm error\nnpm error Did you mean this?')).toBe('npm error Missing script: "lint"')
    expect(reasonOf('Exit code 1\n> orbit@0.1.0 test\n> node --test\n\nTAP version 13\n# Subtest: the ISS\nnot ok 1 - the ISS\n  ---')).toBe('not ok 1 - the ISS')
    expect(reasonOf('Exit code 1\n=================== FAILURES ===================\n    def test_y():\nE       AssertionError: assert 1 == 2')).toBe('E AssertionError: assert 1 == 2')
    expect(reasonOf('Exit code 2\nsrc/a.ts: unused variable')).toBe('src/a.ts: unused variable')
    expect(reasonOf('Exit code 1')).toBe('Exit code 1')
    expect(reasonOf('<tool_use_error>Error:\nFile has not been read yet.</tool_use_error>')).toBe('File has not been read yet.')
    expect(reasonOf(undefined)).toBeNull()
  })

  test('refused and held calls, long-running and unusually slow ones are named; quick successes are not', () => {
    const t = new ActivityTracker()
    t.turnStarted(0)
    t.refused({ id: 'd', tool: 'Bash', input: { command: 'rm -rf dist' }, agentId: undefined, now: 1, status: 'denied', reason: 'Permission Policy: Deleting files is set to Deny' })
    t.refused({ id: 'h', tool: 'Bash', input: { command: 'npm run build' }, agentId: undefined, now: 2, status: 'held', reason: 'Held back' })
    t.started({ id: 'r', tool: 'Bash', input: { command: 'npm test' }, agentId: undefined, now: 3 })
    t.started({ id: 's', tool: 'WebFetch', input: { url: 'https://example.com/a' }, agentId: undefined, now: 4 })
    t.finished({ id: 's', status: 'ok', result: {}, now: 60_004 })
    t.started({ id: 'q', tool: 'Read', input: { file_path: `${ROOT}/a.ts` }, agentId: undefined, now: 5 })
    t.finished({ id: 'q', status: 'ok', result: {}, now: 6 })
    const kinds = attentionOf(t.items, 30_000).map(a => a.kind)
    expect(kinds).toEqual(['blocked', 'held', 'running', 'slow'])
  })
})

describe('this turn and now', () => {
  test('the turn reads as a few counted lines', () => {
    const t = turnOf([
      { tool: 'Read', input: { file_path: `${ROOT}/src/a.ts` }, status: 'ok' },
      { tool: 'Read', input: { file_path: `${ROOT}/src/b.ts` }, status: 'ok' },
      { tool: 'Grep', input: { pattern: 'render' }, status: 'ok' },
      { tool: 'Edit', input: { file_path: `${ROOT}/src/a.ts` }, status: 'ok', result: { filePath: `${ROOT}/src/a.ts`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } },
      { tool: 'Write', input: { file_path: `${ROOT}/src/a.test.ts` }, status: 'ok', result: { type: 'create', filePath: `${ROOT}/src/a.test.ts`, content: 'x', structuredPatch: [] } },
      { tool: 'Bash', input: { command: 'npm test' }, status: 'error', text: 'Exit code 1' },
      { tool: 'Bash', input: { command: 'npm test' }, status: 'ok' },
    ])
    const lines = turnSummaryOf({
      items: t.items,
      changed: [...t.changes.values()],
      groupOf: p => groupOf(p, ctx),
      validation: summarize(t.validationRuns(), 100_000),
      attention: attentionOf(t.items, 100_000),
      milestonesDone: 1,
    })
    expect(lines).toEqual(['Changed 2 files · 1 in code, 1 in tests', 'Ran tests twice, passing after a fix', 'Read 2 files · 1 search', '1 failure recovered', 'Finished 1 milestone'])
  })

  test('now: a running check, else the milestone in Claude’s words, else the running call, else thinking', () => {
    const plan = fromTodoWrite(emptyPlan(), [{ content: 'Optimise the population simulation', status: 'in_progress', activeForm: 'Optimising population simulation' }], 1, 1)
    const t = new ActivityTracker()
    t.turnStarted(0)
    const running = (): ActivityItem[] => t.runningItems()
    expect(nowOf({ isTurnRunning: false, running: running(), progress: progressOf(plan) })).toBeNull()
    expect(nowOf({ isTurnRunning: true, running: running(), progress: progressOf(emptyPlan()) })?.text).toBe('Thinking')
    expect(nowOf({ isTurnRunning: true, running: running(), progress: progressOf(plan) })?.text).toBe('Optimising population simulation')
    t.started({ id: 'e', tool: 'Edit', input: { file_path: `${ROOT}/src/renderer.ts` }, agentId: undefined, now: 1 })
    expect(nowOf({ isTurnRunning: true, running: running(), progress: progressOf(emptyPlan()) })?.text).toBe('Editing renderer.ts')
    t.started({ id: 'v', tool: 'Bash', input: { command: 'npm test' }, agentId: undefined, now: 2 })
    expect(nowOf({ isTurnRunning: true, running: running(), progress: progressOf(plan) })?.text).toBe('Running tests')
  })

  test('a shell call is named by the command doing the work, past a cd or an environment setting', () => {
    // Seen live in the Desktop app: every call of a session began `cd "/c/Game Dev/GRAVELINE" && …`, and the
    // status bar said "Running cd" through a build.
    const doing = (command: string): string | undefined => {
      const t = new ActivityTracker()
      t.turnStarted(0)
      t.started({ id: 's', tool: 'Bash', input: { command }, agentId: undefined, now: 1 })
      return nowOf({ isTurnRunning: true, running: t.runningItems(), progress: progressOf(emptyPlan()) })?.text
    }
    expect(doing('cd "/c/Game Dev/GRAVELINE" && cat .claude/launch.json && echo "---"')).toBe('Running cat')
    expect(doing(`cd "/c/Game Dev/GRAVELINE" && git log -8 --format='%ci %h %s'`)).toBe('Running git log')
    expect(doing('cd /work; NODE_ENV=production node build.mjs')).toBe('Running node')
    expect(doing('Set-Location C:\\work; python tools\\gen.py')).toBe('Running python')
    expect(doing(`$env:DEBUG='1'; node server.js`)).toBe('Running node')
    expect(doing('export PORT=5191 && node dev-server.mjs')).toBe('Running node')
    // Nothing but the setting up: it is still named.
    expect(doing('cd /work')).toBe('Running cd')
    expect(doing('ls -la')).toBe('Running ls')
  })
})
