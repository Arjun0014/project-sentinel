/**
 * View models: render-ready projections of the Runtime, one per `$.state`
 * atom. Pure functions of the runtime's state; the publisher decides when
 * to publish them.
 *
 * The plain-language status helpers below are the product's one voice: the
 * HUD, the Control Centre, the status line and `/cr status` all say the same
 * thing the same way ("Hands off at 70%", "Watching for early stops").
 */

import type {
  ActivityView,
  ChainRunView,
  FileChangeView,
  MissionView,
  ChainView,
  EvidenceRowView,
  FocusModel,
  HudAlert,
  HudModel,
  HudOps,
  OpsView,
  PaneModel,
  PermissionsView,
  QuestView,
  ResourcesView,
  SpinnerModel,
  StatusView,
  SystemId,
  TimelineKind,
  Tone,
  TurnTimelineView,
} from '../../types'
import { MIN_ENGINE } from '../constants'
import * as fmt from '../core/format'
import { findProfile, isModified } from '../core/profiles'
import { PERMISSION_CATEGORIES } from '../core/settings'
import { relativeTo, shortPath } from '../core/text'
import { readingTone } from '../ui/theme'
import { planWords } from '../ui/hud'
import { versionAtLeast } from '../core/version'
import type { ActivityItem, FileChange } from '../features/activity'
import { backgroundWords, blockingOf, classOf, handoffPoint, isHandoffActive } from '../features/autopilot'
import { CLASS_WORDS, isBlocking } from '../features/background'
import { bandOf } from '../features/agents'
import * as Chain from '../features/chain'
import { GROUP_LABEL, GROUP_ORDER, attentionOf, groupOf, isOpen, nowOf, turnSummaryOf } from '../features/digest'
import { companionView, moodOf } from '../features/companion'
import { gitLine } from '../features/git'
import { ACHIEVEMENTS, levelOf, runQuestOf } from '../features/quest'
import { planUsageView, windowRows } from '../features/planUsage'
import { evidenceLine } from '../features/evidence'
import { type ValidationSummary, summarize } from '../features/validation'
import { answerStyleLabel } from '../core/answers'
import { LONG_CALL_MS, chipsOf, headlineOf, runNowOf, trackOf } from './headline'
import type { Runtime } from './runtime'
import { suggestionWords } from '../features/scout'

function contextTone(rt: Runtime): Tone {
  const tokens = rt.usage.tokens
  if (tokens === undefined) return 'muted'
  const threshold = rt.settings.autopilot.enabled ? handoffPoint(rt.autopilot) : null
  const window = rt.usage.window
  const ref = threshold ?? (window === undefined ? null : window * 0.9)
  if (ref === null) return 'normal'
  if (tokens >= ref) return 'bad'
  if (tokens >= ref * 0.85) return 'warn'
  return 'good'
}

// ---------------------------------------------------------------------------
// Plain-language status

const EFFORT_NAME: Record<string, string> = { max: 'Maximum effort', xhigh: 'Extra-high effort', high: 'High effort', keep: 'Policy only' }
const LEVEL_NAME: Record<string, string> = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High', custom: 'Custom' }
const STRATEGY_NAME: Record<string, string> = { off: 'Off', balanced: 'Balanced', performance: 'Performance', economy: 'Economy', custom: 'Custom' }

/**
 * A handoff waiting for the person: calm when they asked for it ("Wait for
 * me"), red only when something went wrong (no notes, clearing refused).
 */
const awaitingTone = (rt: Runtime): Tone => (rt.autopilot.lastError === null ? 'warn' : 'bad')

/** "70%" or "700k": the threshold as the person set it. */
export function thresholdText(rt: Runtime): string {
  const a = rt.settings.autopilot
  return a.thresholdMode === 'percent' ? `${a.thresholdPercent}%` : fmt.tokens(rt.autopilot.threshold ?? a.thresholdTokens)
}

export function autopilotStatus(rt: Runtime): StatusView {
  if (!rt.settings.autopilot.enabled) return { text: 'Off', tone: 'muted' }
  switch (rt.autopilot.state) {
    case 'off':
    case 'armed':
      return { text: `Hands off at ${thresholdText(rt)}`, tone: 'normal' }
    case 'pending':
      return { text: 'Handoff soon', tone: 'warn' }
    case 'requested':
    case 'handoff':
      return { text: 'Writing the handoff', tone: 'info' }
    case 'waiting-background':
      return { text: 'Waiting for background work', tone: 'info' }
    case 'verifying':
      return { text: 'Checking the notes', tone: 'info' }
    case 'clearing':
    case 'compacting':
      return { text: 'Starting fresh', tone: 'info' }
    case 'resuming':
      return { text: 'Resuming', tone: 'info' }
    case 'awaiting':
      return { text: 'Waiting for you', tone: awaitingTone(rt) }
  }
}

export function frontierStatus(rt: Runtime): StatusView {
  const f = rt.settings.frontier
  if (!f.enabled) return { text: 'Off', tone: 'muted' }
  if (f.effort !== 'keep' && rt.frontier.isEffortSupported === false) return { text: 'Policy on · this model has no effort setting', tone: 'normal' }
  return { text: EFFORT_NAME[f.effort] ?? 'On', tone: 'normal' }
}

export function guardStatus(rt: Runtime): StatusView {
  if (!rt.settings.guard.enabled) return { text: 'Off', tone: 'muted' }
  const eff = rt.effective().guard
  if (!eff.isActive) return { text: eff.reason ?? 'Paused', tone: 'muted' }
  if (rt.guard.turnBlocks > 0) return { text: `Kept Claude going ${rt.guard.turnBlocks}× this turn`, tone: 'warn' }
  if (rt.guard.sessionBlocks > 0) return { text: `Kept Claude going ${rt.guard.sessionBlocks}× this session`, tone: 'normal' }
  return { text: 'Watching for early stops', tone: 'normal' }
}

