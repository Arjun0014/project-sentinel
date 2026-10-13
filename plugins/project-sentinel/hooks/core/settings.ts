/**
 * Control Room's settings: the schema, safe defaults, and a normaliser that
 * turns anything read from `$.store` (an older version, a hand edit, garbage)
 * into a complete, valid Settings object. Pure: no engine access.
 */

import { DEFAULT_HANDOFF_FILE } from '../constants'

import type {
  AnswerStyle,
  ContinuationMethod,
  ControlRoomCustomProfile,
  ControlRoomSettings,
  ControlRoomSystems,
  FrontierEffort,
  GuardStrictness,
  ModelAlias,
  PermissionCategory,
  PermissionState,
  ResourceEnforcement,
  ResourceLevel,
  RouterStrategy,
  SubagentMode,
  WatcherScout,
} from '../../types'

export type {
  AnswerStyle,
  ContinuationMethod,
  FrontierEffort,
  GuardStrictness,
  ModelAlias,
  PermissionCategory,
  PermissionState,
  ResourceEnforcement,
  ResourceLevel,
  RouterStrategy,
  SubagentMode,
  WatcherScout,
}

export type Settings = ControlRoomSettings
export type SystemSettings = ControlRoomSystems
export type CustomProfile = ControlRoomCustomProfile

export const PERMISSION_CATEGORIES = [
  'install',
  'network',
  'download',
  'edit',
  'editOutside',
  'delete',
  'commit',
  'push',
  'gitDestructive',
  'deploy',
  'dangerous',
] as const satisfies readonly PermissionCategory[]

// Compile-time proof that the list covers every category in the contract.
type MissingCategory = Exclude<PermissionCategory, (typeof PERMISSION_CATEGORIES)[number]>
const _everyCategory: MissingCategory extends never ? true : never = true
void _everyCategory

export const MODEL_ALIASES: readonly ModelAlias[] = ['session', 'haiku', 'sonnet', 'opus', 'fable']

export const ANSWER_STYLES: readonly AnswerStyle[] = ['standard', 'brief', 'ste', 'mission', 'quest']

export const WATCHER_SCOUTS: readonly WatcherScout[] = ['off', 'suggest', 'auto']

export const SYSTEM_KEYS = [
  'autopilot',
  'frontier',
  'qa',
  'guard',
  'router',
  'subagents',
  'focus',
  'resources',
  'permissions',
  'progress',
  'answers',
  'cache',
  'ops',
] as const satisfies readonly (keyof SystemSettings)[]

export const PERMISSION_STATES: readonly PermissionState[] = ['default', 'ask', 'deny']

/**
 * A saved permission state as it reads now. Allow ("answers prompts for you") was removed in 1.4.0:
 * a saved Allow becomes Default, so Claude Code's own rules decide again, never Ask, which would
 * start asking about what the person had chosen to let through. Anything else unknown falls back.
 */
export function permissionStateOf(raw: unknown, fallback: PermissionState): PermissionState {
  if (raw === 'allow') return 'default'
  return pick(raw, PERMISSION_STATES, fallback)
}

/** Each category's name as the person reads it. */
export const PERMISSION_LABEL: Record<PermissionCategory, string> = {
  install: 'Package installs',
  network: 'Network access',
  download: 'Downloads',
  edit: 'Project edits',
  editOutside: 'Edits outside project',
  delete: 'Deleting files',
  commit: 'Git commits',
  push: 'Git push',
  gitDestructive: 'Force push & resets',
  deploy: 'Deploy & publish',
  dangerous: 'Dangerous commands',
}

export const DEFAULT_PERMISSIONS: Record<PermissionCategory, PermissionState> = {
  install: 'ask',
  network: 'default',
  download: 'ask',
  edit: 'default',
  editOutside: 'ask',
  delete: 'ask',
  commit: 'default',
  push: 'ask',
  gitDestructive: 'deny',
  deploy: 'ask',
  dangerous: 'deny',
}

/**
 * Classic: every system as Project Sentinel set it before 1.7.0 (Autopilot and Frontier Max off). The
 * built-in Classic profile, what an existing install keeps, and the base stored settings are read
 * against, so a group missing from an old store never turns something on by itself.
 */
