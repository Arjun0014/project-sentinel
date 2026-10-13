import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Settings } from '../hooks/core/settings'
import type { CacheView } from '../types'
import { cacheState, cacheSummary, lifetimeWords } from '../hooks/ui/pane/cache'
import { MAX_COLUMNS, TABS } from '../hooks/ui/pane/frame'
import { navRowColumns } from '../hooks/ui/primitives'
import { ACCENT, TIMELINE, meter } from '../hooks/ui/theme'
import { desktopClientFault } from './fixtures/desktop'
import { typeperfLine } from './fixtures/fake-host'
import { SESSION, world } from './fixtures/world'

const ENGINE_ROW = { type: 'Text' as const, props: {}, children: ['ENGINE ROW'] }

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
const isNode = (n: unknown): n is Node => typeof n === 'object' && n !== null && !Array.isArray(n)
const keyOf = (n: unknown): string => (isNode(n) && typeof n.props?.key === 'string' ? n.props.key : '')
const textOf = (n: unknown): string => (typeof n === 'string' ? n : isNode(n) ? (n.children ?? []).map(textOf).join('') : '')
function each(n: unknown, visit: (n: Node) => void): void {
  if (!isNode(n)) return
  visit(n)
  for (const c of n.children ?? []) each(c, visit)
}

/** The first Text under a node (a card head's title, a row's label). Texts carry no keys once drawn; Boxes do. */
function firstText(n: unknown): string {
  let found: string | null = null
  each(n, d => {
    if (found === null && d.type === 'Text') found = textOf(d)
  })
  return found ?? ''
}

/** Every card in a drawn tree: its title and the labels of the rows inside it. */
function cardsOf(tree: unknown): { title: string; labels: string[] }[] {
  const out: { title: string; labels: string[] }[] = []
  each(tree, n => {
    const m = /^card-(.+)$/.exec(keyOf(n))
    if (m === null || /-(head|box|foot)$/.test(m[1]!)) return
    let title = ''
    const labels: string[] = []
    each(n, d => {
      if (keyOf(d) === `card-${m[1]}-head`) title = firstText(d)
      else if (keyOf(d).startsWith('row-')) labels.push(firstText(d))
    })
    out.push({ title, labels })
  })
  return out
}

const bandProps = (bodyColumns: number) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
})