export function routerStatus(rt: Runtime): StatusView {
  const s = rt.settings.router.strategy
  return { text: STRATEGY_NAME[s] ?? s, tone: s === 'off' ? 'muted' : 'normal' }
}

export function subagentStatus(rt: Runtime): StatusView {
  const s = rt.settings.subagents
  const running = rt.runningSubagents()
  const live = running > 0 ? ` · ${running} running` : ''
  switch (s.mode) {
    case 'unrestricted':
      return { text: `No limit${live}`, tone: 'normal' }
    case 'block':
      return { text: 'Off', tone: 'warn' }
    case 'ask':
      return { text: `Ask each time${live}`, tone: 'normal' }
    case 'limit':
      return { text: `Up to ${s.limit} at once${live}`, tone: running >= s.limit ? 'warn' : 'normal' }
  }
}

/** Machine load. `attention` is set only when it needs a look; the HUD shows nothing otherwise. */
export function loadStatus(rt: Runtime): StatusView & { isOn: boolean; attention: string | null; level: string } {
  const r = rt.settings.resources
  const level = LEVEL_NAME[r.level] ?? r.level
  if (r.level === 'off') return { isOn: false, attention: null, level, text: 'Off', tone: 'muted' }
  const m = rt.monitor
  const p = m.pressure
  if (m.status === 'unavailable') return { isOn: true, attention: 'Load unavailable', level, text: 'Readings unavailable', tone: 'muted' }
  if (m.status !== 'live' || p.level === 'unknown') return { isOn: true, attention: null, level, text: 'Starting…', tone: 'muted' }
  const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n)}%`)
  const tone: Tone = p.level === 'ok' ? 'good' : p.level === 'elevated' ? 'warn' : 'bad'
  const driver = p.driver === 'ram' ? `Memory ${pct(p.ram)}` : `CPU ${pct(p.cpu)}`
  return { isOn: true, attention: p.level === 'ok' ? null : driver, level, text: `CPU ${pct(p.cpu)} · Memory ${pct(p.ram)}`, tone }
}

export function focusStatus(rt: Runtime): StatusView {
  const f = rt.settings.focus
  if (!f.enabled) return { text: 'Off', tone: 'muted' }
  return { text: f.tools === 'hidden' ? 'Tool calls hidden' : 'Compact transcript', tone: 'normal' }
}

export function qaStatus(rt: Runtime): StatusView {
  return rt.settings.qa.enabled ? { text: 'Verify before done', tone: 'normal' } : { text: 'Off', tone: 'muted' }
}

/** The answer style in force: the person's own Claude Code output style outranks it. */
export function answersStatus(rt: Runtime): StatusView {
  if (rt.nativeOutputStyle !== null) return { text: `Claude Code style: ${rt.nativeOutputStyle}`, tone: 'muted' }
  const style = rt.settings.answers.style
  return { text: answerStyleLabel(style), tone: style === 'standard' ? 'muted' : 'normal' }
}

export function statusOf(rt: Runtime): Record<SystemId, StatusView> {
  const load = loadStatus(rt)
  return {
    autopilot: autopilotStatus(rt),
    frontier: frontierStatus(rt),
    qa: qaStatus(rt),
    guard: guardStatus(rt),
    router: routerStatus(rt),
    subagents: subagentStatus(rt),
    load: load.isOn ? { text: `${load.level} · ${load.text}`, tone: load.tone } : { text: 'Off', tone: 'muted' },
    focus: focusStatus(rt),
    answers: answersStatus(rt),
  }
}

export function profileOf(rt: Runtime): { id: string; name: string; isModified: boolean } {
  const profile = findProfile(rt.settings, rt.settings.profile)
  return { id: rt.settings.profile, name: profile?.name ?? 'Custom', isModified: isModified(rt.settings) }
}

export function runLabelOf(rt: Runtime): string {
  if (rt.run === null) return 'No run yet'
  const s = Chain.currentSession(rt.run)
  return `Run ${rt.run.number} · Session ${s?.index ?? 1}`
}


function liveLoadOf(rt: Runtime): HudModel['load'] {
  if (rt.monitor.status === 'off') return null
  const latest = rt.monitor.status === 'live' ? rt.monitor.latest() : null
  const ceilings = rt.effective().resources.ceilings
  const cpu = latest?.cpu ?? null
  const ram = latest?.ram ?? null
  return {
    cpu,
    ram,
    cpuTone: readingTone(cpu, ceilings?.cpu ?? null, { warn: 75, bad: 90 }),
    ramTone: readingTone(ram, ceilings?.ram ?? null, { warn: 80, bad: 92 }),
    cpuSeries: rt.monitor.cpuSeries(8),
    ramSeries: rt.monitor.ramSeries(8),
  }
}

// ---------------------------------------------------------------------------
// Signal: shared by the status bar and Activity

/** The main conversation's calls in the current (or last) turn, oldest first. */
const turnItemsOf = (rt: Runtime): ActivityItem[] => rt.activity.items.filter(i => i.turn === rt.activity.turn.index && i.agentId === null)

const validationNow = (rt: Runtime, now: number): ValidationSummary[] => summarize(rt.activity.validationRuns(), now)

const nowLine = (rt: Runtime) => nowOf({ isTurnRunning: rt.turn.isRunning, running: rt.activity.runningItems(), progress: rt.progress() })

// ---------------------------------------------------------------------------
// Projections

/**
 * The line above the headline, for what needs the person now: a handoff, the machine, then the
 * orchestration layer (a watcher due that waits for them, a message the Cold Resume Guard kept, the
 * budget holding automation, a watcher suggestion). One at a time, the most pressing.
 */
function alertOf(rt: Runtime, ops: HudOps | null): HudAlert | null {
  const s = rt.settings
  if (rt.autopilot.state === 'awaiting') return { kind: 'awaiting', text: rt.autopilot.note, tone: awaitingTone(rt) }
  const handoff = handoffAlertOf(rt)
  if (handoff !== null) return handoff
  if (rt.monitor.pressure.level === 'critical' && s.resources.level !== 'off') return { kind: 'load', text: 'Your machine is under heavy load. Claude was asked to ease off.', tone: 'bad' }
  if (rt.autopilot.state === 'pending') return { kind: 'pending', text: 'Finishing this step, then handing off', tone: 'warn' }
  if (rt.turn.isRunning) return null
  const w = ops?.watcher ?? null
  if (w !== null && (w.status === 'due' || w.status === 'stale') && w.needs !== null) {
    const strategy = rt.ops.current().watchers.find(x => x.id === w.id)?.strategy ?? 'warm'
    return { kind: 'watcher', text: `Watcher due: ${w.label} · ${w.needs}`, tone: 'warn', ref: w.id, canFresh: strategy !== 'warm' && rt.ops.resumeHealth().isHealthy }
  }
  if (rt.ops.held !== null) return { kind: 'held', text: 'Your message was not sent: it is kept in Control Room', tone: 'warn' }
  if (rt.ops.budgetHeld !== null) return { kind: 'budget', text: `Run budget reached: ${rt.ops.budgetHeld} waits for you`, tone: 'warn' }
  const sug = rt.ops.suggestion
  if (sug !== null) return { kind: 'suggest', text: `Claude seems to be waiting for a future result. ${suggestionWords(sug, rt.clock())}`, tone: 'info', ref: sug.id, hasTime: sug.when !== null && sug.when.kind === 'at' }
  return null
}

/** From this close to the wait's end, Keep waiting is offered beside the other ways out. */
const KEEP_OFFERED_MS = 5 * 60_000

/**
 * A handoff the person may want to move on, with its ways out (the Handoff Supervisor's): one that
 * waits for background work (Hand off now and leave it running, Stop & hand off, Keep waiting near
 * the wait's end, Call off), and one whose step has not moved on (stalled). Null otherwise.
 */
function handoffAlertOf(rt: Runtime): HudAlert | null {
  if (!rt.settings.autopilot.enabled) return null
  const a = rt.autopilot
  const d = rt.supervisor
  // The wait's end was set by the engine's clock: measured by it.
  const now = rt.engineTime()
  if (a.state === 'waiting-background') {
    const waiting = blockingOf(a.background)
    if (waiting.length === 0 || a.skipWait) return null
    const left = a.waitUntil === null ? '' : a.waitUntil > now ? ` · goes on in ${fmt.countdown(a.waitUntil - now)} at most` : ' · going on'
    const isStalled = d?.status === 'stalled'
    return {
      kind: 'waiting',
      text: `Handoff ${a.notesWritten === false ? 'waits' : 'written, waits'} for ${backgroundWords(waiting)}${left}`,
      tone: isStalled ? 'warn' : 'info',
      canStop: true,
      canKeep: isStalled || (a.waitUntil !== null && a.waitUntil - now < KEEP_OFFERED_MS),
    }
  }
  if (d === null || (d.status !== 'stalled' && d.status !== 'needs-you') || d.blocker === null || a.state === 'awaiting' || a.state === 'pending') return null
  return { kind: 'stuck', text: `Handoff: ${d.blocker.text}`, tone: 'warn', offers: [...d.actions] }
}

export function hudOf(rt: Runtime): HudModel {
  const tokens = rt.usage.tokens ?? null
  const window = rt.usage.window ?? null
  const pct = tokens !== null && window !== null && window > 0 ? Math.round((100 * tokens) / window) : (rt.usage.pct ?? null)
  const totals = rt.run === null ? null : Chain.totals(rt.run, Date.now())
  const ap = autopilotStatus(rt)
  const s = rt.settings
  const ops = rt.ops.hud()
  const alert = alertOf(rt, ops)
  const now = Date.now()
  const validation = validationNow(rt, now)
  const activity = hudActivityOf(rt, now)
  const failing = validation.filter(v => v.isFailing).map(v => v.label)
  const attention = barAttentionOf(rt, now)
  const load = liveLoadOf(rt)
  const agents = { running: rt.runningSubagents(), limit: s.subagents.mode === 'limit' ? s.subagents.limit : null, mode: s.subagents.mode }
  const guard = { isOn: s.guard.enabled, continued: rt.guard.turnBlocks }
  const quest = questHudOf(rt)
  const summary = activity === null || activity.state !== 'done' ? null : { text: activity.text, durationMs: activity.durationMs, isFailing: failing.length > 0 || attention > 0 }
  return {
    isVisible: s.ui.hud === 'band' || s.ui.hud === 'both',
    headline: headlineOf(rt, now, summary),
    chips: chipsOf({ failing, attention, guard, load, agents, quest, ops, isWorking: rt.turn.isRunning }),
    isPaneOpen: rt.ui.isPaneOpen,
    ctx: { tokens, window, pct, threshold: s.autopilot.enabled ? handoffPoint(rt.autopilot) : null, tone: contextTone(rt) },
    cost: { usd: rt.usage.costUsd ?? null, runUsd: totals?.costUsd ?? null, isRunPartial: totals?.isCostPartial ?? false },
    profile: profileOf(rt),
    frontier: { isOn: s.frontier.enabled, effort: s.frontier.enabled ? (EFFORT_NAME[s.frontier.effort] ?? null) : null },
    autopilot: { isOn: s.autopilot.enabled, state: rt.autopilot.state, text: ap.text, tone: ap.tone },
    load,
    agents,
    guard,
    session: { run: rt.run?.number ?? null, index: rt.run === null ? 1 : (Chain.currentSession(rt.run)?.index ?? 1), handoffs: totals?.handoffs ?? 0 },
    alert,
    ops,
    work: workOf(rt),
    now: nowLine(rt),
    failing,
    attention,
    activity,
    checks: validation.map(v => ({ label: v.label, status: v.status })),
    quest,
    cache: sleepingCache(rt.cache.hud(rt.clock(), rt.turn.isRunning), ops),
    objective: rt.run?.objective ?? null,
    isAnimated: !s.ui.reducedMotion,
    companion: companionOf(rt, now, validation),
    git: rt.git === null ? null : gitLine(rt.git),
    agentBand: bandOf(rt.ops.agentRowsNow(), rt.clock()),
    plan: planOf(rt),
  }
}

/** The plan's windows now: `resetsAt` is wall-clock time, so they are read against the system clock. */
function planOf(rt: Runtime): HudModel['plan'] {
  const now = rt.clock()
  return { five: planUsageView(rt.planUsage, now), windows: windowRows(rt.planUsage, now) }
}

/** While a watcher parks the run, the cache says what becomes of it: held warm to the wake, or left to lapse for a fresh one. */
function sleepingCache(cache: HudModel['cache'], ops: HudOps | null): HudModel['cache'] {
  const w = ops?.watcher ?? null
  if (cache === null || ops === null || !ops.isSleeping || w === null || cache.recentMiss !== null) return cache
  if (w.isHeldWarm && cache.warmth === 'warm') return { ...cache, parked: { text: 'held warm', short: 'held' }, tone: 'normal', isShown: true }
  if (w.mode === 'fresh') return { ...cache, parked: { text: 'no keep-alive', short: 'lapses' }, tone: 'muted', isShown: true }
  return cache
}

/** The orchestration layer's view, for Activity → Operations, Overview and Context. */
export function opsOf(rt: Runtime): OpsView {
  return rt.ops.view()
}

/** Kit's mood from what Claude is doing, and what its surface module needs; null while the companion is off or has failed to draw. */
function companionOf(rt: Runtime, now: number, validation: readonly ValidationSummary[]): HudModel['companion'] {
  const s = rt.settings
  if (!s.ui.companion || rt.companionFault !== null) return null
  const turn = rt.activity.turn
  const thisTurn = rt.activity.validationRuns().filter(r => r.turn === turn.index)
  const p = rt.progress()
  const threshold = s.autopilot.enabled ? handoffPoint(rt.autopilot) : null
  const window = rt.usage.window ?? null
  const ref = threshold ?? (window === null ? null : window * 0.9)
  const load = liveLoadOf(rt)
  // Busy for Kit: the processor near its ceiling (fewer frames, no walking). Memory at its limit tires
  // Kit (its mood) but costs nothing to animate, so it never slows or stills it: a desktop often sits
  // at its memory ceiling (seen live, 85–90%), and Kit froze there until 1.5.0.
  const isCpuBusy = load !== null && (load.cpuTone === 'warn' || load.cpuTone === 'bad')
  const isBusy = isCpuBusy || (load !== null && load.ramTone === 'bad')
  const cache = rt.cache.hud(rt.clock(), rt.turn.isRunning)
  const opsHud = rt.ops.hud()
  const isGreen = (thisTurn.length > 0 && thisTurn.every(r => r.status === 'passed')) || (p.total > 0 && p.done === p.total && p.done > rt.turnStartDone)
  const mood = moodOf({
    now,
    isWorking: rt.turn.isRunning,
    source: rt.turn.isRunning ? (nowLine(rt)?.source ?? 'thinking') : null,
    toolKind: rt.activity.runningItems().find(i => i.agentId === null)?.kind ?? null,
    isCheckRunning: validation.some(v => v.status === 'running'),
    isFailing: validation.some(v => v.isFailing) || barAttentionOf(rt, now) > 0,
    autopilotState: s.autopilot.enabled ? rt.autopilot.state : 'off',
    isGreen,
    turnEndedAt: turn.endedAt,
    hasTurned: turn.index > 0,
    contextStartedAt: rt.contextStartedAt,
    contextShare: ref === null || rt.usage.tokens === undefined ? null : rt.usage.tokens / ref,
    isKeepingWarm: (s.cache.keepWarm || rt.ops.hold() !== null) && rt.cache.plan.at !== null,
    // The orchestration layer: decisions to review look to the person; a parked run sleeps (or tends a held cache).
    isNeedingYou: (opsHud?.review ?? 0) > 0 || (opsHud?.watcher?.needs ?? null) !== null,
    sleep: opsHud?.isSleeping === true ? (opsHud.watcher?.isHeldWarm === true ? 'warm' : 'parked') : null,
    isWaiting: rt.lastStop !== null && (rt.blockingInFlight().length > 0 || rt.lastStop.wakeups.length > 0 || rt.lastStop.isQuestion) || p.blocked.length > 0 || p.waiting.length > 0,
    isBusy,
    isCacheNear: cache !== null && cache.tone === 'warn' && cache.recentMiss === null,
    isRefreshing: rt.cache.state.keepWarm.lastAt !== null && now - rt.cache.state.keepWarm.lastAt < 60_000,
  })
  // A processor at its limit: one frame a second (the companion never adds to the load), still alive.
  const pressure = rt.monitor.pressure
  const isStrained = pressure.level === 'critical' && pressure.driver === 'cpu'
  return companionView({
    mood,
    now,
    hour: new Date(now).getHours(),
    isReduced: s.ui.reducedMotion,
    isBusy: isCpuBusy,
    isStrained,
    isWorking: rt.turn.isRunning,
    contextStartedAt: rt.contextStartedAt,
    done: p.done,
    // One-shot moments, as values Kit compares with what it last saw.
    // A green finish is a moment only when nothing failed: never a dance beside a failing check.
    greenAt: mood === 'celebrate' ? turn.endedAt : null,
    fails: rt.activity.validationRuns().filter(r => r.status === 'failed').length,
    refreshAt: rt.cache.state.keepWarm.lastAt,
  })
}

/**
 * The status bar's count of calls that need a look. A failing check is left
 * out: the bar already shows it failing, by name.
 */
function barAttentionOf(rt: Runtime, now: number): number {
  const items = turnItemsOf(rt)
  const checks = new Set(items.filter(i => i.validation !== null).map(i => i.id))
  return attentionOf(items, now).filter(a => isOpen(a) && !(a.kind === 'failed' && checks.has(a.id))).length
}

/**
 * The status bar's top line. While a turn runs: what Claude is doing, the
 * milestone it serves, and how long a slow call has been running. Once it
 * ends: what the turn did, in counted words. Nothing before the first turn.
 */
function hudActivityOf(rt: Runtime, now: number): HudModel['activity'] {
  const turn = rt.activity.turn
  if (turn.index === 0 && !rt.turn.isRunning) return null
  const p = rt.progress()
  const tasks = rt.plan().tasks
  const milestone = p.current === null ? null : { subject: p.current.subject, index: tasks.indexOf(p.current) + 1, total: tasks.length }
  if (rt.turn.isRunning) {
    const line = nowLine(rt) ?? { text: 'Thinking', source: 'thinking' as const }
    const longest = rt.activity
      .runningItems()
      .filter(i => i.agentId === null)
      .reduce((ms, i) => Math.max(ms, now - i.startedAt), 0)
    return { state: 'working', text: line.text, source: line.source, milestone, runningMs: longest >= LONG_CALL_MS ? longest : null, durationMs: null }
  }
  const items = turnItemsOf(rt)
  const files = rt.activity.changeList()
  const ctx = { root: rt.root, handoffFile: rt.settings.autopilot.handoffFile }
  const lines = turnSummaryOf({
    items,
    changed: files.filter(f => turn.files.has(f.path)),
    groupOf: path => groupOf(path, ctx),
    validation: validationNow(rt, now),
    attention: attentionOf(items, now),
    milestonesDone: Math.max(0, p.done - rt.turnStartDone),
  })
  // The changes by count alone ("Changed 4 files"), so the checks after them stay in view.
  const [first, second] = lines.map((line, i) => (i === 0 && line.startsWith('Changed ') ? (line.split(' · ')[0] ?? line) : line))
  return {
    state: 'done',
    text: first === undefined ? 'Replied, no tools used' : second === undefined ? first : `${first} · ${second}`,
    source: 'summary',
    milestone,
    runningMs: null,
    durationMs: turn.startedAt === null || turn.endedAt === null ? null : turn.endedAt - turn.startedAt,
  }
}

function questHudOf(rt: Runtime): HudModel['quest'] {
  if (rt.settings.answers.style !== 'quest') return null
  const l = levelOf(rt.quest.xp)
  return { level: l.level, xp: rt.quest.xp, intoLevel: rt.quest.xp - l.floor, levelSpan: l.next - l.floor, runXp: runQuestOf(rt.run?.quest).xp }
}

function workOf(rt: Runtime): HudModel['work'] {
  const p = rt.progress()
  if (p.total === 0) return null
  return { done: p.done, total: p.total, current: p.current === null ? null : (p.current.activeForm ?? p.current.subject), track: trackOf(rt.plan().tasks) }
}

/** The live status bar for Claude Code's own status line (`/cr hud status`): the run in one line. */
export function statusLineOf(hud: HudModel): string {
  const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n)}%`)
  const isHigh = (t: Tone) => t === 'warn' || t === 'bad'
  const parts = [`◆ Context ${pct(hud.ctx.pct)}`]
  if (hud.work !== null) parts.push(`Work ${hud.work.done}/${hud.work.total}`)
  if (hud.cache !== null) parts.push(`Cache ${hud.cache.parked?.text ?? hud.cache.text}`)
  if (hud.autopilot.isOn && hud.autopilot.state !== 'off' && hud.autopilot.state !== 'armed') parts.push(hud.autopilot.text)
  if (hud.now !== null) parts.push(hud.now.text)
  // The orchestration layer, only while it matters: the run asleep, decisions to review, the budget.
  const ops = hud.ops
  const w = ops?.watcher ?? null
  if (ops !== null && ops.isSleeping && w !== null && w.status === 'armed') parts.push(`Sleeping until ${w.at} · ${w.label} (${w.left})`)
  else if (w !== null && w.needs !== null) parts.push(`Watcher due: ${w.label}`)
  else if (w !== null && w.status === 'armed') parts.push(`Watcher ${w.left}`)
  if (ops !== null && ops.review > 0) parts.push(ops.blocking > 0 ? `Needs you · ${fmt.plural(ops.blocking, 'decision')}` : `Review ${ops.review}`)
  if (ops?.budget != null && ops.budget.tone !== 'muted') parts.push(ops.budget.text)
  if (hud.failing.length > 0) parts.push(`${hud.failing.join(', ')} failing`)
  if (hud.attention > 0) parts.push(`${fmt.plural(hud.attention, 'issue')}`)
  if (hud.load !== null && isHigh(hud.load.cpuTone)) parts.push(`CPU ${pct(hud.load.cpu)}`)
  if (hud.load !== null && isHigh(hud.load.ramTone)) parts.push(`RAM ${pct(hud.load.ram)}`)
  if (hud.agents.running > 0) parts.push(fmt.plural(hud.agents.running, 'agent'))
  if (hud.guard.isOn && hud.guard.continued > 0) parts.push(`Kept going ×${hud.guard.continued}`)
  const plan = planWords(hud.plan.five, false)
  if (plan !== null) parts.push(plan)
  return parts.join(' · ')
}

