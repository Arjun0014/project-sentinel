/**
 * Profiles: named configurations of every Control Room system at once.
 *
 * A profile is a complete SystemSettings value, so applying one is
 * deterministic (no leftovers from the previous profile). The person can
 * still override any individual setting afterwards; the profile then reads
 * as modified. Pure: no engine access.
 */

import { tokens as fmtTokens } from './format'
import {
  type CustomProfile,
  DEFAULT_PERMISSIONS,
  PERMISSION_CATEGORIES,
  PERMISSION_LABEL,
  type Settings,
  type SystemSettings,
  classicSystems,
  clone,
  deepEqual,
  defaultSystems,
  slugOf,
  systemsOf,
} from './settings'

export type ProfileInfo = {
  id: string
  name: string
  tagline: string
  isBuiltin: boolean
  systems: SystemSettings
}

/** Normal: the fresh-install defaults (1.7.0). */
const normal = (): SystemSettings => defaultSystems()

/** Classic: Normal as it was before 1.7.0, Autopilot and Frontier Max off. */
const classic = (): SystemSettings => classicSystems()

// The other built-ins are what they always were (built on Classic), so a person who applied one before 1.7.0
// does not find it "edited" after the update.
const frontier = (): SystemSettings => {
  const s = classicSystems()
  s.frontier = { enabled: true, effort: 'max', subagentEffort: false }
  s.guard = { ...s.guard, enabled: true, strictness: 'standard' }
  s.autopilot = { ...s.autopilot, enabled: true, thresholdMode: 'percent', thresholdPercent: 70 }
  s.resources = { ...s.resources, level: 'medium', cpu: 70, ram: 85, enforcement: 'limit' }
  return s
}

const lowResource = (): SystemSettings => {
  const s = classicSystems()
  s.resources = { ...s.resources, level: 'low', cpu: 50, ram: 75, enforcement: 'strict' }
  s.subagents = { ...s.subagents, mode: 'limit', limit: 1 }
  return s
}

const releaseQa = (): SystemSettings => {
  const s = classicSystems()
  s.qa = { enabled: true }
  s.guard = { ...s.guard, enabled: true, strictness: 'strict', maxPerTurn: 3 }
  s.autopilot = { ...s.autopilot, enabled: true, thresholdMode: 'percent', thresholdPercent: 70 }
  s.subagents = { ...s.subagents, mode: 'limit', limit: 2 }
  s.focus = { ...s.focus, diffs: true }
  s.resources = { ...s.resources, level: 'medium', cpu: 70, ram: 85, enforcement: 'limit' }
  s.permissions = {
    ...DEFAULT_PERMISSIONS,
    install: 'ask',
    download: 'ask',
    delete: 'ask',
    commit: 'ask',
    push: 'ask',
    gitDestructive: 'deny',
    deploy: 'ask',
    dangerous: 'deny',
  }
  return s
}

export const BUILTIN_PROFILES: readonly Omit<ProfileInfo, 'systems'>[] = [
  { id: 'normal', name: 'Normal', tagline: 'Autopilot at 70%, Frontier Max at Extra High', isBuiltin: true },
  {
    id: 'frontier',
    name: 'Frontier Max',
    tagline: 'Maximum effort, finishes the job',
    isBuiltin: true,
  },
  {
    id: 'low-resource',
    name: 'Low Resource',
    tagline: 'Gentle on your machine',
    isBuiltin: true,
  },
  {
    id: 'release-qa',
    name: 'Release / QA',
    tagline: 'Verifies before calling it done',
    isBuiltin: true,
  },
  { id: 'classic', name: 'Classic', tagline: 'As before 1.7: Autopilot and Frontier Max off', isBuiltin: true },
]

const BUILDERS: Record<string, () => SystemSettings> = {
  normal,
  frontier,
  'low-resource': lowResource,
  'release-qa': releaseQa,
  classic,
}