export function classicSystems(): SystemSettings {
  return {
    autopilot: {
      enabled: false,
      thresholdMode: 'percent',
      thresholdTokens: 700_000,
      thresholdPercent: 70,
      continuation: 'clear',
      fallbackToCompact: true,
      handoffFile: DEFAULT_HANDOFF_FILE,
      autoContinue: true,
      waitMinutes: 20,
    },
    frontier: { enabled: false, effort: 'max', subagentEffort: false },
    qa: { enabled: false },
    guard: { enabled: false, strictness: 'standard', maxPerTurn: 2, maxPerSession: 12, modelCheck: true },
    router: {
      strategy: 'off',
      mainLoop: true,
      subagents: true,
      custom: {
        trivial: 'haiku',
        simple: 'sonnet',
        standard: 'session',
        hard: 'session',
        explore: 'haiku',
        plan: 'session',
        general: 'sonnet',
      },
    },
    subagents: { mode: 'unrestricted', limit: 2, countTeammates: true },
    focus: { enabled: true, tools: 'compact', results: false, diffs: false, spinner: true },
    resources: { level: 'off', cpu: 70, ram: 85, intervalSec: 3, enforcement: 'limit' },
    permissions: { ...DEFAULT_PERMISSIONS },
    progress: { milestones: true },
    answers: { style: 'standard' },
    cache: { keepWarm: false, maxIdleMinutes: 120, minTokens: 20_000, guardModelSwitch: true, stablePolicies: true, coldResume: true, coldResumeTokens: 100_000 },
    ops: { decisions: true, watchers: true, scout: 'suggest' },
  }
}

/**
 * The fresh-install defaults (1.7.0), Normal: opinionated out of the box. Context Autopilot on, handing off
 * at 70% to a fresh context (falling back to compacting) that carries on by itself; Frontier Max on at
 * Extra High effort; the Decision Inbox, Watchers and run milestones on. The lazy-exit guard and the
 * permissions are as Classic has them (see DEFAULT_PERMISSIONS: nothing is loosened).
 */
export function defaultSystems(): SystemSettings {
  const s = classicSystems()
  s.autopilot = { ...s.autopilot, enabled: true, thresholdMode: 'percent', thresholdPercent: 70, continuation: 'clear', fallbackToCompact: true, autoContinue: true }
  s.frontier = { enabled: true, effort: 'xhigh', subagentEffort: false }
  s.ops = { ...s.ops, decisions: true, watchers: true }
  s.progress = { milestones: true }
  return s
}

/** The marker of settings written under 1.7.0's defaults (see ControlRoomSettings.defaults). */
export const DEFAULTS_GENERATION = 2

/** A fresh install's settings: Normal, the 1.7.0 defaults. */
export function defaultSettings(): Settings {
  return {
    version: 1,
    defaults: DEFAULTS_GENERATION,
    profile: 'normal',
    ...defaultSystems(),
    ui: { hud: 'band', toasts: true, openOnStart: false, liveLoad: true, companion: false, reducedMotion: false },
    customProfiles: [],
  }
}

/** An install that used Project Sentinel before 1.7.0 without saving a setting: Classic, so nothing changes for it. */
export function classicSettings(): Settings {
  return { ...defaultSettings(), ...classicSystems(), profile: 'classic' }
}

// ---------------------------------------------------------------------------
// Normalisation: never trust what the store hands back.

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)

const num = (v: unknown, d: number, min: number, max: number, isInteger = true): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return d
  const n = isInteger ? Math.round(v) : v
  return Math.min(max, Math.max(min, n))
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d

const str = (v: unknown, d: string, maxLength = 200): string =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, maxLength) : d

/** A relative path inside the project: no drive, no root, no `..` segments. */
export function safeRelativePath(v: unknown, d: string): string {
  const s = str(v, d, 200).replace(/\\/g, '/')
  const isUnsafe =
    s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').some(part => part === '..') || /[\0<>|"?*]/.test(s)
  return isUnsafe ? d : s
}