export function paneOf(rt: Runtime): PaneModel {
  const a = rt.autopilot
  const isBusy = isHandoffActive(a.state) && a.state !== 'pending'
  return {
    tab: rt.ui.tab,
    showAllChanges: rt.ui.showAllChanges,
    openPicker: rt.ui.openPicker,
    status: statusOf(rt),
    activitySub: rt.ui.activitySub,
    settings: rt.settings,
    profileLabel: rt.profileLabel(),
    runLabel: runLabelOf(rt),
    engine: { version: rt.engineVersion, isSupported: rt.engineVersion === null || versionAtLeast(rt.engineVersion, MIN_ENGINE) },
    surfaces: rt.surfaces,
    autopilot: {
      state: a.state,
      note: a.note,
      threshold: handoffPoint(a),
      isClamped: a.isClamped,
      autoCompactAt: rt.autoCompactAt ?? null,
      tokens: rt.usage.tokens ?? null,
      window: rt.usage.window ?? null,
      handoffPath: rt.handoffPath(),
      lastError: a.lastError,
      completed: a.completed,
      canHandoff: rt.settings.autopilot.enabled && !isBusy,
      canFresh: canFreshOf(rt),
      canSnooze: a.state === 'pending' || a.state === 'awaiting',
      background:
        a.state === 'waiting-background'
          ? a.background.map(t => {
              const c = classOf(t)
              return { id: t.id, description: t.description, class: c, classWords: CLASS_WORDS[c], why: t.why ?? null, by: t.by ?? null, isBlocking: isBlocking(c) }
            })
          : [],
      supervisor:
        rt.supervisor === null
          ? null
          : { status: rt.supervisor.status, phase: rt.supervisor.phase, forMs: rt.supervisor.forMs, blocker: rt.supervisor.blocker, goesOnInMs: rt.supervisor.goesOnAt === null ? null : Math.max(0, rt.supervisor.goesOnAt - rt.engineTime()), actions: [...rt.supervisor.actions] },
      waitLeftMs: a.state === 'waiting-background' && a.waitUntil !== null ? Math.max(0, a.waitUntil - rt.engineTime()) : null,
      skipWait: a.skipWait,
      waitMinutes: rt.settings.autopilot.waitMinutes,
    },
    agents: {
      running: rt.agents.list
        .filter(x => !['completed', 'failed', 'killed'].includes(x.status))
        .slice(0, 8)
        .map(x => ({ id: x.id, type: x.type, description: x.description, status: x.status })),
      spawned: rt.agents.spawned,
      denied: rt.agents.denied,
      asked: rt.agents.asked,
    },
    router: {
      lastDecision: rt.router.lastDecision,
      resolved: [...rt.router.known.entries()].map(([alias, id]) => ({ alias, id })),
      unavailable: [...rt.router.unavailable],
    },
    guard: {
      turn: rt.guard.turnBlocks,
      session: rt.guard.sessionBlocks,
      last: rt.guard.last === null ? null : { verdict: rt.guard.last.verdict, score: rt.guard.last.score, reasons: rt.guard.last.reasons.slice(0, 4), at: rt.guard.last.at },
      isActive: rt.effective().guard.isActive,
      reason: rt.effective().guard.reason,
    },
    frontier: {
      lastEffort: rt.frontier.lastEffort,
      isEffortSupported: rt.frontier.isEffortSupported,
      isComposeReached: rt.compose.isReached ? true : rt.composeObserved ? false : null,
      delivery: rt.ledger.frontier(rt.settings.frontier.enabled),
    },
    notes: rt.notes,
    allowRemoved: rt.allowRemoved,
    savedAt: rt.savedAt,
    planSource: rt.planSource,
    nativeOutputStyle: rt.nativeOutputStyle,
    cache: rt.cache.view(rt.clock()),
    handoff: handoffOf(rt),
    firstRun: firstRunOf(rt),
  }
}