/** Every profile the person can pick: the built-ins, then their own. */
export function listProfiles(settings: Settings): ProfileInfo[] {
  const builtins = BUILTIN_PROFILES.map(p => ({ ...p, systems: BUILDERS[p.id]!() }))
  const custom = settings.customProfiles.map(c => ({
    id: `custom:${c.id}`,
    name: c.name,
    tagline: 'Saved by you',
    isBuiltin: false,
    systems: clone(c.systems),
  }))
  return [...builtins, ...custom]
}

export function findProfile(settings: Settings, id: string): ProfileInfo | undefined {
  const wanted = id.trim().toLowerCase()
  return listProfiles(settings).find(
    p => p.id === wanted || p.name.toLowerCase() === wanted || slugOf(p.name) === wanted || p.id === `custom:${wanted}`,
  )
}

/** Settings with the profile's systems applied (bookkeeping and UI kept). */
export function applyProfile(settings: Settings, profile: ProfileInfo): Settings {
  return { ...settings, ...clone(profile.systems), profile: profile.id }
}

/** Whether the current systems differ from the profile they say they came from. */
export function isModified(settings: Settings): boolean {
  const profile = findProfile(settings, settings.profile)
  return profile === undefined ? false : !deepEqual(systemsOf(settings), profile.systems)
}

export function profileLabel(settings: Settings): string {
  const profile = findProfile(settings, settings.profile)
  const name = profile?.name ?? 'Custom'
  return isModified(settings) ? `${name}*` : name
}

export type SettingChange = { path: string; label: string; from: string; to: string }

/** Each setting's name, in the panel's own words. */
const LABELS: Record<string, string> = {
  'autopilot.enabled': 'Autopilot',
  'autopilot.thresholdMode': 'Measure in',
  'autopilot.thresholdTokens': 'Hand off at',
  'autopilot.thresholdPercent': 'Hand off at',
  'autopilot.continuation': 'After the notes',
  'autopilot.fallbackToCompact': 'If clearing fails, compact',
  'autopilot.handoffFile': 'Notes file',
  'autopilot.autoContinue': 'Carry on by itself',
  'autopilot.waitMinutes': 'Wait for background work',
  'frontier.enabled': 'Frontier Max',
  'frontier.effort': 'Effort',
  'frontier.subagentEffort': 'Effort for subagents',
  'qa.enabled': 'Release check',
  'guard.enabled': 'Lazy-exit guard',
  'guard.strictness': 'Guard strictness',
  'guard.maxPerTurn': 'Guard nudges per turn',
  'guard.maxPerSession': 'Guard nudges per session',
  'guard.modelCheck': 'Smart check',
  'router.strategy': 'Model router',
  'router.mainLoop': 'Route main conversation',
  'router.subagents': 'Route subagents',
  'subagents.mode': 'Subagents',
  'subagents.limit': 'Subagents at most',
  'subagents.countTeammates': 'Count teammates',
  'focus.enabled': 'Focus view',
  'focus.tools': 'Tool calls',
  'focus.results': 'Tool results',
  'focus.diffs': 'Inline file diffs',
  'focus.spinner': 'Activity line',
  'resources.level': 'Machine load',
  'resources.cpu': 'CPU ceiling',
  'resources.ram': 'Memory ceiling',
  'resources.intervalSec': 'Sample every',
  'resources.enforcement': 'When over',
  'progress.milestones': 'Milestones',
  'answers.style': 'Answer style',
  'cache.keepWarm': 'Keep warm',
  'cache.maxIdleMinutes': 'Keep warm for',
  'cache.minTokens': 'Keep warm from',
  'cache.guardModelSwitch': 'Ask before a model switch',
  'cache.stablePolicies': 'Keep policies stable',
  'cache.coldResume': 'Ask before a cold resume',
  'cache.coldResumeTokens': 'Cold resume from',
  'ops.decisions': 'Decision Inbox',
  'ops.watchers': 'Watchers',
  'ops.scout': 'Watcher suggestions',
}

for (const category of PERMISSION_CATEGORIES) {
  LABELS[`permissions.${category}`] = PERMISSION_LABEL[category]
}

