import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { COLD } from '../hooks/app/operations'
import { defaultSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import type { HudModel, OpsView, PaneModel } from '../types'
import { desktopClientFault } from './fixtures/desktop'
import { SESSION, world } from './fixtures/world'

const MIN = 60_000
const HOUR = 60 * MIN
const PRESENTATION = { isFullscreen: true, columns: 120 }
const cmd = (args: string) => ({ command: 'cr', args, origin: { kind: 'composer' as const }, presentation: PRESENTATION })

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
const isNode = (n: unknown): n is Node => typeof n === 'object' && n !== null && !Array.isArray(n)
const keyOf = (n: unknown): string => (isNode(n) && typeof n.props?.key === 'string' ? n.props.key : '')
const textOf = (n: unknown): string => (typeof n === 'string' ? n : isNode(n) ? (n.children ?? []).map(textOf).join('') : '')
function each(n: unknown, visit: (n: Node) => void): void {
  if (!isNode(n)) return
  visit(n)
  for (const c of n.children ?? []) each(c, visit)
}
const keys = (tree: unknown): string[] => {
  const out: string[] = []
  each(tree, n => {
    const k = keyOf(n)
    if (k !== '') out.push(k)
  })
  return out
}

/** Buttons with children other than one string: Claude Code 2.1.289 refuses them, and skips the whole tree. */
const richButtons = (tree: unknown): string[] => {
  const out: string[] = []
  each(tree, n => {
    if (n.type === 'Button' && (n.children ?? []).some(c => typeof c !== 'string')) out.push(keyOf(n))
  })
  return out
}
const bandProps = (bodyColumns: number) => ({ hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns, scroll: { offset: 0, bodyRows: 6 }, view: {} })
const paneProps = (bodyColumns: number, placement: 'dock' | 'inline' = 'dock') => ({ title: 'Control Room', isFocused: true, bodyColumns, placement, scroll: { offset: 0, bodyRows: 60 }, view: {} })

const withSettings = (patch: (s: Settings) => void): Settings => {
  const s = defaultSettings()
  patch(s)
  return s
}

async function boot($: Engine, w: ReturnType<typeof world>) {
  await $.session.start(SESSION)
  await w.clock.advance(300)
}

/** What Project Sentinel publishes to `$.state`, as it last set each key (the status bar, the panel, Operations). */
function published(on: On) {
  const last: Record<string, unknown> = {}
  on('state.set', ($, e, next) => {
    const write = e as unknown as { plugin: string; key: string; value: unknown }
    if (write.plugin === 'project-sentinel') last[write.key] = write.value
    return next(e)
  })
  return {
    get ops(): OpsView {
      return last.ops as OpsView
    },
    get hud(): HudModel {
      return last.hud as HudModel
    },
    get pane(): PaneModel {
      return last.pane as PaneModel
    },
  }
}

/** The Decision Inbox's tool, called as Claude calls it. */
const decisionTool = ($: Engine, input: Record<string, unknown>): Promise<unknown> => $.tool.call({ tool: 'mcp__project-sentinel__decision_request', ...input } as never)

/** Desktop draws a text in a monospace face when it looks like a table or a rule (the app's own test). */
const looksTabular = (t: string): boolean => {
  if (/[─-▟]/u.test(t) || /[-=_~]{3,}|[-=]{2,}>|<[-=]{2,}/u.test(t)) return true
  const runs = [...t.matchAll(/\S( {2,})(?=\S)/gu)].map(m => m[1]?.length ?? 0)
  return runs.length >= 2 || runs.some(n => n >= 3)
}
const monospaceOffenders = (tree: unknown, where: string): string[] => {
  const out: string[] = []
  each(tree, n => {
    if (n.type !== 'Text' || !(n.children ?? []).every(c => typeof c === 'string')) return
    const t = (n.children as string[]).join('')
    if (t.trim() !== '' && looksTabular(t)) out.push(`${where}: ${JSON.stringify(t)}`)
  })
  return out
}

/** A run with something in every part of Operations: a decision, queued work, a watcher, an agent, a budget. */
async function fullRun($: Engine, w: ReturnType<typeof world>) {
  expect((await $.command.run(cmd('queue --handoff Carry the cache findings into the README'))).text).toMatch(/^Queued Q-1 · After the handoff\.$/)
  await $.command.run(cmd('queue --handoff Re-run the benchmark'))
  const tool = await decisionTool($, { question: 'Postgres or SQLite for the cache store?', context: 'SQLite keeps it one file.', options: ['Postgres', 'SQLite'], allowText: true })
  expect(JSON.stringify(tool)).toContain('Recorded as D-1')
  expect((await $.command.run(cmd('watch in 2h S-002 result'))).text).toMatch(/^Watcher W-1 wakes (tomorrow )?\d\d:\d\d \(in 2h\) for S-002 result: Smart, /)
  expect((await $.command.run(cmd('budget $30'))).text).toContain('Cost $1.25 of $30')
  await w.clock.advance(300)
}

describe('Operations: the panel', () => {
  test('Activity has Summary · Operations · Agents · Tool calls; Operations holds every part, Agents its agents, on terminal, desktop and mobile', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    const pub = published(on)
    w.live.agents = [{ id: 'a1', type: 'Explore', description: 'Scan the cache code', status: 'running', name: 'scanner' }]
    await boot($, w)
    await fullRun($, w)
    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      for (const [columns, placement] of [[44, 'dock'], [66, 'dock'], [140, 'inline']] as const) {
        const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(columns, placement), viewport: { columns: 200, rows: 60, isFullscreen: placement === 'dock' } })
        await ui.press({ key: 'tab-activity' })
        await w.clock.advance(300)
        expect(await ui.find({ key: 'sub:ops' }), `${surface} ${columns}`).toBeDefined()
        await ui.press({ key: 'sub:ops' })
        await w.clock.advance(300)
        const tree = await ui.drawn()
        const all = keys(tree)
        // Agents have a view of their own: Operations keeps one line leading to it.
        for (const card of ['card-ops-review', 'card-ops-queue', 'card-ops-watchers', 'card-ops-agents-link', 'card-ops-budget']) expect(all, `${surface} ${columns}: ${card}`).toContain(card)
        expect(all, `${surface} ${columns}`).not.toContain('card-ops-agents')
        // The queue's field takes the row under its label: beside it, its text would squeeze the label into a column.
        if (surface !== 'mobile') expect(all, `${surface} ${columns}`).toContain('ops-queue-input-stacked')
        expect(richButtons(tree), `${surface} ${columns}`).toEqual([])
        const text = textOf(tree)
        expect(text, `${surface} ${columns}`).toContain('Postgres or SQLite for the cache store?')
        expect(text).toContain('Carry the cache findings into the README')
        expect(text).toContain('S-002 result')
        expect(text).toContain('1 agent running')
        expect(text).toContain('Permission prompts and confirmations stay Claude Code’s own')
        if (surface === 'desktop') expect(monospaceOffenders(tree, `${surface} ${columns}`)).toEqual([])
        // Activity → Agents: the agent itself, with what Claude Code says of it.
        expect(await ui.find({ key: 'sub:agents' }), `${surface} ${columns}`).toBeDefined()
        await ui.press({ key: 'sub:agents' })
        await w.clock.advance(300)
        const agents = await ui.drawn()
        expect(keys(agents), `${surface} ${columns}`).toContain('card-ops-agents')
        expect(textOf(agents), `${surface} ${columns}`).toContain('scanner')
        expect(richButtons(agents), `${surface} ${columns}`).toEqual([])
        await ui.unmount()
      }
    }
  })

  test('its controls act: answer a decision, add and delete queued work, arm a watcher from the field, set the budget', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    const pub = published(on)
    await boot($, w)
    await fullRun($, w)
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(80) })
    await ui.press({ key: 'tab-activity' })
    await w.clock.advance(300)
    await ui.press({ key: 'sub:ops' })
    await w.clock.advance(300)
    // A decision: its option.
    await ui.press({ key: 'dec-D-1-opt-1' })
    await w.clock.advance(300)
    expect(pub.ops.decisions[0]).toMatchObject({ id: 'D-1', status: 'answered', answer: 'SQLite' })
    // Queued work: deleted; and added from the field, for after the handoff (it would go at once otherwise).
    await ui.press({ key: 'q-Q-2-delete' })
    await w.clock.advance(300)
    await ui.press({ key: 'ops-queue-target' })
    await w.clock.advance(300)
    await ui.press({ key: 'ops-queue-target:fresh' })
    await w.clock.advance(300)
    await ui.input({ key: 'ops-queue-input', text: 'Summarise the findings' })
    await w.clock.advance(300)
    const ops = pub.ops
    expect(ops.queue.map(q => [q.id, q.text])).toEqual([
      ['Q-1', 'Carry the cache findings into the README'],
      ['Q-3', 'Summarise the findings'],
    ])
    expect(ops.queueDone.map(q => [q.id, q.status])).toEqual([['Q-2', 'cancelled']])
    // A watcher from the form: what it waits for, then when.
    await ui.input({ key: 'ops-watch-label', text: 'the nightly eval', kind: 'change' })
    await w.clock.advance(300)
    await ui.press({ key: 'ops-watch-in-60' })
    await w.clock.advance(300)
    expect(pub.ops.watchers.map(x => x.label)).toEqual(['the nightly eval', 'S-002 result'])
    // An ambiguous time offers both readings, and arms nothing until one is chosen.
    await ui.input({ key: 'ops-watch-label', text: 'the eval', kind: 'change' })
    await w.clock.advance(300)
    await ui.input({ key: 'ops-watch-when', text: 'at 2:30' })
    await w.clock.advance(300)
    const choices = pub.ops.ui.choices
    expect(choices).toHaveLength(2)
    await ui.press({ key: 'ops-watch-pick-1' })
    await w.clock.advance(300)
    expect(pub.ops.watchers.map(x => x.label)).toContain('the eval')
    // The budget: its cost limit typed in.
    await ui.input({ key: 'budget-cost-input', text: '45' })
    await w.clock.advance(300)
    expect(pub.ops.budget.cost.limit).toBe(45)
    await ui.press({ key: 'budget-clear' })
    await w.clock.advance(300)
    expect(pub.ops.budget.isSet).toBe(false)
    await ui.unmount()
  })

  test('Overview shows an Operations card only while something is in it; Context has the Cold Resume Guard and Ready to resume', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    const pub = published(on)
    await boot($, w)
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(80) })
    await ui.press({ key: 'tab-overview' })
    await w.clock.advance(300)
    expect(keys(await ui.drawn())).not.toContain('card-operations')
    await fullRun($, w)
    await ui.redraw()
    const overview = await ui.drawn()
    expect(keys(overview)).toContain('card-operations')
    expect(textOf(overview)).toContain('Review 1')
    expect(textOf(overview)).toContain('Queued 2')
    expect(textOf(overview)).toContain('Watcher · wakes in 2h')
    await ui.press({ key: 'tab-context' })
    await w.clock.advance(300)
    const context = await ui.drawn()
    expect(keys(context)).toContain('card-cold-resume')
    expect(keys(context)).toContain('card-resume')
    expect(textOf(context)).toContain('Ask before a cold resume')
    expect(textOf(context)).toContain('Asks above 100k')
    // The threshold's stepper.
    await ui.press({ key: 'cold-at-inc' })
    await w.clock.advance(2000)
    expect((w.store['settings.v1'] as Settings).cache.coldResumeTokens).toBe(150_000)
    // Guardrails says what may be started, and links to what runs.
    await ui.press({ key: 'tab-guardrails' })
    await w.clock.advance(300)
    await ui.press({ key: 'agents-link' })
    await w.clock.advance(300)
    expect(pub.pane).toMatchObject({ tab: 'activity', activitySub: 'agents' })
    await ui.unmount()
  })
})