/**
 * Whether Start fresh context is offered: a handoff waiting for the person, or one no event will move
 * on by itself (its turn ended unseen, or its background work ended with no turn left to end). The
 * press checks the notes and what is in flight first, and says why when it does not start.
 */
function canFreshOf(rt: Runtime): boolean {
  if (!rt.settings.autopilot.enabled || rt.turn.isRunning) return false
  const a = rt.autopilot
  if (a.state === 'awaiting') return true
  // Waiting for nothing it must wait for (a server beside it never holds it): the press finishes it.
  if (a.state === 'waiting-background') return blockingOf(a.background).length === 0
  return a.state === 'handoff' && rt.turn.kind !== 'handoff' && rt.turn.kind !== 'retry'
}

/** A fresh install's first-run card, in the live settings' words; null once dismissed, and for an existing install. */
function firstRunOf(rt: Runtime): PaneModel['firstRun'] {
  const o = rt.onboarding
  if (o === null || o.dismissedAt !== null) return null
  const s = rt.settings
  const a = s.autopilot
  const at = a.thresholdMode === 'percent' ? `${a.thresholdPercent}%` : fmt.tokens(a.thresholdTokens)
  const asks = PERMISSION_CATEGORIES.filter(c => s.permissions[c] === 'ask').length
  const denies = PERMISSION_CATEGORIES.filter(c => s.permissions[c] === 'deny').length
  return {
    autopilot: a.enabled ? at : null,
    frontier: s.frontier.enabled ? (FIRST_RUN_EFFORT[s.frontier.effort] ?? 'its policy only') : null,
    guardrails: `${asks} kinds of action ask you first, ${denies} are denied`,
  }
}

