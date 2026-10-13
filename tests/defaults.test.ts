import { describe, expect, test } from 'claude-code/testing'

import { Runtime } from '../hooks/app/runtime'
import * as Views from '../hooks/app/views'
import { handleCommand } from '../hooks/app/commands'
import { applyProfile, findProfile, isModified, profileLabel } from '../hooks/core/profiles'
import { type Settings, classicSettings, classicSystems, defaultSettings, systemsOf } from '../hooks/core/settings'
import { fakeHost } from './fixtures/fake-host'
import { SESSION, world } from './fixtures/world'

// Fresh-install defaults (1.7.0): a new install is opinionated out of the box (Autopilot at 70% into a fresh
// context, Frontier Max at Extra High, Decisions, Watchers and milestones on) and says so once; an existing
// install keeps exactly what it had. Settings are saved only when one changes, so an install that used
// Sentinel but never changed a setting has no settings in its store: its runs, cache memory or Quest log
// show it is not new.

/** Settings as a version before 1.7.0 saved them: Normal meant what is now Classic, and no defaults marker. */
function before17(patch: (s: Settings) => void = () => undefined, profile = 'normal'): Record<string, unknown> {
  const s: Settings = { ...classicSettings(), profile }
  patch(s)
  const { defaults: _marker, ...stored } = s
  void _marker
  return stored
}

async function loaded(store: Record<string, unknown>) {
  const f = fakeHost()
  Object.assign(f.kept.store, store)
  const rt = new Runtime()
  rt.bind(f.host)
  await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await f.advance(200)
  return { ...f, rt }
}

describe('fresh-install defaults and the update', () => {
  test('a fresh store: the 1.7 defaults, saved at once (no "Normal · edited"), and the first-run card until Got it', async () => {
    const f = await loaded({})
    expect(f.rt.settings).toEqual(defaultSettings())
    expect(f.kept.store['settings.v1']).toEqual(defaultSettings())
    expect(profileLabel(f.rt.settings)).toBe('Normal')
    expect(Views.hudOf(f.rt).profile).toEqual({ id: 'normal', name: 'Normal', isModified: false })
    expect(Views.paneOf(f.rt).firstRun).toEqual({ autopilot: '70%', frontier: 'Extra High effort', guardrails: '6 kinds of action ask you first, 2 are denied' })
    expect(f.kept.store['onboarding.v1']).toMatchObject({ dismissedAt: null })
    expect(f.kept.traces).toContain('settings: a fresh install: the 1.7 defaults (Autopilot at 70%, Frontier Max at Extra High)')
    await f.advance(5000)
    expect(f.kept.toasts).toContain('Project Sentinel is on: Autopilot protects the context at 70%, Frontier Max at Extra High. /cr opens Control Room.')
    // The card follows the live settings.
    f.rt.update(s => {
      s.frontier.enabled = false
    })
    expect(Views.paneOf(f.rt).firstRun?.frontier).toBeNull()
    f.rt.dismissOnboarding()
    expect(Views.paneOf(f.rt).firstRun).toBeNull()
    expect((f.kept.store['onboarding.v1'] as { dismissedAt: unknown }).dismissedAt).toEqual(expect.any(Number))
    // The next session: no card again, and the saved settings are the person's (not re-defaulted, not relabelled).
    await f.advance(3000)
    f.rt.stopTimers()
    const again = new Runtime()
    again.bind(f.host)
    await again.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    expect(Views.paneOf(again).firstRun).toBeNull()
    expect(again.settings.frontier.enabled).toBe(false)
    expect(again.settings.profile).toBe('normal')
  })

  test('used before but never saved a setting (its runs are in the store): Classic is saved, behaviour unchanged, no card', async () => {
    const f = await loaded({ 'runs.counter.v1': 7, 'runs.index.v1': [] })
    expect(f.rt.settings).toEqual(classicSettings())
    expect(f.kept.store['settings.v1']).toEqual(classicSettings())
    expect(f.rt.settings.autopilot.enabled).toBe(false)
    expect(f.rt.settings.frontier.enabled).toBe(false)
    expect(isModified(f.rt.settings)).toBe(false)
    expect(profileLabel(f.rt.settings)).toBe('Classic')
    expect(Views.paneOf(f.rt).firstRun).toBeNull()
    expect(f.kept.store['onboarding.v1']).toBeUndefined()
    await f.advance(5000)
    expect(f.kept.toasts.some(t => t.startsWith('Project Sentinel is on'))).toBe(false)
    // The cache's memory or the Quest log say the same.
    for (const key of ['cache.v1', 'quest.v1']) {
      const g = await loaded({ [key]: { v: 1 } })
      expect(g.rt.settings.profile, key).toBe('classic')
    }
  })

  test('saved before 1.7 on Normal: relabelled Classic, every value untouched, never "edited" by the new Normal', async () => {
    const stored = before17(s => {
      s.autopilot.enabled = true
      s.autopilot.thresholdPercent = 80
    })
    const f = await loaded({ 'settings.v1': stored })
    expect(f.rt.settings.profile).toBe('classic')
    expect(f.rt.settings.defaults).toBe(2)
    expect(f.rt.settings.autopilot).toMatchObject({ enabled: true, thresholdPercent: 80 })
    expect(f.rt.settings.frontier.enabled).toBe(false)
    expect(systemsOf(f.rt.settings)).toEqual({ ...classicSystems(), autopilot: { ...classicSystems().autopilot, enabled: true, thresholdPercent: 80 } })
    // Edited against Classic, exactly as it was "edited" against the old Normal.
    expect(profileLabel(f.rt.settings)).toBe('Classic*')
    expect(f.kept.store['settings.v1']).toMatchObject({ profile: 'classic', defaults: 2 })
    expect(Views.paneOf(f.rt).firstRun).toBeNull()
    expect(f.kept.traces).toContain('settings: saved before 1.7: Normal is now called Classic (values unchanged)')
    // Untouched old Normal: Classic, not edited.
    const g = await loaded({ 'settings.v1': before17() })
    expect(profileLabel(g.rt.settings)).toBe('Classic')
  })

  test('saved before 1.7 on another built-in: it keeps its name and is not edited; saved under 1.7 on Normal: left alone', async () => {
    const frontierBefore = applyProfile(classicSettings(), findProfile(classicSettings(), 'frontier')!)
    const { defaults: _a, ...frontierStored } = frontierBefore
    void _a
    const f = await loaded({ 'settings.v1': frontierStored })
    expect(f.rt.settings.profile).toBe('frontier')
    expect(isModified(f.rt.settings)).toBe(false)
    const lowBefore = applyProfile(classicSettings(), findProfile(classicSettings(), 'low-resource')!)
    const { defaults: _b, ...lowStored } = lowBefore
    void _b
    const g = await loaded({ 'settings.v1': lowStored })
    expect(g.rt.settings.profile).toBe('low-resource')
    expect(isModified(g.rt.settings)).toBe(false)
    const h = await loaded({ 'settings.v1': defaultSettings() })
    expect(h.rt.settings).toEqual(defaultSettings())
  })

  test('Frontier Max no longer turns the lazy-exit guard on by itself', async () => {
    const f = await loaded({ 'settings.v1': classicSettings() })
    expect((await handleCommand(f.rt, 'frontier on')).text).toBe('Frontier Max on.')
    expect(f.rt.settings.frontier.enabled).toBe(true)
    expect(f.rt.settings.guard.enabled).toBe(false)
  })
})