describe('Operations: the status bar', () => {
  test('Review is an amber chip that opens Activity → Operations; nothing of the layer shows while it is empty', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    const pub = published(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    await boot($, w)
    await w.clock.advance(300)
    expect(pub.hud.ops).toBeNull()
    await decisionTool($, { question: 'Which layout should the report use?', options: ['Grid', 'List'] })
    await w.clock.advance(300)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'AbovePrompt', props: bandProps(120) })
      const chip = await band.find({ key: 'chip-review' })
      expect(chip, surface).toBeDefined()
      expect(chip?.type, surface).toBe('Button')
      expect(chip?.props?.label ?? textOf(chip), surface).toBe('Review 1')
      expect(richButtons(await band.drawn()), surface).toEqual([])
      if (surface === 'desktop') expect(monospaceOffenders(await band.drawn(), 'status bar')).toEqual([])
      await band.press({ key: 'chip-review' })
      await w.clock.advance(300)
      expect(pub.pane, surface).toMatchObject({ tab: 'activity', activitySub: 'ops' })
      expect(w.kept.opened).toContain('control-room')
      await band.unmount()
    }
    const hud = pub.hud
    expect(hud.chips.find(c => c.key === 'review')).toMatchObject({ tone: 'warn', opens: 'ops' })
  })

  test('a chip and /cr agents open Operations at their own card, by the key the panel draws it under (seen live: a chip opened it at its top)', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    const pub = published(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    w.live.agents = [{ id: 'a1', type: 'Explore', description: 'Scan the cache code', status: 'running', name: 'scanner' }]
    await boot($, w)
    await fullRun($, w)
    const pane = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(66) })
    const band = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(120) })
    // The test engine scrolls and focuses nothing (it refuses every `$.ui.scroll` and `$.ui.focus`), so each try is traced with the key it asked for.
    const asked = (): string[] => [...new Set(w.kept.logs.flatMap(l => /^ops: scroll to (\S+) refused/.exec(l)?.[1] ?? []))]
    // The panel is not open yet, as live: the chip opens it at Activity → Operations, then asks for its card.
    expect(w.kept.opened).toEqual([])
    await band.press({ key: 'chip-review' })
    await w.clock.advance(3000)
    expect(w.kept.opened).toEqual(['control-room'])
    expect(pub.pane).toMatchObject({ tab: 'activity', activitySub: 'ops' })
    expect(keys(await pane.drawn())).toContain('card-ops-review')
    // /cr agents and the agents chip open the agents' own view (nothing to scroll to).
    await $.command.run(cmd('agents'))
    await w.clock.advance(3000)
    expect(pub.pane).toMatchObject({ tab: 'activity', activitySub: 'agents' })
    await band.press({ key: 'chip-agents' })
    await w.clock.advance(1000)
    expect(pub.pane).toMatchObject({ tab: 'activity', activitySub: 'agents' })
    expect(asked()).toEqual(['card-ops-review'])
    expect(keys(await pane.drawn())).toContain('card-ops-agents')
    // /cr queue with the panel open: opened again with the keyboard (the prompt box has it after a
    // command), then its field focused, by the key the panel draws it under.
    await $.command.run(cmd('queue'))
    await w.clock.advance(1000)
    expect(w.kept.opens).toEqual([
      { id: 'control-room', isFocus: true },
      { id: 'control-room', isFocus: true },
    ])
    const focusedKey = w.kept.logs.flatMap(l => /^ops: focus (\S+) refused/.exec(l)?.[1] ?? [])
    expect(focusedKey).toEqual(['ops-queue-input'])
    expect(keys(await pane.drawn())).toContain('ops-queue-input')
    await band.unmount()
    await pane.unmount()
  })

  test('sleeping: the headline says until when and why, the countdown is an instrument, the alert asks when a watcher waits for you', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    const pub = published(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    await boot($, w)
    await $.command.run(cmd('watch in 2h S-002 result --warm'))
    await w.clock.advance(300)
    const hud = pub.hud
    expect(hud.headline.state).toBe('sleeping')
    expect(hud.headline.text).toMatch(/^Sleeping until (tomorrow )?\d\d:\d\d · S-002 result$/)
    const terminal = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(120) })
    expect(textOf(await terminal.drawn())).toContain('WATCHER')
    expect(textOf(await terminal.drawn())).toContain('2h')
    await terminal.unmount()
    const desktop = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(120) })
    const drawn = await desktop.drawn()
    expect(keys(drawn)).toContain('cell-machine')
    expect(textOf(drawn)).toContain('Watcher')
    expect(monospaceOffenders(drawn, 'sleeping status bar')).toEqual([])
    await desktop.unmount()
    // Kit curls up while the run sleeps (Kit on).
    await $.command.run(cmd('companion on'))
    await w.clock.advance(300)
    expect(pub.hud.companion?.mood).toBe('tend')
    const kit = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(120) })
    await kit.advance(400)
    expect(desktopClientFault(await kit.drawn({ in: 'kit' }))).toBeNull()
    await kit.unmount()
  })
})