const FIRST_RUN_EFFORT: Record<string, string> = { max: 'Maximum effort', xhigh: 'Extra High effort', high: 'High effort', keep: 'its policy only (effort left as is)' }

/** The run's latest handoff, as Context shows it. */
function handoffOf(rt: Runtime): PaneModel['handoff'] {
  const h = rt.run?.lastHandoff
  if (h === undefined || h === null || rt.run === null) return null
  const index = Chain.currentSession(rt.run)?.index ?? 1
  return {
    at: h.at,
    fromSession: h.fromSession,
    toSession: h.toSession,
    via: h.via,
    health: h.health,
    continuity: h.continuity,
    isChecking: h.toSession !== null && h.continuity === null && h.toSession === index,
    leftRunning: (h.leftRunning ?? []).map(t => ({ id: t.id, description: t.description, isService: t.class === 'persistent', endedAt: t.endedAt, status: t.status })),
    evidence: [...evidenceRowsOf(rt).values()].filter(e => e.status !== 'rebaselined'),
  }
}

export function resourcesOf(rt: Runtime): ResourcesView {
  const ceilings = rt.effective().resources.ceilings
  // The newest reading, as the status bar shows it. Pressure (a smoothed
  // window) exists only under ceilings; readings alone still have values.
  const latest = rt.monitor.status === 'live' ? rt.monitor.latest() : null
  return {
    status: rt.monitor.status,
    platform: rt.monitor.platform,
    cpu: latest?.cpu ?? null,
    ram: latest?.ram ?? null,
    level: rt.monitor.pressure.level,
    ceilings: ceilings === null ? null : { cpu: ceilings.cpu, ram: ceilings.ram, maxHeavy: ceilings.maxHeavy },
    cpuSeries: rt.monitor.cpuSeries(40),
    ramSeries: rt.monitor.ramSeries(40),
    background: [...rt.activity.background.values()].slice(0, 10),
    heavyRunning: rt.activity.runningHeavy().map(i => i.label).slice(0, 5),
    refused: rt.resourceStats.refused,
    noticesSent: rt.resourceStats.noticesSent,
    error: rt.monitor.error,
  }
}