/** The panel's word for a stored value, where it is not just the value capitalised. */
const VALUE_LABELS: Record<string, Record<string, string>> = {
  'autopilot.continuation': { clear: 'Start fresh', compact: 'Compact', manual: 'Wait for me' },
  'frontier.effort': { max: 'Maximum', xhigh: 'Extra high', high: 'High', keep: 'Leave as is' },
  'subagents.mode': { unrestricted: 'No limit', limit: 'Up to a number', ask: 'Ask each time', block: 'None' },
  'focus.tools': { compact: 'One line', hidden: 'Hidden' },
  'resources.enforcement': { inform: 'Just tell Claude', limit: 'Hold extra heavy jobs', strict: 'Hold all heavy jobs' },
  'answers.style': { standard: 'Standard', brief: 'Brief', ste: 'Plain technical', mission: 'Mission control', quest: 'Quest log' },
  'ops.scout': { off: 'Off', suggest: 'Suggest', auto: 'Arm explicit waits' },
}

const UNITS: Record<string, (n: number) => string> = {
  'autopilot.thresholdPercent': n => `${n}%`,
  'autopilot.thresholdTokens': n => fmtTokens(n),
  'autopilot.waitMinutes': n => (n === 0 ? 'Never' : n % 60 === 0 ? `${n / 60} h` : `${n} min`),
  'resources.cpu': n => `${n}%`,
  'resources.ram': n => `${n}%`,
  'resources.intervalSec': n => `${n} s`,
  'cache.maxIdleMinutes': n => (n % 60 === 0 ? `${n / 60} h` : `${n} min`),
  'cache.minTokens': n => fmtTokens(n),
  'cache.coldResumeTokens': n => fmtTokens(n),
}

/** A stored value as the panel shows it: "On", "Maximum", "70%", "700k". */
function show(path: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'On' : 'Off'
  if (typeof v === 'number') return UNITS[path]?.(v) ?? String(v)
  if (typeof v === 'string') return VALUE_LABELS[path]?.[v] ?? (/^[a-z]+$/.test(v) ? v.charAt(0).toUpperCase() + v.slice(1) : v)
  return JSON.stringify(v)
}

function flatten(prefix: string, value: unknown, out: Map<string, unknown>) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(prefix === '' ? k : `${prefix}.${k}`, v, out)
  } else {
    out.set(prefix, value)
  }
}

/** Every setting that differs between two system configurations, labelled. */
export function diffSystems(from: SystemSettings, to: SystemSettings): SettingChange[] {
  const a = new Map<string, unknown>()
  const b = new Map<string, unknown>()
  flatten('', from, a)
  flatten('', to, b)
  const changes: SettingChange[] = []
  for (const [path, next] of b) {
    const prev = a.get(path)
    if (deepEqual(prev, next)) continue
    if (path.startsWith('router.custom.')) continue
    changes.push({ path, label: LABELS[path] ?? path, from: show(path, prev), to: show(path, next) })
  }
  return changes
}

/** Saves the current systems as a custom profile (replacing one of the same name). */
export function saveCustomProfile(settings: Settings, name: string, now: number): Settings {
  const clean = name.trim().slice(0, 40)
  if (clean === '') return settings
  const id = slugOf(clean)
  const entry: CustomProfile = { id, name: clean, createdAt: now, systems: clone(systemsOf(settings)) }
  const others = settings.customProfiles.filter(p => p.id !== id)
  const customProfiles = [...others, entry].slice(-12)
  return { ...settings, customProfiles, profile: `custom:${id}` }
}

export function deleteCustomProfile(settings: Settings, id: string): Settings {
  const bare = id.startsWith('custom:') ? id.slice('custom:'.length) : id
  const customProfiles = settings.customProfiles.filter(p => p.id !== bare)
  const profile = settings.profile === `custom:${bare}` ? 'normal' : settings.profile
  return { ...settings, customProfiles, profile }
}