describe('Operations: commands', () => {
  test('/cr queue, list, now and cancel; /cr queue alone opens the queue to type in', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    const pub = published(on)
    await boot($, w)
    expect((await $.command.run(cmd('queue --turn Update the README'))).text).toBe('Queued Q-1 · Due: goes now.')
    await w.clock.advance(1000)
    expect(w.kept.submitted.at(-1)).toContain('Update the README')
    await $.command.run(cmd('queue --handoff Keep this'))
    expect((await $.command.run(cmd('queue list'))).text).toContain('Q-2  Keep this')
    expect((await $.command.run(cmd('queue cancel q-2'))).text).toBe('Q-2 deleted.')
    expect((await $.command.run(cmd('queue now Q-9'))).text).toBe('No queued item Q-9. /cr queue list shows them.')
    // Typed text keeps its case; a word that is not an id is text.
    expect((await $.command.run(cmd('queue --handoff Cancel the BETA flag'))).text).toBe('Queued Q-3 · After the handoff.')
    await w.clock.advance(300)
    expect(pub.ops.queue.at(-1)?.text).toBe('Cancel the BETA flag')
    const open = await $.command.run(cmd('queue'))
    expect(open.text).toContain('Mission Queue: type the work under Add work for later')
    expect(w.kept.opened).toContain('control-room')
    await w.clock.advance(300)
    expect(pub.pane).toMatchObject({ tab: 'activity', activitySub: 'ops' })
  })

  test('/cr watch in 2h, at a time, an ambiguous time asked in Claude Code’s own dialog; /cr watchers; now and cancel', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    const pub = published(on)
    await boot($, w)
    expect((await $.command.run(cmd('watch'))).text).toContain('Watchers: say what it waits for and when it wakes')
    expect((await $.command.run(cmd('watch S-002 result'))).text).toContain('When should it wake?')
    expect((await $.command.run(cmd('watch in 9 days x'))).text).toBe('A watcher wakes within a week.')
    expect((await $.command.run(cmd('watch in 2h S-002 result --fresh'))).text).toMatch(/^Watcher W-1 wakes .* for S-002 result: Fresh\.$/)
    // Ambiguous: Claude Code's question dialog, with both readings.
    w.live.askAnswer = (_question, options) => options[1] ?? ''
    const ambiguous = await $.command.run(cmd('watch at 2:30 the eval'))
    expect(w.kept.asked.at(-1)).toContain('"at 2:30" could be either')
    expect(ambiguous.text).toMatch(/^Watcher W-2 wakes .* for the eval: Smart, /)
    const list = (await $.command.run(cmd('watchers'))).text
    expect(list).toContain('W-1  S-002 result')
    expect(list).toContain('W-2  the eval')
    expect(list).toContain('Watchers run while Claude Code runs')
    expect((await $.command.run(cmd('watch cancel w-2'))).text).toBe('W-2 dismissed.')
    expect((await $.command.run(cmd('watch pause W-1'))).text).toBe('W-1 paused. /cr watch resume W-1 arms it again.')
    expect((await $.command.run(cmd('watch resume W-1'))).text).toMatch(/^W-1 armed again: wakes /)
  })

  test('/cr decisions and /cr decide; /cr agents with no argument shows what runs, with one sets the policy', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    const pub = published(on)
    await boot($, w)
    await decisionTool($, { question: 'Publish once CI passes?', options: ['Publish', 'Wait for me'], blocking: true })
    const list = (await $.command.run(cmd('decisions'))).text
    expect(list).toContain('D-1  Publish once CI passes? (blocks the run)')
    expect(list).toContain('Options: Publish · Wait for me')
    expect((await $.command.run(cmd('decide D-1 publish'))).text).toBe('D-1 answered: Publish. Claude continues with it now.')
    await w.clock.advance(1000)
    expect(w.kept.submitted.at(-1)).toContain('Decision Inbox · the user answered your decision')
    expect((await $.command.run(cmd('agents'))).text).toContain('◆ Agents · none running')
    expect((await $.command.run(cmd('agents 2'))).text).toStartWith('Subagents:')
    // Saved once the debounce passes (a fresh install's settings are in the store from its first load).
    await w.clock.advance(2000)
    expect((w.store['settings.v1'] as Settings | undefined)?.subagents).toMatchObject({ mode: 'limit', limit: 2 })
  })

  test('/cr budget sets, shows and removes; /cr resume shows what a fresh context would get; help lists them', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    const pub = published(on)
    await boot($, w)
    expect((await $.command.run(cmd('budget'))).text).toContain('◆ Run budget · off')
    const set = (await $.command.run(cmd('budget $30 handoffs 5 finish'))).text
    expect(set).toContain('Cost $1.25 of $30')
    expect(set).toContain('Handoffs 0 of 5')
    expect(set).toContain('At a limit: Finish the milestone, then pause')
    expect((await $.command.run(cmd('budget soon'))).text).toBe('"soon" is not a budget: try $30, 6h, handoffs 5, or notify|ask|finish.')
    expect((await $.command.run(cmd('budget off'))).text).toBe('Run budget removed.')
    const resume = (await $.command.run(cmd('resume'))).text
    expect(resume).toContain('◆ Ready to resume · not ready')
    expect(resume).toContain('No run state')
    const help = (await $.command.run(cmd('help'))).text
    for (const word of ['/cr queue <text>', '/cr watch in 2h', '/cr decisions', '/cr budget', '/cr resume']) expect(help).toContain(word)
    void w
  })
})