function runView(run: Chain.Run, now: number): ChainRunView {
  const t = Chain.totals(run, now)
  return {
    id: run.id,
    number: run.number,
    startedAt: run.startedAt,
    status: run.status,
    root: shortPath(run.root, 48),
    sessions: run.sessions.map(s => ({
      index: s.index,
      id: s.id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      start: s.start,
      end: s.end,
      peakTokens: s.peakTokens,
      window: s.window,
      costUsd: s.costUsd,
      turns: s.turns,
      endNote: s.endNote,
      transitions: s.transitions.length,
    })),
    costUsd: t.costUsd,
    isCostPartial: t.isCostPartial,
    turns: t.turns,
    handoffs: t.handoffs,
    durationMs: t.durationMs,
  }
}

export function chainOf(rt: Runtime): ChainView {
  const now = Date.now()
  return {
    current: rt.run === null ? null : runView(rt.run, now),
    history: rt.history.slice(0, 8).map(r => runView(r, now)),
  }
}

/** Milestones shown around the work under way: a few done, the current one, a few next. */
const PLAN_WINDOW = { done: 2, shown: 7 }

/** The run's completed milestones whose evidence is not plainly current, by milestone key (features/evidence.ts). */
export function evidenceRowsOf(rt: Runtime): Map<string, EvidenceRowView> {
  const rows = new Map<string, EvidenceRowView>()
  for (const s of rt.evidence().snapshots) {
    const line = evidenceLine(s)
    if (line === null) continue
    rows.set(s.key, { subject: s.subject, status: s.status === 'current' ? 'rebaselined' : s.status, line })
  }
  return rows
}