const paneProps = (bodyColumns: number, placement: 'dock' | 'inline' = 'dock') => ({
  title: 'Control Room',
  isFocused: true,
  bodyColumns,
  placement,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

const toolRow = (id: string, tool = 'Bash', input: unknown = { command: 'npm test' }) => ({
  tool_use_id: id,
  tool,
  input,
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
})

async function boot($: Engine, w: ReturnType<typeof world>) {
  await $.session.start(SESSION)
  await w.clock.advance(300)
}

const saved = (w: ReturnType<typeof world>) => w.store['settings.v1'] as Settings

/** The run's last handoff as stored: what it left behind, and what session 2 picked up. */
const LAST_HANDOFF = {
  at: 950_000,
  fromSession: 1,
  toSession: 2,
  via: 'clear',
  health: [
    { id: 'runState', label: 'Run state saved', state: 'ok', detail: 'Milestones sent again' },
    { id: 'milestone', label: 'Milestone under way captured', state: 'ok', detail: 'Rewrite the hot loop' },
    { id: 'notes', label: 'Handoff notes written', state: 'ok', detail: 'NEXT_SESSION_PROMPT.md' },
    { id: 'docs', label: 'Project docs updated', state: 'ok', detail: 'README.md' },
    { id: 'validation', label: 'Validation recorded', state: 'ok', detail: 'Tests passing' },
    { id: 'claudeMd', label: 'CLAUDE.md', state: 'none', detail: 'No update needed' },
  ],
  currentKey: 'rewrite the hot loop',
  currentSubject: 'Rewrite the hot loop',
  done: 1,
  total: 3,
  continuity: [
    { id: 'notesRead', label: 'Handoff notes read', state: 'ok', detail: 'NEXT_SESSION_PROMPT.md' },
    { id: 'runState', label: 'Run state restored', state: 'ok', detail: '1 of 3 milestones' },
    { id: 'milestone', label: 'Milestone picked up', state: 'ok', detail: 'Rewrite the hot loop' },
    { id: 'docsRead', label: 'Project docs read', state: 'missing', detail: 'None opened' },
    { id: 'resumed', label: 'Work resumed', state: 'ok', detail: '2 edits' },
  ],
}

describe('ui', () => {
  test('a coarse meter never hides a reading past its threshold under the tick', () => {
    // 88k of a 1M window, handing off at 60k, in the status bar's ten cells.
    expect(meter(0.088, 10, 0.06)).toBe('┃━────────')
    expect(meter(0.03, 10, 0.06)).toBe('┃─────────')
    expect(meter(0.69, 10, 0.7)).toBe('━━━━━━┃───')
    expect(meter(1, 10, 0.7)).toBe('━━━━━━┃━━━')
    expect(meter(0.5, 10)).toBe('━━━━━─────')
  })

  test('the HUD band draws its vital signs on terminal and desktop at every width', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 684_000 })
    // A claude.ai plan: the five-hour window Claude Code reports takes the place the run's cost had.
    w.live.usage = { ...w.live.usage, rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() }] }
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    await boot($, w)
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const columns of [44, 80, 120, 200]) {
        const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'AbovePrompt', props: bandProps(columns), viewport: { columns, rows: 40 } })
        expect(await ui.find({ text: /68%/ }), `${surface} ${columns}`).toBeDefined()
        expect(await ui.find({ text: /41%/ }), `${surface} ${columns}`).toBeDefined()
        expect(await ui.find({ text: /\$1\.25/ }), `${surface} ${columns}`).toBeUndefined()
        expect(await ui.find({ type: 'Button', key: 'open' }), `${surface} ${columns}`).toBeDefined()
        // The terminal names its readings only where there is room (5H names itself at every width); Desktop captions each cell.
        const isLabelled = surface === 'terminal' ? columns >= 72 : true
        const [contextName, planName] = surface === 'terminal' ? [/CONTEXT/, /5H/] : [/^Context/, columns < 80 ? /^5h$/ : /^5-hour usage$/]
        expect((await ui.find({ text: contextName })) !== undefined, `${surface} ${columns}`).toBe(isLabelled)
        expect(await ui.find({ text: planName }), `${surface} ${columns}`).toBeDefined()
        await ui.unmount()
      }
    }
  })

  test('the status bar shows live readings only, never settings', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    await boot($, w)
    const quiet = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    expect(await quiet.find({ text: /Hands off/ })).toBeUndefined()
    expect(await quiet.find({ text: /Frontier/ })).toBeUndefined()
    await quiet.unmount()
    await $.command.run({ command: 'cr', args: 'profile frontier', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await w.clock.advance(300)
    const busy = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    expect(await busy.find({ text: /CONTEXT/ })).toBeDefined()
    expect(await busy.find({ text: /Frontier Max/ })).toBeUndefined()
    expect(await busy.find({ text: /Hands off/ })).toBeUndefined()
  })

  test('the band yields to surveys and to a hidden HUD', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ENGINE_ROW)
    await boot($, w)
    const survey = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps(100), hasSurvey: true } })
    expect(await survey.find({ text: /CONTEXT/ })).toBeUndefined()
    await survey.unmount()
    await $.command.run({ command: 'cr', args: 'hud status', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
    await w.clock.advance(300)
    const hidden = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(100) })
    expect(await hidden.find({ text: /CONTEXT/ })).toBeUndefined()
    expect(w.kept.statuses.some(s => s !== undefined && s.startsWith('◆ Context'))).toBe(true)
  })

  test('every section draws on terminal, desktop and mobile, docked and inline', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    await boot($, w)
    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      for (const [columns, placement] of [[44, 'dock'], [66, 'dock'], [140, 'inline']] as const) {
        const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(columns, placement), viewport: { columns: 200, rows: 50, isFullscreen: placement === 'dock' } })
        for (const tab of TABS) {
          await ui.press({ key: `tab-${tab.id}` })
          await w.clock.advance(300)
          expect(await ui.drawn(), `${surface} ${columns} ${tab.id}`).toBeDefined()
          expect(await ui.find({ text: /Control Room/ }), `${surface} ${columns} ${tab.id}`).toBeDefined()
        }
        await ui.unmount()
      }
    }
  })

  test('a row never repeats the title of its card', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    await boot($, w)
    await $.command.run({ command: 'cr', args: 'profile frontier', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await w.clock.advance(300)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(66) })
      let checked = 0
      for (const tab of TABS) {
        await ui.press({ key: `tab-${tab.id}` })
        await w.clock.advance(300)
        for (const c of cardsOf(await ui.drawn())) {
          if (c.title === '') continue
          checked += 1
          for (const label of c.labels) expect(label.toLowerCase(), `${surface} ${tab.id}: ${c.title}`).not.toBe(c.title.toLowerCase())
        }
      }
      expect(checked, surface).toBeGreaterThan(10)
      await ui.unmount()
    }
  })

  test('a wide frame keeps the page to a readable width, centred, on every surface; a narrower one fills its room', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await boot($, w)
    const mount = (surface: 'terminal' | 'desktop', columns: number, placement: 'dock' | 'inline') =>
      $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(columns, placement), viewport: { columns: columns + 2, rows: 50, isFullscreen: placement === 'dock' } })
    for (const [surface, placement] of [['terminal', 'inline'], ['desktop', 'dock']] as const) {
      const wide = await mount(surface, 180, placement)
      expect(await wide.drawn(), surface).toMatchObject({ props: { alignItems: 'center' } })
      expect((await wide.find({ key: 'page-body' }))?.props.width, surface).toBe(MAX_COLUMNS + 2)
      await wide.unmount()
    }
    for (const [surface, columns, placement] of [['terminal', 66, 'dock'], ['desktop', 50, 'dock']] as const) {
      const ui = await mount(surface, columns, placement)
      expect((await ui.find({ key: 'page-body' }))?.props.width, `${surface} ${columns}`).toBeUndefined()
      await ui.unmount()
    }
  })

  test('desktop section buttons: one row when every label fits, else three equal cells per row with each button centred', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await boot($, w)
    for (const [columns, isOneRow] of [[MAX_COLUMNS + 2, true], [navRowColumns(TABS), true], [navRowColumns(TABS) - 1, false], [50, false], [30, false]] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'Pane', requestId: 'control-room', props: paneProps(columns + 2) })
      const nav = await ui.find({ key: 'nav' })
      const rows = (nav?.children ?? []).filter(c => /^nav-row-\d+$/.test(keyOf(c))) as Node[]
      if (isOneRow) {
        expect(rows.length, `${columns}`).toBe(0)
        expect((nav?.children ?? []).map(keyOf), `${columns}`).toEqual(TABS.map(t => `tab-${t.id}`))
      } else {
        expect(rows.length, `${columns}`).toBe(2)
        for (const r of rows) {
          const cells = (r.children ?? []) as Node[]
          expect(cells.map(c => keyOf(c).replace(/^nav-cell-/, '')).every(id => TABS.some(t => t.id === id)), `${columns}`).toBe(true)
          expect(cells.length, `${columns}`).toBe(3)
          expect(new Set(cells.map(c => c.props?.width)).size, `${columns}: equal cells`).toBe(1)
          for (const c of cells) expect(c.props?.justifyContent, `${columns}`).toBe('center')
        }
      }
      await ui.unmount()
    }
  })

  test('on desktop a truncating line may narrow below its text; the terminal tree is unchanged', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await boot($, w)
    const shrinkers = async (surface: 'terminal' | 'desktop') => {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(48) })
      let clipped = 0
      each(await ui.drawn(), n => {
        if (n.type === 'Box' && n.props?.minWidth === 0 && n.props.overflow === 'hidden') clipped += 1
      })
      await ui.unmount()
      return clipped
    }
    expect(await shrinkers('desktop')).toBeGreaterThan(5)
    expect(await shrinkers('terminal')).toBe(0)
  })

  test('on desktop the profile name field moves under its label in a narrow pane', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await boot($, w)
    await $.command.run({ command: 'cr', args: 'guard on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await w.clock.advance(300)
    const at = async (columns: number) => {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'Pane', requestId: 'control-room', props: paneProps(columns) })
      await ui.press({ key: 'tab-setup' })
      await w.clock.advance(300)
      const where = { beside: await ui.find({ key: 'profile-save-right' }), under: await ui.find({ key: 'profile-save-stacked' }) }
      await ui.unmount()
      return where
    }
    const narrow = await at(54)
    expect(narrow.under).toBeDefined()
    expect(narrow.beside).toBeUndefined()
    const wide = await at(120)
    expect(wide.beside).toBeDefined()
    expect(wide.under).toBeUndefined()
  })

  test('a segmented choice sits beside its label when the text fits, under it when it would not', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await boot($, w)
    await $.command.run({ command: 'cr', args: 'guard on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await w.clock.advance(300)
    const at = async (columns: number, placement: 'dock' | 'inline') => {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(columns, placement) })
      await ui.press({ key: 'tab-behavior' })
      await w.clock.advance(300)
      const where = { beside: await ui.find({ key: 'gu-strict-right' }), under: await ui.find({ key: 'gu-strict-stacked' }) }
      await ui.unmount()
      return where
    }
    // Docked (a 60-cell card): the description would wrap beside the choice, so it moves under.
    const docked = await at(66, 'dock')
    expect(docked.under).toBeDefined()
    expect(docked.beside).toBeUndefined()
    // A wide frame (a 76-cell card): there is room for both on one line.
    const wide = await at(100, 'inline')
    expect(wide.beside).toBeDefined()
    expect(wide.under).toBeUndefined()
    // Switches never move, however narrow.
    const narrow = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(44) })
    await narrow.press({ key: 'tab-behavior' })
    await w.clock.advance(300)
    expect(await narrow.find({ key: 'gu-on-right' })).toBeDefined()
  })

  test('the terminal never draws a dropdown; desktop uses its native popup', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await boot($, w)
    for (const surface of ['terminal', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(66) })
      await ui.press({ key: 'tab-guardrails' })
      await w.clock.advance(300)
      expect(await ui.find({ type: 'Select' }), surface).toBeUndefined()
      await ui.unmount()
    }
    const desktop = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'Pane', requestId: 'control-room', props: paneProps(66) })
    await desktop.press({ key: 'tab-guardrails' })
    await w.clock.advance(300)
    await desktop.select({ key: 'perm-push', value: 'deny' })
    await w.clock.advance(2000)
    expect(saved(w).permissions.push).toBe('deny')
  })

  test('a picker opens in place, picks, and closes, with keys or the pointer', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await boot($, w)
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(66) })
    await ui.press({ key: 'tab-guardrails' })
    await w.clock.advance(300)
    expect(await ui.find({ type: 'Button', key: 'perm-push:deny' })).toBeUndefined()
    await ui.press({ key: 'perm-push' })
    await w.clock.advance(300)
    expect(await ui.find({ type: 'Button', key: 'perm-push:deny' })).toBeDefined()
    await ui.press({ key: 'perm-push:deny' })
    await w.clock.advance(2000)
    expect(saved(w).permissions.push).toBe('deny')
    expect(await ui.find({ type: 'Button', key: 'perm-push:deny' })).toBeUndefined()
    await ui.press({ key: 'perm-push' })
    await w.clock.advance(300)
    await ui.press({ key: 'perm-push' })
    await w.clock.advance(300)
    expect(await ui.find({ type: 'Button', key: 'perm-push:ask' })).toBeUndefined()
  })

  test('Control Centre controls change and persist settings', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await boot($, w)
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(66) })
    await ui.press({ key: 'tab-behavior' })
    await w.clock.advance(300)
    // A fresh install has Frontier Max on (1.7.0); it no longer turns the lazy-exit guard on by itself.
    expect(saved(w).frontier.enabled).toBe(true)
    await ui.press({ key: 'fr-on' })
    await w.clock.advance(2000)
    expect(saved(w).frontier.enabled).toBe(false)
    await ui.press({ key: 'fr-on' })
    await w.clock.advance(2000)
    expect(saved(w).frontier.enabled).toBe(true)
    expect(saved(w).guard.enabled).toBe(false)
    await ui.press({ key: 'gu-on' })
    await w.clock.advance(300)
    await ui.press({ key: 'gu-strict:strict' })
    await ui.press({ key: 'gu-turn-inc' })
    await w.clock.advance(2000)
    expect(saved(w).guard).toMatchObject({ strictness: 'strict', maxPerTurn: 3 })
    await ui.press({ key: 'tab-guardrails' })
    await w.clock.advance(300)
    await ui.press({ key: 'sa-mode' })
    await w.clock.advance(300)
    await ui.press({ key: 'sa-mode:limit' })
    await w.clock.advance(300)
    await ui.press({ key: 'sa-limit-dec' })
    await w.clock.advance(2000)
    expect(saved(w).subagents).toMatchObject({ mode: 'limit', limit: 1 })
    await ui.press({ key: 'tab-context' })
    await w.clock.advance(300)
    // On out of the box: off, then on again.
    await ui.press({ key: 'ap-enabled' })
    await w.clock.advance(2000)
    expect(saved(w).autopilot.enabled).toBe(false)
    await ui.press({ key: 'ap-enabled' })
    await w.clock.advance(300)
    await ui.press({ key: 'ap-threshold-inc' })
    await ui.press({ key: 'ap-cont:manual' })
    await w.clock.advance(2000)
    expect(saved(w).autopilot).toMatchObject({ enabled: true, thresholdPercent: 75, continuation: 'manual' })
    await ui.press({ key: 'tab-setup' })
    await w.clock.advance(300)
    await ui.press({ key: 'apply-low-resource' })
    await w.clock.advance(2000)
    expect(saved(w).resources.level).toBe('low')
    expect(saved(w).profile).toBe('low-resource')
  })

  test('mobile draws choices in place, as buttons', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    await boot($, w)
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'mobile', component: 'Pane', requestId: 'control-room', props: paneProps(60) })
    await ui.press({ key: 'tab-behavior' })
    await w.clock.advance(300)
    await ui.press({ key: 'ro-strategy' })
    await w.clock.advance(300)
    await ui.press({ key: 'ro-strategy:economy' })
    await w.clock.advance(2000)
    expect(saved(w).router.strategy).toBe('economy')
  })

  test('Focus View draws a compact tool row that expands in place', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    on('ui.render', { component: 'ToolUse' }, () => ENGINE_ROW)
    await boot($, w)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'ToolUse', requestId: `t-${surface}`, props: toolRow(`t-${surface}`), viewport: { columns: 100, rows: 40 } })
      expect(await ui.find({ text: /npm test/ })).toBeDefined()
      expect(await ui.find({ text: /ENGINE ROW/ })).toBeUndefined()
      await ui.press({ key: `expand-t-${surface}` })
      await w.clock.advance(300)
      await ui.redraw()
      expect(await ui.find({ text: /ENGINE ROW/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('Focus View off restores the engine rows; results and diffs follow their switches', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on)
    on('ui.render', { component: 'ToolUse' }, () => ENGINE_ROW)
    on('ui.render', { component: 'ToolResult' }, () => ENGINE_ROW)
    await boot($, w)
    const result = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'ToolResult', requestId: 'e1', props: { tool_use_id: 'e1', tool: 'Edit', output: {}, isErrored: false } })
    expect(await result.find({ text: /ENGINE ROW/ })).toBeUndefined()
    await $.command.run({ command: 'cr', args: 'focus off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
    await w.clock.advance(300)
    await result.redraw()
    expect(await result.find({ text: /ENGINE ROW/ })).toBeDefined()
    const row = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'ToolUse', requestId: 'b1', props: toolRow('b1') })
    expect(await row.find({ text: /ENGINE ROW/ })).toBeDefined()
  })

  test('Activity leads with the run and what needs a look; every call is the secondary view', { timeoutMs: 30_000 }, async ($, on) => {
    // Answers beneath the plugin for the calls this turn makes (registered before the world's catch-all).
    on('tool.call', { tool: 'Write' }, ($, e) => ({ result: { type: 'create', filePath: e.file_path, content: 'export const a = 1\nexport const b = 2\n', structuredPatch: [], originalFile: null } }))
    on('tool.call', { tool: 'Bash' }, ($, e) =>
      e.command === 'npm run lint'
        ? { isError: true as const, result: 'Exit code 1', text: 'Exit code 1\nsrc/a.ts: unused variable' }
        : e.command === 'touch scripts/gen.sh'
          ? { result: { stdout: '', stderr: '', interrupted: false, bashEditDiff: { files: [{ filePath: '/work/scripts/gen.sh', hunks: [], created: true as const }], moreFiles: 0 } } }
          : { result: { stdout: 'ok', stderr: '', interrupted: false } },
    )
    const w = world(on, { tokens: 300_000 })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await boot($, w)
    await $.prompt.submit({ text: 'Build the parser and cover it with tests.', origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: 'Build the parser and cover it with tests.', turnId: 't1' })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Sketch the grammar', status: 'completed', activeForm: 'Sketching the grammar' },
        { content: 'Build the parser', status: 'in_progress', activeForm: 'Building the parser' },
        { content: 'Write the tests', status: 'pending', activeForm: 'Writing the tests' },
      ],
    })
    await $.tool.call({ tool: 'Write', file_path: '/work/src/parser.ts', content: 'export const a = 1\nexport const b = 2\n' })
    await $.tool.call({ tool: 'Bash', command: 'touch scripts/gen.sh' })
    await $.tool.call({ tool: 'Write', file_path: '/work/NEXT_SESSION_PROMPT.md', content: 'notes' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
    await w.clock.advance(300)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(66) })
      await ui.press({ key: 'tab-activity' })
      await w.clock.advance(300)
      const text = textOf(await ui.drawn())
      for (const expected of ['RUN PROGRESS', 'Build the parser and cover it with tests.', '1 of 3 milestones', 'Building the parser', 'Write the tests', 'THIS TURN', 'ATTENTION', 'unresolved', 'VALIDATION', 'Tests', 'Lint', 'CHANGES', 'CODE', '+2', 'new · diff unavailable']) {
        expect(text, `${surface}: ${expected}`).toContain(expected)
      }
      expect(text, surface).not.toContain('+0 −0')
      // Files are buttons that open their diff; the handoff notes sit folded under generated files.
      expect(await ui.find({ key: 'pick-/work/src/parser.ts' }), surface).toBeDefined()
      expect(await ui.find({ key: 'pick-/work/NEXT_SESSION_PROMPT.md' }), surface).toBeUndefined()
      expect((await ui.find({ key: 'toggle-generated' }))?.props.label, surface).toContain('Generated and temporary · 1')
      await ui.press({ key: 'toggle-generated' })
      await w.clock.advance(300)
      expect(await ui.find({ key: 'pick-/work/NEXT_SESSION_PROMPT.md' }), surface).toBeDefined()
      await ui.press({ key: 'toggle-generated' })
      await w.clock.advance(300)
      // The full call list is one press away, newest first.
      await ui.press({ key: 'sub:raw' })
      await w.clock.advance(300)
      const raw = textOf(await ui.drawn())
      expect(raw.indexOf('npm run lint'), surface).toBeLessThan(raw.indexOf('TodoWrite'))
      await ui.press({ key: 'sub:summary' })
      await w.clock.advance(300)
      await ui.unmount()
    }
  })

  test('the status bar shows run progress apart from context, what Claude is doing, and the run cost only', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    await boot($, w)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'A', status: 'completed', activeForm: 'Doing A' },
        { content: 'B', status: 'completed', activeForm: 'Doing B' },
        { content: 'C', status: 'in_progress', activeForm: 'Running regression tests' },
        { content: 'D', status: 'pending', activeForm: 'Doing D' },
      ],
    })
    await w.clock.advance(300)
    const wide = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    const line = textOf(await wide.drawn())
    // The headline: what Claude is doing in its own words, then where the milestone sits; the instruments below.
    expect(line).toContain('Running regression tests · step 3 of 4')
    expect(line).not.toContain('C · 3 of 4')
    expect(line.indexOf('Running regression tests')).toBeLessThan(line.indexOf('CONTEXT'))
    // Work is a track of stops, Context a meter of segments: two shapes that cannot be confused.
    expect(line).toContain('WORK ●━●━◉─○ 2/4')
    expect(line).toContain('CONTEXT ▇')
    // The plan's five-hour window, before Claude Code has a reading of it; the run's cost is no longer on the bar.
    expect(line).toContain('5H —')
    expect(line).not.toContain('$1.25')
    await wide.unmount()
    // Narrow: no names, the instruments stay apart by shape.
    const narrow = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(48) })
    const small = textOf(await narrow.drawn())
    expect(small).not.toContain('CONTEXT')
    expect(small).toContain('◉─○ 2/4')
    expect(small).toContain('▇')
    expect(small).toContain('30%')
    await narrow.unmount()
    // Desktop: each reading a cell, a caption over its graphic and value; every graphic an image of a fixed size.
    const desktop = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(120) })
    const drawn = await desktop.drawn()
    expect(textOf(drawn)).toContain('Work2 of 4')
    expect(textOf(drawn)).toContain('Context')
    expect(textOf(drawn)).toContain('5-hour usage—')
    each(drawn, n => {
      if (n.type !== 'Svg') return
      expect(n.props?.isInteractive, String(n.props?.alt)).toBeUndefined()
      expect(typeof n.props?.width, String(n.props?.alt)).toBe('number')
      expect(typeof n.props?.height, String(n.props?.alt)).toBe('number')
    })
    for (const key of ['cell-work', 'cell-ctx', 'cell-cache', 'cell-plan']) expect(await desktop.find({ key }), key).toBeDefined()
    await desktop.unmount()
    // A narrow band takes the compact cells.
    const compact = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(60) })
    expect(textOf(await compact.drawn())).toContain('Work2/4')
    await compact.unmount()
  })

  test('once a turn ends, the top line says what it did, and checks show by name', async ($, on) => {
    on('tool.call', { tool: 'Bash' }, ($, e) =>
      e.command === 'npm run lint' ? { isError: true as const, result: 'Exit code 1', text: 'Exit code 1\nnpm error Missing script: "lint"' } : { result: { stdout: 'ok', stderr: '', interrupted: false } },
    )
    const w = world(on, { tokens: 300_000 })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    await boot($, w)
    const before = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    // Before the first turn there is nothing to say on top: the readings alone.
    expect(textOf(await before.drawn())).not.toContain('Ran ')
    await before.unmount()
    await $.turn.start({ text: 'check it', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.advance(300)
    const after = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    const text = textOf(await after.drawn())
    expect(text).toContain('Ran tests once, passing · lint once, failing')
    // What needs a look is a chip on the right: the failing check by name, shown once, not again as an issue.
    expect(text).toContain('✗ Lint failing')
    expect(text).not.toContain('issue')
    expect(text).not.toContain('Tests failing')
    await after.unmount()
    // Docked beside the panel: the chip still fits.
    const docked = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(79) })
    expect(textOf(await docked.drawn())).toContain('Lint failing')
  })

  test('the spinner carries the activity summary while a turn runs', async ($, on) => {
    const w = world(on)
    const seen: (string | null)[] = []
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      seen.push(e.props.message)
      return ENGINE_ROW
    })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await boot($, w)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await w.clock.advance(300)
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Spinner', requestId: 'main', props: { word: 'Working', message: null, suffix: '…', mode: 'tool-use' } })
    await ui.drawn()
    expect(seen.at(-1)).toContain('Working · 1 tool')
  })

  test('Behavior offers the answer styles on every surface, with a line written in the chosen one', async ($, on) => {
    const w = world(on)
    await boot($, w)
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(66) })
    await ui.press({ key: 'tab-behavior' })
    await w.clock.advance(300)
    const cards = cardsOf(await ui.drawn())
    expect(cards[0]?.title).toBe('ANSWER STYLE')
    await ui.press({ key: 'an-style' })
    await w.clock.advance(300)
    expect(textOf(await ui.drawn())).toContain('Simplified Technical English')
    await ui.press({ key: 'an-style:mission' })
    await w.clock.advance(2000)
    expect(saved(w).answers.style).toBe('mission')
    const text = textOf(await ui.drawn())
    expect(text).toContain('For example')
    expect(text).toContain('GO · tests pass, 3 of 3')
    expect(text).toContain('GO only for what was verified')
    await ui.unmount()
    for (const surface of ['desktop', 'mobile'] as const) {
      const other = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(90) })
      expect(textOf(await other.drawn()), surface).toContain('How Claude writes to you')
      await other.unmount()
    }
  })

  test('Quest log: Activity shows the level, the awards and the achievements; the status bar the level', async ($, on) => {
    const w = world(on, { settings: { answers: { style: 'quest' } } })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    await boot($, w)
    await $.turn.start({ text: 'Build the parser and test it.', turnId: 't1' })
    await $.tool.call({ tool: 'mcp__project-sentinel__milestones', milestones: [{ title: 'Sketch', status: 'completed' }, { title: 'Build', status: 'in_progress', doing: 'Building' }] } as never)
    await w.clock.advance(300)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(66) })
      await ui.press({ key: 'tab-activity' })
      await w.clock.advance(300)
      const text = textOf(await ui.drawn())
      for (const expected of ['QUEST', 'Level 1', '+50 XP this run', 'Milestone: Sketch', '50 XP', 'First green', 'Comeback', 'Full clear', 'XP counts verified progress only']) {
        expect(text, `${surface}: ${expected}`).toContain(expected)
      }
      await ui.unmount()
    }
    const band = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    expect(textOf(await band.drawn())).toContain('★ Lv 1')
  })

  test('Context draws the run as columns, one per session, against the handoff line', async ($, on) => {
    const run = {
      v: 1,
      id: 'r1',
      number: 7,
      startedAt: 900_000,
      updatedAt: 990_000,
      root: '/work',
      profile: 'normal',
      status: 'active',
      sessions: [
        { id: 'earlier', index: 1, startedAt: 900_000, endedAt: 950_000, start: 'startup', end: 'handoff', peakTokens: 720_000, lastTokens: 718_000, window: 1_000_000, costUsd: 20, turns: 9, model: null, endNote: 'handoff at 700k tokens', transitions: [] },
        { id: 'session-1', index: 2, startedAt: 950_000, endedAt: null, start: 'handoff', end: null, peakTokens: 300_000, lastTokens: 300_000, window: 1_000_000, costUsd: 4, turns: 2, model: null, endNote: null, transitions: [] },
      ],
      lastHandoff: LAST_HANDOFF,
    }
    const w = world(on, { tokens: 300_000, settings: { autopilot: { enabled: true, thresholdMode: 'percent', thresholdPercent: 70 } } })
    w.store['run.v1.r1'] = run
    w.store['runs.index.v1'] = ['r1']
    await boot($, w)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(66) })
      await ui.press({ key: 'tab-context' })
      await w.clock.advance(300)
      const text = textOf(await ui.drawn())
      expect(text, surface).toContain('Peak context per session · hands off at 70%')
      expect(text, surface).toContain('RUN 7')
      // The last handoff: what it left (5 of 5), and what the fresh context picked up (4 of 5, the docs not read).
      for (const expected of ['LAST HANDOFF', 'Session 1 → 2', 'Left for the fresh context', '5 of 5', 'Picked up in session 2', '4 of 5', 'Project docs read', 'None opened', 'never from what Claude said']) {
        expect(text, `${surface}: ${expected}`).toContain(expected)
      }
      if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('Context shows the prompt cache: how long it stays warm, what it holds, Keep warm, and why it was rebuilt', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    w.store['cache.v1'] = { v: 1, ttl: '1h', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    // Every request writes its whole prompt afresh: the second, on another model, finds nothing cached.
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 300_000, model: e.model } }
    })
    await boot($, w)
    for (const [turnId, model] of [['t1', 'claude-opus-5-5'], ['t2', 'claude-sonnet-5-5']] as const) {
      await $.turn.start({ text: 'Build the parser.', turnId })
      for await (const _ of $.turn.step({ turnId, index: 0, model, effort: 'high', messageCount: 2 })) void _
      await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId, reason: 'answer' })
    }
    await w.clock.advance(300)
    expect(w.kept.toasts).toContain('Cache rebuilt: 300k tokens · Model changed')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(66) })
      await ui.press({ key: 'tab-context' })
      await w.clock.advance(300)
      const text = textOf(await ui.drawn())
      for (const expected of ['CACHE', 'Warm · lapses in about', '1-hour cache', '300k tokens cached', 'Keep warm while you are away', 'Ask before a model switch', 'Keep policies stable', 'CACHE HEALTH', '1 rebuild · 1 preventable', 'Model changed: opus-5-5 → sonnet-5-5', 'Proven cause. Switch models', 'Switch models at the start of a fresh context', 'derived']) {
        expect(text, `${surface}: ${expected}`).toContain(expected)
      }
      await ui.unmount()
    }
    // The switch and the idle limit are set right there.
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(66) })
    await ui.press({ key: 'tab-context' })
    await w.clock.advance(300)
    expect(await ui.find({ key: 'cache-idle-inc' })).toBeUndefined()
    await ui.press({ key: 'cache-keep' })
    await w.clock.advance(300)
    await ui.press({ key: 'cache-idle-inc' })
    await w.clock.advance(2000)
    expect(saved(w).cache).toMatchObject({ keepWarm: true, maxIdleMinutes: 180 })
    expect(textOf(await ui.drawn())).toContain('Next refresh at')
    await ui.unmount()
    // The status bar names the costly rebuild for a few minutes, in place of the time left.
    const band = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    expect(textOf(await band.drawn())).toContain('CACHE ● rebuilt 300k')
    await band.unmount()
    const desktop = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(120) })
    expect((await desktop.find({ type: 'Svg' }))?.props.alt).toBeDefined()
    expect(textOf(await desktop.drawn())).toContain('rebuilt 300k')
  })

  test('the status bar: what is happening and the run cost on top, then Context, Work and Cache, each its own shape', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    w.store['cache.v1'] = { v: 1, ttl: '1h', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 300_000, model: e.model } }
    })
    await boot($, w)
    // Before the first turn: the top line is quiet, and nothing is cached yet.
    const before = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    const idle = textOf(await before.drawn())
    expect(idle).toContain('Ready')
    expect((await before.find({ type: 'Button', key: 'open' }))?.props.label).toBe('◆ Control Room')
    expect(idle).not.toContain('CACHE')
    await before.unmount()
    // On Desktop the button is the app's primary one with the panel closed too: a button, not a tag.
    const closed = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(120) })
    expect((await closed.find({ type: 'Button', key: 'open' }))?.props).toMatchObject({ label: '◆ Control Room', variant: 'primary' })
    await closed.unmount()
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'mcp__project-sentinel__milestones', milestones: [{ title: 'Sketch', status: 'completed' }, { title: 'Build', status: 'in_progress', doing: 'Building the parser' }, { title: 'Test', status: 'pending' }] } as never)
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 2 })) void _
    await w.clock.advance(300)
    const band = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    const text = textOf(await band.drawn())
    expect(text).toContain('Building the parser · step 2 of 3')
    expect(text).toContain('5H —')
    expect(text).toContain('WORK ●━◉─○ 1/3')
    // While Claude works its requests keep the cache warm: the reading would only be noise.
    expect(text).not.toContain('CACHE')
    // The headline, then the instruments: what is happening sits above them.
    expect(text.indexOf('Building the parser')).toBeLessThan(text.indexOf('CONTEXT'))
    expect(text.indexOf('Control Room')).toBeLessThan(text.indexOf('CONTEXT'))
    // The button is a filled control, in the brand color while the panel is open.
    expect((await band.find({ type: 'Box', key: 'open-chip' }))?.props.backgroundColor).toBe('subtle')
    await $.command.run({ command: 'cr', args: 'open', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await w.clock.advance(300)
    await band.redraw()
    expect((await band.find({ type: 'Box', key: 'open-chip' }))?.props.backgroundColor).toBe('claude')
    await band.unmount()
    // Desktop: the state's mark, the track, the meter and the clock as SVG, each transparent on the app's theme.
    // The cache keeps its cell while Claude works: warm, its time left no reading while requests keep it so.
    const desktop = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(120) })
    const svgs: Node[] = []
    each(await desktop.drawn(), n => void (n.type === 'Svg' ? svgs.push(n) : undefined))
    expect(svgs.map(s => String(s.props?.alt))).toEqual(['working', 'Work: 1 of 3 milestones done', 'Context 30% used', expect.stringMatching(/^Prompt cache warm/)])
    for (const svg of svgs) expect(String(svg.props?.source)).toContain('color-scheme:light dark')
    // Where there is room, the cache says what it holds as well.
    expect(textOf(await desktop.find({ key: 'cell-cache' }))).toBe('Cachewarm · 300k')
    expect((await desktop.find({ type: 'Button', key: 'open' }))?.props.variant).toBe('primary')
    await desktop.unmount()
    // Once the turn ends and the person is away, the cache shows how long it has left.
    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.advance(300)
    const away = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    expect(textOf(await away.drawn())).toMatch(/CACHE ● (1h|59m) left/)
    await away.unmount()
    for (const [columns, expected] of [[120, /^Cache(1h|59m) left · 300k$/], [96, /^Cache(1h|59m) left$/], [60, /^Cache(1h|59m)$/]] as const) {
      const remote = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(columns) })
      expect(textOf(await remote.find({ key: 'cell-cache' })), String(columns)).toMatch(expected)
      await remote.unmount()
    }
  })

  test('on Desktop the five readings keep their cells, a quiet word standing in for one with nothing yet', async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    await boot($, w)
    // Mobile leaves the band to the engine.
    for (const surface of ['desktop'] as const) {
      for (const [columns, none] of [[120, 'No milestones yet'], [60, 'None']] as const) {
        const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'AbovePrompt', props: bandProps(columns) })
        const where = `${surface} ${columns}`
        // Before any milestone and before anything is cached: Work and Cache keep their place, in dim words.
        const work = await ui.find({ key: 'cell-work' })
        expect(textOf(work), where).toBe(`Work${none}`)
        expect(textOf(await ui.find({ key: 'cell-cache' })), where).toBe('Cache—')
        // No machine readings (the sampler is off): the Machine cell keeps its place too.
        expect(textOf(await ui.find({ key: 'cell-machine' })), where).toBe('Machine—')
        let dimmed = 0
        each(work, n => void (n.type === 'Text' && n.props?.dimColor === true && textOf(n) === none ? dimmed++ : undefined))
        expect(dimmed, where).toBe(1)
        // Columns weighted by what they hold, on a zero basis (fixed shares); the five-hour reading takes what it needs at the right edge.
        for (const [key, weight] of [['cell-work', 3], ['cell-ctx', 3], ['cell-cache', 2], ['cell-machine', 2]] as const) {
          const cell = await ui.find({ key })
          expect(cell?.props.flexGrow, `${where} ${key}`).toBe(weight)
          expect(cell?.props.width, `${where} ${key}`).toBe(0)
        }
        expect((await ui.find({ key: 'cell-plan' }))?.props.flexGrow, where).toBe(0)
        expect(textOf(await ui.find({ key: 'cell-plan' })), where).toBe(columns < 80 ? '5h—' : '5-hour usage—')
        await ui.unmount()
      }
    }
  })

  test('the Machine cell: CPU and memory as level bars with their percentages, toned near a ceiling; on Desktop the headline does not repeat them', async ($, on) => {
    const w = world(on, { tokens: 300_000, samplerLines: [typeperfLine(34, 1500)] })
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    await $.session.start({ ...SESSION, cwd: 'C:\\work' })
    await w.clock.advance(500)
    // 34% CPU, 85% memory (1.5 of 10 GB free): calm, then near the 92% mark.
    for (const [columns, caption, labels] of [[140, 'Machine', true], [96, 'CPU · RAM', false], [64, 'CPU · RAM', false]] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(columns) })
      const cell = await ui.find({ key: 'cell-machine' })
      const text = textOf(cell)
      expect(text, String(columns)).toBe(labels ? 'MachineCPU34%RAM85%' : `${caption}34%85%`)
      const bars: Node[] = []
      each(cell, n => void (n.type === 'Svg' ? bars.push(n) : undefined))
      expect(bars.map(b => String(b.props?.alt)), String(columns)).toEqual(columns < 80 ? [] : ['CPU 34%', 'RAM 85%'])
      // No machine chip in the headline on Desktop: the cell carries it.
      expect(textOf(await ui.find({ key: 'hud-head' })), String(columns)).not.toContain('RAM')
      await ui.unmount()
    }
    // The terminal has no such cell: the chip stays there.
    const term = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(160) })
    expect(textOf(await term.find({ key: 'hud-head' }))).toContain('▲ RAM 85%')
    await term.unmount()
  })

  test('Overview leads with the run, then Work, Context and Cache, each with how it starts over', async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    await boot($, w)
    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(66) })
      const text = textOf(await ui.drawn())
      for (const expected of ['Run 1 · Session 1', '$1.25', 'WORK', 'CONTEXT', 'CACHE', 'Carries across handoffs', 'Starts over', 'Nothing cached yet', 'BEHAVIOR', 'GUARDRAILS', 'ACTIVITY']) {
        expect(text, `${surface}: ${expected}`).toContain(expected)
      }
      expect(text.indexOf('WORK'), surface).toBeLessThan(text.indexOf('CONTEXT'))
      expect(text.indexOf('CONTEXT'), surface).toBeLessThan(text.indexOf('CACHE'))
      expect(text.indexOf('CACHE'), surface).toBeLessThan(text.indexOf('BEHAVIOR'))
      await ui.unmount()
    }
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(66) })
    await ui.press({ key: 'sys-keepwarm' })
    await w.clock.advance(2000)
    expect(saved(w).cache.keepWarm).toBe(true)
  })

  test("Overview's Cache card says the cache's state once: the status line, then only what it holds, the lifetime in the aside", () => {
    const base: CacheView = {
      warmth: 'unknown', ttl: null, ttlSource: null, expiresAt: null, lastRequestAt: 1, cachedTokens: 345_000, requests: 3, hitRatio: 0.98, read: 1, written: 1, model: null,
      keepWarm: { isOn: false, nextAt: null, isProbe: false, reason: 'Off', refreshes: 0, lastAt: null, lastRead: null, lastHit: null, verified: 'unknown', maxIdleMinutes: 120, isRefreshing: false, error: null, main: 'none', pausedReason: null, log: [] },
      misses: [], policies: { isStable: true, isHolding: false }, guardModelSwitch: true,
    }
    // The status line says it may have lapsed; the line under it says only what the cache holds.
    expect(cacheState(base, 10).text).toContain('May have lapsed')
    expect(cacheSummary(base)).toBe('345k cached · 98% read from cache')
    expect(lifetimeWords(base)).toBeNull()
    for (const warmth of ['warm', 'cold'] as const) expect(cacheSummary({ ...base, warmth })).not.toMatch(/lapsed|warm/i)
    expect(lifetimeWords({ ...base, ttl: '1h', ttlSource: 'plan' })).toBe('1-hour cache')
  })

  test('Kit, the companion: off by default; on, one surface module draws it in the terminal and on Desktop, on its own clock, and a touch gets a reaction', async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    await boot($, w)
    const off = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(120) })
    expect(await off.find({ type: 'Client' })).toBeUndefined()
    await off.unmount()
    expect((await $.command.run({ command: 'cr', args: 'companion on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text).toContain('Kit')
    await w.clock.advance(300)

    // The terminal: the module named by a fixed path, its props plain data with the surface added.
    const band = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(120) })
    const client = await band.find({ type: 'Client' })
    expect(String(client?.props.module)).toContain('kit.client.tsx')
    expect(client?.props.props).toMatchObject({ surface: 'terminal', mood: 'wake', isFresh: true, isReduced: false })
    await band.resize({ columns: 100, rows: 5, in: 'kit' })
    // Where Kit's half blocks start on its five rows, and what the rows say.
    const rowsOf = (tree: unknown) => ((tree as Node).children ?? []).map(textOf)
    const rows = async () => rowsOf(await band.drawn({ in: 'kit' }))
    const leftOf = async () => Math.min(...(await rows()).map(r => (/[▀▄█]/.test(r) ? r.search(/[▀▄█]/) : 999)))
    // A fresh context: Kit walks in from beyond the left edge, then rests at its place.
    await band.advance(1000)
    expect(await rows()).toHaveLength(5)
    expect(await leftOf()).toBe(0)
    expect((await rows()).join('').replace(/[^▀▄█]/g, '').length).toBeLessThan(60)
    await band.advance(12_000)
    const home = await leftOf()
    expect(home).toBeGreaterThan(10)
    // Drawn again in the same context (a new instance), it does not walk in again: it is where it was.
    await band.unmount()
    const again = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(120) })
    await again.resize({ columns: 100, rows: 5, in: 'kit' })
    await again.advance(400)
    const rowsAgain = rowsOf(await again.drawn({ in: 'kit' }))
    expect(Math.min(...rowsAgain.map(r => (/[▀▄█]/.test(r) ? r.search(/[▀▄█]/) : 999)))).toBe(home)
    await again.unmount()

    // Claude thinks: Kit paces its lane.
    const live = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(120) })
    await live.resize({ columns: 100, rows: 5, in: 'kit' })
    const liveLeft = async () => Math.min(...rowsOf(await live.drawn({ in: 'kit' })).map(r => (/[▀▄█]/.test(r) ? r.search(/[▀▄█]/) : 999)))
    await $.turn.start({ text: 'Build the parser.', turnId: 't1' })
    await w.clock.advance(300)
    await live.redraw()
    expect(((await live.find({ type: 'Client' }))?.props.props as { mood: string }).mood).toBe('think')
    const before = await liveLeft()
    // It ponders, then paces a few units and back, so one sample may find it where it began: watch it a while.
    const seen = new Set<number>()
    for (let i = 0; i < 12; i++) {
      await live.advance(1500)
      seen.add(await liveLeft())
    }
    expect([...seen].some(x => x !== before)).toBe(true)
    // It works on a milestone; a touch while Claude works: a quick look up, and nothing opens.
    await $.tool.call({ tool: 'mcp__project-sentinel__milestones', milestones: [{ title: 'Build', status: 'in_progress', doing: 'Building the parser' }, { title: 'Test', status: 'pending' }] } as never)
    await w.clock.advance(300)
    await live.redraw()
    expect(((await live.find({ type: 'Client' }))?.props.props as { mood: string }).mood).toBe('work')
    await live.advance(3000)
    const at = await liveLeft()
    await live.pointer({ type: 'down', x: at + 8, y: 3, button: 'left', in: 'kit' })
    // At once, or after a walk eases to a stop (a working Kit may be carrying its notes somewhere).
    let isGlanced = false
    for (let i = 0; i < 6 && !isGlanced; i++) {
      await live.advance(250)
      isGlanced = rowsOf(await live.drawn({ in: 'kit' })).join('').includes('!')
    }
    expect(isGlanced).toBe(true)
    await w.clock.advance(300)
    expect(w.kept.opened).not.toContain('control-room')
    await live.unmount()

    // Desktop: the same module draws an image a frame, a lane that fits the band, and takes a touch in cells.
    const desktop = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(120) })
    const desktopClient = await desktop.find({ type: 'Client' })
    expect(desktopClient?.props.props).toMatchObject({ surface: 'desktop', mood: 'work' })
    await desktop.resize({ columns: 100, rows: 4, in: 'kit' })
    const findArt = async () => {
      let found: Node | undefined
      each(await desktop.drawn({ in: 'kit' }), n => void (n.type === 'Svg' ? (found = n) : undefined))
      return found
    }
    // Switched on mid-session and drawn anew: it moves within 600 ms (its arrival), never a still first picture.
    await desktop.advance(100)
    const arriving = String((await findArt())?.props?.source)
    await desktop.advance(500)
    const art = await findArt()
    expect(String(art?.props?.source)).not.toBe(arriving)
    expect(String(art?.props?.alt)).toContain('Kit')
    expect(String(art?.props?.source)).toContain('<path')
    expect(String(art?.props?.source)).not.toContain('<animate')
    expect(art?.props?.isInteractive).toBeUndefined()
    // The whole width of the status bar, no longer a strip of it: wider than the region, so the page's
    // `max-width: 100%` makes its box the region's, and the drawing (100 cells of lane) stretches to
    // fill it whatever a Desktop cell measures. Desktop's page refuses a module's image without both a
    // width and a height (1.5.0 sent no width: "returned a tree the page cannot draw").
    expect(art?.props?.width).toBe(1211)
    expect(art?.props?.height).toBe(84)
    expect(String(art?.props?.source)).toContain('viewBox="0 0 807 84"')
    expect(String(art?.props?.source)).toContain('width="1211" height="84" preserveAspectRatio="none"')
    expect(desktopClientFault(await desktop.drawn({ in: 'kit' }))).toBeNull()
    const first = String(art?.props?.source)
    await desktop.advance(3000)
    expect(String((await findArt())?.props?.source)).not.toBe(first)
    expect(desktopClientFault(await desktop.drawn({ in: 'kit' }))).toBeNull()
    // At the widest lane too: the width stays within what the page draws.
    await desktop.resize({ columns: 500, rows: 4, in: 'kit' })
    await desktop.advance(400)
    expect((await findArt())?.props?.width).toBe(4096)
    expect(desktopClientFault(await desktop.drawn({ in: 'kit' }))).toBeNull()
    await desktop.pointer({ type: 'down', x: 8, y: 2, button: 'left', in: 'kit' })
    await desktop.advance(300)
    expect(w.kept.opened).not.toContain('control-room')
    // A module that cannot draw says so; Kit is left out, and the status bar draws without it.
    await desktop.post({ fault: 'drawing failed' }, { in: 'kit' })
    await w.clock.advance(300)
    await desktop.unmount()
    const without = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(120) })
    expect(await without.find({ type: 'Client' })).toBeUndefined()
    expect(await without.find({ key: 'hud-head' })).toBeDefined()
    await without.unmount()
  })

  test('Kit held still: Reduce motion holds one pose; VS Code, which draws no surface module, shows that pose as an image', async ($, on) => {
    const w = world(on, { tokens: 300_000, settings: { ui: { companion: true, reducedMotion: true } } })
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    await boot($, w)
    const band = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'AbovePrompt', props: bandProps(120) })
    expect((await band.find({ type: 'Client' }))?.props.props).toMatchObject({ isReduced: true })
    await band.resize({ columns: 100, rows: 5, in: 'kit' })
    await band.advance(400)
    const still = JSON.stringify(await band.drawn({ in: 'kit' }))
    await band.advance(8000)
    expect(JSON.stringify(await band.drawn({ in: 'kit' }))).toBe(still)
    await band.unmount()
    const vscode = await $.ui.mount({ plugin: 'project-sentinel', surface: 'vscode', component: 'AbovePrompt', props: bandProps(120) })
    let image: Node | undefined
    each(await vscode.drawn(), n => void (n.type === 'Svg' && String(n.props?.alt).includes('Kit') ? (image = n) : undefined))
    expect(String(image?.props?.source)).toContain('<path')
    expect(image?.props?.height).toBe(84)
    await vscode.unmount()
    // Setup carries both switches.
    const pane = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(66) })
    await pane.press({ key: 'tab-setup' })
    await w.clock.advance(300)
    await pane.press({ key: 'ui-companion' })
    await w.clock.advance(2000)
    expect(saved(w).ui).toMatchObject({ companion: false, reducedMotion: true })
  })

  test('panel hierarchy: Setup lists the most telling changes first, Guardrails groups permissions, Now is what Claude is doing', async ($, on) => {
    const w = world(on, {
      tokens: 300_000,
      settings: {
        autopilot: { enabled: true, thresholdPercent: 60 },
        frontier: { enabled: true },
        guard: { enabled: true },
        qa: { enabled: true },
        resources: { level: 'medium' },
        subagents: { mode: 'block' },
        focus: { enabled: false },
        answers: { style: 'brief' },
      },
    })
    await boot($, w)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(66) })
      await ui.press({ key: 'tab-setup' })
      await w.clock.advance(300)
      let text = textOf(await ui.drawn())
      // Settings saved before 1.7.0 (no defaults marker): their Normal now reads as Classic, the values untouched.
      expect(text, surface).toContain('CHANGED FROM CLASSIC')
      // Autopilot and Frontier Max before presentation; four shown, then a way to all of them.
      expect(text, surface).toContain('Hand off at')
      expect(text, surface).not.toContain('Focus')
      expect(String((await ui.find({ type: 'Button', key: 'changes-all' }))?.props.label), surface).toMatch(/^View all \d+/)
      expect(text, surface).not.toMatch(/and \d+ more/)
      await ui.press({ key: 'changes-all' })
      await w.clock.advance(300)
      text = textOf(await ui.drawn())
      expect(String((await ui.find({ type: 'Button', key: 'changes-all' }))?.props.label), surface).toMatch(/^Show fewer/)
      expect(text.indexOf('Hand off at'), surface).toBeLessThan(text.indexOf('Focus'))
      await ui.press({ key: 'changes-all' })
      await w.clock.advance(300)
      // Guardrails: the permissions in groups a person thinks in.
      await ui.press({ key: 'tab-guardrails' })
      await w.clock.advance(300)
      text = textOf(await ui.drawn())
      const order = ['PROJECT', 'Project edits', 'NETWORK', 'Network access', 'GIT', 'Git push', 'EXTERNAL', 'Deploy', 'SAFETY', 'Dangerous commands', 'Ask always asks you first', 'SUBAGENTS']
      for (let i = 1; i < order.length; i++) expect(text.indexOf(order[i - 1]!), `${surface}: ${order[i]}`).toBeLessThan(text.indexOf(order[i]!))
      // Each group is a card of its own (a heading inside a box reads as a row on Desktop), its title quiet
      // structure: bold and gray, never a color (color is meaning: 1.7.0).
      for (const id of ['project', 'network', 'git', 'external', 'safety']) {
        const colors = new Set<unknown>()
        let isQuiet = false
        each(await ui.find({ key: `card-perm-${id}-head` }), n => {
          if (n.type !== 'Text') return
          if (n.props?.color !== undefined) colors.add(n.props.color)
          if (n.props?.bold === true && n.props?.dimColor === true) isQuiet = true
        })
        expect([...colors], `${surface} ${id}`).toEqual([])
        expect(isQuiet, `${surface} ${id}`).toBe(true)
      }
      // Overview: Now is what Claude is doing; the machine's readings sit with Guardrails.
      await ui.press({ key: 'tab-overview' })
      await w.clock.advance(300)
      text = textOf(await ui.drawn())
      // Now sits right under the run, unboxed: what is happening comes before the lifecycles and the settings.
      const now = textOf(await ui.find({ key: 'now' }))
      expect(now, surface).toContain('Ready')
      expect(now, surface).not.toContain('Memory')
      expect(text.indexOf('Ready'), surface).toBeLessThan(text.indexOf('WORK'))
      await ui.unmount()
    }
  })

  test('Activity’s views are a second level of navigation: a breadcrumb over a View row, never a setting’s radio choice', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 300_000 })
    await boot($, w)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(66) })
      await ui.press({ key: 'tab-activity' })
      await w.clock.advance(300)
      const nav = await ui.find({ key: 'sub-nav' })
      const text = textOf(nav)
      expect(text, surface).toContain('Activity › Summary')
      expect(text, surface).toContain('View')
      // Never the radio marks a setting's choice uses.
      expect(text, surface).not.toMatch(/[●○] (Summary|Operations|Tool calls)/)
      if (surface === 'terminal') {
        // The current view bracketed in the section's accent and bright; the others plain and dim.
        expect(text).toContain('[  ]')
        expect((await ui.find({ type: 'Button', key: 'sub:summary' }))?.props).toMatchObject({ label: 'Summary', plain: true })
        expect((await ui.find({ type: 'Button', key: 'sub:summary' }))?.props.dimColor).toBeUndefined()
        expect((await ui.find({ type: 'Button', key: 'sub:ops' }))?.props).toMatchObject({ plain: true, dimColor: true })
      } else {
        // Desktop: a bordered group of its own buttons, the current one primary, apart from the section bar.
        expect((await ui.find({ key: 'sub-group' }))?.props).toMatchObject({ borderStyle: 'round' })
        expect((await ui.find({ type: 'Button', key: 'sub:summary' }))?.props.variant).toBe('primary')
        expect((await ui.find({ type: 'Button', key: 'sub:ops' }))?.props.variant).toBe('secondary')
      }
      await ui.press({ key: 'sub:ops' })
      await w.clock.advance(300)
      expect(textOf(await ui.find({ key: 'sub-nav' })), surface).toContain('Activity › Operations')
      await ui.press({ key: 'sub:summary' })
      await w.clock.advance(300)
      await ui.unmount()
    }
  })

  test('panel details: the permissions’ shared footnote after the last group, the Now mark, the cache’s dot, the turn legend in the strip’s colors', async ($, on) => {
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
    const w = world(on, { tokens: 300_000, settings: { permissions: { commit: 'ask' } } as never })
    w.store['cache.v1'] = { v: 1, ttl: '1h', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 300_000, model: e.model } }
    })
    await boot($, w)
    await $.turn.start({ text: 'go', turnId: 't1' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 2 })) void _
    await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm run build' })
    await w.clock.advance(300)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: paneProps(66) })
      // Overview: Now carries the state's mark (the status bar's icon on Desktop, set on its first line); the cache a small dot.
      await ui.press({ key: 'tab-overview' })
      await w.clock.advance(300)
      const nowMark: Node[] = []
      each(await ui.find({ key: 'now' }), n => void (n.type === 'Svg' ? nowMark.push(n) : undefined))
      if (surface === 'desktop') {
        expect(nowMark.map(n => [n.props?.alt, n.props?.width, n.props?.height])).toEqual([['thinking', 16, 24]])
        expect(String(nowMark[0]?.props?.source)).toContain('translate(0 4)')
      } else expect(nowMark).toEqual([])
      const cacheCard = await ui.find({ key: 'card-life-cache' })
      let clockFaces = 0
      each(cacheCard, n => void (n.type === 'Svg' ? clockFaces++ : undefined))
      expect(clockFaces, surface).toBe(0)
      expect(textOf(cacheCard), surface).toMatch(/● Warm/)
      // Guardrails: Restore safe defaults and the footnote close the permission groups, after the last card.
      await ui.press({ key: 'tab-guardrails' })
      await w.clock.advance(300)
      const keys: string[] = []
      each(await ui.drawn(), n => void (keyOf(n) !== '' ? keys.push(keyOf(n)) : undefined))
      const at = (key: string) => keys.indexOf(key)
      expect(at('card-perm-safety'), surface).toBeGreaterThan(-1)
      expect(at('card-perm-safety'), surface).toBeLessThan(at('foot-permissions'))
      expect(at('foot-permissions'), surface).toBeLessThan(at('perm-reset'))
      expect(at('perm-reset'), surface).toBeLessThan(at('card-agents'))
      expect(textOf(await ui.find({ key: 'foot-permissions' })), surface).toContain('Deny always stops an action')
      // Activity: on Desktop the legend's squares are drawn in the strip's own colors.
      await ui.press({ key: 'tab-activity' })
      await w.clock.advance(300)
      const swatches: Node[] = []
      each(await ui.find({ key: 'turn-legend' }), n => void (n.type === 'Svg' ? swatches.push(n) : undefined))
      if (surface === 'desktop') {
        expect(swatches.map(s => s.props?.alt)).toEqual(['read', 'check'])
        expect(String(swatches[0]?.props?.source)).toContain(`fill="${TIMELINE.read.svg}"`)
        expect(String(swatches[1]?.props?.source)).toContain(`fill="${TIMELINE.check.svg}"`)
      } else {
        expect(swatches).toEqual([])
        expect(textOf(await ui.find({ key: 'turn-legend' }))).toContain('■ read')
      }
      await ui.unmount()
    }
    // Restore safe defaults puts every permission back.
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: paneProps(66) })
    await ui.press({ key: 'tab-guardrails' })
    await w.clock.advance(300)
    await ui.press({ key: 'perm-reset' })
    await w.clock.advance(2000)
    expect(saved(w).permissions.commit).toBe('default')
  })

  test('a removed Allow is said in Guardrails beside the permissions, never as a warning atop the panel', async ($, on) => {
    const w = world(on, { settings: { permissions: { install: 'allow', commit: 'allow' } } })
    await boot($, w)
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'Pane', requestId: 'control-room', props: paneProps(100) })
    expect(await ui.find({ text: /Allow was removed/ })).toBeUndefined()
    await ui.press({ key: 'tab-guardrails' })
    await w.clock.advance(300)
    const said = await ui.find({ text: /Allow was removed in 1\.4\.0: Package installs, Git commits now use Default/ })
    expect(said).toBeDefined()
    await ui.unmount()
    await w.clock.advance(2000)
    expect(w.kept.toasts.some(t => t.startsWith('Allow was removed'))).toBe(true)
  })

  test('on Desktop no text of the panel or the status bar trips the app’s monospace rule', { timeoutMs: 30_000 }, async ($, on) => {
    on('tool.call', { tool: 'Write' }, ($, e) => ({ result: { type: 'create', filePath: e.file_path, content: 'a\nb\n', structuredPatch: [], originalFile: null } }))
    on('tool.call', { tool: 'Edit' }, ($, e) => ({ result: { filePath: e.file_path, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }] } }))
    on('tool.call', { tool: 'Bash' }, ($, e) => (e.command === 'npm test' ? { isError: true as const, result: 'Exit code 1', text: 'Exit code 1\nFAIL a.test.ts' } : { result: { stdout: 'ok', stderr: '', interrupted: false } }))
    const w = world(on, { tokens: 300_000, settings: { answers: { style: 'quest' }, autopilot: { enabled: true } } })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    w.store['run.v1.r1'] = {
      v: 1,
      id: 'r1',
      number: 3,
      startedAt: 900_000,
      updatedAt: 990_000,
      root: '/work',
      profile: 'normal',
      status: 'active',
      sessions: [
        { id: 'earlier', index: 1, startedAt: 900_000, endedAt: 950_000, start: 'startup', end: 'handoff', peakTokens: 720_000, lastTokens: 718_000, window: 1_000_000, costUsd: 20, turns: 9, model: null, endNote: null, transitions: [] },
        { id: 'session-1', index: 2, startedAt: 950_000, endedAt: null, start: 'handoff', end: null, peakTokens: 300_000, lastTokens: 300_000, window: 1_000_000, costUsd: 4, turns: 2, model: null, endNote: null, transitions: [] },
      ],
      lastHandoff: LAST_HANDOFF,
    }
    w.store['runs.index.v1'] = ['r1']
    w.store['cache.v1'] = { v: 1, ttl: '1h', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }
    // Two requests, the second on another model with nothing cached: the cache card and its health list draw too.
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 300_000, model: e.model } }
    })
    await boot($, w)
    await $.command.run({ command: 'cr', args: 'cache keep on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await $.turn.start({ text: 'Build the parser and cover it with tests.', turnId: 't1' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 2 })) void _
    for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 3 })) void _
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Sketch', status: 'completed', activeForm: 'Sketching' }, { content: 'Build', status: 'in_progress', activeForm: 'Building' }] })
    await $.tool.call({ tool: 'Write', file_path: '/work/src/parser.ts', content: 'a\nb\n' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/README.md', old_string: 'a', new_string: 'b\nc' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await w.clock.advance(300)
    // Desktop draws a text in a monospace face when it looks like a table or a rule (the app's own test).
    const looksTabular = (t: string): boolean => {
      if (/[─-▟]/u.test(t) || /[-=_~]{3,}|[-=]{2,}>|<[-=]{2,}/u.test(t)) return true
      const runs = [...t.matchAll(/\S( {2,})(?=\S)/gu)].map(m => m[1]?.length ?? 0)
      return runs.length >= 2 || runs.some(n => n >= 3)
    }
    const offenders: string[] = []
    const check = (tree: unknown, where: string) =>
      each(tree, n => {
        if (n.type !== 'Text' || !(n.children ?? []).every(c => typeof c === 'string')) return
        const t = (n.children as string[]).join('')
        if (t.trim() !== '' && looksTabular(t)) offenders.push(`${where}: ${JSON.stringify(t)}`)
      })
    const band = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: bandProps(110) })
    check(await band.drawn(), 'status bar')
    await band.unmount()
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'Pane', requestId: 'control-room', props: paneProps(90) })
    for (const tab of TABS) {
      await ui.press({ key: `tab-${tab.id}` })
      await w.clock.advance(300)
      check(await ui.drawn(), tab.id)
    }
    expect(offenders).toEqual([])
  })
})