describe('Operations: hooks', () => {
  test('prompt.submit: the Cold Resume Guard asks before a cold context is re-read; Cancel keeps the message out, Continue sends it', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 616_000 })
    const pub = published(on)
    let filled: string | null = null
    on('prompt.fill', ($, e) => {
      filled = e.text
      return { isFilled: true }
    })
    await boot($, w)
    // A resumed session: Claude Code says how long since its last answer, its context, that the cache likely expired, and its estimate.
    await $.classic.SessionStart({ source: 'resume', session_id: 'session-1', model: 'claude-opus-5-5', seconds_since_last_response: 7200, context_tokens: 616_000, prompt_cache_likely_expired: true, estimated_cache_write_usd: 4.62 } as never)
    await w.clock.advance(300)
    expect(pub.ops.cold).toMatchObject({ isArmed: true, tokens: 616_000, usd: 4.62 })
    w.live.askAnswer = COLD.cancel
    const before = w.kept.submitted.length
    const result = await $.prompt.submit({ text: 'Now fix the tokenizer.', wait: false, origin: { kind: 'composer' } })
    expect(result).toMatchObject({ drop: 'Not sent. Your message is back in the prompt box.' })
    expect(w.kept.asked.at(-1)).toContain('616k tokens need to be reprocessed: the prompt cache expired')
    expect(w.kept.asked.at(-1)).toContain('Claude Code currently estimates at least ~$4.62.')
    expect(w.kept.submitted).toHaveLength(before)
    await w.clock.advance(1000)
    expect(filled).toBe('Now fix the tokenizer.')
    w.live.askAnswer = COLD.continue
    const sent = await $.prompt.submit({ text: 'Now fix the tokenizer.', wait: false, origin: { kind: 'composer' } })
    expect(sent.drop).toBeUndefined()
    expect(w.kept.submitted.at(-1)).toBe('Now fix the tokenizer.')
  })

  test('the decision tool: refused for a subagent, recorded for the main conversation; permissions stay Claude Code’s', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { settings: withSettings(s => void (s.permissions.push = 'ask')) })
    const pub = published(on)
    await boot($, w)
    const sub = await decisionTool($, { question: 'Which one?', agentId: 'agent-1' })
    expect(JSON.stringify(sub)).toContain('for the main conversation')
    const main = await decisionTool($, { question: 'Ship on Friday?', blocking: true })
    expect(JSON.stringify(main)).toContain('It blocks the current milestone')
    w.live.askAnswer = 'Approve'
    await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    await w.clock.advance(300)
    // The push was asked about at once, in Claude Code's own dialog, beside the open decision.
    expect(w.kept.asked.some(q => q.includes('push'))).toBe(true)
    expect(pub.ops.decisions.map(d => d.question)).toEqual(['Ship on Friday?'])
  })
})
