import { describe, expect, test } from 'claude-code/testing'

import { CARRIED_MARK, carriedWrites, configDirFromEnv, configDirOf, formerStorePaths, isFormerHud, newestFirst, sourceOf, storeFileName } from '../hooks/app/formerStore'
import { Runtime } from '../hooks/app/runtime'
import { classicSettings, defaultSettings } from '../hooks/core/settings'
import type { Settings } from '../hooks/core/settings'
import { fakeHost } from './fixtures/fake-host'

describe('the store kept under the former name', () => {
  test('store files are named as Claude Code names them (checked against real stores)', async () => {
    expect(await storeFileName('control-room', 'inline')).toBe('control-room_inline-7b750613ef16.json')
    expect(await storeFileName('control-room', 'control-room')).toBe('control-room_control-room-8bbff897507c.json')
    expect(await storeFileName('cr-test', 'inline')).toBe('cr-test_inline-f63a99e15d2a.json')
  })

  test('the configuration folder comes from the transcript path; anything else is not trusted', () => {
    expect(configDirOf('C:\\Users\\a\\.claude\\projects\\C--work\\2a.jsonl')).toBe('C:\\Users\\a\\.claude')
    expect(configDirOf('/home/a/.claude/projects/-work/2a.jsonl')).toBe('/home/a/.claude')
    expect(configDirOf('/tmp/cfg/projects/-work/2a.jsonl')).toBe('/tmp/cfg')
    expect(configDirOf('/home/a/elsewhere/2a.jsonl')).toBeNull()
    expect(configDirOf('')).toBeNull()
    expect(configDirOf(undefined)).toBeNull()
  })

  test('the configuration folder from the environment, as Claude Code finds it', () => {
    expect(configDirFromEnv({ claudeConfigDir: '/cfg', userProfile: 'C:\\Users\\a', home: '/home/a' })).toBe('/cfg')
    expect(configDirFromEnv({ claudeConfigDir: ' ', userProfile: 'C:\\Users\\a', home: undefined })).toBe('C:\\Users\\a\\.claude')
    expect(configDirFromEnv({ claudeConfigDir: undefined, userProfile: 'C:\\Users\\a\\', home: '/c/Users/a' })).toBe('C:\\Users\\a\\.claude')
    expect(configDirFromEnv({ claudeConfigDir: undefined, userProfile: undefined, home: '/home/a/' })).toBe('/home/a/.claude')
    expect(configDirFromEnv({ claudeConfigDir: undefined, userProfile: '', home: undefined })).toBeNull()
  })

  test('an installed copy keeps its store under the marketplace, a plugin loaded in place under inline', () => {
    expect(sourceOf('C:\\Users\\a\\.claude\\plugins\\cache\\control-room\\project-sentinel\\1.4.0')).toBe('control-room')
    expect(sourceOf('/home/a/.claude/plugins/cache/mine/project-sentinel/1.4.0')).toBe('mine')
    expect(sourceOf('C:\\Web UI\\Control Room Mod\\plugins\\project-sentinel')).toBe('inline')
  })

  test('the same source is looked for first, then the others', async () => {
    const paths = await formerStorePaths('/home/a/.claude', 'control-room')
    expect(paths).toEqual([
      '/home/a/.claude/plugins/store/control-room_control-room-8bbff897507c.json',
      '/home/a/.claude/plugins/store/control-room_inline-7b750613ef16.json',
    ])
    expect((await formerStorePaths('C:\\Users\\a\\.claude', 'inline'))[0]).toBe('C:\\Users\\a\\.claude\\plugins\\store\\control-room_inline-7b750613ef16.json')
  })

  test('of the stores kept under the former name, the one written last comes first; equal times keep their order', () => {
    expect(newestFirst([{ path: 'a', mtimeMs: 5 }, { path: 'b', mtimeMs: 9 }, { path: 'c', mtimeMs: 5 }])).toEqual(['b', 'a', 'c'])
    expect(newestFirst([])).toEqual([])
  })

  test('Control Room is known by its status bar, not by the name alone', () => {
    expect(isFormerHud({ isVisible: true, profile: { id: 'normal' }, autopilot: { isOn: true }, ctx: { tokens: 1 } })).toBe(true)
    expect(isFormerHud({ isVisible: true, profile: 'normal' })).toBe(false)
    expect(isFormerHud(undefined)).toBe(false)
    expect(isFormerHud('hud')).toBe(false)
  })

  test('what comes along: never over what the new store holds; runs merged, the counter never going back', () => {
    const former = {
      'settings.v1': { version: 1, autopilot: { thresholdPercent: 80 } },
      'quest.v1': { xp: 120 },
      'cache.v1': { v: 1, ttl: '1h' },
      'runs.counter.v1': 32,
      'runs.index.v1': ['r32', 'r31', 'gone'],
      'run.v1.r32': { v: 1, id: 'r32', number: 32, sessions: [] },
      'run.v1.r31': { v: 1, id: 'r31', number: 31, sessions: [] },
      'something.else': true,
    }
    const fresh = carriedWrites(former, { settings: false, quest: false, cache: false, counter: 1, index: ['n1'] })
    expect(Object.keys(fresh).sort()).toEqual(['cache.v1', 'quest.v1', 'run.v1.r31', 'run.v1.r32', 'runs.counter.v1', 'runs.index.v1', 'settings.v1'])
    expect(fresh['runs.index.v1']).toEqual(['n1', 'r32', 'r31'])
    expect(fresh['runs.counter.v1']).toBe(32)
    const kept = carriedWrites(former, { settings: true, quest: true, cache: true, counter: 40, index: ['r32'] })
    expect(Object.keys(kept).sort()).toEqual(['run.v1.r31', 'runs.index.v1'])
    expect(carriedWrites('not a store', { settings: false, quest: false, cache: false, counter: 0, index: [] })).toEqual({})
  })

  test('a whole carry-over: settings, runs, the Quest log and the cache memory come along once, and the new run is numbered after them', async () => {
    // Control Room kept settings before 1.7.0: Normal meant what is now Classic, and no defaults marker.
    const { defaults: _marker, ...old } = { ...classicSettings(), profile: 'normal' }
    void _marker
    old.autopilot.enabled = true
    old.autopilot.thresholdPercent = 80
    old.permissions.network = 'deny'
    const store = {
      'settings.v1': old,
      'runs.counter.v1': 32,
      'runs.index.v1': ['r32'],
      'run.v1.r32': { v: 1, id: 'r32', number: 32, startedAt: 1, updatedAt: 2, root: '/work', profile: 'normal', status: 'ended', sessions: [{ id: 's-old', index: 1, startedAt: 1, endedAt: 2, start: 'startup', end: 'exit', peakTokens: 0, lastTokens: 0, window: null, costUsd: 3, turns: 4, transitions: [] }] },
      'quest.v1': { xp: 120, achievements: [], recent: [] },
      'cache.v1': { v: 1, ttl: '1h', ttlSource: 'observed', verified: 'unknown', verifiedAt: null, effortRebuilds: [] },
    }
    const file = '/home/a/.claude/plugins/store/control-room_inline-7b750613ef16.json'
    const f = fakeHost({ files: { [file]: JSON.stringify(store) }, pluginRoot: '/home/a/src/plugins/project-sentinel' })
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await f.advance(200)
    // The first load found an empty store: a fresh install, as far as it could tell (the 1.7 defaults, the first-run card).
    expect(rt.settings).toMatchObject({ profile: 'normal', autopilot: { enabled: true, thresholdPercent: 70 }, frontier: { enabled: true } })
    expect(rt.onboarding).not.toBeNull()
    await rt.onClassicSessionStart({ source: 'startup', sessionId: 'session-1', transcriptPath: '/home/a/.claude/projects/-work/session-1.jsonl' })
    await f.advance(2000)
    // The carry still wins over those defaults (they were not the person's), and the settings read as Classic, values untouched.
    expect(rt.settings.autopilot.enabled).toBe(true)
    expect(rt.settings.autopilot.thresholdPercent).toBe(80)
    expect(rt.settings.permissions.network).toBe('deny')
    expect(rt.settings.frontier.enabled).toBe(false)
    expect(rt.settings.profile).toBe('classic')
    // Not a fresh install after all: no first-run card.
    expect(rt.onboarding).toBeNull()
    expect(f.kept.store['onboarding.v1']).toBeUndefined()
    expect(rt.cache.memory.ttl).toBe('1h')
    expect(rt.quest.xp).toBe(120)
    expect(rt.run?.number).toBe(33)
    expect(f.kept.store['runs.index.v1']).toContain('r32')
    expect(f.kept.store['run.v1.r32']).toBeDefined()
    expect(f.kept.store[CARRIED_MARK]).toMatchObject({ from: 'control-room_inline-7b750613ef16.json', keys: 6 })
    // Said once, as a toast: not a warning pinned at the top of the panel.
    expect(f.kept.toasts.join(' ')).toContain('Project Sentinel is Control Room renamed')
    expect(rt.notes.join(' ')).not.toContain('renamed')
    // Once: a later session leaves the store as it is, even if it changed since.
    ;(f.kept.store['settings.v1'] as Settings).autopilot.thresholdPercent = 60
    const next = new Runtime()
    next.bind(f.host)
    await next.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await next.onClassicSessionStart({ source: 'startup', sessionId: 'session-2', transcriptPath: '/home/a/.claude/projects/-work/session-2.jsonl' })
    expect(next.settings.autopilot.thresholdPercent).toBe(60)
    await f.advance(2000)
    expect(f.kept.toasts.filter(t => t.includes('Control Room renamed')).length).toBe(1)
  })

  test('loaded into a running session (an update), it carries over at the load, from the store written last, before a setting is read', async () => {
    const stale = defaultSettings()
    stale.autopilot.enabled = false
    const live = defaultSettings()
    live.autopilot.enabled = true
    live.autopilot.thresholdPercent = 80
    live.permissions.delete = 'default'
    live.permissions.push = 'default'
    live.permissions.gitDestructive = 'default'
    const dir = 'C:\\Users\\a\\.claude\\plugins\\store'
    const installed = `${dir}\\control-room_control-room-8bbff897507c.json`
    const inline = `${dir}\\control-room_inline-7b750613ef16.json`
    const f = fakeHost({
      files: {
        [installed]: JSON.stringify({ 'settings.v1': stale, 'runs.counter.v1': 5 }),
        [inline]: JSON.stringify({ 'settings.v1': live, 'runs.counter.v1': 32 }),
      },
      // The installed copy's store is looked for first (the same source), but the in-place one was written last.
      fileTimes: { [installed]: 1_000, [inline]: 9_000 },
      pluginRoot: 'C:\\Users\\a\\.claude\\plugins\\cache\\control-room\\project-sentinel\\1.4.0',
      configEnv: { claudeConfigDir: undefined, userProfile: 'C:\\Users\\a', home: undefined },
      dirs: [dir],
    })
    const rt = new Runtime()
    rt.bind(f.host)
    // A reload starts the plugin with no session start after it.
    await rt.onSessionStart({ cwd: '/work', surface: 'desktop', isInteractive: false })
    expect(rt.settings.autopilot.enabled).toBe(true)
    expect(rt.settings.autopilot.thresholdPercent).toBe(80)
    expect(rt.settings.permissions.delete).toBe('default')
    expect(rt.settings.permissions.gitDestructive).toBe('default')
    expect(rt.run?.number).toBe(33)
    expect(f.kept.store[CARRIED_MARK]).toMatchObject({ from: 'control-room_inline-7b750613ef16.json' })
    await f.advance(2000)
    expect(f.kept.toasts.join(' ')).toContain('Project Sentinel is Control Room renamed')
  })

  test('an environment that names a folder without plugin stores is not trusted at the load: the session start looks by its transcript', async () => {
    const { defaults: _marker, ...old } = { ...classicSettings(), profile: 'normal' }
    void _marker
    old.autopilot.enabled = true
    old.autopilot.thresholdPercent = 85
    const file = '/home/a/.claude/plugins/store/control-room_inline-7b750613ef16.json'
    const f = fakeHost({ files: { [file]: JSON.stringify({ 'settings.v1': old }) }, configEnv: { claudeConfigDir: undefined, userProfile: undefined, home: '/elsewhere' }, dirs: [] })
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(f.kept.store[CARRIED_MARK]).toBeUndefined()
    expect(rt.settings.autopilot.thresholdPercent).toBe(70)
    await rt.onClassicSessionStart({ source: 'startup', sessionId: 'session-1', transcriptPath: '/home/a/.claude/projects/-work/session-1.jsonl' })
    expect(rt.settings.autopilot.thresholdPercent).toBe(85)
    expect(rt.settings.profile).toBe('classic')
    expect(f.kept.store[CARRIED_MARK]).toMatchObject({ from: 'control-room_inline-7b750613ef16.json' })
  })

  test('beside a Control Room that still runs in the session, it stands by and says so once', async () => {
    const f = fakeHost({ formerHud: { isVisible: true, profile: { id: 'normal' }, autopilot: { isOn: true }, ctx: {} } })
    const rt = new Runtime()
    rt.bind(f.host)
    expect(await rt.checkStandby()).toBe(true)
    expect(await rt.checkStandby()).toBe(true)
    expect(rt.isStandby).toBe(true)
    await f.advance(2000)
    expect(f.kept.toasts).toEqual(['Project Sentinel is installed. Control Room keeps this session until it restarts.'])
    // A reload (an install, an update) builds a new runtime: it stands by again without a second note.
    const reloaded = new Runtime()
    reloaded.bind(f.host)
    expect(await reloaded.checkStandby()).toBe(true)
    await f.advance(2000)
    expect(f.kept.toasts.length).toBe(1)
    const alone = fakeHost()
    const own = new Runtime()
    own.bind(alone.host)
    expect(await own.checkStandby()).toBe(false)
    await alone.advance(2000)
    expect(alone.kept.toasts).toEqual([])
  })

  test('with no former store, nothing changes and it is not looked for again', async () => {
    const f = fakeHost()
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await rt.onClassicSessionStart({ source: 'startup', sessionId: 'session-1', transcriptPath: '/home/a/.claude/projects/-work/session-1.jsonl' })
    expect(f.kept.store[CARRIED_MARK]).toMatchObject({ from: null, keys: 0 })
    await f.advance(2000)
    expect(f.kept.toasts.join(' ')).not.toContain('renamed')
  })

  test('without a transcript path nothing is looked for, so a later session can still carry it over', async () => {
    const f = fakeHost()
    const rt = new Runtime()
    rt.bind(f.host)
    await rt.onSessionStart({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await rt.onClassicSessionStart({ source: 'startup', sessionId: 'session-1' })
    expect(f.kept.store[CARRIED_MARK]).toBeUndefined()
  })
})