function normalizeSystems(raw: unknown, base: SystemSettings): SystemSettings {
  const r = isRecord(raw) ? raw : {}
  const ap = isRecord(r.autopilot) ? r.autopilot : {}
  const fr = isRecord(r.frontier) ? r.frontier : {}
  const qa = isRecord(r.qa) ? r.qa : {}
  const gu = isRecord(r.guard) ? r.guard : {}
  const ro = isRecord(r.router) ? r.router : {}
  const roc = isRecord(ro.custom) ? ro.custom : {}
  const sa = isRecord(r.subagents) ? r.subagents : {}
  const fo = isRecord(r.focus) ? r.focus : {}
  const re = isRecord(r.resources) ? r.resources : {}
  const pe = isRecord(r.permissions) ? r.permissions : {}
  const pr = isRecord(r.progress) ? r.progress : {}
  const an = isRecord(r.answers) ? r.answers : {}
  const ca = isRecord(r.cache) ? r.cache : {}
  const op = isRecord(r.ops) ? r.ops : {}

  const permissions = {} as Record<PermissionCategory, PermissionState>
  for (const category of PERMISSION_CATEGORIES) permissions[category] = permissionStateOf(pe[category], base.permissions[category])

  return {
    autopilot: {
      enabled: bool(ap.enabled, base.autopilot.enabled),
      thresholdMode: pick(ap.thresholdMode, ['tokens', 'percent'] as const, base.autopilot.thresholdMode),
      thresholdTokens: num(ap.thresholdTokens, base.autopilot.thresholdTokens, 10_000, 10_000_000),
      thresholdPercent: num(ap.thresholdPercent, base.autopilot.thresholdPercent, 10, 95),
      continuation: pick(ap.continuation, ['clear', 'compact', 'manual'] as const, base.autopilot.continuation),
      fallbackToCompact: bool(ap.fallbackToCompact, base.autopilot.fallbackToCompact),
      handoffFile: safeRelativePath(ap.handoffFile, base.autopilot.handoffFile),
      autoContinue: bool(ap.autoContinue, base.autopilot.autoContinue),
      waitMinutes: num(ap.waitMinutes, base.autopilot.waitMinutes, 0, 240),
    },
    frontier: {
      enabled: bool(fr.enabled, base.frontier.enabled),
      effort: pick(fr.effort, ['max', 'xhigh', 'high', 'keep'] as const, base.frontier.effort),
      subagentEffort: bool(fr.subagentEffort, base.frontier.subagentEffort),
    },
    qa: { enabled: bool(qa.enabled, base.qa.enabled) },
    guard: {
      enabled: bool(gu.enabled, base.guard.enabled),
      strictness: pick(gu.strictness, ['lenient', 'standard', 'strict'] as const, base.guard.strictness),
      maxPerTurn: num(gu.maxPerTurn, base.guard.maxPerTurn, 1, 5),
      maxPerSession: num(gu.maxPerSession, base.guard.maxPerSession, 1, 50),
      modelCheck: bool(gu.modelCheck, base.guard.modelCheck),
    },
    router: {
      strategy: pick(ro.strategy, ['off', 'balanced', 'performance', 'economy', 'custom'] as const, base.router.strategy),
      mainLoop: bool(ro.mainLoop, base.router.mainLoop),
      subagents: bool(ro.subagents, base.router.subagents),
      custom: {
        trivial: pick(roc.trivial, MODEL_ALIASES, base.router.custom.trivial),
        simple: pick(roc.simple, MODEL_ALIASES, base.router.custom.simple),
        standard: pick(roc.standard, MODEL_ALIASES, base.router.custom.standard),
        hard: pick(roc.hard, MODEL_ALIASES, base.router.custom.hard),
        explore: pick(roc.explore, MODEL_ALIASES, base.router.custom.explore),
        plan: pick(roc.plan, MODEL_ALIASES, base.router.custom.plan),
        general: pick(roc.general, MODEL_ALIASES, base.router.custom.general),
      },
    },
    subagents: {
      mode: pick(sa.mode, ['unrestricted', 'block', 'ask', 'limit'] as const, base.subagents.mode),
      limit: num(sa.limit, base.subagents.limit, 1, 16),
      countTeammates: bool(sa.countTeammates, base.subagents.countTeammates),
    },
    focus: {
      enabled: bool(fo.enabled, base.focus.enabled),
      tools: pick(fo.tools, ['compact', 'hidden'] as const, base.focus.tools),
      results: bool(fo.results, base.focus.results),
      diffs: bool(fo.diffs, base.focus.diffs),
      spinner: bool(fo.spinner, base.focus.spinner),
    },
    resources: {
      level: pick(re.level, ['off', 'low', 'medium', 'high', 'custom'] as const, base.resources.level),
      cpu: num(re.cpu, base.resources.cpu, 10, 100),
      ram: num(re.ram, base.resources.ram, 10, 100),
      intervalSec: num(re.intervalSec, base.resources.intervalSec, 2, 60),
      enforcement: pick(re.enforcement, ['inform', 'limit', 'strict'] as const, base.resources.enforcement),
    },
    permissions,
    progress: { milestones: bool(pr.milestones, base.progress.milestones) },
    answers: { style: pick(an.style, ANSWER_STYLES, base.answers.style) },
    cache: {
      keepWarm: bool(ca.keepWarm, base.cache.keepWarm),
      maxIdleMinutes: num(ca.maxIdleMinutes, base.cache.maxIdleMinutes, 15, 480),
      minTokens: num(ca.minTokens, base.cache.minTokens, 5_000, 1_000_000),
      guardModelSwitch: bool(ca.guardModelSwitch, base.cache.guardModelSwitch),
      stablePolicies: bool(ca.stablePolicies, base.cache.stablePolicies),
      coldResume: bool(ca.coldResume, base.cache.coldResume),
      coldResumeTokens: num(ca.coldResumeTokens, base.cache.coldResumeTokens, 20_000, 2_000_000),
    },
    ops: {
      decisions: bool(op.decisions, base.ops.decisions),
      watchers: bool(op.watchers, base.ops.watchers),
      scout: pick(op.scout, WATCHER_SCOUTS, base.ops.scout),
    },
  }
}