describe('first-run clarity on the surfaces', () => {
  test('Overview shows the first-run card on terminal and Desktop: Autopilot at 70%, Frontier Max at Extra High, where Guardrails and Activity live, Work vs Context; Got it closes it', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 120_000 })
    await $.session.start(SESSION)
    await w.clock.advance(300)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'project-sentinel', surface, component: 'Pane', requestId: 'control-room', props: { title: 'Control Room', isFocused: true, bodyColumns: 66, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } })
      await w.clock.advance(300)
      const text = JSON.stringify(await ui.find({ key: 'card-first-run' }))
      for (const words of ['SENTINEL IS ON', 'Autopilot protects the context at 70%', 'Frontier Max at Extra High effort', 'never changes the model', 'Guardrails: what Claude may do', '6 kinds of action ask you first, 2 are denied', 'Activity has views', 'Summary · Operations · Agents · Tool calls', 'Work carries on; Context starts over']) {
        expect(text, `${surface}: ${words}`).toContain(words)
      }
      // The header's profile reads plain Normal, never "edited", on a fresh install.
      expect(JSON.stringify(await ui.find({ type: 'Button', key: 'header-profile' }))).toContain('"label":"Normal"')
      await ui.unmount()
    }
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: { title: 'Control Room', isFocused: true, bodyColumns: 66, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } })
    await w.clock.advance(300)
    await ui.press({ key: 'first-dismiss' })
    await w.clock.advance(300)
    await ui.redraw()
    expect(await ui.find({ key: 'card-first-run' })).toBeUndefined()
  })

  test('Guardrails says each value and whether it is the default; a changed one says what the default is, in amber', { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, { tokens: 120_000 })
    await $.session.start(SESSION)
    await w.clock.advance(300)
    await $.command.run({ command: 'cr', args: 'profile release-qa', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    await w.clock.advance(300)
    const ui = await $.ui.mount({ plugin: 'project-sentinel', surface: 'terminal', component: 'Pane', requestId: 'control-room', props: { title: 'Control Room', isFocused: true, bodyColumns: 66, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } })
    await ui.press({ key: 'tab-guardrails' })
    await w.clock.advance(300)
    const row = async (c: string) => JSON.stringify(await ui.find({ key: `row-perm-${c}` }))
    expect(await row('dangerous')).toContain('Never runs · default')
    expect(await row('push')).toContain('Asks you first · default')
    expect(await row('edit')).toContain('Claude Code decides · default')
    // Release/QA asks before commits: a change from the default, said with what the default is.
    expect(await row('commit')).toContain('Asks you first · changed (default: claude code decides)')
    expect(await row('commit')).toContain('"color":"warning"')
  })
})
