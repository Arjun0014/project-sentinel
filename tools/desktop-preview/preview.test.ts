import { describe, test } from 'claude-code/testing'

import { SESSION, world } from './fixtures/world'

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }

/** The band's tree with Kit's region holding what its surface module drew (the app draws the module inside it). */
function withKit(tree: unknown, kit: unknown): unknown {
  if (typeof tree !== 'object' || tree === null) return tree
  const n = tree as Node
  if (n.type === 'Client' && n.props?.key === 'kit') return { type: 'Box', props: { key: 'kit-region', flexGrow: 1 }, children: [kit] }
  return { ...n, children: (n.children ?? []).map(c => withKit(c, kit)) }
}

const band = (bodyColumns: number) => ({ hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} })
// From a full window (1400 px, about 175 columns) down to about 500 px (64 columns).
const WIDTHS = [175, 140, 120, 96, 80, 64]
const PANE = 90
const cmd = (args: string) => ({ command: 'cr', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })

describe('preview', () => {
  test('desktop band states', async ($, on) => {
    on('tool.call', { tool: 'Bash' }, ($, e) =>
      e.command === 'npm run lint' ? { isError: true as const, result: 'Exit code 1', text: 'Exit code 1\nnpm error Missing script: "lint"' } : { result: { stdout: 'ok', stderr: '', interrupted: false } },
    )
    // Machine load readings from the sampler (34% CPU, 85% memory), on a Windows session.
    const w = world(on, { tokens: 240_000, samplerLines: ['P 34 1500000000 10000000000'] })
    w.store['cache.v1'] = { v: 1, ttl: '1h', ttlSource: 'engine', verified: 'unknown', verifiedAt: null }
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))
    on('session.measure', ($, e) => ({ changed: e.changed }))
    let read = 0
    on('turn.step', async function* ($, e) {
      const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: read, cache_creation_input_tokens: 240_000 - read, model: e.model }
      read = 240_000
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage }
    })
    await $.session.start({ ...SESSION, cwd: 'C:\\work' })
    await w.clock.advance(300)
    await $.command.run(cmd('autopilot on'))
    await w.clock.advance(300)
    // A plan's five-hour window, as a response reports it: 36%, resetting in 1h 43m (the reading is wider than its caption).
    const rateLimits = [
      { kind: 'five_hour', percentUsed: 36, resetsAt: new Date(Date.now() + 103 * 60_000 + 30_000).toISOString() },
      { kind: 'seven_day', percentUsed: 16, resetsAt: new Date(Date.now() + 6 * 86_400_000).toISOString() },
    ]
    w.live.usage = { ...w.live.usage, rateLimits: rateLimits as never }
    await $.session.measure({ context: w.live.usage.context, rateLimits: rateLimits as never, cost: { usd: 1.25 }, changed: ['rateLimits'] })
    await w.clock.advance(300)
    const dump = async (name: string, surfaces: readonly ('desktop' | 'terminal')[] = ['desktop']) => {
      for (const surface of surfaces) {
        for (const columns of surface === 'desktop' ? WIDTHS : [150, 100, 80]) {
          const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'AbovePrompt', props: band(columns), viewport: { columns, rows: 40 } })
          let tree: unknown = await ui.drawn()
          // Kit: its region laid out across the band, its clock moved on so it has walked in.
          if ((await ui.find({ type: 'Client' })) !== undefined) {
            await ui.resize({ columns, rows: surface === 'desktop' ? 4 : 5, in: 'kit' })
            await ui.advance(9000)
            tree = withKit(await ui.drawn(), await ui.drawn({ in: 'kit' }))
          }
          console.log(`PREVIEW\t${name}\t${surface}\t${columns}\t${JSON.stringify(tree)}`)
          await ui.unmount()
        }
      }
    }
    await dump('ready')
    await $.turn.start({ text: 'go', turnId: 't1' })
    // A turn under way before Claude lists milestones, the cache warm from its first request.
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 2 })) void _
    await w.clock.advance(300)
    await dump('working-no-plan')
    await $.tool.call({
      tool: 'mcp__project-sentinel__milestones',
      milestones: [
        { title: 'Understand the code', status: 'completed' },
        { title: 'Investigate the Git strip', status: 'completed' },
        { title: 'Verify the cache', status: 'in_progress', doing: 'Running the regression tests' },
        { title: 'Verify Autopilot', status: 'pending' },
        { title: 'Redesign the status bar', status: 'verifying' },
        { title: 'Redesign Kit', status: 'verifying' },
        { title: 'Panel hierarchy', status: 'verifying' },
        { title: 'Milestone quality', status: 'verifying' },
        { title: 'Docs and screenshots', status: 'pending' },
        { title: 'Release', status: 'pending' },
      ],
    } as never)
    for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })) void _
    await w.clock.advance(300)
    await dump('working')
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 2, model: 'claude-opus-5-5', effort: 'high', messageCount: 4 })) void _
    await $.turn.complete({ answer: 'done', durationMs: 46_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.advance(300)
    await dump('done-failing')
    // Away for a while: the cache shows its time left.
    await w.clock.advance(12 * 60_000)
    await dump('away')
    await $.command.run(cmd('companion on'))
    await w.clock.advance(300)
    await dump('kit', ['desktop', 'terminal'])
    // Kit through a turn on Desktop, one drawing kept alive: frames along the way.
    const live = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'AbovePrompt', props: band(120), viewport: { columns: 120, rows: 40 } })
    await live.resize({ columns: 120, rows: 4, in: 'kit' })
    const frame = async (label: string, ms: number) => {
      await live.advance(ms)
      console.log(`PREVIEW\tkit-${label}\tdesktop\t120\t${JSON.stringify(withKit(await live.drawn(), await live.drawn({ in: 'kit' })))}`)
    }
    await frame('idle', 3000)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await w.clock.advance(300)
    await live.redraw()
    await frame('thinking', 4000)
    await frame('thinking-later', 3000)
    await $.turn.complete({ answer: 'done', durationMs: 9000, isAborted: false, turnId: 't2', reason: 'answer' })
    await w.clock.advance(300)
    await live.redraw()
    await frame('finished', 1500)
    await live.pointer({ type: 'down', x: 30, y: 2, button: 'left', in: 'kit' })
    await frame('touched', 500)
    await live.unmount()
    // The panel's pages, as a docked pane draws them.
    const pane = { title: 'Control Room', isFocused: true, bodyColumns: PANE, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 80 }, view: {} }
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'desktop', component: 'Pane', requestId: 'control-room', props: pane, viewport: { columns: PANE, rows: 80 } })
    for (const tab of ['overview', 'context', 'behavior', 'guardrails', 'activity', 'setup']) {
      await ui.press({ key: `tab-${tab}` })
      await w.clock.advance(300)
      console.log(`PREVIEW\tpane-${tab}\tdesktop\t${PANE}\t${JSON.stringify(await ui.drawn())}`)
    }
    // Operations: work queued for the fresh context, a decision Claude left, a budget; then the run asleep.
    await $.command.run(cmd('companion off'))
    await $.command.run(cmd('queue --handoff Carry the cache findings into the README'))
    await $.command.run(cmd('queue --handoff Re-run the benchmark on the new machine'))
    await $.tool.call({ tool: 'mcp__project-sentinel__decision_request', question: 'Postgres or SQLite for the cache store?', context: 'SQLite keeps it one file; Postgres is shared with the API.', options: ['Postgres', 'SQLite'], allowText: true } as never)
    await $.command.run(cmd('budget $30'))
    await w.clock.advance(300)
    await dump('ops-review')
    await ui.redraw()
    await ui.press({ key: 'tab-activity' })
    await w.clock.advance(300)
    await ui.press({ key: 'sub:ops' })
    await w.clock.advance(300)
    console.log(`PREVIEW\tpane-operations\tdesktop\t${PANE}\t${JSON.stringify(await ui.drawn())}`)
    await $.command.run(cmd('decide D-1 SQLite'))
    await $.command.run(cmd('watch in 2h S-002 result --warm'))
    await w.clock.advance(300)
    await dump('sleeping')
    await ui.redraw()
    console.log(`PREVIEW\tpane-operations-sleeping\tdesktop\t${PANE}\t${JSON.stringify(await ui.drawn())}`)
    await ui.unmount()
  })
})