export function missionOf(rt: Runtime): MissionView {
  const p = rt.progress()
  const tasks = rt.plan().tasks
  const evidence = evidenceRowsOf(rt)
  let plan: MissionView['plan'] = null
  if (tasks.length > 0) {
    const done = tasks.filter(t => t.status === 'completed')
    const open = tasks.filter(t => t.status !== 'completed')
    const shownOpen = open.slice(0, Math.max(1, PLAN_WINDOW.shown - Math.min(PLAN_WINDOW.done, done.length)))
    const shownDone = done.slice(-Math.max(PLAN_WINDOW.done, PLAN_WINDOW.shown - shownOpen.length))
    plan = {
      done: p.done,
      total: p.total,
      tasks: [...shownDone, ...shownOpen].map(t => ({ subject: t.subject, status: t.status, isCurrent: t === p.current, detail: t.detail, evidence: t.status === 'completed' ? (evidence.get(t.key) ?? null) : null })),
      earlier: done.length - shownDone.length,
      later: open.length - shownOpen.length,
      staleEarlier: done.filter(t => !shownDone.includes(t)).map(t => evidence.get(t.key)).filter((e): e is EvidenceRowView => e !== undefined && e.status === 'stale'),
    }
  }
  const totals = rt.run === null ? null : Chain.totals(rt.run, Date.now())
  const current = runNowOf(rt, Date.now())
  return {
    objective: rt.run?.objective ?? null,
    plan,
    now: current.text,
    nowState: current.state,
    next: p.next === null ? null : p.next.subject,
    isWorking: rt.turn.isRunning,
    session: rt.run === null ? 1 : (Chain.currentSession(rt.run)?.index ?? 1),
    handoffs: totals?.handoffs ?? 0,
  }
}

