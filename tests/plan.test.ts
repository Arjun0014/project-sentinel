import { describe, expect, test } from 'claude-code/testing'

import { applyTool, emptyPlan, fromMilestones, fromTodoWrite, isNewWork, isSameMilestone, objectiveOf, planOf, progressOf } from '../hooks/features/plan'
import { continuationContext } from '../hooks/features/prompts'

const todo = (content: string, status: 'pending' | 'in_progress' | 'completed', activeForm = `${content}ing`) => ({ content, status, activeForm })

describe('run plan', () => {
  test('a TodoWrite list is the plan: done of total, the task under way and the next one', () => {
    const plan = fromTodoWrite(emptyPlan(), [todo('Parse input', 'completed'), todo('Write tests', 'in_progress', 'Writing tests'), todo('Update docs', 'pending')], 1, 10)
    const p = progressOf(plan)
    expect([p.done, p.total]).toEqual([1, 3])
    expect(p.current?.activeForm).toBe('Writing tests')
    expect(p.next?.subject).toBe('Update docs')
  })

  test('the milestone in progress is the one under way, ahead of later ones still being verified', () => {
    // This run's own list after a handoff: an early milestone in hand, later ones built and awaiting review.
    const plan = fromMilestones(
      emptyPlan(),
      {
        milestones: [
          { title: 'Understand the code', status: 'completed', evidence: 'read' },
          { title: 'Verify the cache against the API', status: 'in_progress', doing: 'Checking the second refresh' },
          { title: 'Verify the handoff', status: 'pending' },
          { title: 'Redesign the status bar', status: 'verifying', evidence: 'tests pass' },
          { title: 'Redesign Kit', status: 'verifying', evidence: 'contact sheet' },
        ],
      },
      2,
      10,
    )
    expect(progressOf(plan).current?.subject).toBe('Verify the cache against the API')
    // With nothing in progress, the latest one being verified is what Claude is on.
    const checking = fromMilestones(plan, { milestones: [{ title: 'Redesign the status bar', status: 'verifying' }, { title: 'Redesign Kit', status: 'verifying' }] }, 2, 20)
    expect(progressOf(checking).current?.subject).toBe('Redesign Kit')
  })

  test('new work is another objective naming none of the plan’s milestones; a reworded objective or a shared milestone is the same work', () => {
    const done = fromMilestones(emptyPlan(), { milestones: [{ title: 'Ship the release', status: 'completed' }, { title: 'Write the report', status: 'completed' }] }, 1, 10)
    const video = { milestones: [{ title: 'Storyboard the video', status: 'in_progress' }, { title: 'Render both formats', status: 'pending' }] }
    expect(isNewWork(done, video, true)).toBe(true)
    // The same objective (a rewritten list mid-run) keeps what was finished.
    expect(isNewWork(done, video, false)).toBe(false)
    // A list that carries any old milestone continues the work.
    expect(isNewWork(done, { milestones: [{ title: 'Write the report', status: 'completed' }, { title: 'Render both formats', status: 'pending' }] }, true)).toBe(false)
    expect(isNewWork(emptyPlan(), video, true)).toBe(false)
    expect(isNewWork(done, { milestones: [] }, true)).toBe(false)
  })

  test('a rewritten list drops open work it no longer names, but never forgets finished work', () => {
    const first = fromTodoWrite(emptyPlan(), [todo('A', 'completed'), todo('B', 'in_progress'), todo('C', 'pending')], 1, 10)
    const second = fromTodoWrite(first, [todo('B', 'completed'), todo('D', 'pending')], 1, 20)
    expect(second.tasks.map(t => `${t.subject}:${t.status}`)).toEqual(['A:completed', 'B:completed', 'D:pending'])
    expect(second.tasks[0]!.doneAt).toBe(10)
  })

  test('after a handoff the fresh context carries the run: earlier open work stays until named or dropped; a reworded title is the same milestone, in its place', () => {
    // Seen in a real run (1.7.0): the fresh context's first, partial list dropped the run's open milestones and the
    // Work track read as unrelated new work while the code work went on from the notes.
    const before = fromTodoWrite(
      emptyPlan(),
      [todo('Write the parser', 'completed'), todo('Wire the CLI', 'completed'), todo('Fix the cache scheduler', 'in_progress'), todo('Document the flags', 'pending'), todo('Benchmark startup', 'pending')],
      1,
      10,
    )
    // Session 2 writes a partial list from the notes: the scheduler reworded, the docs dropped, the benchmark left out.
    const after = fromTodoWrite(before, [todo('Fix cache scheduler races', 'in_progress'), { content: 'Document the flags', status: 'dropped' }, todo('Release notes', 'pending')], 2, 20)
    expect(after.tasks.map(t => `${t.subject}:${t.status}:${t.session}`)).toEqual([
      'Write the parser:completed:1',
      'Wire the CLI:completed:1',
      'Fix cache scheduler races:in_progress:2',
      'Benchmark startup:pending:1',
      'Release notes:pending:2',
    ])
    expect(progressOf(after)).toMatchObject({ done: 2, total: 5 })
    // The reworded milestone took its new title's key: the next list matches it exactly, and it is not carried twice.
    const third = fromTodoWrite(after, [todo('Fix cache scheduler races', 'completed'), todo('Release notes', 'in_progress')], 2, 30)
    expect(third.tasks.map(t => `${t.subject}:${t.status}`)).toEqual(['Write the parser:completed', 'Wire the CLI:completed', 'Fix cache scheduler races:completed', 'Benchmark startup:pending', 'Release notes:in_progress'])
    // Within one session a rewritten list stays authoritative for the open work that session wrote.
    const fourth = fromTodoWrite(third, [todo('Benchmark startup', 'in_progress')], 2, 40)
    expect(fourth.tasks.map(t => t.subject)).toEqual(['Write the parser', 'Wire the CLI', 'Fix cache scheduler races', 'Benchmark startup'])
    expect(isSameMilestone('Fix the cache scheduler', 'Fix cache scheduler races')).toBe(true)
    expect(isSameMilestone('Fix the cache scheduler', 'Document the cache')).toBe(false)
    expect(isSameMilestone('C', 'Finish C')).toBe(false)
  })

  test('the Task tools: a fresh session’s own task list (new ids) never drops the run’s carried open tasks', () => {
    let plan = applyTool(emptyPlan(), { tool: 'TaskCreate', input: { subject: 'Port the renderer', description: '' }, result: { task: { id: '1', subject: 'Port the renderer' } }, session: 1, now: 1 })
    plan = applyTool(plan, { tool: 'TaskCreate', input: { subject: 'Profile the hot loop', description: '' }, result: { task: { id: '2', subject: 'Profile the hot loop' } }, session: 1, now: 2 })
    plan = applyTool(plan, { tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, result: {}, session: 1, now: 3 })
    // Session 2: Claude Code's task list starts over; TaskList names only the new session's tasks.
    plan = applyTool(plan, { tool: 'TaskCreate', input: { subject: 'Write the migration guide', description: '' }, result: { task: { id: '1', subject: 'Write the migration guide' } }, session: 2, now: 4 })
    plan = applyTool(plan, { tool: 'TaskList', input: {}, result: { tasks: [{ id: '1', subject: 'Write the migration guide', status: 'in_progress' }] }, session: 2, now: 5 })
    expect(plan.tasks.map(t => `${t.subject}:${t.status}`)).toEqual(['Port the renderer:completed', 'Profile the hot loop:pending', 'Write the migration guide:in_progress'])
  })

  test('the Task tools build the plan by id; a deleted task leaves it, TaskList is the truth', () => {
    let plan = emptyPlan()
    plan = applyTool(plan, { tool: 'TaskCreate', input: { subject: 'Build parser', description: '', activeForm: 'Building the parser' }, result: { task: { id: '1', subject: 'Build parser' } }, session: 1, now: 1 })
    plan = applyTool(plan, { tool: 'TaskCreate', input: { subject: 'Ship', description: '' }, result: { task: { id: '2', subject: 'Ship' } }, session: 1, now: 2 })
    plan = applyTool(plan, { tool: 'TaskCreate', input: { subject: 'Spike', description: '' }, result: { task: { id: '3', subject: 'Spike' } }, session: 1, now: 3 })
    plan = applyTool(plan, { tool: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' }, result: { success: true }, session: 1, now: 4 })
    plan = applyTool(plan, { tool: 'TaskUpdate', input: { taskId: '3', status: 'deleted' }, result: { success: true }, session: 1, now: 5 })
    expect(progressOf(plan)).toMatchObject({ done: 0, total: 2 })
    expect(progressOf(plan).current?.activeForm).toBe('Building the parser')
    plan = applyTool(plan, { tool: 'TaskList', input: {}, result: { tasks: [{ id: '1', subject: 'Build parser', status: 'completed', blockedBy: [] }, { id: '2', subject: 'Ship', status: 'pending', blockedBy: [] }] }, session: 1, now: 6 })
    expect(progressOf(plan)).toMatchObject({ done: 1, total: 2 })
    // Any other tool, or a malformed result, leaves the plan as it was.
    expect(applyTool(plan, { tool: 'Read', input: {}, result: {}, session: 1, now: 7 })).toBe(plan)
    expect(applyTool(plan, { tool: 'TaskCreate', input: { subject: 'x' }, result: 'oops', session: 1, now: 8 })).toBe(plan)
  })

  test('a stored plan is validated: anything malformed reads as no plan', () => {
    expect(planOf(undefined).tasks).toEqual([])
    expect(planOf({ tasks: 'x' }).tasks).toEqual([])
    expect(planOf({ tasks: [{ subject: 'A', status: 'done' }, { subject: 'B', status: 'pending' }] }).tasks.map(t => t.subject)).toEqual(['B'])
  })

  test('the objective is the request in its own words, never a bare "yes"', () => {
    expect(objectiveOf('Redesign Activity around signal instead of raw tool spam. Then update the docs.')).toBe('Redesign Activity around signal instead of raw tool spam.')
    expect(objectiveOf('/cr status\nFix the flaky login test')).toBe('Fix the flaky login test')
    expect(objectiveOf('yes')).toBeNull()
    expect(objectiveOf('   ')).toBeNull()
  })

  test('a prompt pasted in Desktop is named by its first sentence, never by its wrapper tag', () => {
    // Seen live in the Desktop app: Run progress read `Objective <pasted_content id="2961">`. Desktop wraps a pasted
    // prompt in a tag on its own lines, the closing one carrying the id too.
    const pasted = '\n\n<pasted_content id="2961">\nProject Sentinel 1.7.0 is committed locally (2432d9f, not pushed). Read the notes first.\n1. The status bar.\n</pasted_content id="2961">\n'
    expect(objectiveOf(pasted)).toBe('Project Sentinel 1.7.0 is committed locally (2432d9f, not pushed).')
    expect(objectiveOf('<pasted_content id="7">Fix the flaky login test on Windows</pasted_content id="7">')).toBe('Fix the flaky login test on Windows')
    expect(objectiveOf('<pasted_content id="8">\n</pasted_content id="8">')).toBeNull()
    // Only the wrapper goes: tags the person wrote are their words.
    expect(objectiveOf('Fix the focus ring on <Button> in the settings dialog')).toBe('Fix the focus ring on <Button> in the settings dialog')
  })
})

describe('the fresh context after a handoff', () => {
  test('is told the whole list and the objective, to carry them on under the same titles', () => {
    const text = continuationContext({
      runNumber: 3,
      sessionNumber: 2,
      handoffPath: '/work/NEXT_SESSION_PROMPT.md',
      policies: [],
      objective: 'Speed up the renderer',
      milestones: [
        { subject: 'Profile the renderer', status: 'completed' },
        { subject: 'Rewrite the hot loop', status: 'in_progress' },
        { subject: 'Run the regression suite', status: 'pending' },
      ],
    })
    // Seen live: told only the open ones, each fresh context re-planned under new titles and counted finished work twice.
    expect(text).toContain(`toward the run's objective, "Speed up the renderer", 1 of 3 done`)
    expect(text).toContain('[done] Profile the renderer; [in progress] Rewrite the hot loop; Run the regression suite')
    expect(text).toContain('under the same titles and the same objective')
    expect(text).toContain('never one of its own')
    expect(continuationContext({ runNumber: 3, sessionNumber: 2, handoffPath: 'x', policies: [] })).not.toContain('task list')
    // A finished run needs no list carried on.
    expect(continuationContext({ runNumber: 3, sessionNumber: 2, handoffPath: 'x', policies: [], milestones: [{ subject: 'A', status: 'completed' }] })).not.toContain('Carry this list on')
  })
})