function normalizeCustomProfiles(raw: unknown): CustomProfile[] {
  if (!Array.isArray(raw)) return []
  const out: CustomProfile[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!isRecord(item)) continue
    const name = str(item.name, '', 40)
    if (name === '') continue
    const id = slugOf(name)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name,
      createdAt: num(item.createdAt, 0, 0, Number.MAX_SAFE_INTEGER),
      systems: normalizeSystems(item.systems, classicSystems()),
    })
    if (out.length >= 12) break
  }
  return out
}

/** A profile id from a name: lowercase letters, digits and dashes. */
export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug === '' ? 'profile' : slug
}

/** Any value to complete, valid Settings; unknown keys are dropped. */
export function normalizeSettings(raw: unknown): Settings {
  const d = defaultSettings()
  if (!isRecord(raw)) return d
  const ui = isRecord(raw.ui) ? raw.ui : {}
  return {
    version: 1,
    // Stored settings without the marker were written before 1.7.0 (ensureLoaded relabels their Normal as Classic).
    defaults: num(raw.defaults, 1, 1, DEFAULTS_GENERATION),
    profile: str(raw.profile, d.profile, 60),
    // Stored settings are read against Classic: a group an older version did not save is never turned on by the new defaults.
    ...normalizeSystems(raw, classicSystems()),
    ui: {
      hud: pick(ui.hud, ['band', 'status', 'both', 'off'] as const, d.ui.hud),
      toasts: bool(ui.toasts, d.ui.toasts),
      openOnStart: bool(ui.openOnStart, d.ui.openOnStart),
      liveLoad: bool(ui.liveLoad, d.ui.liveLoad),
      companion: bool(ui.companion, d.ui.companion),
      reducedMotion: bool(ui.reducedMotion, d.ui.reducedMotion),
    },
    customProfiles: normalizeCustomProfiles(raw.customProfiles),
  }
}

export function systemsOf(settings: Settings): SystemSettings {
  return {
    autopilot: settings.autopilot,
    frontier: settings.frontier,
    qa: settings.qa,
    guard: settings.guard,
    router: settings.router,
    subagents: settings.subagents,
    focus: settings.focus,
    resources: settings.resources,
    permissions: settings.permissions,
    progress: settings.progress,
    answers: settings.answers,
    cache: settings.cache,
    ops: settings.ops,
  }
}

/** Structural equality for plain JSON data. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** A deep copy of plain JSON data. */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