function fileView(rt: Runtime, f: FileChange): FileChangeView {
  return {
    path: f.path,
    display: shortPath(relativeTo(f.path, rt.root), 56),
    added: f.added,
    removed: f.removed,
    hasDiff: f.hasDiff,
    edits: f.edits,
    isCreated: f.isCreated,
    isDeleted: f.isDeleted,
    lastAt: f.lastAt,
  }
}

export function activityOf(rt: Runtime): ActivityView {
  const now = Date.now()
  const files = rt.activity.changeList()
  const selected = rt.ui.selectedPath === null ? null : (rt.activity.changes.get(rt.ui.selectedPath) ?? null)
  const ctx = { root: rt.root, handoffFile: rt.settings.autopilot.handoffFile }
  const group = (path: string) => groupOf(path, ctx)
  const turnItems = turnItemsOf(rt)
  const attention = attentionOf(turnItems, now)
  const runs = rt.activity.validationRuns()
  const validation = summarize(runs, now)
  const turn = rt.activity.turn
  return {
    summary: rt.activity.summaryLine({ subagentsRunning: rt.runningSubagents() }),
    turn: turn.index,
    sessionTools: rt.activity.sessionTools,
    mission: missionOf(rt),
    turnSummary: {
      lines: turnSummaryOf({
        items: turnItems,
        changed: files.filter(f => turn.files.has(f.path)),
        groupOf: group,
        validation,
        attention,
        milestonesDone: Math.max(0, rt.progress().done - rt.turnStartDone),
      }),
      isRunning: rt.turn.isRunning,
      durationMs: turn.startedAt === null ? null : (turn.endedAt ?? now) - turn.startedAt,
      tools: turn.tools,
    },
    timeline: timelineOf(turnItems, turn.startedAt, turn.endedAt ?? now, now),
    quest: questOf(rt),
    attention: [
      // Verification gone stale first: a finished milestone whose files changed since (never called wrong).
      ...rt.staleEvidence().map(s => ({ id: `stale-${s.key}`, kind: 'stale' as const, title: s.subject, reason: evidenceLine(s), state: null, attempts: 1, durationMs: null, since: s.verifiedAt })),
      ...attention.slice(0, 12).map(a => ({ id: a.id, kind: a.kind, title: a.title, reason: a.reason, state: a.state, attempts: a.attempts, durationMs: a.durationMs, since: a.since })),
    ],
    validation: validation.map(v => ({
      kind: v.kind,
      label: v.label,
      command: v.command,
      status: v.status,
      durationMs: v.durationMs,
      runs: v.runs,
      failures: v.failures,
      isRecovered: v.isRecovered,
      history: runs.filter(r => r.kind === v.kind).map(r => r.status).slice(-12),
    })),
    groups: GROUP_ORDER.map(id => ({ id, label: GROUP_LABEL[id], files: files.filter(f => group(f.path) === id).slice(0, 40).map(f => fileView(rt, f)) })).filter(g => g.files.length > 0),
    showGenerated: rt.ui.showGenerated,
    items: rt.activity.items
      .slice(-80)
      .reverse()
      .map(i => ({
        id: i.id,
        tool: i.tool,
        kind: i.kind,
        label: i.label,
        status: i.status,
        reason: i.reason,
        startedAt: i.startedAt,
        endedAt: i.endedAt,
        isSubagent: i.agentId !== null,
        heavy: i.heavy,
      })),
    totals: rt.activity.totals(),
    selectedPath: selected?.path ?? null,
    selectedHunks: selected?.hunks ?? '',
  }
}

const TIMELINE_KIND: Record<string, TimelineKind> = { read: 'read', search: 'read', edit: 'edit', shell: 'run', web: 'web', agent: 'agent' }

/** Where the turn's time went: one span per call of the main conversation, by kind, a check apart from other commands. */
export function timelineOf(items: readonly ActivityItem[], from: number | null, to: number, now: number): TurnTimelineView | null {
  if (from === null || items.length === 0) return null
  return {
    from,
    to: Math.max(to, from + 1),
    spans: items
      .filter(i => i.kind !== 'task')
      .map(i => ({
        kind: i.validation !== null ? 'check' : (TIMELINE_KIND[i.kind] ?? 'other'),
        start: Math.max(from, i.startedAt),
        end: i.endedAt ?? now,
        isFailed: i.status === 'error' || i.status === 'denied' || i.status === 'held',
      })),
  }
}

function questOf(rt: Runtime): QuestView | null {
  if (rt.settings.answers.style !== 'quest') return null
  const q = rt.quest
  const l = levelOf(q.xp)
  return {
    level: l.level,
    xp: q.xp,
    intoLevel: q.xp - l.floor,
    levelSpan: l.next - l.floor,
    runXp: runQuestOf(rt.run?.quest).xp,
    recent: q.recent.slice(0, 5),
    achievements: ACHIEVEMENTS.map(a => ({ id: a.id, name: a.name, hint: a.hint, unlockedAt: q.unlocked[a.id] ?? null })),
  }
}

export function permissionsOf(rt: Runtime): PermissionsView {
  return { recent: rt.permissionLog.slice(0, 20), ...rt.permissionCounts }
}

export function focusOf(rt: Runtime): FocusModel {
  const f = rt.settings.focus
  return { isOn: f.enabled, tools: f.tools, results: f.results, diffs: f.diffs, expanded: [...rt.ui.expanded].slice(-200) }
}

export function spinnerOf(rt: Runtime): SpinnerModel {
  const f = rt.settings.focus
  if (!f.enabled || !f.spinner || !rt.turn.isRunning) return { line: null }
  return { line: rt.activity.summaryLine({ subagentsRunning: rt.runningSubagents() }) }
}
