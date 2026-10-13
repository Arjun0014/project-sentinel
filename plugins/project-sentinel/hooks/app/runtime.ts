/**
 * The Runtime: Control Room's composition root. It owns the live model,
 * receives every engine event from `register.tsx`, asks the policy engine
 * what is in force, runs the feature logic, performs effects through the
 * Host, and marks view models dirty for the publisher.
 *
 * Module memory survives /clear (the module is not reloaded), so the run,
 * the settings and the autopilot carry straight into the fresh context.
 */

import type {
  AgentInfo,
  AgentOfferInput,
  AgentSpawnInput,
  AgentSpawnResult,
  CommandRunResult,
  PromptOrigin,
  RenderSurface,
  SessionCompactResult,
  SessionEndInput,
  SessionStartInput,
  SessionUsage,
  ToolCallResult,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'

import type { PermissionLogEntry, QueueTarget, TabId, WatchStrategy } from '../../types'
import { COMMAND, LIMITS, MIN_ENGINE, PANE_ID, PANE_TITLE, SHORT_COMMAND, STORE_ENTRIES } from '../constants'
import { type Effective, POLICY_SECTION_ID, effective, policySections, policyText } from '../core/policy'
import { applyProfile, findProfile, profileLabel } from '../core/profiles'
import { DEFAULTS_GENERATION, PERMISSION_LABEL, type Settings, classicSettings, clone, defaultSettings, normalizeSettings } from '../core/settings'
import { fingerprint } from '../core/hash'
import { clean } from '../core/text'
import { versionAtLeast } from '../core/version'
import { ActivityTracker } from '../features/activity'
import * as Autopilot from '../features/autopilot'
import * as Background from '../features/background'
import { type HandoffIntent, INTENT_WORDS, handoffIntentOf } from '../features/intent'
import * as Supervisor from '../features/supervisor'
import * as Chain from '../features/chain'
import * as Evidence from '../features/evidence'
import { type GitState, parseStatus } from '../features/git'
import * as Handoff from '../features/handoff'
import * as Ops from '../features/ops'
import * as Plan from '../features/plan'
import * as PlanUsage from '../features/planUsage'
import * as Quest from '../features/quest'
import { VALIDATION_LABEL, summarize } from '../features/validation'
import { groupOf } from '../features/digest'
import { answerStyleLabel } from '../core/answers'
import { type GuardAssessment, assessExit, isRepeat } from '../features/guard'
import * as Guard from '../features/guard'
import { APPROVE, DECLINE, approvalQuestion, callWords, declineMessage, decisionFor, denyMessage, editPathOf, findingsFor, isEditTool, isOwnQuestionNeeded, isShellTool } from '../features/permissions/decide'
import type { Decision } from '../features/permissions/categories'
import * as prompts from '../features/prompts'
import { type Pressure, gateHeavy, isOver } from '../features/resources/pressure'
import { heavyKinds, heavyLabel } from '../features/resources/heavy'
import { type Family, classifyTask, familyOf, routeMain, routeSubagent } from '../features/router'
import { decideSpawn, isOffered } from '../features/subagents'
import { aliveRows, limitCount } from '../features/agents'
import { doingOf } from '../features/digest'
import type { Host } from '../host'
import { ResourceMonitor } from './monitor'
import { Debounced, type Onboarding, findRunBySession, hasPriorUse, loadHistory, loadIndex, loadSettings, nextRunNumber, onboardingOf, saveRun } from './persist'
import { CARRIED_MARK, type CarriedMarker, carriedWrites, configDirFromEnv, configDirOf, isFormerHud, readFormerStore } from './formerStore'
import { CacheGuardian } from './cacheGuardian'
import { handleCommand } from './commands'
import { type FreshPurpose, Operations, isTurnOnlyCompact } from './operations'
import { headlineOf } from './headline'
import { PolicyLedger, policyRenderOf, recordLine } from './ledger'
import { type NoteKind, NoteBox } from './notes'
import { Publisher } from './publisher'
import * as CacheModel from '../features/cache'
import { endsWithQuestion } from './headline'
import type { HudHeadline } from '../../types'
import * as fmt from '../core/format'
import { cardKey } from '../ui/primitives'

type TurnKind = Autopilot.TurnKind

type TurnState = {
  id: string | null
  isRunning: boolean
  kind: TurnKind
  request: string
  toolCount: number
  editCount: number
}

export type UsageFigures = { tokens: number | undefined; window: number | undefined; pct: number | undefined; costUsd: number | undefined }

const OWN_PLUGIN = 'project-sentinel'

/** How long after the load an announcement waits, so the session's window is there to show it. */
const ANNOUNCE_DELAY_MS = 1500
/** The evidence of a run that keeps none yet. */
const EMPTY_EVIDENCE: Evidence.EvidenceStore = Evidence.emptyEvidence()

/** While a cost limit is set, the session's cost is read mid-turn at most this often (`$.session.usage()` costs nothing). */
const BUDGET_COST_EVERY_MS = 5_000
/** The notes count as written for a handoff when modified no earlier than this before it began (clocks, file systems). */
const NOTES_SLACK_MS = 5000
/** Operations opened at a card or field: the first try this long after, each later one this much later again. */
const OPS_DRAWN_MS = 300
const OPS_SCROLL_TRIES = 3
/** How often the Handoff Supervisor looks at a handoff under way (observation; it moves no step but a wait's end). */
const SUPERVISE_MS = 30_000
/** At most this many unrecognised background tasks go to the isolated classifier per look. */
const CLASSIFY_PER_LOOK = 2
/** While any agent is alive, Claude Code's agent list is looked at this often (a workflow's agents are never in it). */
const AGENT_POLL_MS = 2_000

/** The person's choices about a message typed while a handoff is under way, as Claude Code's question dialog offers them. */
export const HANDOFF_CHOICE = {
  carry: 'Hand off now, then give it to the fresh context',
  freshCarry: 'Start fresh now, then give it to the fresh context',
  queue: 'Give it to the fresh context',
  here: 'Send it here (this context)',
  box: 'Back to the prompt box',
  stop: 'Stop it and hand off',
  leave: 'Hand off, leave it running',
  wait: 'Keep waiting',
} as const

const isOwnPrompt = (origin: PromptOrigin | undefined): boolean => origin?.kind === 'plugin' && origin.name === OWN_PLUGIN

const isPersonOrigin = (origin: PromptOrigin | undefined): boolean =>
  origin === undefined || origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'

/** `$.session.compact`'s refusal where a session compacts only inside a turn (headless and SDK sessions: the /compact command does it). */

export class Runtime {
  host: Host | null = null
  settings: Settings = defaultSettings()
  isLoaded = false
  loading: Promise<void> | null = null

  root = ''
  cwd = ''
  sessionId: string | null = null
  engineVersion: string | null = null
  surfaces: RenderSurface[] = []
  permissionMode: string | undefined
  sessionModel = ''
  usage: UsageFigures = { tokens: undefined, window: undefined, pct: undefined, costUsd: undefined }
  autoCompactAt: number | undefined
  /** The plan's rate-limit windows as Claude Code last reported them (features/planUsage.ts): the status bar's 5H reading. */
  planUsage: PlanUsage.PlanUsage = PlanUsage.emptyPlanUsage()
  /** While a five-hour window counts down to its reset: one look a minute (usage is read, never pushed, between responses). */
  private usageTicker: { cancel: () => void } | null = null

  autopilot: Autopilot.Autopilot = Autopilot.initialAutopilot()
  run: Chain.Run | null = null
  history: Chain.Run[] = []
  activity = new ActivityTracker()
  monitor: ResourceMonitor

  turn: TurnState = { id: null, isRunning: false, kind: 'other', request: '', toolCount: 0, editCount: 0 }
  guard = { turnBlocks: 0, sessionBlocks: 0, lastBlockedAnswer: '', last: null as (GuardAssessment & { at: number }) | null }
  router = {
    turnModel: null as string | null,
    lastDecision: null as string | null,
    /** Model ids the engine reported answering this session, by family: the only ids a request is routed to. */
    known: new Map<Family, string>(),
    /** Families whose routed model the engine refused this session. */
    unavailable: new Set<string>(),
    /** True when the router sent the last turn to another model than the session's. */
    wasRouted: false,
  }
  agents = {
    list: [] as AgentInfo[],
    spawned: 0,
    denied: 0,
    asked: 0,
    allowAll: false,
    poll: null as { cancel: () => void } | null,
    /** Spawns allowed whose start is not settled yet: they hold a slot, so spawns made at once never all pass a limit. */
    reserved: 0,
  }
  permissionLog: PermissionLogEntry[] = []
  permissionCounts = { denied: 0, asked: 0 }
  resourceStats = { refused: 0, noticesSent: 0, lastNoticeLevel: 'ok' as string }
  frontier = { lastEffort: null as string | null, isEffortSupported: null as boolean | null }
  compose = { isReached: false, deliveredFallback: false, isLikelyBypassed: false }
  /** Notes for Claude, waiting for the next batch of tool results or the next prompt (app/notes.ts). */
  readonly notesBox = new NoteBox()
  /** Request by request: how the policies and the effort reached Claude in this context (app/ledger.ts). */
  readonly ledger = new PolicyLedger()
  /** What Claude was last told about the machine's load: nothing (ok), or that it is high or critical. */
  pressureTold: 'ok' | 'high' | 'critical' = 'ok'
  private pressureToldAt = 0
  /** Whether the latest request carried Frontier Max (the panel redraws when that changes). */
  private lastFrontierDelivered: boolean | null = null

  ui = {
    tab: 'overview' as TabId,
    activitySub: 'summary' as 'summary' | 'ops' | 'agents' | 'raw',
    showGenerated: false,
    selectedPath: null as string | null,
    expanded: new Set<string>(),
    isPaneOpen: false,
    openPicker: null as string | null,
    showAllChanges: false,
    /** Activity → Operations: the forms' choices and drafts, and what is open. */
    ops: {
      queueTarget: 'boundary' as QueueTarget,
      editing: null as string | null,
      watchLabel: '',
      watchStrategy: 'smart' as WatchStrategy,
      choices: null as { at: number; label: string }[] | null,
      error: null as string | null,
      expanded: [] as string[],
      budgetOpen: false,
      rescheduling: null as string | null,
      messaging: null as string | null,
    },
  }
  notes: string[] = []
  /** Categories whose saved Allow read as Default at this load (Guardrails says so for the session). */
  allowRemoved: string[] = []
  savedAt: number | null = null

  /** Quest log: lifetime XP and achievements (kept while the Quest log style is chosen). */
  quest: Quest.QuestState = Quest.emptyQuest()
  /** Checks of each kind that already paid XP this turn, so re-running a passing check earns nothing. */
  private questGreen = new Set<string>()
  /** The person's own Claude Code output style, as the last system prompt reported it; it outranks the answer style. */
  nativeOutputStyle: string | null = null

  /** Milestones finished when the turn began, so the turn's summary can count its own. */
  turnStartDone = 0

  /** The handoff turn, for Handoff Health: the first activity turn it counts from, and whether the milestones were sent again in it. */
  private handoffTurn = { fromTurn: -1, isPlanUpdated: false }
  /** Files the main conversation read in this context: the continuity check after a handoff looks for the notes and the docs. */
  private reads: string[] = []

  /** The prompt cache: telemetry, the miss doctor, Keep warm and stable policies. */
  readonly cache: CacheGuardian
  /** The orchestration layer: the Mission Queue, the Decision Inbox, Watchers, the Run Budget, the Cold Resume Guard, agents. */
  readonly ops: Operations
  /** The project's Git state, for the terminal (Desktop shows Git itself); null outside a repository or before the first look. */
  git: GitState | null = null
  /** The repository root, once looked up (null: not a repository). */
  private gitRoot: string | null | undefined = undefined
  private gitCheckedAt = 0
  private isGitRefreshing = false

  /**
   * What the last main turn left behind as it stopped (its Stop event): background jobs still
   * running, wake-ups scheduled, and whether its last words asked the person something. Between
   * turns this tells "waiting for a result" from "waiting for you"; a new turn clears it.
   */
  lastStop: {
    /** Each task with its class (features/background.ts): a server never counts as work that will bring the turn back. */
    background: Autopilot.BackgroundTask[]
    wakeups: { schedule: string; recurring: boolean }[]
    isQuestion: boolean
    at: number
  } | null = null

  /** What the isolated classifier said a background task is, by its id: it outranks the rules for that task. */
  private taskVerdicts = new Map<string, Background.TaskVerdict>()
  /** Tasks the isolated classifier was asked about, once each. */
  private classifyAsked = new Set<string>()

  /** The Handoff Supervisor's latest look at a handoff under way (features/supervisor.ts); null while none is. */
  supervisor: Supervisor.Diagnosis | null = null
  private supervisorTimer: { cancel: () => void } | null = null
  /** The last diagnosis traced, so the debug log has a line only when it changes. */
  private supervisorKey = ''
  /** When the main conversation last showed any activity (a prompt, a turn's start or end, a step, a call). */
  private quietSince: number | null = null

  /** The background work in flight Claude Code last listed, with each task's class; null before any Stop. */
  inFlight(): Autopilot.BackgroundTask[] | null {
    return this.lastStop === null ? null : this.lastStop.background
  }

  /** The work in flight that will bring a turn back (a test run, a render, an agent): never a server or a watcher. */
  blockingInFlight(): Autopilot.BackgroundTask[] {
    return Autopilot.blockingOf(this.lastStop?.background ?? [])
  }

  /** One task as Claude Code lists it, with its class: what the classifier said of it, else the rules. */
  private taskOf(b: { id: string; type: string; description: string; command?: string; agent_type?: string; name?: string }): Autopilot.BackgroundTask {
    const v = this.taskVerdicts.get(b.id) ?? Background.classifyTask({ id: b.id, type: b.type, description: b.description, ...(b.command === undefined ? {} : { command: b.command }), ...(b.agent_type === undefined ? {} : { agentType: b.agent_type }), ...(b.name === undefined ? {} : { name: b.name }) })
    return { id: b.id, description: clean(b.description || b.command || `a ${b.type} task`, 80), class: v.class, why: v.why, by: v.by, ...(b.command === undefined ? {} : { command: clean(b.command, 200) }) }
  }

  /** When this context began (system clock): the companion wakes up with it. */
  contextStartedAt: number | null = null
  /** Why the companion's surface module failed to draw, if it did: it is left out until the plugin reloads. */
  companionFault: string | null = null
  /** While the companion is on, its mood moves on with time (sleepy, asleep): one republish a minute. */
  private companionTicker: { cancel: () => void } | null = null
  /** What the last settings change was, in words, for a policy-caused cache miss. */
  private policyReason: string | null = null

  /** The clear a handoff owes, held back while a turn runs (a prompt the person queued): the turn's end carries it out. */
  private isClearOwed = false
  /**
   * What the next turn to start begins with, as `prompt.submit` named it: a background task's
   * notification (origin `task-notification`, no running turn), so that turn is known for what it is
   * whatever its text; null for any other prompt. `turn.start` follows the submit that starts it.
   */
  private nextTurn: 'notification' | null = null
  private startSource: { source: string; sessionId: string } | null = null
  /** True from Control Room's own /clear until the fresh session it makes is seen (or the wait ends). */
  private isOwnClear = false
  /** Resolves when classic.SessionStart{clear} reports the fresh session of Control Room's own /clear. */
  private onOwnClearSeen: (() => void) | null = null
  private commandsRegistered = new Set<string>()

  readonly publisher: Publisher
  private readonly saveSettings: Debounced<Settings>
  private readonly saveRunLater: Debounced<Chain.Run>
  private readonly saveQuest: Debounced<Quest.QuestState>

  constructor() {
    this.publisher = new Publisher(() => this.host, this)
    this.saveSettings = new Debounced<Settings>(() => this.host, (host, value) => host.storeSet(STORE_ENTRIES.settings, value), LIMITS.persistDebounceMs)
    this.saveRunLater = new Debounced<Chain.Run>(() => this.host, (host, run) => saveRun(host, run), LIMITS.persistDebounceMs)
    this.saveQuest = new Debounced<Quest.QuestState>(() => this.host, (host, value) => host.storeSet(STORE_ENTRIES.quest, value), LIMITS.persistDebounceMs)
    this.monitor = new ResourceMonitor(
      (pressure, previous) => this.onPressure(pressure, previous),
      () => this.publisher.mark('resources', 'hud', 'pane'),
    )
    this.cache = new CacheGuardian({
      host: () => this.host,
      now: () => this.clock(),
      settings: () => this.settings,
      isTurnRunning: () => this.turn.isRunning,
      contextTokens: () => this.usage.tokens ?? 0,
      standDown: () => this.keepWarmStandDown(),
      changed: () => this.onCacheChanged(),
      missed: miss => this.onCacheMiss(miss),
      verdict: (verdict, reason) => this.onKeepWarmVerdict(verdict, reason),
      hold: () => this.ops.hold(),
    })
    this.ops = new Operations(this)
  }

  // -------------------------------------------------------------------------
  // The prompt cache

  /** Milliseconds since the epoch: the system clock, or a test's manual one. Every cache figure is timed by it. */
  clock(): number {
    return this.host?.time?.() ?? Date.now()
  }

  /**
   * Keep warm stands down only once the old context is about to be thrown away: the notes checked
   * before a clear, the clear itself, the fresh context resuming. Every earlier step still reads the
   * old context again: the turn that crosses the threshold, the handoff turn, each background
   * notification's turn while a written handoff waits, the person's own message while it waits for
   * them. A stuck or long handoff must never be what lets a large warm cache lapse (seen in a real
   * run: a handoff held by a preview server stood Keep warm down for two hours and a 775k cache went
   * cold). A handoff that compacts keeps the cache throughout (compaction re-reads it).
   */
  keepWarmStandDown(): string | null {
    const a = this.settings.autopilot
    if (!a.enabled) return null
    const state = this.autopilot.state
    if (state === 'clearing' || state === 'resuming') return 'A handoff is starting a fresh context, so this cache is about to be discarded'
    if (state === 'verifying' && a.continuation === 'clear') return 'The handoff notes are being checked before the clear, so this cache is about to be discarded'
    return null
  }

  /** The last request the cache memo holds (`$.state`), so a write goes only when it moved. */
  private memoAt: number | null = null

  /** The cache changed: redraw, and keep its last request where a reload of the plugin finds it. */
  private onCacheChanged(): void {
    this.publisher.mark('hud', 'pane', 'ops')
    const at = this.cache.state.lastRequestAt
    const host = this.host
    if (host === null || at === this.memoAt) return
    this.memoAt = at
    void host.saveCacheMemo(this.cache.memoOf(this.sessionId)).catch(() => {
      this.memoAt = null
    })
  }

  private onCacheMiss(miss: CacheModel.CacheMiss): void {
    this.publisher.mark('hud', 'pane')
    const host = this.host
    if (host === null || !this.settings.ui.toasts || miss.kind === 'lifecycle' || miss.severity !== 'warn') return
    host.toast(`Cache rebuilt: ${fmt.tokens(miss.recached)} tokens · ${CacheModel.CAUSE_LABEL[miss.cause]}`, 6000)
  }

  private onKeepWarmVerdict(verdict: 'yes' | 'no', reason: string | null): void {
    const host = this.host
    this.trace(`keep warm: verdict ${verdict === 'yes' ? 'VERIFIED' : 'FAILED, paused'}${reason === null ? '' : ` (${reason})`}`)
    if (verdict === 'no') this.note(`Keep warm paused itself: ${reason ?? 'it did not keep the prompt cache warm here'}. Turn it on again to retry; Context → Cache has each refresh.`)
    if (host !== null && this.settings.ui.toasts) {
      const paused = reason !== null && reason.startsWith('Rebuilt') ? 'the conversation rebuilt its cache though a refresh had kept it warm (cause unknown)' : 'refreshes found the cache gone before its expiry'
      host.toast(verdict === 'yes' ? 'Keep warm verified: the conversation read its cache past the old expiry' : `Keep warm paused: ${paused}`, 7000)
    }
  }

  /**
   * Before a model switch the person makes: with a large warm cache, Claude
   * Code is asked to confirm, with what the switch re-sends uncached.
   */
  onPreModelSwitch(e: { from_model: string; to_model: string; source: string; context_tokens: number; prompt_cache_warm: boolean; cache_ttl: '5m' | '1h'; estimated_cache_write_usd: number; pricing?: string }): string | null {
    if (e.cache_ttl === '5m' || e.cache_ttl === '1h') this.cache.noteTtl(e.cache_ttl)
    // Claude Code's own price for re-caching on the model switched to: the Cold Resume Guard's figure.
    this.cache.noteWriteRate({ model: e.to_model, ttl: e.cache_ttl === '5m' || e.cache_ttl === '1h' ? e.cache_ttl : null, usd: e.estimated_cache_write_usd, tokens: e.context_tokens, pricing: e.pricing })
    const s = this.settings.cache
    if (!s.guardModelSwitch || !e.prompt_cache_warm || e.from_model === e.to_model || e.context_tokens < LIMITS.guardSwitchTokens) return null
    if (e.source !== 'command' && e.source !== 'picker') return null
    // Claude Code shows the reason on one line, cut at the terminal's width: the figure first, the model in its own button.
    const cost = Number.isFinite(e.estimated_cache_write_usd) && e.estimated_cache_write_usd > 0 ? ` (about ${fmt.cost(e.estimated_cache_write_usd)})` : ''
    return `Control Room: this re-sends ${fmt.tokens(e.context_tokens)} cached tokens uncached${cost}. A fresh context avoids it.`
  }

  onPostModelSwitch(e: { from_model: string; to_model: string; cache_ttl: '5m' | '1h'; source: string; context_tokens?: number; estimated_cache_write_usd?: number; pricing?: string }): void {
    const by = e.source === 'auto' || e.source === 'resume' ? 'engine' : 'person'
    if (e.estimated_cache_write_usd !== undefined && e.context_tokens !== undefined) {
      this.cache.noteWriteRate({ model: e.to_model, ttl: e.cache_ttl === '5m' || e.cache_ttl === '1h' ? e.cache_ttl : null, usd: e.estimated_cache_write_usd, tokens: e.context_tokens, pricing: e.pricing })
    }
    if (e.cache_ttl === '5m' || e.cache_ttl === '1h') this.cache.noteModelSwitch({ from: e.from_model, to: e.to_model, ttl: e.cache_ttl, now: this.clock(), by })
    if (e.to_model !== '') this.sessionModel = e.to_model
  }

  // -------------------------------------------------------------------------
  // Binding and loading

  bind(host: Host): void {
    if (this.host === null) this.host = host
  }

  /** Loads settings once (any hook may be the first to need them). */
  async ensureLoaded(): Promise<void> {
    if (this.isLoaded) return
    if (this.loading === null) {
      this.loading = (async () => {
        const host = this.host
        if (host === null) return
        await this.carryAtLoad()
        const loaded = await loadSettings(host)
        this.settings = loaded.settings
        await this.settleDefaults(loaded.isFresh)
        this.quest = Quest.questOf(await host.storeGet(STORE_ENTRIES.quest).catch(() => undefined))
        if (loaded.wasRepaired) this.note('Some saved Control Room settings were invalid and were reset to safe defaults.')
        if (loaded.allowRemoved.length > 0) {
          const names = loaded.allowRemoved.join(', ')
          this.allowRemoved = loaded.allowRemoved
          this.announce(`Allow was removed: ${names} now use${loaded.allowRemoved.length === 1 ? 's' : ''} Default, so Claude Code's own rules decide.`)
          // Saved at once, so the note shows in one session rather than every one.
          this.saveSettings.schedule(this.settings)
        }
        this.isLoaded = true
      })().finally(() => {
        this.loading = null
      })
    }
    await this.loading
  }

  /** A fresh install's first-run card: shown until the person dismisses it; null for an existing install. */
  onboarding: Onboarding | null = null

  /**
   * Fresh-install defaults (1.7.0) without touching an existing install. No saved settings and no sign of
   * earlier use: the new defaults (Normal) are saved and the first-run card shows. No saved settings but
   * earlier use (it never changed a setting): Classic is saved, so nothing changes for it. Saved settings
   * from before 1.7.0: a Normal is relabelled Classic (the values are untouched, so it does not read
   * "edited" against the new Normal).
   */
  private async settleDefaults(isFresh: boolean): Promise<void> {
    const host = this.host
    if (host === null) return
    if (isFresh) {
      const isUsed = await hasPriorUse(host)
      this.settings = isUsed ? classicSettings() : defaultSettings()
      await host.storeSet(STORE_ENTRIES.settings, this.settings).catch(() => undefined)
      // Written by this load, not by the person: the former store's carry at the session's start may replace them.
      this.isFreshDefaults = !isUsed
      if (!isUsed) {
        this.onboarding = { at: Date.now(), dismissedAt: null }
        await host.storeSet(STORE_ENTRIES.onboarding, this.onboarding).catch(() => undefined)
        // Once, for whoever never opens the panel: what is on, and where it lives.
        this.announce('Project Sentinel is on: Autopilot protects the context at 70%, Frontier Max at Extra High. /cr opens Control Room.')
      }
      this.trace(`settings: ${isUsed ? 'none saved, earlier use found: Classic kept' : 'a fresh install: the 1.7 defaults (Autopilot at 70%, Frontier Max at Extra High)'}`)
      return
    }
    this.onboarding = onboardingOf(await host.storeGet(STORE_ENTRIES.onboarding).catch(() => undefined))
    if (this.settings.defaults >= DEFAULTS_GENERATION) return
    const wasNormal = this.settings.profile === 'normal'
    this.settings = { ...this.settings, defaults: DEFAULTS_GENERATION, profile: wasNormal ? 'classic' : this.settings.profile }
    await host.storeSet(STORE_ENTRIES.settings, this.settings).catch(() => undefined)
    this.trace(`settings: saved before 1.7${wasNormal ? ': Normal is now called Classic (values unchanged)' : ''}`)
  }

  /** The settings in the store are this load's fresh-install defaults, not yet the person's (see carryFormerStore). */
  private isFreshDefaults = false

  /** The person dismissed the first-run card ("Got it"). */
  dismissOnboarding(): void {
    const host = this.host
    if (this.onboarding === null || this.onboarding.dismissedAt !== null) return
    this.onboarding = { ...this.onboarding, dismissedAt: Date.now() }
    void host?.storeSet(STORE_ENTRIES.onboarding, this.onboarding).catch(() => undefined)
    this.publisher.mark('pane')
  }

  /** Something that needs a look (settings repaired, an old Claude Code): a line at the top of the panel. */
  note(text: string): void {
    if (!this.notes.includes(text)) this.notes = [...this.notes, text].slice(-6)
    this.publisher.mark('pane')
  }

  private announced = new Set<string>()

  /**
   * Something worth saying once that is not a problem (the rename, a removed setting): a toast a
   * moment after the load, never a warning pinned at the top of the panel.
   */
  announce(text: string): void {
    const host = this.host
    if (host === null || this.announced.has(text)) return
    this.announced.add(text)
    host.after(ANNOUNCE_DELAY_MS, () => {
      if (this.settings.ui.toasts) host.toast(text, 8000)
    })
  }

  effective(): Effective {
    return effective(this.settings, {
      autopilot: this.autopilot.state,
      autopilotThreshold: Autopilot.handoffPoint(this.autopilot),
      pressure: this.monitor.pressure.level,
      permissionMode: this.permissionMode,
    })
  }

  // -------------------------------------------------------------------------
  // Session lifecycle

  async onSessionStart(e: SessionStartInput): Promise<void> {
    const host = this.host
    if (host === null) return
    await this.ensureLoaded()
    this.cwd = e.cwd
    const [root, id, version, surfaces, model, panes] = await Promise.all([
      host.sessionRoot().catch(() => e.cwd),
      host.sessionId().catch(() => null),
      host.version().catch(() => null),
      host.surfaces().catch(() => [] as readonly RenderSurface[]),
      host.sessionModel().catch(() => ''),
      host.panes().catch(() => []),
    ])
    this.root = root
    this.sessionId = id
    this.contextStartedAt = Date.now()
    // The supervisor's quiet counts from the load: a turn that began before it shows itself by its calls.
    this.noteActivity()
    this.engineVersion = version?.version ?? null
    this.surfaces = [...surfaces]
    this.sessionModel = model
    // A hot reload starts a fresh Runtime under a panel that is still open.
    this.ui.isPaneOpen = panes.some(p => p.id === PANE_ID)
    if (this.engineVersion !== null && !versionAtLeast(this.engineVersion, MIN_ENGINE)) {
      this.note(`Claude Code ${this.engineVersion} is older than ${MIN_ENGINE}, the version Control Room was verified on; some features may not work.`)
    }

    await this.registerCommands()
    await this.offerMilestones()
    await this.offerDecisions()
    // Managed settings seat Anthropic's sec-default guard, which continues prompt.compose past
    // user-installed mods; policies then ride the prompt as context instead.
    const policy = await host.settings('policy').catch(() => ({}))
    this.compose.isLikelyBypassed = Object.keys(policy).length > 0
    await this.attachRun()
    await this.cache.load()
    await this.restorePolicyMemo()
    const memo = await host.loadCacheMemo().catch(() => null)
    if (memo !== null) this.cache.restoreMemo(memo, this.sessionId)
    await this.refreshUsage(true)
    this.reconfigure({ isStartup: true })
    await this.recoverAutopilot()
    await this.ops.onLoad()
    // Agents a runtime before this one saw start (a reload) are read from Claude Code again.
    void this.refreshAgents()
    void this.refreshHistory()
    void this.refreshGit()
    // A resumed or reloaded run: its verified milestones against the workspace as it is now (Ready to resume).
    void this.checkEvidence('session start')
    this.publisher.markAll()

    if (this.settings.ui.openOnStart) void host.open({ id: PANE_ID, title: PANE_TITLE }).catch(() => undefined)
  }

  /**
   * After a reload of the plugin in the same context: the section the system prompt already carries
   * is what the runtime before this one sent, so a held section stays held (and the cache stays warm).
   */
  private async restorePolicyMemo(): Promise<void> {
    const host = this.host
    if (host === null || this.sessionId === null) return
    const memo = await host.loadPolicyMemo().catch(() => null)
    if (memo === null || memo.sessionId !== this.sessionId) return
    this.cache.restoreDelivered(memo.text)
    this.memoText = memo.text
    // The turn under way (if any) keeps sending that system prompt: its requests carry the section.
    this.ledger.carried(policyRenderOf(memo.text === '' ? null : memo.text, { at: this.clock(), isHeld: false, isLoaded: true }))
    this.trace(`policy: the system prompt carries section ${memo.text === '' ? 'none' : fingerprint(memo.text)} from before the reload`)
  }

  /** The milestones tool's full name once offered to Claude; null while it is not. */
  milestonesTool: string | null = null
  /** Where run progress comes from in this session. */
  planSource: 'tasks' | 'milestones' | 'none' = 'none'

  /**
   * Run progress counts Claude's task list. Claude Code builds that offer
   * none (its task tools are off by default in 2.1.29x) get Control Room's
   * milestones tool instead, with a short policy, unless the person turned
   * it off. Where a task list exists it is used, and nothing is added.
   */
  async offerMilestones(): Promise<void> {
    const host = this.host
    if (host === null) return
    const tools = await host.listTools().catch(() => [] as readonly { name: string }[])
    if (tools.some(t => Plan.isPlanTool(t.name))) {
      this.planSource = 'tasks'
      this.publisher.mark('pane')
      return
    }
    if (!this.settings.progress.milestones) {
      this.planSource = this.milestonesTool === null ? 'none' : 'milestones'
      this.publisher.mark('pane')
      return
    }
    if (this.milestonesTool === null) {
      this.milestonesTool = await host
        .registerTool({ name: prompts.MILESTONES_TOOL.name, description: prompts.MILESTONES_TOOL.description, inputSchema: prompts.MILESTONES_TOOL.inputSchema as unknown as Record<string, unknown> })
        .catch(() => null)
    }
    this.planSource = this.milestonesTool === null ? 'none' : 'milestones'
    this.publisher.mark('pane')
  }

  /** The decision tool's full name once offered to Claude; null while it is not. */
  decisionsTool: string | null = null

  /**
   * The Decision Inbox: Claude is offered `decision_request` (Behavior → Decisions, on by default),
   * so a non-urgent choice that is the person's waits in Needs review. Offered once per session; turned
   * off mid-session, the tool stays until the session ends and answers that the inbox is off.
   */
  async offerDecisions(): Promise<void> {
    const host = this.host
    if (host === null || !this.settings.ops.decisions || this.decisionsTool !== null) return
    this.decisionsTool = await host
      .registerTool({ name: prompts.DECISION_TOOL.name, description: prompts.DECISION_TOOL.description, inputSchema: prompts.DECISION_TOOL.inputSchema as unknown as Record<string, unknown> })
      .catch(() => null)
    this.publisher.mark('pane', 'ops')
  }

  /** The milestones tool's answer: the run plan updated from the whole list. A subagent's list is its own. */
  recordMilestones(input: Record<string, unknown>, agentId: string | undefined): string {
    if (!this.settings.progress.milestones) return 'Milestone tracking is off in Control Room; there is no need to call this tool.'
    // A subagent's milestones are its own plan (Activity → Agents), never the run's.
    if (agentId !== undefined) return this.ops.noteAgentPlan(agentId, { milestones: input, now: this.clock() }) ? 'Recorded as your own plan.' : 'Recorded.'
    if (this.run === null) return 'Recorded.'
    const session = Chain.currentSession(this.run)?.index ?? 1
    // Claude's own statement of the objective, when it gives one, says it better than the request's first sentence.
    const objective = typeof input.objective === 'string' ? clean(input.objective, 140) : ''
    // Another objective of Claude's with none of the plan's milestones is new work: it counts from nothing.
    const isOtherObjective = objective.length >= 8 && this.run.objectiveBy === 'claude' && this.run.objective !== null && objective !== this.run.objective
    const base = Plan.isNewWork(this.plan(), input, isOtherObjective) ? Plan.emptyPlan() : this.plan()
    if (objective.length >= 8 && (objective !== this.run.objective || this.run.objectiveBy !== 'claude')) {
      this.run = { ...this.run, objective, objectiveBy: 'claude' }
      this.persistRun()
      this.publisher.mark('activity', 'hud')
    }
    // Outputs Claude names (generated files, renders) join a milestone's evidence before it may complete in this same list.
    if (Array.isArray(input.milestones)) {
      let store = this.evidence()
      for (const m of input.milestones) {
        if (typeof m !== 'object' || m === null) continue
        const item = m as Record<string, unknown>
        if (!Array.isArray(item.outputs) || typeof item.title !== 'string') continue
        const outputs = item.outputs.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map(o => this.absPath(o.trim()))
        store = Evidence.noteOutputs(store, Plan.keyOf(clean(item.title, 120)), outputs, Date.now())
      }
      this.setEvidence(store)
    }
    this.setPlan(Plan.fromMilestones(base, input, session, Date.now()))
    this.noteWorkStarted()
    const p = this.progress()
    return `Recorded: ${p.done} of ${p.total} milestones done${p.current === null ? '' : `, now: ${p.current.subject}`}.`
  }

  /** A new run plan from Claude's task list: kept with the run, and in the Quest log, newly finished milestones pay. */
  private setPlan(plan: Plan.Plan): void {
    if (this.run === null || plan === this.plan()) return
    const previous = this.plan()
    const before = Plan.progressOf(previous)
    const wasDone = new Set(previous.tasks.filter(t => t.status === 'completed').map(t => t.key))
    this.run = { ...this.run, plan }
    this.planEvidence(previous, plan)
    // A milestone done mid-turn is a boundary for work queued after it.
    this.ops.onPlanChanged(previous, plan)
    const after = this.progress()
    // Part of the handoff: its own turn, a retry, or a turn while it waits for background work (the result recorded).
    if (this.turn.isRunning && (this.turn.kind === 'handoff' || this.turn.kind === 'retry' || this.autopilot.state === 'waiting-background')) this.handoffTurn.isPlanUpdated = true
    for (const t of plan.tasks) {
      if (t.status === 'completed' && !wasDone.has(t.key)) this.questEvent('milestone', `Milestone: ${t.subject}`, t.key)
    }
    if (after.total >= 3 && after.done === after.total && before.done < before.total) {
      this.questEvent('fullClear', `Full clear: ${after.done} of ${after.total} milestones`)
    }
    this.persistRun()
    this.publisher.mark('activity', 'hud', 'pane')
  }

  /**
   * Milestone evidence follows the plan: a milestone under way starts its work's window, one no longer
   * completed (reopened) loses its snapshot, one newly completed gets one.
   */
  private planEvidence(previous: Plan.Plan, plan: Plan.Plan): void {
    const now = Date.now()
    let store = this.evidence()
    for (const t of plan.tasks) if (Plan.isActive(t.status)) store = Evidence.noteActive(store, t.key, now)
    const done = new Set(plan.tasks.filter(t => t.status === 'completed').map(t => t.key))
    const reopened = previous.tasks.filter(t => t.status === 'completed' && !done.has(t.key) && plan.tasks.some(n => n.key === t.key)).map(t => t.key)
    store = Evidence.dropSnapshots(store, reopened, now)
    this.setEvidence(store)
    const wasDone = new Set(previous.tasks.filter(t => t.status === 'completed').map(t => t.key))
    for (const t of plan.tasks) if (t.status === 'completed' && !wasDone.has(t.key)) void this.snapshotMilestone(t)
  }

  /**
   * Quest log: one verified outcome. Only while the person chose the Quest log
   * style; a milestone pays once per run (by `paidKey`).
   */
  private questEvent(kind: Quest.QuestEventKind, text: string, paidKey?: string): void {
    if (this.settings.answers.style !== 'quest' || this.run === null) return
    const share = Quest.runQuestOf(this.run.quest)
    if (paidKey !== undefined && share.paid.includes(paidKey)) return
    const result = Quest.award(this.quest, { kind, text }, Date.now())
    this.quest = result.state
    this.run = { ...this.run, quest: { xp: share.xp + result.xp, paid: paidKey === undefined ? share.paid : [...share.paid, paidKey].slice(-200) } }
    const shape = Quest.unlockForRun(this.quest, { sessions: this.run.sessions.length, milestonesDone: Quest.runQuestOf(this.run.quest).paid.length }, Date.now())
    this.quest = shape.state
    this.saveQuest.schedule(this.quest)
    this.persistRun()
    this.publisher.mark('hud', 'activity')
    if (!this.settings.ui.toasts) return
    for (const id of [...result.unlocked, ...shape.unlocked]) this.host?.toast(`Achievement: ${Quest.achievementName(id)}`, 5000)
    if (result.levelUp !== null) this.host?.toast(`Level ${result.levelUp}`, 4000)
  }

  /** Quest log: achievements a run earns by its shape (a third context), checked when it rolls over. */
  private questForRunShape(now: number): void {
    if (this.settings.answers.style !== 'quest' || this.run === null) return
    const shape = Quest.unlockForRun(this.quest, { sessions: this.run.sessions.length, milestonesDone: Quest.runQuestOf(this.run.quest).paid.length }, now)
    if (shape.unlocked.length === 0) return
    this.quest = shape.state
    this.saveQuest.schedule(this.quest)
    this.publisher.mark('hud', 'activity')
    if (this.settings.ui.toasts) for (const id of shape.unlocked) this.host?.toast(`Achievement: ${Quest.achievementName(id)}`, 5000)
  }

  /** The policy sections in force, with what this session offers. */
  policies(): ReturnType<typeof policySections> {
    return policySections(this.settings, this.autopilot.threshold, { milestonesTool: this.milestonesTool, nativeOutputStyle: this.nativeOutputStyle })
  }

  private async registerCommands(): Promise<void> {
    const host = this.host
    if (host === null) return
    const existing = new Set((await host.listCommands().catch(() => [])).map(c => c.name))
    try {
      await host.registerCommand({
        name: COMMAND,
        description: 'Open Control Room: context, behavior, guardrails, activity and setup',
        argumentHint: '[status|queue <text>|watch in 2h <what>|watchers|decisions|decide <id>|budget|resume|evidence|profile <name>|autopilot on|off|<70%|700k>|handoff [now|wait|stop|cancel]|fresh [now]|cache|agents [mode]|help]',
      })
      this.commandsRegistered.add(COMMAND)
    } catch (error) {
      this.note(`Could not register /${COMMAND}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!existing.has(SHORT_COMMAND) || this.commandsRegistered.has(SHORT_COMMAND)) {
      try {
        await host.registerCommand({ name: SHORT_COMMAND, description: 'Control Room (short for /control-room)', argumentHint: '[sub-command]' })
        this.commandsRegistered.add(SHORT_COMMAND)
      } catch {
        // The alias is a convenience only.
      }
    }
  }

  isOwnCommand(command: string): boolean {
    return command === COMMAND || (command === SHORT_COMMAND && this.commandsRegistered.has(SHORT_COMMAND))
  }

  /** Continues the run this session belongs to (reload, resume) or starts one. */
  private async attachRun(): Promise<void> {
    const host = this.host
    if (host === null || this.sessionId === null) return
    if (this.run !== null && this.run.sessions.some(s => s.id === this.sessionId)) return
    const now = await host.now()
    const existing = await findRunBySession(host, this.sessionId)
    if (existing !== null) {
      this.run = { ...existing, status: 'active', plan: Plan.planOf(existing.plan), lastHandoff: Handoff.handoffRecordOf(existing.lastHandoff), ops: Ops.opsOf(existing.ops), ...(existing.evidence === undefined ? {} : { evidence: Evidence.evidenceOf(existing.evidence) }) }
      // Milestones done before this runtime attached are no turn's doing.
      this.turnStartDone = this.progress().done
      return
    }
    const resumedFrom = this.startSource?.source === 'resume' ? this.startSource.sessionId : null
    const previous = resumedFrom === null ? null : await findRunBySession(host, resumedFrom)
    if (previous !== null) {
      this.run = Chain.rollOver({ ...previous, plan: Plan.planOf(previous.plan), ops: Ops.opsOf(previous.ops), ...(previous.evidence === undefined ? {} : { evidence: Evidence.evidenceOf(previous.evidence) }) }, { end: 'resume', endNote: 'resumed', nextId: this.sessionId, nextStart: 'resume', now })
    } else {
      this.run = Chain.newRun({
        id: Chain.runIdOf(now, Math.random()),
        number: await nextRunNumber(host),
        sessionId: this.sessionId,
        root: this.root,
        profile: this.settings.profile,
        start: this.startSource?.source === 'resume' ? 'resume' : 'startup',
        now,
      })
    }
    this.turnStartDone = this.progress().done
    this.persistRun()
  }

  /**
   * The branch and the uncommitted files, read with one `git status` at the
   * start and after each turn (at most every 15 s), only where a terminal
   * draws: Desktop shows Git natively beside the session.
   */
  async refreshGit(): Promise<void> {
    const host = this.host
    if (host === null || !this.surfaces.includes('terminal') || this.isGitRefreshing) return
    const now = Date.now()
    if (now - this.gitCheckedAt < 15_000) return
    this.isGitRefreshing = true
    this.gitCheckedAt = now
    try {
      if (this.gitRoot === undefined) this.gitRoot = await host.repoRoot().catch(() => null)
      if (this.gitRoot === null) return
      const result = await host.gitStatus()
      const next = result.exitCode === 0 ? parseStatus(result.stdout) : null
      if (JSON.stringify(next) !== JSON.stringify(this.git)) {
        this.git = next
        this.publisher.mark('hud')
      }
    } catch {
      // Git missing or slow: the line is left out.
    } finally {
      this.isGitRefreshing = false
    }
  }

  async refreshHistory(): Promise<void> {
    const host = this.host
    if (host === null) return
    this.history = await loadHistory(host, this.run?.id ?? null).catch(() => [])
    this.ops.findForeign()
    this.publisher.mark('chain')
  }

  /** Writes a run other than this session's (an ended run whose operations were brought here). */
  async saveOtherRun(run: Chain.Run): Promise<void> {
    const host = this.host
    if (host !== null && run.id !== this.run?.id) await saveRun(host, run).catch(() => undefined)
  }

  persistRun(isNow = false): void {
    const run = this.run
    if (run === null) return
    if (isNow) {
      // A write of the run now supersedes a later one waiting with an older copy of it (which would
      // otherwise put that copy back: a watcher armed just after a turn, lost at the next restart).
      this.saveRunLater.drop(pending => pending.id === run.id)
      const host = this.host
      if (host !== null) void saveRun(host, run).catch(() => undefined)
      return
    }
    this.saveRunLater.schedule(run)
  }

  // -------------------------------------------------------------------------
  // Milestone evidence (features/evidence.ts)

  /** The run's milestone evidence: what each milestone's work changed, and what each completed one stood on. */
  evidence(): Evidence.EvidenceStore {
    return this.run?.evidence ?? EMPTY_EVIDENCE
  }

  private setEvidence(next: Evidence.EvidenceStore): void {
    if (this.run === null || next === this.evidence()) return
    this.run = { ...this.run, evidence: next }
    this.persistRun()
    this.publisher.mark('activity', 'pane')
  }

  /** A path as the project names it: absolute paths as they are, others under the project's root. */
  private absPath(path: string): string {
    if (/^([a-z]:[\\/]|[\\/])/i.test(path) || this.root === '') return path
    const sep = this.root.includes('\\') && !this.root.includes('/') ? '\\' : '/'
    return `${this.root.replace(/[\\/]+$/, '')}${sep}${path.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep)}`
  }

  /** Files Claude's tools changed: the milestone under way owns them, and a verified milestone's file changed is noted on it. */
  private noteEvidenceEdits(paths: readonly string[], now: number): void {
    if (this.run === null) return
    const ctx = { root: this.root, handoffFile: this.settings.autopilot.handoffFile }
    // Generated and temporary files (outside the project, temp and build folders, .claude, the handoff notes) are no milestone's evidence.
    const kept = paths.filter(p => groupOf(p, ctx) !== 'generated')
    if (kept.length === 0) return
    const current = this.progress().current
    this.setEvidence(Evidence.noteEdits(this.evidence(), current === null ? null : { key: current.key, subject: current.subject }, kept, now))
  }

  /** The checks Claude ran in this context, as Activity's Validation counts them (main conversation). */
  private checkRuns(): Evidence.CheckRun[] {
    return this.activity.validationRuns().map(r => ({ kind: r.kind, label: VALIDATION_LABEL[r.kind], command: r.command, status: r.status, endedAt: r.endedAt }))
  }

  /** Each file's `stat` (size, time; a directory or a missing file as such), with no blob id yet. */
  private async statFiles(paths: readonly string[]): Promise<Map<string, Evidence.Fingerprint>> {
    const host = this.host
    const found = new Map<string, Evidence.Fingerprint>()
    if (host === null) return found
    await Promise.all(
      paths.map(async path => {
        const st = await host.stat(path, false).catch(() => null)
        if (st === null) found.set(path, { exists: false, size: null, mtimeMs: null, blob: null })
        else if (st.kind === 'dir') found.set(path, { exists: true, isDir: true, size: null, mtimeMs: null, blob: null })
        else found.set(path, { exists: true, size: st.size, mtimeMs: st.mtimeMs, blob: null })
      }),
    )
    return found
  }

  /** Git's blob ids for those of `paths` that exist as files under the size limit, one `git hash-object` per fifty. */
  private async hashInto(found: Map<string, Evidence.Fingerprint>, paths: readonly string[]): Promise<void> {
    const host = this.host
    if (host === null) return
    const eligible = paths.filter(p => {
      const f = found.get(p)
      return f !== undefined && f.exists && f.isDir !== true && (f.size === null || f.size <= Evidence.HASH_MAX_BYTES)
    })
    for (let i = 0; i < eligible.length; i += 50) {
      const chunk = eligible.slice(i, i + 50)
      const result = await host.hashFiles(chunk).catch(() => null)
      if (result === null || result.exitCode !== 0) {
        this.trace(`evidence: git hash-object ${result === null ? 'could not run' : `failed (exit ${result.exitCode})`}: size and time stand in`)
        return
      }
      const ids = result.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
      if (ids.length !== chunk.length) return
      chunk.forEach((p, j) => {
        const f = found.get(p)
        const id = ids[j] ?? ''
        if (f !== undefined && /^[0-9a-f]{40,64}$/.test(id)) found.set(p, { ...f, blob: id })
      })
    }
  }

  /** The commit HEAD points at, in a Git repository; null elsewhere or when Git cannot say. */
  private async gitHeadOf(): Promise<string | null> {
    const host = this.host
    if (host === null) return null
    if (this.gitRoot === undefined) this.gitRoot = await host.repoRoot().catch(() => null)
    if (this.gitRoot === null) return null
    const result = await host.gitHead().catch(() => null)
    const head = result === null || result.exitCode !== 0 ? '' : result.stdout.trim()
    return /^[0-9a-f]{40,64}$/.test(head) ? head : null
  }

  /**
   * A milestone verified (completed): a snapshot of what it stood on. Its green checks in its window
   * (from when it was first seen under way), its files' fingerprints, HEAD. Then the earlier snapshots
   * are compared again: one this milestone changed and re-verified is re-baselined.
   */
  private async snapshotMilestone(task: Plan.PlanTask): Promise<void> {
    if (this.run === null) return
    const now = Date.now()
    const store = this.evidence()
    const since = Evidence.windowStart(store, task.key, this.contextStartedAt ?? 0)
    const checks = Evidence.greenChecks(this.checkRuns(), since, now)
    const paths = Evidence.filesFor(store, task.key)
    const found = await this.statFiles(paths)
    await this.hashInto(found, paths)
    const head = paths.length === 0 ? null : await this.gitHeadOf()
    if (this.run === null) return
    // Reopened meanwhile: no snapshot of a milestone that is no longer done.
    if (this.plan().tasks.find(t => t.key === task.key)?.status !== 'completed') return
    const ctx = { root: this.root, handoffFile: this.settings.autopilot.handoffFile }
    const files = paths.map(path => ({ path, ...(found.get(path) ?? { exists: false, size: null, mtimeMs: null, blob: null }), ...(groupOf(path, ctx) === 'docs' ? { isDoc: true } : {}) }))
    const session = Chain.currentSession(this.run)?.index ?? 1
    this.setEvidence(Evidence.addSnapshot(this.evidence(), { key: task.key, subject: task.subject, verifiedAt: now, session, checks, files, head }))
    this.trace(`evidence: "${task.subject}" verified with ${checks.length === 0 ? 'no check' : checks.map(c => c.label).join(', ')}; ${fmt.plural(files.length, 'file')}${files.some(f => f.blob !== null) ? ' (blob ids)' : ''}${head === null ? '' : ` at ${head.slice(0, 8)}`}`)
    this.evidenceCheckedAt = 0
    await this.checkEvidence('milestone verified')
  }

  private isEvidenceChecking = false
  private evidenceCheckedAt = 0

  /**
   * Compares the snapshots with the workspace: each file's `stat`, and a blob id only for one whose size or
   * time moved. Run at a handoff (the fresh context's block and Handoff Health read that comparison), a
   * session's start or reload, a milestone's completion and (at most once a minute) a turn's end; never
   * while nothing is kept.
   */
  async checkEvidence(reason: string): Promise<void> {
    if (this.host === null || this.run === null || this.isEvidenceChecking || this.evidence().snapshots.length === 0) return
    this.isEvidenceChecking = true
    try {
      const store = this.evidence()
      const found = await this.statFiles(Evidence.pathsToObserve(store))
      await this.hashInto(found, Evidence.pathsToHash(store, found))
      if (this.run === null) return
      const now = Date.now()
      this.evidenceCheckedAt = now
      const tasks = this.plan().tasks
      const before = this.evidence()
      const next = Evidence.compare(before, found, {
        active: new Set(tasks.filter(t => Plan.isActive(t.status)).map(t => t.key)),
        completed: new Set(tasks.filter(t => t.status === 'completed').map(t => t.key)),
        green: Evidence.greenChecks(this.checkRuns(), 0, now),
        now,
      })
      if (next === before) return
      for (const snap of next.snapshots) {
        const was = before.snapshots.find(b => b.key === snap.key)
        if (was !== undefined && (was.status !== snap.status || was.rebaselined.length !== snap.rebaselined.length)) {
          const line = Evidence.evidenceLine(snap)
          this.trace(`evidence (${reason}): "${snap.subject}" ${snap.status}${line === null ? '' : `: ${line}`}`)
        }
      }
      this.setEvidence(next)
    } finally {
      this.isEvidenceChecking = false
    }
  }

  /** The completed milestones whose verification is stale now (the last comparison's word). */
  staleEvidence(): Evidence.Snapshot[] {
    return this.evidence().snapshots.filter(s => s.status === 'stale')
  }

  /**
   * The person accepts stale milestones' files as they are now (one by key, or all): their evidence is
   * re-baselined on the files as found, "accepted by you". The words say what was accepted.
   */
  async acceptEvidence(key: string | null): Promise<string> {
    const stale = this.staleEvidence().filter(s => key === null || s.key === key)
    if (stale.length === 0) return 'No milestone has stale verification.'
    const paths = [...new Set(stale.flatMap(s => s.changes.map(c => c.path)))]
    const found = await this.statFiles(paths)
    await this.hashInto(found, paths)
    this.setEvidence(Evidence.acceptChanges(this.evidence(), key, found, Date.now()))
    const names = stale.map(s => `"${s.subject}"`).join(', ')
    this.trace(`evidence: accepted by the person as they are now: ${names}`)
    return `Accepted ${names} as ${stale.length === 1 ? 'it is' : 'they are'} now: ${stale.length === 1 ? 'its' : 'their'} files are the evidence from here.`
  }

  /** A stale milestone named by its number in /cr evidence's list or by words of its subject; null when none matches. */
  staleEvidenceKey(words: string): string | null {
    const stale = this.staleEvidence()
    const n = Number(words)
    if (Number.isInteger(n) && n >= 1 && n <= stale.length) return stale[n - 1]?.key ?? null
    const w = words.trim().toLowerCase()
    return w === '' ? null : (stale.find(s => s.subject.toLowerCase().includes(w))?.key ?? null)
  }

  /** /cr evidence: each verified milestone's evidence in words, the stale ones numbered for /cr evidence accept. */
  evidenceText(): string {
    const snaps = this.evidence().snapshots
    if (snaps.length === 0) return 'No milestone evidence yet: it is kept when a milestone is completed (its green checks and the files its work changed).'
    let n = 0
    const lines = snaps.map(s => {
      const line = Evidence.evidenceLine(s)
      const files = s.files.length === 0 ? 'no files' : fmt.plural(s.files.length, 'file')
      const checks = s.checks.length === 0 ? 'no check' : [...new Set(s.checks.map(c => c.label))].join(', ')
      const head = s.head === null ? '' : ` at ${s.head.slice(0, 8)}`
      if (s.status === 'stale') return `  ${++n}. ▲ ${s.subject}: verification stale · ${line ?? ''}`
      return `     ${s.status === 'changing' ? '◷' : '✓'} ${s.subject}: ${s.status === 'changing' ? (line ?? 'being changed') : `current${line === null ? '' : ` (${line})`}`} · ${checks} · ${files}${head}`
    })
    const tail = n === 0 ? [] : ['', `Rerun the named checks, or accept the files as they are now: /cr evidence accept ${n === 1 ? '1' : '<number>|all'}.`]
    return [`Milestone evidence: ${fmt.plural(snaps.length, 'verified milestone')}${n === 0 ? ', none stale' : `, ${n} stale`}`, ...lines, ...tail].join('\n')
  }

  /**
   * What the fresh context after Control Room's own handoff is told with its first message (the
   * continuation, or whatever the person types first): the run, the notes, the milestones. It is
   * one more context block of that message (`prompt.context`), so the session's start is left
   * exactly as Claude Code made it.
   */
  private freshContext: string | null = null

  /** The fresh context's notes, once: the first message after a handoff carries them. */
  takeFreshContext(): string | null {
    const text = this.freshContext
    this.freshContext = null
    return text
  }

  /** classic.SessionStart: a session begins (startup, resume, compact) or a fresh context after /clear. */
  async onClassicSessionStart(input: {
    source: string
    sessionId: string
    model?: string
    transcriptPath?: string
    /** resume/fork: Claude Code's word on the cache: seconds since the last answer, the context, whether it likely expired, its estimate of re-caching. */
    secondsSince?: number
    contextTokens?: number
    isCacheExpired?: boolean
    usd?: number
  }): Promise<void> {
    await this.ensureLoaded()
    await this.carryAtSessionStart(input.transcriptPath)
    if (input.source !== 'clear') {
      this.startSource = { source: input.source, sessionId: input.sessionId }
      if (input.source === 'compact') this.publisher.mark('chain', 'hud')
      if (input.source === 'resume' || input.source === 'fork') {
        this.ops.noteResumed({ secondsSince: input.secondsSince, tokens: input.contextTokens, isExpired: input.isCacheExpired, usd: input.usd, model: input.model })
      }
      return
    }
    const host = this.host
    const now = host === null ? Date.now() : await this.engineNow()
    const wasOurs = this.isOwnClear || this.autopilot.state === 'clearing'
    const purpose = wasOurs ? this.freshPurpose : null
    this.trace(`fresh session ${input.sessionId} after /clear (${purpose !== null ? `Project Sentinel's ${purpose.endNote}` : wasOurs ? "Control Room's handoff" : 'cleared by the person'})`)
    if (wasOurs) this.onOwnClearSeen?.()
    if (this.run !== null) {
      this.run = Chain.rollOver(this.run, {
        end: wasOurs ? 'handoff' : 'clear',
        endNote: purpose !== null
          ? purpose.endNote
          : wasOurs
            ? `handoff at ${this.autopilot.triggeredTokens === null ? 'manual request' : `${Math.round(this.autopilot.triggeredTokens / 1000)}k tokens`}`
            : 'cleared by you',
        nextId: input.sessionId,
        nextStart: wasOurs ? 'handoff' : 'clear',
        now,
      })
      this.persistRun(true)
      this.questForRunShape(now)
    }
    this.sessionId = input.sessionId
    this.usage = { tokens: undefined, window: this.usage.window, pct: undefined, costUsd: 0 }
    this.cache.resetForContext()
    this.reads = []
    this.contextStartedAt = Date.now()
    if (wasOurs && this.run !== null) {
      const h = this.run.lastHandoff
      const index = Chain.currentSession(this.run)?.index ?? 1
      if (h !== undefined && h !== null && h.toSession === null && h.fromSession === index - 1) this.run = { ...this.run, lastHandoff: { ...h, toSession: index } }
    }
    this.activity.reset()
    this.guard = { turnBlocks: 0, sessionBlocks: 0, lastBlockedAnswer: '', last: null }
    this.compose = { ...this.compose, isReached: false, deliveredFallback: false }
    // A fresh context: a fresh system prompt, so notes about the old one, and what the old one was told, are gone.
    this.notesBox.clear()
    this.ledger.reset()
    this.lastFrontierDelivered = null
    this.pressureTold = 'ok'
    this.memoText = null
    this.router.turnModel = null
    this.publisher.forgetPublished()
    this.publisher.markAll()
    if (!wasOurs) {
      this.freshContext = null
      this.stepAutopilot({ kind: 'externalClear' })
      return
    }
    const policies = this.policies().map(s => s.name)
    const sessionNumber = this.run === null ? 1 : (Chain.currentSession(this.run)?.index ?? 1)
    // What the old context left running keeps running here (Claude Code keeps background work across /clear).
    const left = this.autopilot.leftRunning
    const base = prompts.continuationContext({
      runNumber: this.run?.number ?? null,
      sessionNumber,
      handoffPath: this.handoffPath(),
      policies,
      milestones: this.plan().tasks.map(t => ({ subject: t.subject, status: t.status, detail: t.detail })).slice(-30),
      objective: this.run?.objectiveBy === 'claude' ? this.run.objective : null,
      cause: purpose?.cause,
      leftRunning: left,
      stale: Evidence.staleText(this.staleEvidence()),
    })
    if (left.length > 0) {
      this.trace(`autopilot: the fresh context is told what still runs (${left.map(t => `${t.id} ${t.class ?? 'unknown'}`).join(', ')})`)
      this.stepAutopilot({ kind: 'leftRunningTold' })
    }
    // What the run carries into it: the wake, work queued for a fresh context, answers and open decisions.
    const extras = this.ops.onFreshContext(purpose)
    this.freshContext = extras === null ? base : `${base} ${extras}`
    // The fresh conversation is empty, so asking for its context blocks again costs nothing.
    this.host?.invalidatePromptContext()
  }

  /** Whether this runtime has looked for the store the plugin kept under its former name. */
  private isCarryChecked = false

  /**
   * Once per install: the settings, runs, Quest log and cache memory the plugin kept as Control Room
   * come along to Project Sentinel (app/formerStore.ts). The old store is only read, never changed.
   * Returns the keys that came along: none when it was done before or nothing was found.
   */
  private async carryFormerStore(configDir: string | null): Promise<string[]> {
    const host = this.host
    if (host === null || this.isCarryChecked || configDir === null) return []
    this.isCarryChecked = true
    if ((await host.storeGet(CARRIED_MARK).catch(() => undefined)) !== undefined) return []
    const now = Date.now()
    const former = await readFormerStore(host, configDir)
    if (former === null) {
      const marker: CarriedMarker = { from: null, at: now, keys: 0 }
      await host.storeSet(CARRIED_MARK, marker).catch(() => undefined)
      return []
    }
    const has = async (key: string) => (await host.storeGet(key).catch(() => undefined)) !== undefined
    const counter = await host.storeGet(STORE_ENTRIES.runCounter).catch(() => undefined)
    const writes = carriedWrites(former.store, {
      // Fresh-install defaults this very load wrote are not the person's: what Control Room kept wins.
      settings: (await has(STORE_ENTRIES.settings)) && !this.isFreshDefaults,
      quest: await has(STORE_ENTRIES.quest),
      cache: await has(STORE_ENTRIES.cache),
      counter: typeof counter === 'number' && Number.isFinite(counter) ? Math.floor(counter) : 0,
      index: await loadIndex(host),
    })
    const keys = Object.keys(writes)
    for (const key of keys) await host.storeSet(key, writes[key]).catch(() => undefined)
    const marker: CarriedMarker = { from: former.file, at: now, keys: keys.length }
    await host.storeSet(CARRIED_MARK, marker).catch(() => undefined)
    this.trace(`carried ${keys.length} keys over from ${former.file}`)
    // Not a fresh install after all: no first-run card, and the defaults it had (Classic) unless its settings came along.
    if (keys.length > 0 && this.isFreshDefaults) {
      this.isFreshDefaults = false
      if (!keys.includes(STORE_ENTRIES.settings)) await host.storeSet(STORE_ENTRIES.settings, classicSettings()).catch(() => undefined)
      this.onboarding = null
      await host.storeDelete(STORE_ENTRIES.onboarding).catch(() => undefined)
    }
    if (keys.length > 0) this.announce('Project Sentinel is Control Room renamed: your settings, runs, Quest log and cache memory came along.')
    return keys
  }

  /**
   * At the first load, before the settings are read, so they are the person's from the first hook
   * on: an update can load the plugin into a running session, where no session start follows.
   */
  private async carryAtLoad(): Promise<void> {
    const host = this.host
    if (host === null || this.isCarryChecked) return
    const env = await host.configEnv().catch(() => null)
    const configDir = env === null ? null : configDirFromEnv(env)
    if (configDir === null) return
    // A folder without plugin stores is not Claude Code's: the session's start looks again, by its transcript.
    const sep = configDir.includes('\\') && !configDir.includes('/') ? '\\' : '/'
    if (!(await host.exists([configDir, 'plugins', 'store'].join(sep)).catch(() => false))) return
    await this.carryFormerStore(configDir)
  }

  /** At a session's start, when the environment did not say where the configuration is: the transcript's folder. */
  private async carryAtSessionStart(transcriptPath: string | undefined): Promise<void> {
    const host = this.host
    const keys = await this.carryFormerStore(configDirOf(transcriptPath))
    if (host === null || keys.length === 0) return
    // What came along takes effect now: the settings, the Quest log, the cache's memory, the run numbers.
    this.isLoaded = false
    await this.ensureLoaded()
    await this.cache.load()
    if (this.run !== null && keys.includes(STORE_ENTRIES.runCounter) && this.run.sessions.length === 1 && (this.run.sessions[0]?.turns ?? 0) === 0) {
      this.run = { ...this.run, number: await nextRunNumber(host) }
      this.persistRun(true)
    }
    this.reconfigure({})
    void this.refreshHistory()
    this.publisher.markAll()
  }

  /**
   * True while Control Room, this plugin under its former name, runs in the session too. Claude
   * Desktop hands a session its plugins when the session's process starts, so an update loads
   * Project Sentinel beside the Control Room that process already runs. Project Sentinel then stands
   * by: every hook passes its event on, and nothing is drawn, registered, recorded or carried over,
   * until the session restarts without Control Room.
   */
  isStandby = false

  /** At the load: whether Control Room has published its status bar in this session (it stays standing by if so). */
  async checkStandby(): Promise<boolean> {
    const host = this.host
    if (host === null || this.isStandby) return this.isStandby
    const hud = await host.formerHud().catch(() => undefined)
    if (!isFormerHud(hud)) return false
    this.isStandby = true
    this.trace('Control Room still runs in this session: Project Sentinel stands by until the session restarts')
    // Once per session: a later reload (an install, an update) stands by without saying it again.
    if (!(await host.isStandbyNoted().catch(() => false))) {
      await host.noteStandby().catch(() => undefined)
      host.after(ANNOUNCE_DELAY_MS, () => host.toast('Project Sentinel is installed. Control Room keeps this session until it restarts.', 8000))
    }
    return true
  }

  /**
   * Every timer and sampler this runtime keeps (the session ends; a test's reload). Claude Code cancels
   * a reloaded plugin's waits itself, so an old runtime never acts after a new one took over.
   */
  stopTimers(): void {
    this.monitor.stop()
    this.agents.poll?.cancel()
    this.agents.poll = null
    this.supervisorTimer?.cancel()
    this.supervisorTimer = null
    this.cache.stop()
    this.ops.stop()
    this.companionTicker?.cancel()
    this.companionTicker = null
    this.usageTicker?.cancel()
    this.usageTicker = null
    this.ticker?.cancel()
    this.ticker = null
  }

  async onSessionEnd(e: SessionEndInput): Promise<void> {
    if (e.reason === 'clear') {
      this.publisher.forgetPublished()
      this.persistRun(true)
      return
    }
    this.stopTimers()
    if (this.run !== null) {
      const now = Date.now()
      const end: Chain.SessionEnd = e.reason === 'resume' ? 'resume' : e.reason === 'logout' ? 'logout' : e.reason === 'prompt_input_exit' ? 'exit' : 'other'
      this.run = Chain.endRun(this.run, end, now)
      const host = this.host
      if (host !== null) await saveRun(host, this.run).catch(() => undefined)
    }
    await this.saveSettings.flush()
    await this.saveQuest.flush()
  }

  // -------------------------------------------------------------------------
  // Usage, context and the autopilot

  handoffPath(): string {
    const sep = this.root.includes('\\') && !this.root.includes('/') ? '\\' : '/'
    const file = this.settings.autopilot.handoffFile.replace(/\//g, sep)
    return this.root === '' ? file : `${this.root.replace(/[\\/]+$/, '')}${sep}${file}`
  }

  /** `isAfterAnswer`: read right after a turn of the main conversation was answered (an API response has come back). */
  async refreshUsage(withSummary = false, isAfterAnswer = false): Promise<void> {
    const host = this.host
    if (host === null) return
    const usage = await (withSummary ? host.usageSummary() : host.usage()).catch(() => null)
    if (usage === null) return
    this.applyUsage(usage)
    this.notePlanUsage(usage.rateLimits, isAfterAnswer)
    if (withSummary) {
      const at = usage.context.breakdown?.autoCompactThreshold
      this.autoCompactAt = usage.context.breakdown?.isAutoCompactEnabled === false ? undefined : at
    }
  }

  applyUsage(usage: Pick<SessionUsage, 'context' | 'cost'>): void {
    const previousWindow = this.usage.window
    this.usage = {
      tokens: usage.context.tokens ?? this.usage.tokens,
      window: usage.context.window,
      pct: usage.context.percent ?? this.usage.pct,
      costUsd: usage.cost?.usd ?? this.usage.costUsd,
    }
    if (this.run !== null) {
      this.run = Chain.measure(this.run, { tokens: usage.context.tokens, window: usage.context.window, costUsd: usage.cost?.usd, model: this.sessionModel || undefined }, Date.now())
      this.persistRun()
    }
    if (previousWindow !== this.usage.window) this.configureAutopilot()
    this.publisher.mark('hud', 'pane', 'chain')
  }

  /**
   * The plan's rate-limit windows, as a response reported them (a measurement, a read after a turn or
   * on the minute). Redrawn when they say something new; the minute look runs only while a five-hour
   * window counts down, so an API-key session (no windows) or a reset window costs nothing.
   */
  notePlanUsage(rateLimits: readonly PlanUsage.RateLimitReading[], isAfterAnswer = false): void {
    // A claude.ai plan's rate-limit windows: the one-hour cache is Claude Code's default for its main conversation.
    if (rateLimits.some(r => r.kind === 'five_hour' || r.kind === 'seven_day')) this.cache.notePlan()
    const before = this.planUsage
    this.planUsage = PlanUsage.readWindows(before, rateLimits, this.clock(), isAfterAnswer)
    if (this.planUsage !== before) {
      const five = this.planUsage.fiveHour
      if (five !== before.fiveHour || this.planUsage.isAbsent !== before.isAbsent) {
        this.trace(`plan usage: ${five === null ? (this.planUsage.isAbsent ? 'no five-hour window' : 'no reading') : `five-hour ${five.percent}%${five.resetsAt === null ? '' : `, resets ${new Date(five.resetsAt).toISOString()}`}`}`)
      }
      this.publisher.mark('hud', 'pane')
    }
    this.syncUsageTicker()
  }

  /** Claude Code ended a request on an API error: a rate limit is the plan's limit reached (or a throttle), shown until it lifts. */
  onStopFailure(error: string): void {
    if (error !== 'rate_limit') return
    this.planUsage = PlanUsage.noteRateLimited(this.planUsage, this.clock())
    this.trace(`plan usage: a request ended on the rate limit${this.planUsage.limited?.window === null ? '' : ` (${this.planUsage.limited?.window} full)`}`)
    this.publisher.mark('hud', 'pane')
    this.syncUsageTicker()
  }

  private syncUsageTicker(): void {
    const host = this.host
    if (host === null) return
    const isWanted = PlanUsage.isTicking(this.planUsage, this.clock())
    if (isWanted && this.usageTicker === null) {
      this.usageTicker = host.every(60_000, () => {
        // The countdown moves on, and a reading may have come from a request no measurement reported.
        this.publisher.mark('hud', 'pane')
        void host
          .usage()
          .then(u => this.notePlanUsage(u.rateLimits))
          .catch(() => this.syncUsageTicker())
      })
    } else if (!isWanted && this.usageTicker !== null) {
      this.usageTicker.cancel()
      this.usageTicker = null
    }
  }

  configureAutopilot(): void {
    const a = this.settings.autopilot
    const { threshold, isClamped } = Autopilot.resolveThreshold({
      mode: a.thresholdMode,
      tokens: a.thresholdTokens,
      percent: a.thresholdPercent,
      window: this.usage.window,
      autoCompactAt: this.autoCompactAt,
    })
    this.stepAutopilot({ kind: 'configure', enabled: a.enabled, threshold, isClamped })
  }

  /** A fresh context started working (or ended a turn read in): Autopilot gives it room from its size now. */
  noteWorkStarted(): void {
    if (!this.autopilot.isFreshContext || this.usage.tokens === undefined) return
    this.stepAutopilot({ kind: 'oriented', tokens: this.usage.tokens })
  }

  /** Context Autopilot's configuration as the machine reads it (features/autopilot.ts AutopilotConfig). */
  autopilotConfig(): Autopilot.AutopilotConfig {
    const a = this.settings.autopilot
    return { continuation: a.continuation, fallbackToCompact: a.fallbackToCompact, autoContinue: a.autoContinue, waitMs: a.waitMinutes * 60_000 }
  }

  stepAutopilot(event: Autopilot.AutopilotEvent): void {
    const before = this.autopilot.state
    const result = Autopilot.step(this.autopilot, event, this.autopilotConfig())
    // A new state is timed from the event's own clock (the engine's), else the engine's last reading.
    if (result.model.state !== before) result.model = { ...result.model, stateSince: 'now' in event && typeof event.now === 'number' ? event.now : (this.lastEngineAt ?? this.clock()) }
    if (result.model.state !== before || result.effects.length > 0 || event.kind === 'oriented') {
      const effects = result.effects.filter(e => e.kind !== 'notify').map(e => e.kind)
      const at = event.kind === 'oriented' ? ` at ${Math.round(event.tokens / 1000)}k, hands off at ${Math.round((Autopilot.handoffPoint(result.model) ?? 0) / 1000)}k` : ''
      this.trace(`autopilot: ${event.kind}${at} · ${before} → ${result.model.state}${effects.length === 0 ? '' : ` · ${effects.join(', ')}`}`)
    }
    this.applyAutopilot(result)
  }

  /** The engine's last reading of its clock, and the system clock's then: what a step with no time of its own is timed by. */
  private lastEngineAt: number | null = null
  private lastEngineSystemAt = 0

  /** The engine's clock (`$.clock.now()`), which times the handoff's steps; the system clock when it cannot be read. */
  engineNow(): Promise<number> {
    const host = this.host
    const read = host === null ? Promise.resolve(this.clock()) : host.now().catch(() => this.clock())
    return read.then(at => {
      this.lastEngineAt = at
      this.lastEngineSystemAt = this.clock()
      return at
    })
  }

  /**
   * The engine's time now, without a call: its last reading moved on by the system clock since. What a
   * handoff's wait is measured in (its end was set from the engine's clock), for the countdowns drawn.
   */
  engineTime(): number {
    return this.lastEngineAt === null ? this.clock() : this.lastEngineAt + Math.max(0, this.clock() - this.lastEngineSystemAt)
  }

  /** One line in Claude Code's debug log (claude --debug), never on screen: how a handoff or a refresh went, step by step. */
  trace(text: string): void {
    this.host?.trace?.(text)
  }

  private applyAutopilot(result: Autopilot.Step): void {
    const before = this.autopilot.state
    // How long a step has stood is the supervisor's first fact (stamped by stepAutopilot; a reload keeps the record's).
    this.autopilot = result.model.stateSince === null && result.model.state !== 'off' ? { ...result.model, stateSince: this.lastEngineAt ?? this.clock() } : result.model
    this.saveAutopilotRecord()
    this.publisher.mark('hud', 'pane')
    for (const effect of result.effects) void this.runEffect(effect)
    // A handoff coming or going changes whether the cache is worth keeping.
    if (before !== this.autopilot.state && !this.turn.isRunning) this.cache.schedule()
    if (before !== this.autopilot.state) this.superviseLater(true)
  }

  // -------------------------------------------------------------------------
  // The Handoff Supervisor

  /**
   * The supervisor looks every SUPERVISE_MS while a handoff is under way (any state but off and
   * armed), and once at once when the state changes. It only observes, with no model call and nothing
   * added to the transcript, except at a wait's end (features/supervisor.ts dueStep).
   */
  private superviseLater(isNow = false): void {
    const host = this.host
    if (host === null) return
    const state = this.settings.autopilot.enabled ? this.autopilot.state : 'off'
    const isActive = state !== 'off' && state !== 'armed'
    if (!isActive) {
      this.supervisorTimer?.cancel()
      this.supervisorTimer = null
      if (this.supervisor !== null) {
        this.supervisor = null
        this.supervisorKey = ''
        this.publisher.mark('hud', 'pane')
      }
      return
    }
    if (this.supervisorTimer === null) this.supervisorTimer = host.every(SUPERVISE_MS, () => void this.supervise())
    if (isNow) host.after(0, () => void this.supervise())
  }

  /** Questions open to the person now: Project Sentinel's own approvals, and a running AskUserQuestion. */
  private questionsOpen(): number {
    return this.pendingApprovals.length + this.activity.runningItems().filter(i => i.agentId === null && i.tool === 'AskUserQuestion').length
  }

  /** The supervisor's facts, as the Runtime knows them now. */
  private supervisorInput(now: number): Supervisor.SupervisorInput {
    const ap = this.autopilot
    return {
      now,
      state: this.settings.autopilot.enabled ? ap.state : 'off',
      stateSince: ap.stateSince,
      isTurnRunning: this.turn.isRunning,
      isHandoffTurn: this.turn.isRunning && (this.turn.kind === 'handoff' || this.turn.kind === 'retry'),
      background: ap.background,
      waitSince: ap.waitSince,
      waitUntil: ap.waitUntil,
      skipWait: ap.skipWait,
      notesWritten: ap.notesWritten,
      questionsOpen: this.questionsOpen(),
      quietMs: this.quietSince === null ? null : this.clock() - this.quietSince,
      lastError: ap.lastError,
      continuation: this.settings.autopilot.continuation,
    }
  }

  /** One look: the diagnosis (traced and shown when it changes), a wait's end, and the classifier for a task the rules do not know. */
  async supervise(): Promise<void> {
    const host = this.host
    if (host === null) return
    const now = await this.engineNow()
    const input = this.supervisorInput(now)
    if (input.state === 'off' || input.state === 'armed') {
      this.superviseLater()
      return
    }
    const d = Supervisor.diagnose(input)
    const key = `${d.phase}|${d.status}|${d.blocker?.kind ?? ''}|${d.blocker?.text ?? ''}`
    if (key !== this.supervisorKey) {
      this.supervisorKey = key
      this.trace(Supervisor.traceLine(d))
    }
    this.supervisor = d
    this.publisher.mark('hud', 'pane')
    const due = Supervisor.dueStep(input)
    if (due === 'waitExpired') {
      this.trace(`supervisor: the wait's patience is over (${this.settings.autopilot.waitMinutes} min): the handoff goes on${this.turn.isRunning ? ' when this turn ends' : ''}, leaving ${Autopilot.backgroundWords(Autopilot.blockingOf(this.autopilot.background))} running`)
      this.stepAutopilot({ kind: 'waitExpired', now, isTurnRunning: this.turn.isRunning })
    } else if (due === 'unblocked') {
      this.trace('supervisor: nothing the handoff must wait for is left and the session is quiet: the handoff goes on')
      this.stepAutopilot({ kind: 'unblocked', now })
    }
    this.classifyUnknown(now)
  }

  /**
   * A task the rules do not recognise, waited for a minute already: a small isolated classification
   * (`$.model.classify`, the engine's small fast model, never the conversation), once per task. Only
   * its command and Claude Code's description of it are sent.
   */
  private classifyUnknown(now: number): void {
    const host = this.host
    const ap = this.autopilot
    if (host === null || ap.state !== 'waiting-background') return
    const ask = Supervisor.toClassify({ now, waitSince: ap.waitSince, background: ap.background, asked: this.classifyAsked }).slice(0, CLASSIFY_PER_LOOK)
    for (const t of ask) {
      this.classifyAsked.add(t.id)
      const summary: Background.TaskSummary = { id: t.id, type: 'shell', description: t.description, ...(t.command === undefined ? {} : { command: t.command }) }
      void host
        .classify(Background.classifierText(summary), Background.CLASSIFIER_LABELS)
        .then(label => {
          const verdict = Background.verdictOfLabel(label)
          this.trace(`supervisor: asked the isolated classifier about ${t.id} (${clean(t.description, 60)}): ${label ?? 'no label'}${verdict === null ? ', still waited for' : ` → ${verdict.class}`}`)
          if (verdict === null) return
          this.taskVerdicts.set(t.id, verdict)
          if (this.lastStop !== null) this.lastStop = { ...this.lastStop, background: this.lastStop.background.map(b => (b.id === t.id ? { ...b, class: verdict.class, why: verdict.why, by: verdict.by } : b)) }
          this.stepAutopilot({ kind: 'reclassified', id: t.id, class: verdict.class, why: verdict.why, by: verdict.by, isTurnRunning: this.turn.isRunning })
        })
        .catch(error => this.trace(`supervisor: the isolated classifier could not answer about ${t.id}: ${error instanceof Error ? clean(error.message, 100) : String(error)}`))
    }
  }

  /** The main conversation showed activity: the supervisor's quiet counts from now. */
  private noteActivity(): void {
    this.quietSince = this.clock()
  }

  /** The last record written, so an unchanged machine writes nothing. */
  private savedRecord = 'null'

  /** Keeps the handoff in flight in `$.state`, where a reload of the plugin finds it. */
  private saveAutopilotRecord(): void {
    const host = this.host
    if (host === null) return
    const record = Autopilot.recordOf(this.autopilot, this.sessionId, Date.now())
    const key = JSON.stringify(record === null ? null : { ...record, at: 0 })
    if (key === this.savedRecord) return
    this.savedRecord = key
    void host.saveAutopilotRecord(record).catch(() => {
      this.savedRecord = 'unsaved'
    })
  }

  /**
   * After a reload: a handoff that was under way carries on from where its
   * record left it, so the context crossing the threshold again does not
   * start a second one. A restart or /clear leaves no record.
   */
  private async recoverAutopilot(): Promise<void> {
    const host = this.host
    if (host === null) return
    const record = await host.loadAutopilotRecord().catch(() => null)
    if (record === null) return
    this.savedRecord = JSON.stringify({ ...record, at: 0 })
    const result = Autopilot.recover(this.autopilot, record, { sessionId: this.sessionId, now: await this.engineNow(), waitMs: this.autopilotConfig().waitMs })
    if (result.model === this.autopilot) return
    this.applyAutopilot(result)
    this.trace(`autopilot: recovered ${result.model.state} after a reload${result.model.state === 'waiting-background' ? ` (waiting for ${Autopilot.backgroundWords(Autopilot.blockingOf(result.model.background))}${result.model.waitUntil === null ? '' : `, at most until ${new Date(result.model.waitUntil).toISOString()}`})` : ''}`)
  }

  private async runEffect(effect: Autopilot.AutopilotEffect): Promise<void> {
    const host = this.host
    if (host === null) return
    switch (effect.kind) {
      case 'appendPending':
        // Mid-turn: it goes with the batch of tool results the crossing step asked for (app/notes.ts).
        this.tell('autopilot', prompts.pendingNotice({ tokens: effect.tokens, threshold: effect.threshold, window: effect.window }))
        return
      case 'notify':
        if (this.settings.ui.toasts) host.toast(effect.text, effect.level === 'error' ? 8000 : 5000)
        if (effect.level === 'error') this.note(effect.text)
        return
      case 'submitHandoff':
      case 'submitRetry': {
        const text =
          effect.kind === 'submitRetry'
            ? prompts.handoffRetryPrompt(this.settings.autopilot.handoffFile)
            : prompts.handoffPrompt({
                tokens: this.usage.tokens,
                window: this.usage.window,
                handoffFile: this.settings.autopilot.handoffFile,
                runNumber: this.run?.number ?? null,
                sessionNumber: this.run === null ? 1 : (Chain.currentSession(this.run)?.index ?? 1),
                planTool: this.planSource === 'milestones' ? this.milestonesTool : this.planSource === 'tasks' ? 'your task list (TodoWrite or the Task tools)' : null,
                waitMinutes: this.settings.autopilot.waitMinutes,
                stale: Evidence.staleText(this.staleEvidence()),
              })
        // Deferred only to leave the dispatch that decided it; the turn's start (recognised by its text) moves the handoff on.
        host.after(250, () => void this.submitOwn(text, effect.kind === 'submitRetry' ? 'retry' : 'handoff'))
        return
      }
      case 'verifyHandoff': {
        // What the handoff leaves: its milestones' evidence as it stands now (Handoff Health, the fresh context's block).
        await this.checkEvidence('handoff')
        const notes = await this.verifyHandoff()
        if (notes.isOk) this.questEvent('handoff', 'Clean handoff: notes verified')
        this.recordHandoffHealth(notes.isOk, notes.mtimeMs)
        this.stepAutopilot({ kind: 'handoffVerified', isOk: notes.isOk, now: await this.engineNow() })
        return
      }
      case 'checkNotes': {
        const state = await this.notesState(this.autopilot.handoffSince)
        this.stepAutopilot({ kind: 'notesSeen', isWritten: state === 'fresh' })
        return
      }
      case 'clear':
        host.after(LIMITS.clearDelayMs, () => void this.runClear())
        return
      case 'compact':
        host.after(LIMITS.clearDelayMs, () => void this.runCompact())
        return
      case 'submitContinuation': {
        const text = prompts.continuationPrompt({
          handoffPath: this.handoffPath(),
          sessionNumber: this.run === null ? 1 : (Chain.currentSession(this.run)?.index ?? 1),
        })
        host.after(400, () => void this.submitOwn(text, 'continuation'))
        return
      }
    }
  }

  /**
   * Submits one of Control Room's own prompts, unless the step that asked
   * for it was overtaken (the person cleared, compacted or took over). The
   * turn it starts is recognised at turn.start by its text, which moves the
   * handoff on; a refused prompt leaves the handoff waiting for the person.
   */
  private async submitOwn(text: string, kind: TurnKind): Promise<void> {
    const host = this.host
    if (host === null) return
    const wanted: Record<string, Autopilot.AutopilotState> = { handoff: 'requested', retry: 'handoff', continuation: 'resuming' }
    if (wanted[kind] !== undefined && this.autopilot.state !== wanted[kind]) {
      this.trace(`autopilot: ${kind} prompt not sent, the handoff is ${this.autopilot.state} now`)
      return
    }
    this.trace(`autopilot: submitting the ${kind} prompt`)
    try {
      const result = await host.submit(text)
      if (result.drop !== undefined) {
        this.trace(`autopilot: the ${kind} prompt was dropped: ${result.drop}`)
        this.stepAutopilot({ kind: 'submitFailed', error: `prompt dropped: ${result.drop}` })
      }
    } catch (error) {
      this.stepAutopilot({ kind: 'submitFailed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Handoff Health, read once the notes are checked: what the handoff turn
   * left in each of the four places (the milestones, the project's docs,
   * CLAUDE.md, the notes), and whether a check ran in this context.
   */
  private recordHandoffHealth(isNotesWritten: boolean, notesAt: number | null = null, left: readonly Autopilot.BackgroundTask[] = this.autopilot.leftRunning): void {
    if (this.run === null) return
    const p = this.progress()
    const ap = this.autopilot
    const services = left.filter(t => t.class === 'persistent')
    const ctx = { root: this.root, handoffFile: this.settings.autopilot.handoffFile }
    const from = this.handoffTurn.fromTurn
    const changed = from < 0 ? [] : this.activity.changeList().filter(f => f.lastTurn >= from)
    const isClaudeMd = (path: string) => /(^|[\\/])claude\.md$/i.test(path)
    const word: Record<string, string> = { passed: 'passing', failed: 'failing', running: 'running', blocked: 'blocked', background: 'in the background', stopped: 'stopped' }
    const checks = summarize(this.activity.validationRuns(), Date.now()).map(v => ({ label: v.label, status: word[v.status] ?? v.status }))
    const continuation = this.settings.autopilot.continuation
    const record: Handoff.HandoffRecord = {
      at: Date.now(),
      fromSession: Chain.currentSession(this.run)?.index ?? 1,
      toSession: null,
      via: continuation === 'compact' ? 'compact' : continuation === 'manual' ? 'manual' : 'clear',
      health: Handoff.healthOf({
        hasPlan: p.total > 0,
        isPlanUpdated: this.handoffTurn.isPlanUpdated,
        current: p.current === null ? null : { key: p.current.key, subject: p.current.subject },
        isPlanSettled: p.total > 0 && this.plan().tasks.every(t => t.status === 'completed' || Plan.isHeld(t.status)),
        next: p.next === null ? null : { subject: p.next.subject },
        isNotesWritten,
        handoffFile: this.settings.autopilot.handoffFile,
        docsEdited: changed.filter(f => groupOf(f.path, ctx) === 'docs' && !isClaudeMd(f.path)).map(f => f.path),
        checks,
        isClaudeMdEdited: changed.some(f => isClaudeMd(f.path)),
        // A handoff that waited for background work: whether the notes were written again after it ended.
        // Of the tasks it waited for, the ones that ended before it went on (the rest are left running).
        background:
          ap.waitedFor - (left.length - services.length) <= 0 || ap.backgroundEndedAt === null
            ? null
            : { tasks: ap.waitedFor - (left.length - services.length), isNotesAfter: notesAt !== null && notesAt >= ap.backgroundEndedAt - 1000 },
        left: left.length === 0 ? null : { services: services.length, work: left.length - services.length, names: left.map(t => t.description).join('; ') },
        evidence: this.evidenceFacts(),
      }),
      currentKey: p.current?.key ?? null,
      currentSubject: p.current?.subject ?? null,
      done: p.done,
      total: p.total,
      continuity: null,
      ...(left.length === 0 ? {} : { leftRunning: left.map(t => ({ id: t.id, description: t.description, class: t.class ?? 'unknown', endedAt: null, status: null })) }),
    }
    this.run = { ...this.run, lastHandoff: record }
    this.persistRun()
    this.publisher.mark('pane')
  }

  /** Handoff Health's evidence item: the verified milestones with files, and those whose verification is stale. */
  private evidenceFacts(): Handoff.HealthFacts['evidence'] {
    const kept = this.evidence().snapshots.filter(s => s.files.length > 0)
    if (kept.length === 0) return null
    const stale = kept.filter(s => s.status === 'stale')
    return { verified: kept.length, stale: stale.map(s => s.subject), rerun: [...new Set(stale.flatMap(s => s.checks.map(c => c.label)))] }
  }

  /**
   * Continuity, read when the first turn of the context after a handoff
   * ends: the notes read, the run state restored, the milestone picked up
   * again, the project's docs read, the work resumed. One toast says how it went.
   */
  private checkContinuity(): void {
    const run = this.run
    const h = run?.lastHandoff
    if (run === null || h === undefined || h === null || h.toSession === null || h.continuity !== null) return
    const index = Chain.currentSession(run)?.index ?? 1
    if (h.toSession !== index) return
    const p = this.progress()
    const ctx = { root: this.root, handoffFile: this.settings.autopilot.handoffFile }
    const continuity = Handoff.continuityOf(
      {
        handoffFile: this.settings.autopilot.handoffFile,
        reads: this.reads,
        isDoc: path => groupOf(path, ctx) === 'docs',
        isPlanUpdated: this.plan().session >= index && this.plan().updatedAt !== null,
        tasks: this.plan().tasks.map(t => ({ key: t.key, subject: t.subject, status: t.status })),
        done: p.done,
        current: p.current === null ? null : { key: p.current.key, subject: p.current.subject },
        edits: this.activity.items.filter(i => i.kind === 'edit' && i.status === 'ok' && i.agentId === null).length,
        checks: this.activity.validationRuns().length,
      },
      h,
    )
    this.run = { ...run, lastHandoff: { ...h, continuity } }
    this.persistRun()
    this.publisher.mark('pane')
    if (this.settings.ui.toasts) this.host?.toast(Handoff.continuityToast(continuity), 6000)
  }

  private async verifyHandoff(): Promise<{ isOk: boolean; mtimeMs: number | null }> {
    const host = this.host
    if (host === null) return { isOk: false, mtimeMs: null }
    const ap = this.autopilot
    const since = ap.handoffSince ?? 0
    try {
      const stat = await host.stat(this.handoffPath(), false)
      const isOk = stat.kind === 'file' && stat.size > 0 && stat.mtimeMs >= since - NOTES_SLACK_MS
      // After a wait for background work: were the notes written again once it ended (its result recorded)?
      const after = ap.backgroundEndedAt === null ? '' : `; ${stat.mtimeMs >= ap.backgroundEndedAt - 1000 ? 'updated' : 'not updated'} after the background work ended`
      this.trace(`autopilot: notes ${this.handoffPath()} ${isOk ? 'written' : 'not fresh'} (${stat.size} bytes, modified ${Math.round((stat.mtimeMs - since) / 1000)} s after the handoff began${after})`)
      return { isOk, mtimeMs: stat.mtimeMs }
    } catch {
      this.trace(`autopilot: notes ${this.handoffPath()} not found`)
      return { isOk: false, mtimeMs: null }
    }
  }

  /** The notes as a look at the disk finds them, against the handoff that began at `since` (null: none began in this context), and when they were last written. */
  private async lookAtNotes(since: number | null): Promise<{ state: Autopilot.NotesState; mtimeMs: number | null }> {
    const host = this.host
    if (host === null) return { state: 'missing', mtimeMs: null }
    try {
      const stat = await host.stat(this.handoffPath(), false)
      if (stat.kind !== 'file') return { state: 'missing', mtimeMs: null }
      const state: Autopilot.NotesState = stat.size <= 0 ? 'empty' : since === null ? 'present' : stat.mtimeMs >= since - NOTES_SLACK_MS ? 'fresh' : 'stale'
      return { state, mtimeMs: stat.mtimeMs }
    } catch {
      return { state: 'missing', mtimeMs: null }
    }
  }

  private async notesState(since: number | null): Promise<Autopilot.NotesState> {
    return (await this.lookAtNotes(since)).state
  }

  /**
   * Control Room's /clear. `$.command.run` resolves when the command has run,
   * which in the interactive terminal is before the engine has reset the
   * session; the Desktop host protocol resets first. Either way the fresh
   * session is waited for, so it is recognised as ours (handoff recorded,
   * fresh context seeded) and the continuation goes into it, numbered for it.
   */
  private async runClear(): Promise<void> {
    const host = this.host
    if (host === null || this.autopilot.state !== 'clearing') return
    // Never in the middle of a turn: a prompt the person queued may have started as the handoff turn ended.
    if (this.turn.isRunning) {
      this.isClearOwed = true
      this.trace('autopilot: a turn is running, the clear waits for it to end')
      return
    }
    this.trace('autopilot: running /clear')
    const cleared = await this.clearOwn()
    if (!cleared.ok) {
      this.stepAutopilot({ kind: 'clearFailed', error: cleared.error })
      return
    }
    this.stepAutopilot({ kind: 'clearDone', now: await this.engineNow() })
  }

  /**
   * Project Sentinel's own /clear. The fresh session is waited for (its `classic.SessionStart{clear}`,
   * or a changed session id), so it is recognised as ours: the context that ended is recorded, the
   * fresh context seeded, and what follows goes into it.
   */
  private async clearOwn(): Promise<{ ok: true } | { ok: false; error: string }> {
    const host = this.host
    if (host === null) return { ok: false, error: 'not bound' }
    const before = await host.sessionId().catch(() => null)
    let isSeen = false
    const seen = new Promise<void>(resolve => {
      this.onOwnClearSeen = () => {
        isSeen = true
        resolve()
      }
    })
    this.isOwnClear = true
    const settle = () => {
      this.isOwnClear = false
      this.onOwnClearSeen = null
    }
    try {
      await host.clearContext()
    } catch (error) {
      settle()
      return { ok: false, error: error instanceof Error ? clean(error.message, 160) : String(error) }
    }
    if (!isSeen) await Promise.race([seen, new Promise<void>(resolve => host.after(LIMITS.clearSettleMs, resolve))])
    settle()
    // Without the fresh session's start, a new session id still proves the clear happened.
    const after = isSeen ? null : await host.sessionId().catch(() => null)
    if (!isSeen && (after === null || after === before)) return { ok: false, error: 'the context was not cleared' }
    return { ok: true }
  }

  /** Why the fresh context Project Sentinel is starting outside a handoff exists (a fresh wake, the Cold Resume Guard); null otherwise. */
  freshPurpose: FreshPurpose | null = null

  /** True from a fresh start's /clear until its first prompt has gone. */
  isFreshStarting = false

  /**
   * A fresh context outside a handoff: a watcher's fresh wake, or the Cold Resume Guard's Start fresh.
   * The resume state was checked healthy by the caller. Never while a turn runs or a handoff is under
   * way; nothing is cleared when the clear is refused.
   */
  async freshStart(purpose: FreshPurpose): Promise<{ ok: true } | { ok: false; error: string }> {
    const host = this.host
    const ap = this.settings.autopilot.enabled ? this.autopilot.state : 'off'
    if (host === null) return { ok: false, error: 'not bound' }
    if (this.turn.isRunning) return { ok: false, error: 'a turn is running' }
    if (ap !== 'off' && ap !== 'armed') return { ok: false, error: 'a handoff is under way' }
    this.isFreshStarting = true
    this.freshPurpose = purpose
    this.trace(`ops: running /clear for a ${purpose.endNote}`)
    const cleared = await this.clearOwn()
    this.freshPurpose = null
    if (!cleared.ok) {
      this.isFreshStarting = false
      this.trace(`ops: the clear for a ${purpose.endNote} failed: ${cleared.error}`)
      return cleared
    }
    // The fresh context gets Autopilot's room to work, as after a handoff.
    if (this.settings.autopilot.enabled) this.stepAutopilot({ kind: 'externalClear' })
    const text = prompts.freshResumePrompt({ sessionNumber: this.run === null ? 1 : (Chain.currentSession(this.run)?.index ?? 1), handoffPath: this.handoffPath(), why: purpose.why, then: purpose.then })
    host.after(400, () => {
      void host
        .submit(text)
        .then(r => {
          this.trace(r.drop !== undefined ? `ops: the fresh resume prompt was dropped: ${r.drop}` : `ops: the fresh context's first prompt went (${purpose.endNote})`)
        })
        .catch(error => this.trace(`ops: the fresh resume prompt failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.isFreshStarting = false
        })
    })
    return { ok: true }
  }

  /** The status bar's headline, as the panel's Agents card names the main conversation. */
  hudHeadline(): HudHeadline {
    return headlineOf(this, Date.now(), null)
  }

  private async runCompact(): Promise<void> {
    const host = this.host
    if (host === null) return
    const instructions = `Context Autopilot handoff: keep the current task, its state, decisions, unfinished work and where the handoff notes are (${this.handoffPath()}).`
    try {
      const result: SessionCompactResult = await host.compact(instructions)
      if (result.skip !== undefined) {
        this.stepAutopilot({ kind: 'compactFailed', error: result.skip })
        return
      }
      if (this.run !== null) {
        this.run = Chain.recordTransition(this.run, { kind: 'handoff-compact', at: await host.now(), tokensBefore: result.tokensBefore ?? null, tokensAfter: result.tokensAfter ?? null })
        this.persistRun()
      }
      // Claude Code does not run this plugin's own session.compact hook for its own compaction.
      this.afterCompaction(result)
      this.stepAutopilot({ kind: 'compactDone', now: await this.engineNow() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A headless or SDK session (Desktop's host protocol among them) compacts only inside a turn:
      // `$.session.compact` refuses there (seen live, Claude Code 2.1.295); /compact, run as a command, does it.
      if (isTurnOnlyCompact(message)) return this.compactByCommand(instructions)
      this.stepAutopilot({ kind: 'compactFailed', error: clean(message, 160) })
    }
  }

  /** While the handoff's compaction runs as /compact: since when (the engine's compaction then finishes the step). */
  private compactByCommandSince: number | null = null

  /** The handoff's compaction as the /compact command, where the session compacts only inside a turn. */
  private async compactByCommand(instructions: string): Promise<void> {
    const host = this.host
    if (host === null || this.autopilot.state !== 'compacting') return
    this.trace('autopilot: this session compacts only inside a turn: running /compact')
    const since = this.clock()
    this.compactByCommandSince = since
    // A compaction that never comes (the command refused or failing) must not leave the handoff hanging.
    host.after(LIMITS.compactByCommandMs, () => {
      if (this.compactByCommandSince !== since || this.autopilot.state !== 'compacting') return
      this.compactByCommandSince = null
      this.stepAutopilot({ kind: 'compactFailed', error: '/compact did not compact the context' })
    })
    try {
      await host.compactCommand(instructions)
    } catch (error) {
      if (this.compactByCommandSince !== since) return
      this.compactByCommandSince = null
      this.stepAutopilot({ kind: 'compactFailed', error: error instanceof Error ? clean(error.message, 160) : String(error) })
    }
  }

  // -------------------------------------------------------------------------
  // Prompts and turns

  /**
   * Context added to a submitted prompt: the notes waiting for Claude (app/notes.ts), the machine's
   * load when it changed since Claude was last told, a reminder of a pending handoff, and the
   * policies themselves where the system prompt's hook is not reached. Part of the prompt's own
   * message, so the conversation reads the same at every later request.
   */
  onPromptSubmit(text: string, origin: PromptOrigin | undefined, turnId?: string, at: number = this.clock()): string[] {
    const context: string[] = []
    const isOwn = isOwnPrompt(origin)
    this.noteActivity()
    // Without a running turn the prompt starts the next one: a notification's is that turn's whatever its text.
    if (turnId === undefined) this.nextTurn = origin?.kind === 'task-notification' ? 'notification' : null
    if (origin?.kind === 'task-notification') {
      // Claude Code's own word that a background task ended (completed, failed, killed), as it is delivered.
      const task = Autopilot.notificationTask(text)
      this.trace(`background: a task notification ${turnId === undefined ? 'starts a turn' : `is delivered into turn ${turnId}`}${task === null ? '' : ` (${task.id}${task.status === null ? '' : `, ${task.status}`})`}`)
      if (task !== null) this.noteTaskEnded(task.id, task.status, 'its notification', at)
      // A workflow run's task ended: its agents with no end of their own seen end with it.
      if (task?.toolUseId !== undefined) this.ops.noteWorkflowEnd(task.toolUseId, task.status)
      const hold = this.backgroundHoldNote()
      if (hold !== null) context.push(hold)
    }
    if (!isOwn && isPersonOrigin(origin)) {
      this.turn.request = text
      this.noteObjective(text)
      if (this.autopilot.state === 'pending') context.push(prompts.pendingPromptReminder())
      this.planRoute(text)
    }
    const now = this.clock()
    for (const note of this.notesBox.take('prompt', now)) context.push(this.delivered(note.kind, note.text, 'prompt'))
    const load = this.pressureNote(now)
    if (load !== null) context.push(this.delivered('pressure', load, 'prompt'))
    // Answers from the Decision Inbox that did not block ride whichever prompt goes next.
    context.push(...this.ops.onPromptSubmit(origin, text))
    // After a handoff that compacted instead of clearing: what still runs, with the first prompt after it.
    const left = this.autopilot.leftRunning
    if (left.length > 0 && (this.autopilot.state === 'resuming' || this.autopilot.state === 'armed') && origin?.kind !== 'task-notification') {
      const note = prompts.leftRunningNote(left)
      if (note !== null) context.push(note)
      this.stepAutopilot({ kind: 'leftRunningTold' })
    }
    if (isOwn) return context
    const isComposeMissing = !this.compose.isReached && (this.composeObserved || this.compose.isLikelyBypassed)
    if (isComposeMissing && !this.compose.deliveredFallback) {
      const policy = policyText(this.policies())
      if (policy !== null) {
        context.push(policy)
        this.compose.deliveredFallback = true
        this.ledger.fallbackDelivered(now, this.settings.frontier.enabled)
        this.trace(`policy: delivered as the prompt's context (the system prompt's hook was not reached), fingerprint ${fingerprint(policy)}`)
      }
    }
    return context
  }

  /**
   * Something Claude must read outside its system prompt. It waits for the next batch of tool
   * results of a running turn, or for the next prompt; a newer note of the same kind replaces it.
   * Nothing is appended to the transcript (app/notes.ts says why).
   */
  tell(kind: NoteKind, text: string): void {
    this.notesBox.put({ kind, text, at: this.clock() })
    this.trace(`note: ${kind} waits for ${this.turn.isRunning ? 'the next batch of tool results' : 'the next prompt'} (${this.notesBox.count()} waiting)`)
    this.publisher.mark('pane')
  }

  /** classic.PostToolBatch on the main conversation: what waits goes with this batch's results. */
  notesForBatch(): string[] {
    const now = this.clock()
    const out = this.notesBox.take('tool-batch', now).map(n => this.delivered(n.kind, n.text, 'tool-batch'))
    const load = this.pressureNote(now)
    if (load !== null) out.push(this.delivered('pressure', load, 'tool-batch'))
    return out
  }

  /** Bookkeeping as a note leaves: the ledger learns which policies Claude now reads, the trace says where it went. */
  private delivered(kind: NoteKind, text: string, channel: 'tool-batch' | 'prompt'): string {
    const now = this.clock()
    if (kind === 'policies') {
      // A held-policies note names the policies in force: Frontier Max is in force when its section is in it.
      this.ledger.noteDelivered(now, text.includes('## Frontier Max'))
      this.cache.isHeldNoteSent = !text.includes('apply again as written')
    }
    if (kind === 'pressure') this.resourceStats.noticesSent += 1
    if (kind === 'queue' || kind === 'answers' || kind === 'agents') this.ops.onNoteDelivered(kind)
    this.trace(`note: ${kind} delivered with the ${channel === 'tool-batch' ? 'batch of tool results' : 'prompt'} (${text.length} chars)`)
    this.publisher.mark('pane', 'resources')
    return text
  }

  /**
   * What Claude should hear about the machine's load now, if that changed since it was last told:
   * that it is over a ceiling (or critical), or back under them. Read at each delivery, so load that
   * rose and fell between two batches of tool results is never mentioned at all.
   */
  private pressureNote(now: number): string | null {
    const ceilings = this.effective().resources.ceilings
    const p = this.monitor.pressure
    if (ceilings === null) {
      this.pressureTold = 'ok'
      return null
    }
    if (p.level === 'unknown') return null
    const want: 'ok' | 'high' | 'critical' = p.level === 'critical' ? 'critical' : p.level === 'high' ? 'high' : 'ok'
    if (want === this.pressureTold) return null
    // Going back to calm says so only after a while over: a notice and its all-clear never come back to back.
    if (want === 'ok' && now - this.pressureToldAt < LIMITS.pressureNoticeGapMs) return null
    if (want === 'high' && this.pressureTold === 'critical') {
      // Easing from critical to high changes nothing Claude should do.
      this.pressureTold = 'high'
      return null
    }
    this.pressureTold = want
    this.pressureToldAt = now
    if (want === 'ok') return prompts.pressureRecoveredNotice({ cpu: p.cpu, ram: p.ram })
    const background = [...this.activity.background.values()].map(b => `${b.id} (${b.label})`).slice(0, 4)
    if (this.settings.ui.toasts) this.host?.toast(`Machine load ${p.level}: Claude was asked to ease off`, 5000)
    return prompts.pressureNotice({ level: p.level, cpu: p.cpu, ram: p.ram, cpuCeiling: ceilings.cpu, ramCeiling: ceilings.ram, backgroundTasks: background })
  }

  /** True once a request went out, so an unreached compose hook means it is bypassed. */
  composeObserved = false

  /** When the session's usage was last read for the plan's rate-limit windows (the cache's default lifetime). */
  private planCheckedAt = 0
  /** When the session's cost was last read mid-turn for the run budget. */
  private budgetCostAt = 0

  /**
   * The run's objective: the person's latest substantial request (a short
   * "yes" or "continue" keeps the one before), cut to its first sentence.
   * An objective Claude stated with its milestones holds while any of them is
   * open: a request made meanwhile is part of that work, and Claude states
   * another objective with its milestones when it starts other work.
   */
  private noteObjective(text: string): void {
    if (this.run === null) return
    const objective = Plan.objectiveOf(text)
    if (objective === null) return
    const isSubstantial = text.trim().length >= 40 || this.run.objective === undefined || this.run.objective === null
    if (!isSubstantial || this.run.objective === objective) return
    if (this.run.objectiveBy === 'claude' && this.plan().tasks.some(t => t.status !== 'completed')) return
    this.run = { ...this.run, objective, objectiveBy: 'person' }
    this.persistRun()
    this.publisher.mark('activity', 'hud')
  }

  /** Claude's milestones for this run. */
  plan(): Plan.Plan {
    return this.run?.plan ?? Plan.emptyPlan()
  }

  progress(): Plan.Progress {
    return Plan.progressOf(this.plan())
  }

  private planRoute(text: string): void {
    const eff = this.effective()
    if (!eff.router.isMainLoop) {
      this.router.turnModel = null
      return
    }
    const { cls } = classifyTask(text)
    const decision = routeMain({
      router: this.settings.router,
      cls,
      sessionModel: this.sessionModel,
      contextTokens: this.usage.tokens ?? 0,
      isFrontier: eff.frontier.isActive,
      unavailable: this.router.unavailable,
      known: this.router.known,
      cache: { isWarm: CacheModel.warmthOf(this.cache.state, this.clock()) === 'warm', cachedTokens: this.cache.state.lastPrefix },
    })
    this.router.turnModel = decision.model
    this.router.lastDecision = decision.why
    this.publisher.mark('pane', 'hud')
  }

  /**
   * A background task ended, as Claude Code reported it: its notification, or a TaskStop that stopped
   * it. The list of work in flight (the last Stop's) drops it, and a handoff waiting for it hears.
   */
  noteTaskEnded(id: string, status: string | null, via: string, now: number): void {
    this.activity.backgroundEnded(id)
    if (this.lastStop !== null && this.lastStop.background.some(b => b.id === id)) {
      this.lastStop = { ...this.lastStop, background: this.lastStop.background.filter(b => b.id !== id) }
    }
    this.trace(`background: ${id} ended${status === null ? '' : ` (${status})`}, as ${via} says`)
    // Work the last handoff left running: its end is the run's record now (its result reached this context).
    const h = this.run?.lastHandoff
    if (this.run !== null && h !== undefined && h !== null) {
      const next = Handoff.noteLeftEnded(h, id, status, now)
      if (next !== h) {
        this.run = { ...this.run, lastHandoff: next }
        this.persistRun()
        this.trace(`background: ${id}, left running by the last handoff, ended here (${status ?? 'ended'})`)
      }
    }
    if (this.settings.autopilot.enabled) this.stepAutopilot({ kind: 'backgroundEnded', id, status, now })
    this.publisher.mark('hud', 'activity', 'pane', 'resources')
  }

  /** While a written handoff waits for background work: what Claude is asked to do with a task's result as it comes in. */
  private backgroundHoldNote(): string | null {
    if (!this.settings.autopilot.enabled || this.autopilot.state !== 'waiting-background') return null
    return prompts.backgroundResultNote({
      handoffFile: this.settings.autopilot.handoffFile,
      planTool: this.planSource === 'milestones' ? this.milestonesTool : this.planSource === 'tasks' ? 'your task list' : null,
      // What the handoff still waits for: a server running beside it is not.
      left: Autopilot.blockingOf(this.autopilot.background).map(t => t.description),
    })
  }

  async onTurnStart(input: { turnId: string; text: string }): Promise<void> {
    // Whose turn this is: Control Room's own prompts are recognised by their text; a background task's
    // notification by the origin its prompt was submitted with (its text, the engine's own frame, as a fallback).
    const begun = this.nextTurn
    this.nextTurn = null
    const isNotification = begun === 'notification' || Autopilot.notificationTask(input.text) !== null
    const kind: TurnKind = prompts.ownPromptKind(input.text) ?? (isNotification ? 'notification' : input.text === '' ? 'other' : 'person')
    this.lastStop = null
    this.noteActivity()
    this.turn = {
      id: input.turnId,
      isRunning: true,
      kind,
      // A notification's text is the engine's report, not a request: the person's last request stays the one the guard reads.
      request: kind === 'person' ? input.text || this.turn.request : kind === 'notification' ? this.turn.request : input.text,
      toolCount: 0,
      editCount: 0,
    }
    if (kind !== 'person') this.router.turnModel = null
    this.cache.turnStarted()
    const host = this.host
    if (host !== null) void host.listTools().then(tools => this.cache.noteTools(tools.map(t => t.name))).catch(() => undefined)
    this.guard.turnBlocks = 0
    this.guard.lastBlockedAnswer = ''
    this.activity.turnStarted(Date.now())
    this.turnStartDone = this.progress().done
    if (kind === 'handoff') this.handoffTurn = { fromTurn: this.activity.turn.index, isPlanUpdated: false }
    this.questGreen.clear()
    this.ops.onTurnStart()
    this.publisher.mark('hud', 'pane', 'activity', 'spinner', 'ops')
    this.trace(`turn ${input.turnId} started (${kind})`)
    // The handoff and the continuation move on when their own turns begin, not when their prompts were sent.
    if (kind === 'handoff' || kind === 'continuation' || (kind === 'person' && this.autopilot.state === 'resuming')) {
      const now = host === null ? Date.now() : await this.engineNow()
      this.stepAutopilot(kind === 'handoff' ? { kind: 'handoffStarted', now, turnId: input.turnId } : kind === 'continuation' ? { kind: 'continuationStarted', now } : { kind: 'personTookOver', now })
    }
  }

  /** turn.step, before the request: the model and effort to send. */
  stepRequest(e: TurnStepInput): { model?: string; effort?: TurnStepInput['effort'] } {
    this.composeObserved = true
    if (e.agentId === undefined) this.noteActivity()
    else this.ops.noteAgentStep(e.agentId)
    const out: { model?: string; effort?: TurnStepInput['effort'] } = {}
    const eff = this.effective()
    const isMain = e.agentId === undefined
    if (isMain && this.router.turnModel !== null && eff.router.isMainLoop && this.router.turnModel !== e.model) {
      out.model = this.router.turnModel
    }
    if (isMain && e.index === 0) {
      // A turn the router sends to another model than the last one (or back from one) rebuilds the cache: the router's doing.
      const sending = out.model ?? e.model
      const last = this.cache.state.model
      if (last !== null && sending !== last && (out.model !== undefined || this.router.wasRouted)) {
        this.cache.noteRouted(last, sending, out.model !== undefined ? (this.router.lastDecision ?? 'routed') : 'back to the session model')
      }
      this.router.wasRouted = out.model !== undefined
    }
    const wantsEffort = eff.frontier.effort !== null && (isMain || this.settings.frontier.subagentEffort)
    if (wantsEffort) {
      if (e.effort === undefined) {
        if (isMain) this.frontier.isEffortSupported = false
      } else if (typeof e.effort === 'string') {
        out.effort = eff.frontier.effort ?? e.effort
        if (isMain) {
          this.frontier.isEffortSupported = true
          this.frontier.lastEffort = out.effort ?? null
        }
      }
    } else if (isMain && typeof e.effort === 'string') {
      this.frontier.lastEffort = e.effort
    }
    if (isMain) {
      const effort = out.effort ?? e.effort
      const effortWord = typeof effort === 'string' ? effort : typeof effort === 'number' ? String(effort) : null
      this.cache.stepStarted(`${e.turnId}:${e.index}`, effortWord)
      this.ledger.stepStarted({
        key: `${e.turnId}:${e.index}`,
        at: this.clock(),
        turnId: e.turnId,
        step: e.index,
        model: out.model ?? e.model,
        effort: effortWord,
        effortAsked: eff.frontier.effort,
      })
    }
    return out
  }

  /** turn.step, after the response: live context, model learning, mid-turn autopilot. */
  stepResponse(e: TurnStepInput, sent: { model?: string }, result: TurnStepResult): void {
    if (result.usage !== null) {
      const family = familyOf(result.usage.model)
      if (family !== null && this.router.known.get(family) !== result.usage.model) {
        this.router.known.set(family, result.usage.model)
        this.publisher.mark('pane')
      }
    }
    if (e.agentId !== undefined) {
      if (result.usage !== null) this.ops.noteAgentModel(e.agentId, result.usage.model)
      return
    }
    const record = this.ledger.stepEnded(`${e.turnId}:${e.index}`, { sessionId: this.sessionId, frontierOn: this.settings.frontier.enabled })
    if (record !== null) {
      this.trace(`policy: ${recordLine(record)}`)
      if (record.n === 1 || record.frontierDelivered !== this.lastFrontierDelivered) this.publisher.mark('pane')
      this.lastFrontierDelivered = record.frontierDelivered
    }
    if (sent.model !== undefined && result.usage === null && result.stopReason === null) {
      const family = familyOf(sent.model)
      this.router.unavailable.add(family ?? sent.model)
      if (family !== null) this.router.known.delete(family)
      this.router.turnModel = null
      this.router.lastDecision = `${sent.model} was refused — the session model is kept`
      this.publisher.mark('pane', 'hud')
    }
    if (result.usage === null) return
    const u = result.usage
    this.cache.stepAnswered(`${e.turnId}:${e.index}`, u)
    // The plan's rate-limit windows arrive with the first response: with the lifetime unknown, look once a minute at most.
    if (this.cache.state.ttl === null && !this.cache.isPlan && Date.now() - this.planCheckedAt > 60_000) {
      this.planCheckedAt = Date.now()
      void this.refreshUsage()
    }
    const tokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
    this.usage = { ...this.usage, tokens, pct: this.usage.window ? Math.round((100 * tokens) / this.usage.window) : this.usage.pct }
    if (this.run !== null) this.run = Chain.measure(this.run, { tokens, window: this.usage.window, costUsd: undefined }, Date.now())
    this.publisher.mark('hud')
    // A cost limit is checked as Claude works: Claude Code measures the session's cost after the turn, not
    // after each step (seen live: one measurement in a 13-step turn), and Finish the milestone must act mid-turn.
    if (result.stopReason === 'tool_use' && this.ops.isCostWatched() && this.clock() - this.budgetCostAt >= BUDGET_COST_EVERY_MS) {
      this.budgetCostAt = this.clock()
      void this.refreshUsage().then(() => this.ops.checkBudget())
    }
    if (result.stopReason === 'tool_use' && this.settings.autopilot.enabled) {
      this.stepAutopilot({ kind: 'context', tokens, window: this.usage.window, isInTurn: true, now: Date.now() })
    }
  }

  async onTurnComplete(input: { agentId: string | undefined; reason: 'answer' | 'aborted' | 'refusal' | 'error'; answer: string }): Promise<void> {
    if (input.agentId !== undefined) {
      this.ops.noteAgentEnd(input.agentId, input.reason, input.answer)
      void this.refreshAgents()
      return
    }
    this.turn = { ...this.turn, isRunning: false }
    this.noteActivity()
    this.activity.turnEnded()
    if (this.run !== null) this.run = Chain.countTurn(this.run, Date.now())
    if (input.reason === 'answer') this.planUsage = PlanUsage.noteAnswered(this.planUsage)
    await this.refreshUsage(false, input.reason === 'answer')
    const host = this.host
    const now = host === null ? Date.now() : await this.engineNow()
    // A turn whose start this runtime never saw began before a reload of the plugin.
    const turnKind: TurnKind = this.turn.id === null ? 'unknown' : this.turn.kind
    // What Claude Code listed in flight as this turn stopped (its Stop comes before turn.complete); none seen: an interrupt.
    const inFlight = this.lastStop?.background ?? null
    this.trace(`turn ${this.turn.id ?? '?'} completed (${turnKind}, ${input.reason}; background in flight: ${inFlight === null ? 'no Stop seen' : inFlight.length === 0 ? 'none' : inFlight.map(b => b.id).join(', ')})`)
    // A fresh context's turn that ended without starting work: it is read in now, room counts from here.
    this.noteWorkStarted()
    // A handoff turn that stops under background work waits for it (waiting-background); while it waits,
    // the first turn of any kind to end with nothing in flight finishes it (features/autopilot.ts).
    this.stepAutopilot({ kind: 'turnComplete', reason: input.reason, turn: turnKind, now, background: inFlight })
    // A clear held back while this turn ran (one the person queued behind the handoff) is carried out now.
    if (this.isClearOwed && this.autopilot.state === 'clearing') {
      this.isClearOwed = false
      host?.after(LIMITS.clearDelayMs, () => void this.runClear())
    }
    if (this.autopilot.state === 'armed' && input.reason !== 'aborted' && this.usage.tokens !== undefined) {
      this.stepAutopilot({ kind: 'context', tokens: this.usage.tokens, window: this.usage.window, isInTurn: false, now })
    }
    this.cache.turnEnded(this.clock())
    this.checkContinuity()
    if (Date.now() - this.evidenceCheckedAt >= Evidence.EVIDENCE_CHECK_EVERY_MS) void this.checkEvidence('turn end')
    void this.refreshGit()
    this.persistRun()
    // The run's boundary: queued work, answers and a due watcher go out from here, one at a time.
    this.ops.onTurnEnd({ reason: input.reason, kind: turnKind })
    this.publisher.mark('hud', 'pane', 'activity', 'spinner', 'chain', 'ops')
  }

  onMeasure(input: Pick<SessionUsage, 'context' | 'cost'> & { rateLimits?: readonly PlanUsage.RateLimitReading[]; changed?: readonly string[] }): void {
    this.applyUsage(input)
    if (input.rateLimits !== undefined) this.notePlanUsage(input.rateLimits)
    // The session's cost grew with no turn of the conversation running: Claude Code sent a request of its own.
    if (input.changed?.includes('cost') === true && !this.turn.isRunning) this.cache.noteSideRequest(this.clock())
  }

  onCompacted(trigger: string, result: SessionCompactResult): void {
    // The handoff's own /compact (a session that compacts only inside a turn) finishing.
    const isHandoffCompact = this.compactByCommandSince !== null && this.autopilot.state === 'compacting' && trigger !== 'precompute'
    if (isHandoffCompact) this.compactByCommandSince = null
    if (result.skip !== undefined) {
      if (isHandoffCompact) this.stepAutopilot({ kind: 'compactFailed', error: result.skip })
      return
    }
    if (trigger === 'auto') this.stepAutopilot({ kind: 'engineCompacted' })
    if (this.run !== null && trigger !== 'precompute' && trigger !== 'plugin') {
      this.run = Chain.recordTransition(this.run, {
        kind: isHandoffCompact ? 'handoff-compact' : trigger === 'auto' ? 'auto-compact' : 'compact',
        at: Date.now(),
        tokensBefore: result.tokensBefore ?? null,
        tokensAfter: result.tokensAfter ?? null,
      })
      this.persistRun()
    }
    this.afterCompaction(result)
    if (isHandoffCompact) this.stepAutopilot({ kind: 'compactDone', now: Date.now() })
    // A compaction the Cold Resume Guard asked for: the message it held goes now.
    if (!isHandoffCompact && trigger !== 'auto') this.ops.onCompacted()
  }

  /**
   * What any compaction changes here: the context's size, the cache (the next request rebuilds it, a
   * lifecycle cost), and the notes about the old system prompt. Project Sentinel's own compactions
   * (`$.session.compact`) call it themselves: Claude Code does not run the calling plugin's own
   * `session.compact` hook for them ("skipped: re-entry", seen live).
   */
  afterCompaction(result: { tokensAfter?: number }): void {
    this.compose.deliveredFallback = false
    // The system prompt is composed afresh after a compaction: a note about the held section means nothing now.
    this.notesBox.drop('policies')
    this.usage = { ...this.usage, tokens: result.tokensAfter ?? undefined }
    this.cache.noteCompact(this.clock())
    this.publisher.mark('hud', 'chain')
  }

  // -------------------------------------------------------------------------
  // System prompt

  /**
   * Project Sentinel's section of the system prompt, for one composition. A composition that only
   * measures the prompt (`/context`: the `analysis` trait) sends nothing: it gets the section, so the
   * figures are right, but it is neither evidence of delivery nor a change to the cache's state.
   */
  composeSection(outputStyle?: { name: string } | null, traits: readonly string[] = []): { id: string; text: string; scope: 'session' } | null {
    const isAnalysis = traits.includes('analysis')
    const native = outputStyle === undefined || outputStyle === null ? null : clean(outputStyle.name, 60) || null
    if (isAnalysis) {
      const current = this.cache.deliveredPolicy() ?? policyText(this.policies()) ?? ''
      return current === '' ? null : { id: POLICY_SECTION_ID, text: current, scope: 'session' }
    }
    this.compose.isReached = true
    if (native !== this.nativeOutputStyle) {
      this.nativeOutputStyle = native
      this.publisher.mark('pane')
    }
    // While the cache is warm, the section the system prompt already carries is sent again (stable policies).
    const { text, isHeld } = this.cache.policyText(policyText(this.policies()), native, this.policyReason)
    this.ledger.rendered(policyRenderOf(text, { at: this.clock(), isHeld, isLoaded: this.isLoaded }))
    this.rememberPolicy(text ?? '')
    return text === null ? null : { id: POLICY_SECTION_ID, text, scope: 'session' }
  }

  /** The section the system prompt carries, kept in `$.state` for a reload of the plugin (written only when it changes). */
  private memoText: string | null = null
  private rememberPolicy(text: string): void {
    const host = this.host
    if (host === null || this.sessionId === null || text === this.memoText) return
    this.memoText = text
    void host.savePolicyMemo({ sessionId: this.sessionId, text }).catch(() => {
      this.memoText = null
    })
  }

  // -------------------------------------------------------------------------
  // No-Lazy-Exit Guard

  async onStop(input: {
    stopHookActive: boolean
    lastMessage: string
    background: readonly { id: string; type: string; description: string; command?: string; agent_type?: string; name?: string }[]
    wakeups: readonly { schedule: string; recurring: boolean }[]
    permissionMode: string | undefined
  }): Promise<string | null> {
    if (input.permissionMode !== undefined) this.permissionMode = input.permissionMode
    this.noteActivity()
    // Claude Code's own list of the background work still running is the truth: a job that ended by
    // itself (or was stopped some other way) leaves the list kept from the tool results.
    const running = new Set(input.background.map(b => b.id))
    for (const id of [...this.activity.background.keys()]) if (!running.has(id)) this.activity.backgroundEnded(id)
    this.ops.noteStop(input.lastMessage)
    // Each task classified (features/background.ts): a server or a watcher never holds a handoff, the queue or the guard.
    const background = input.background.map(b => this.taskOf(b)).slice(0, 8)
    const persistent = background.filter(t => t.class === 'persistent')
    if (persistent.length > 0) this.trace(`background: not waited for (${persistent.map(t => `${t.id}: ${t.why ?? 'persistent'}`).join('; ')})`)
    this.lastStop = {
      background,
      wakeups: input.wakeups.map(w => ({ schedule: w.schedule, recurring: w.recurring })).slice(0, 8),
      isQuestion: endsWithQuestion(input.lastMessage),
      at: Date.now(),
    }
    this.publisher.mark('hud', 'activity')
    const eff = this.effective()
    if (!eff.guard.isActive) {
      if (this.settings.guard.enabled) this.trace(`guard: stands down (${eff.guard.reason ?? 'inactive'})`)
      return null
    }
    // A notification's turn is judged against the person's last request, as the turn of theirs it carries on.
    if (!['person', 'notification', 'continuation', 'queued', 'answer', 'wake', 'resume'].includes(this.turn.kind)) {
      this.trace(`guard: stands down for the ${this.turn.kind} turn`)
      return null
    }
    const threshold = Autopilot.handoffPoint(this.autopilot)
    if (this.settings.autopilot.enabled && threshold !== null && (this.usage.tokens ?? 0) >= threshold) {
      this.trace(`guard: stands down, the context is past the handoff point (${Math.round((this.usage.tokens ?? 0) / 1000)}k of ${Math.round(threshold / 1000)}k): the handoff comes first`)
      return null
    }
    const g = this.settings.guard
    if (this.guard.turnBlocks >= g.maxPerTurn || this.guard.sessionBlocks >= g.maxPerSession) return null
    if (input.stopHookActive && this.guard.lastBlockedAnswer !== '' && isRepeat(this.guard.lastBlockedAnswer, input.lastMessage)) return null

    const now = Date.now()
    let assessment = assessExit({
      request: this.turn.request.slice(-LIMITS.guardTextChars),
      answer: input.lastMessage.slice(-LIMITS.guardTextChars),
      toolCount: this.activity.turn.tools,
      editCount: this.activity.turn.files.size,
      strictness: g.strictness,
      // Work whose notification brings the turn back; a dev server never does, so it excuses no early stop.
      hasBackgroundWork: Autopilot.blockingOf(background).length > 0,
      permissionMode: this.permissionMode,
    })
    if (assessment.verdict === 'uncertain' && g.modelCheck) assessment = await this.classifyExit(assessment, input.lastMessage)
    this.guard.last = { ...assessment, at: now }
    this.publisher.mark('pane', 'hud')
    this.trace(`guard: ${assessment.verdict} the ${this.turn.kind} turn's end${assessment.reasons.length > 0 ? ` (${assessment.reasons.slice(0, 3).join('; ')})` : ''}`)
    if (assessment.verdict !== 'block') return null

    this.guard.turnBlocks += 1
    this.guard.sessionBlocks += 1
    this.guard.lastBlockedAnswer = input.lastMessage
    if (this.settings.ui.toasts) this.host?.toast(`Kept Claude going: ${assessment.reasons[0] ?? 'unfinished work'}`, 4000)
    return prompts.guardBlock({ reasons: assessment.reasons.slice(0, 3), items: assessment.items, attempt: this.guard.turnBlocks, max: g.maxPerTurn })
  }

  private async classifyExit(assessment: GuardAssessment, answer: string): Promise<GuardAssessment> {
    const host = this.host
    if (host === null || Guard.isConversational(this.turn.request, this.activity.turn.tools)) return { ...assessment, verdict: 'allow' }
    try {
      const label = await host.classify(
        prompts.guardClassifierText(this.turn.request.slice(-3000), answer.slice(-4000)),
        prompts.GUARD_CLASSIFIER_LABELS,
      )
      if (label === 'premature') return { ...assessment, verdict: 'block', reasons: [...assessment.reasons, 'model check: premature'] }
      return { ...assessment, verdict: 'allow', reasons: [...assessment.reasons, `model check: ${label ?? 'unclear'}`] }
    } catch {
      return { ...assessment, verdict: 'allow', reasons: [...assessment.reasons, 'model check unavailable'] }
    }
  }

  // -------------------------------------------------------------------------
  // Tools: permissions, resources, activity

  /** Whether an edit path lands inside the project root (null when it cannot be placed). */
  private rootReal: string | null = null

  private async isInsideProject(path: string): Promise<boolean | null> {
    const host = this.host
    if (host === null || this.root === '') return null
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (this.rootReal === null) {
      const rootStat = await host.stat(this.root, true).catch(() => null)
      this.rootReal = normalize(rootStat?.realPath ?? this.root)
    }
    const rootReal = this.rootReal
    const abs = /^([A-Za-z]:[\\/]|[\\/])/.test(path) ? path : `${this.cwd || this.root}/${path}`
    const own = await host.stat(abs, true).catch(() => null)
    let real = own?.realPath
    if (real === undefined) {
      const cut = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'))
      const dir = await host.stat(cut <= 0 ? abs : abs.slice(0, cut), true).catch(() => null)
      if (dir?.realPath === undefined) return null
      real = `${dir.realPath}/${abs.slice(cut + 1)}`
    }
    const r = normalize(real)
    return r === rootReal || r.startsWith(`${rootReal}/`)
  }

  private logPermission(entry: Omit<PermissionLogEntry, 'at'>): void {
    this.permissionLog = [{ ...entry, at: Date.now() }, ...this.permissionLog].slice(0, 40)
    this.publisher.mark('permissions')
  }

  /** tool.call, before: policy deny and resource gate. Returns a refusal, or null to run. */
  async beforeTool(tool: string, input: Record<string, unknown>, id: string, agentId: string | undefined): Promise<string | null> {
    await this.ensureLoaded()
    const isEdit = isEditTool(tool)
    const path = isEdit ? editPathOf(input) : null
    const inside = path === null ? null : await this.isInsideProject(path)
    const findings = findingsFor(tool, input, inside)
    const decision = decisionFor(findings, this.settings.permissions)
    if (decision.state === 'deny' && decision.category !== null) {
      this.permissionCounts.denied += 1
      this.logPermission({ tool, category: decision.category, state: 'deny', evidence: clean(decision.evidence, 120), outcome: 'denied' })
      this.activity.refused({ id, tool, input, agentId, now: Date.now(), status: 'denied', reason: `Permission Policy: ${PERMISSION_LABEL[decision.category]} is set to Deny` })
      this.publisher.mark('activity', 'hud')
      return denyMessage(decision)
    }
    if (isShellTool(tool)) {
      const command = typeof input.command === 'string' ? input.command : ''
      const refusal = this.gateHeavy(command)
      if (refusal !== null) {
        this.resourceStats.refused += 1
        this.logPermission({ tool, category: 'resources', state: 'deny', evidence: clean(command, 120), outcome: 'refused-heavy' })
        this.activity.refused({ id, tool, input, agentId, now: Date.now(), status: 'held', reason: 'Held back: the machine is busy and other heavy jobs are running' })
        this.publisher.mark('resources', 'activity', 'hud')
        return refusal
      }
    }
    if (decision.state === 'ask' && decision.category !== null) {
      const declined = await this.askFirst(tool, input, decision)
      if (declined !== null) {
        this.activity.refused({ id, tool, input, agentId, now: Date.now(), status: 'denied', reason: `Permission Policy: you declined ${PERMISSION_LABEL[decision.category].toLowerCase()}` })
        this.publisher.mark('activity', 'hud')
        return declined
      }
    }
    this.turn.toolCount += 1
    if (isEdit) this.turn.editCount += 1
    if (agentId === undefined) this.noteActivity()
    const item = this.activity.started({ id, tool, input, agentId, now: Date.now() })
    // A call in an agent's loop: what that agent is doing now.
    if (agentId !== undefined) this.ops.noteAgentCall(agentId, doingOf(item))
    this.publisher.mark('activity', 'spinner', 'hud')
    this.tickWhileRunning()
    return null
  }

  private ticker: { cancel: () => void } | null = null

  /** While a call runs, Activity's elapsed times and long-running notes refresh every few seconds. */
  private tickWhileRunning(): void {
    const host = this.host
    if (host === null || this.ticker !== null) return
    this.ticker = host.every(LIMITS.runningTickMs, () => {
      if (this.activity.runningItems().length === 0) {
        this.ticker?.cancel()
        this.ticker = null
      }
      this.publisher.mark('activity', 'hud')
    })
  }

  private gateHeavy(command: string): string | null {
    const ceilings = this.effective().resources.ceilings
    if (ceilings === null || heavyKinds(command).length === 0) return null
    const running = this.activity.runningHeavy()
    const gate = gateHeavy({ pressure: this.monitor.pressure, ceilings, running: running.length })
    if (gate.isAllowed) return null
    return prompts.heavyCommandRefusal({
      reason: gate.reason,
      cpu: this.monitor.pressure.cpu,
      ram: this.monitor.pressure.ram,
      running: running.map(r => `${r.label}${r.heavy[0] ? ` (${heavyLabel(r.heavy[0])})` : ''}`).slice(0, 3),
    })
  }

  /** tool.call, after. */
  afterTool(tool: string, input: Record<string, unknown>, id: string, result: ToolCallResult | undefined, agentId?: string): void {
    const status = result === undefined ? 'error' : result.deny !== undefined ? 'denied' : result.isError === true ? 'error' : 'ok'
    const now = Date.now()
    if (agentId === undefined) this.noteActivity()
    const changed = this.activity.finished({ id, status, result: result?.result, text: result?.deny ?? result?.text, now })
    // Milestone evidence: the files this call changed belong to the milestone under way (an agent's work serves it too).
    if (status === 'ok' && changed.length > 0) this.noteEvidenceEdits(changed.map(c => c.path), now)
    // A subagent's own task list is its plan (Activity → Agents shows it as its track).
    if (status === 'ok' && agentId !== undefined && Plan.isPlanTool(tool)) this.ops.noteAgentPlan(agentId, { tool, input, result: result?.result, now })
    // Claude's own task list is the run's plan.
    if (status === 'ok' && agentId === undefined && Plan.isPlanTool(tool) && this.run !== null) {
      const session = Chain.currentSession(this.run)?.index ?? 1
      this.setPlan(Plan.applyTool(this.plan(), { tool, input, result: result?.result, session, now }))
    }
    // A fresh context starts working when it records its plan, edits a file or hands work to an agent.
    if (status === 'ok' && agentId === undefined && (Plan.isPlanTool(tool) || isEditTool(tool) || tool === 'Agent' || tool === 'Task')) this.noteWorkStarted()
    if (agentId === undefined) this.questForCheck(id)
    if (tool === 'Read' && status === 'ok' && agentId === undefined && typeof input.file_path === 'string') this.reads = [...this.reads, input.file_path].slice(-200)
    if (tool === 'TaskStop' && status === 'ok') {
      const taskId = typeof input.task_id === 'string' ? input.task_id : typeof input.shell_id === 'string' ? input.shell_id : null
      // Timed by the engine's clock, as the handoff's other steps (and the notes it is compared with) are.
      if (taskId !== null) void this.engineNow().then(now => this.noteTaskEnded(taskId, 'killed', "Claude's TaskStop", now))
    }
    if (tool === 'Agent') void this.refreshAgents()
    this.publisher.mark('activity', 'spinner', 'hud', 'resources', 'pane')
  }

  /**
   * Quest log: a check that just passed. Passing after its last run failed is
   * a comeback; otherwise its first pass in the turn pays. Re-running a
   * passing check earns nothing, and a background run has no outcome to count.
   */
  private questForCheck(id: string): void {
    if (this.settings.answers.style !== 'quest') return
    const item = this.activity.items.find(i => i.id === id)
    if (item === undefined || item.validation === null || item.status !== 'ok' || item.backgroundTaskId !== null || item.isInterrupted) return
    const kind = item.validation
    const own = this.activity.validationRuns().filter(r => r.kind === kind)
    const previous = own.at(-2)
    const label = VALIDATION_LABEL[kind]
    if (previous?.status === 'failed') {
      this.questGreen.add(kind)
      this.questEvent('comeback', `Comeback: ${label} pass again`)
    } else if (!this.questGreen.has(kind)) {
      this.questGreen.add(kind)
      this.questEvent('green', `${label} pass`)
    }
  }

  /** The questions Control Room has open for Ask categories, oldest first, while it waits for the person. */
  pendingApprovals: { id: number; label: string; what: string; since: number }[] = []
  private approvalSeq = 0

  /**
   * An Ask category, before the call goes on: unless Claude Code is about to ask the person itself
   * (or refuses the call anyway), Control Room asks them, in Claude Code's own question dialog. A yes
   * passes the call on to Claude Code's permission check, so its rules and PreToolUse hooks still
   * apply after it; anything else refuses the call. Returns the refusal, or null to go on.
   */
  private async askFirst(tool: string, input: Record<string, unknown>, decision: Decision): Promise<string | null> {
    const host = this.host
    const category = decision.category
    if (host === null || category === null) return null
    const engine = await host.checkTool(tool, input).catch(() => null)
    if (!isOwnQuestionNeeded(engine, this.permissionMode)) return null
    const what = callWords(tool, input, decision)
    const id = ++this.approvalSeq
    this.permissionCounts.asked += 1
    this.pendingApprovals = [...this.pendingApprovals, { id, label: PERMISSION_LABEL[category], what, since: Date.now() }]
    this.publisher.mark('hud', 'activity', 'permissions')
    let answer: string | null
    try {
      answer = await host.ask(approvalQuestion(decision, what), [APPROVE, DECLINE], 'Approve')
    } catch {
      answer = null
    } finally {
      this.pendingApprovals = this.pendingApprovals.filter(p => p.id !== id)
      this.publisher.mark('hud', 'activity')
    }
    const isApproved = answer === APPROVE
    this.logPermission({ tool, category, state: 'ask', evidence: clean(what, 120), outcome: isApproved ? 'approved' : 'declined' })
    return isApproved ? null : declineMessage(decision, answer)
  }

  // -------------------------------------------------------------------------
  // Subagents

  isAgentOffered(_e: AgentOfferInput): boolean {
    return isOffered(this.settings.subagents.mode)
  }

  /**
   * `agent.spawn`, before the agent starts: Subagent Control decides (a limit counts the agents alive now,
   * as the rows reconcile them, plus spawns allowed and not settled yet, so spawns made at once never all
   * pass it), and the router may pick its model. A workflow's agents are not counted against a limit.
   */
  async onAgentSpawn(e: AgentSpawnInput): Promise<{ deny?: string; model?: string; isReserved?: boolean }> {
    await this.ensureLoaded()
    const s = this.settings.subagents
    const isWorkflowAgent = (e as { workflow?: unknown }).workflow !== undefined
    await this.refreshAgents()
    // From here to the reservation nothing awaits: two spawns at once see each other's slot.
    const decision = decideSpawn({
      mode: s.mode,
      limit: s.limit,
      active: isWorkflowAgent ? 0 : limitCount(this.ops.agentRowsNow(), s.countTeammates) + this.agents.reserved,
      isTeammate: e.isTeammate === true,
      countTeammates: s.countTeammates,
      type: clean(e.subagentType, 40),
      description: clean(e.description, 80),
      isAllowedForSession: this.agents.allowAll,
    })
    if (decision.action === 'deny') {
      this.agents.denied += 1
      this.trace(`agents: refused a spawn (${clean(e.subagentType, 40)}: ${clean(e.description, 60)}): ${decision.reason}`)
      this.publisher.mark('pane', 'hud')
      return { deny: decision.reason }
    }
    const isReserved = !isWorkflowAgent
    if (isReserved) this.agents.reserved += 1
    if (decision.action === 'ask') {
      this.agents.asked += 1
      const host = this.host
      const answer = host === null ? 'Deny' : await host.ask(decision.question, ['Allow', 'Deny', 'Allow all this session'], 'Subagent').catch(() => 'Deny')
      if (answer === 'Allow all this session') this.agents.allowAll = true
      if (answer !== 'Allow' && answer !== 'Allow all this session') {
        if (isReserved) this.agents.reserved = Math.max(0, this.agents.reserved - 1)
        this.agents.denied += 1
        this.publisher.mark('pane', 'hud')
        return { deny: 'Control Room: the user did not approve this subagent. Do the work directly or ask the user.' }
      }
    }
    this.agents.spawned += 1
    const eff = this.effective()
    if (eff.router.isSubagents && !isWorkflowAgent) {
      const route = routeSubagent({
        router: this.settings.router,
        subagentType: e.subagentType,
        requested: e.model,
        isFork: e.fork,
        isTeammate: e.isTeammate === true,
        isFrontier: eff.frontier.isActive,
        sessionModel: this.sessionModel,
        unavailable: this.router.unavailable,
        known: this.router.known,
      })
      this.router.lastDecision = `subagent: ${route.why}`
      if (route.model !== null) return { model: route.model, isReserved }
    }
    this.publisher.mark('pane', 'hud')
    return { isReserved }
  }

  /**
   * `agent.spawn` settled: the agent shows from now (starting until Claude Code lists it; a workflow's
   * agents never are), its slot passes to the ledger, and the list is looked at every couple of seconds
   * while any agent is alive, whether or not the list has caught up yet.
   */
  onAgentSpawned(e: AgentSpawnInput, answer: AgentSpawnResult | undefined, isReserved: boolean): void {
    if (isReserved) this.agents.reserved = Math.max(0, this.agents.reserved - 1)
    if (answer === undefined || answer.deny !== undefined || answer.agentId === undefined) {
      this.publisher.mark('pane', 'hud')
      return
    }
    const workflow = (e as { workflow?: { runId: string; agentIndex: number } }).workflow
    this.ops.noteSpawn({
      agentId: answer.agentId,
      model: answer.model ?? null,
      isBackground: e.background,
      isFork: e.fork,
      description: e.description,
      type: e.subagentType,
      name: e.name ?? null,
      parentId: e.parentAgentId ?? null,
      workflow: workflow === undefined ? null : { runId: workflow.runId, index: workflow.agentIndex },
      toolUseId: e.tool_use_id || null,
      isTeammate: e.isTeammate === true,
    })
    this.trace(`agents: ${answer.agentId} started (${clean(e.subagentType, 40)}: ${clean(e.description, 60)}${workflow === undefined ? '' : `, workflow ${workflow.runId} #${workflow.agentIndex}`}${e.parentAgentId === undefined ? '' : `, inside ${e.parentAgentId}`})`)
    this.pollAgents()
    void this.refreshAgents()
  }

  /** Claude Code's agent list, looked at and reconciled with what this session saw (features/agents.ts). */
  async refreshAgents(): Promise<void> {
    const host = this.host
    if (host === null) return
    this.agents.list = await host.listAgents().catch(() => this.agents.list)
    this.ops.reconcileAgents(this.agents.list)
    this.pollAgents()
    this.publisher.mark('pane', 'hud', 'spinner', 'ops')
  }

  /** The list is looked at every AGENT_POLL_MS while any agent is alive (the ledger's or the list's), and not otherwise. */
  private pollAgents(): void {
    const host = this.host
    if (host === null) return
    const alive = this.runningSubagents()
    if (alive > 0 && this.agents.poll === null) {
      this.agents.poll = host.every(AGENT_POLL_MS, () => void this.refreshAgents())
    } else if (alive === 0 && this.agents.poll !== null) {
      this.agents.poll.cancel()
      this.agents.poll = null
    }
  }

  // -------------------------------------------------------------------------
  // Resource pressure

  /**
   * The machine's load changed level. Nothing is sent from here: what Claude hears is decided when a
   * note can go (the next batch of tool results, or the next prompt), from the level then
   * (`pressureNote`). Load that rises and falls between two of those is never mentioned, and while
   * the person is away nothing piles up.
   */
  private onPressure(pressure: Pressure, previous: Pressure): void {
    this.publisher.mark('resources', 'hud')
    if (pressure.level === previous.level) return
    this.resourceStats.lastNoticeLevel = pressure.level
    if (isOver(pressure) !== isOver(previous)) this.trace(`resources: load ${pressure.level} (CPU ${pressure.cpu ?? '?'}%, RAM ${pressure.ram ?? '?'}%)`)
  }

  // -------------------------------------------------------------------------
  // Settings changes (from the Control Centre, commands and profiles)

  /** Applies new settings: validates, persists, reconfigures, tells Claude what changed. */
  update(change: (draft: Settings) => Settings | void, options: { isProfile?: boolean } = {}): void {
    const before = this.settings
    const draft = clone(before)
    const returned = change(draft)
    const next = normalizeSettings(returned ?? draft)
    this.settings = next
    this.saveSettings.schedule(next)
    this.savedAt = Date.now()
    this.reconfigure({ before })
    this.publisher.markAll()
  }

  applyProfileById(id: string): boolean {
    const profile = findProfile(this.settings, id)
    if (profile === undefined) return false
    this.update(s => applyProfile(s, profile), { isProfile: true })
    if (this.settings.ui.toasts) this.host?.toast(`Profile ${profile.name} applied`, 3000)
    return true
  }

  /** Brings live systems in line with the settings, and informs Claude of material changes. */
  reconfigure(input: { before?: Settings; isStartup?: boolean }): void {
    const host = this.host
    const before = input.before
    this.configureAutopilot()
    if (!this.turn.isRunning) this.cache.schedule()
    if (host !== null && this.settings.ui.companion && this.companionTicker === null) {
      this.companionTicker = host.every(60_000, () => this.publisher.mark('hud'))
    } else if (!this.settings.ui.companion && this.companionTicker !== null) {
      this.companionTicker.cancel()
      this.companionTicker = null
    }
    if (host !== null) {
      const ceilings = this.effective().resources.ceilings
      const isLiveWanted = this.settings.ui.liveLoad && this.settings.ui.hud !== 'off'
      void this.monitor.configure(host, this.cwd || this.root, ceilings, this.settings.resources.intervalSec, isLiveWanted)
    }
    if (before === undefined || host === null) return
    const changes: string[] = []
    if (before.frontier.enabled !== this.settings.frontier.enabled) changes.push(`Frontier Max is now ${this.settings.frontier.enabled ? 'ON' : 'OFF'}`)
    if (before.qa.enabled !== this.settings.qa.enabled) changes.push(`Release/QA mode is now ${this.settings.qa.enabled ? 'ON' : 'OFF'}`)
    if (before.subagents.mode !== this.settings.subagents.mode || before.subagents.limit !== this.settings.subagents.limit) {
      changes.push(`subagent policy is now ${this.subagentLabel()}`)
      if ((before.subagents.mode === 'block') !== (this.settings.subagents.mode === 'block')) host.invalidateDescribes()
    }
    const resourceChanged =
      before.resources.level !== this.settings.resources.level ||
      before.resources.cpu !== this.settings.resources.cpu ||
      before.resources.ram !== this.settings.resources.ram ||
      before.resources.enforcement !== this.settings.resources.enforcement
    if (resourceChanged) {
      const section = this.policies().find(s => s.name.startsWith('Resource Governor'))
      this.tell('resources', prompts.resourceLevelChangedNotice(section?.text ?? null))
      // New ceilings: what Claude was told about the load is measured against them afresh.
      this.pressureTold = 'ok'
    }
    if (!before.ops.decisions && this.settings.ops.decisions) void this.offerDecisions()
    if (before.progress.milestones !== this.settings.progress.milestones) {
      void this.offerMilestones()
      if (this.milestonesTool !== null) changes.push(`milestone tracking is now ${this.settings.progress.milestones ? 'on' : 'off'}`)
    }
    if (before.answers.style !== this.settings.answers.style && this.nativeOutputStyle === null) {
      changes.push(`the answer style is now ${answerStyleLabel(this.settings.answers.style)}${this.settings.answers.style === 'standard' ? ' (write as you normally would)' : ''}`)
    }
    if (changes.length > 0) this.policyReason = changes.join('; ')
    const policy = policyText(this.policies())
    if (this.cache.isHoldingPolicies() && this.cache.isPolicyHeld(policy)) {
      // The system prompt keeps its cached section: the policies now in force come as a note.
      this.tell('policies', prompts.heldPoliciesNotice(changes, policy))
    } else if (!this.cache.isPolicyHeld(policy) && (this.cache.isHeldNoteSent || this.notesBox.has('policies'))) {
      // Back to what the system prompt says. A note Claude never received is simply withdrawn; one it read is taken back.
      this.notesBox.drop('policies')
      if (this.cache.isHeldNoteSent) this.tell('policies', prompts.policiesRestoredNotice(changes))
    } else if (changes.length > 0) {
      // Claude Code composes the system prompt once per turn (seen live), so a change made mid-turn is in it from the next turn.
      this.tell('settings', `Control Room · The user changed session settings: ${changes.join('; ')}. This applies now; your system prompt carries it from the next turn.`)
    }
    // Keep warm turned on again tries afresh, whatever it concluded about itself before.
    if (!before.cache.keepWarm && this.settings.cache.keepWarm) this.cache.resetVerdict()
    // A change of effort where it is known to rebuild the cache: say so while there is a large warm cache to lose.
    const effortOf = (s: Settings) => (s.frontier.enabled && s.frontier.effort !== 'keep' ? s.frontier.effort : null)
    if (effortOf(before) !== effortOf(this.settings) && this.settings.ui.toasts && this.cache.isEffortRebuilding(null)) {
      const cached = this.cache.state.lastPrefix
      if (CacheModel.warmthOf(this.cache.state, this.clock()) === 'warm' && cached >= this.settings.cache.minTokens) {
        host.toast(`Effort changes rebuild the prompt cache on ${CacheModel.shortModel(this.cache.state.model ?? '')}: the next request re-sends ${fmt.tokens(cached)} tokens`, 6000)
      }
    }
  }

  subagentLabel(): string {
    const s = this.settings.subagents
    switch (s.mode) {
      case 'unrestricted':
        return 'unrestricted'
      case 'block':
        return 'blocked'
      case 'ask':
        return 'ask each time'
      case 'limit':
        return `max ${s.limit}`
    }
  }

  profileLabel(): string {
    return profileLabel(this.settings)
  }

  // -------------------------------------------------------------------------
  // Control Centre actions

  async openPane(isPersonAsking: boolean): Promise<boolean> {
    const host = this.host
    if (host === null) return false
    const opened = await host
      .open({ id: PANE_ID, title: PANE_TITLE, columns: 66, rows: 28, ...(isPersonAsking ? { focus: true as const } : {}) })
      .catch(() => null)
    this.ui.isPaneOpen = opened !== null
    this.publisher.markAll()
    return opened?.isPlaced === true
  }

  async closePane(): Promise<void> {
    await this.host?.close({ id: PANE_ID }).catch(() => undefined)
    this.ui.isPaneOpen = false
    this.publisher.mark('hud')
  }

  async togglePane(): Promise<'opened' | 'closed' | 'waiting'> {
    const host = this.host
    if (host === null) return 'closed'
    const isOpen = (await host.panes().catch(() => [])).some(p => p.id === PANE_ID)
    if (isOpen) {
      await this.closePane()
      return 'closed'
    }
    return (await this.openPane(true)) ? 'opened' : 'waiting'
  }

  /**
   * Activity → Operations, opened (from a status bar chip or alert, or `/cr queue`, `/cr watch`,
   * `/cr decisions`, `/cr agents`), with `focusKey`'s field focused. False where no panel can be
   * shown (a headless run): the caller answers in words instead.
   */
  async openOps(focusKey?: string, section?: string): Promise<boolean> {
    return this.openActivity('ops', focusKey, section)
  }

  /** Activity, at one of its views (Operations, Agents), opened as `openOps` opens Operations. */
  async openActivity(sub: 'summary' | 'ops' | 'agents' | 'raw', focusKey?: string, section?: string): Promise<boolean> {
    const isChange = this.ui.tab !== 'activity' || this.ui.activitySub !== sub
    this.ui.tab = 'activity'
    this.ui.activitySub = sub
    this.ui.openPicker = null
    this.publisher.mark('pane', 'ops')
    const host = this.host
    if (host === null) return false
    void this.refreshAgents()
    const isOpen = (await host.panes().catch(() => [])).some(p => p.id === PANE_ID)
    // A field takes the focus only while the panel holds the keyboard, and after a /cr command the
    // prompt box holds it (seen live: "that site does not hold the keyboard"): opening the panel
    // again with `focus` hands it over.
    const isShown = isOpen && focusKey === undefined ? true : (await this.openPane(true)) || isOpen
    if (isOpen && isChange && section === undefined) void host.scrollPaneToTop().catch(() => undefined)
    // At its card (a chip, /cr agents), with the field focused (/cr queue), once the panel has drawn it.
    if (isShown && section !== undefined) {
      const key = cardKey(section)
      this.onceDrawn(`scroll to ${key}`, () => host.scrollPaneTo(key), OPS_SCROLL_TRIES)
    }
    // Claude Code waits for a field not drawn yet itself: one try.
    if (isShown && focusKey !== undefined) this.onceDrawn(`focus ${focusKey}`, () => host.focusPane(focusKey), 1)
    return isShown
  }

  /**
   * Acts on an element of the panel once it is drawn. A panel opened a moment ago may not have
   * drawn Operations yet, so a refusal is tried again, up to `tries` times and a little later each
   * time; never once the person moved the panel themselves. Each refusal goes to the debug trace.
   */
  private onceDrawn(what: string, act: () => Promise<string | null>, tries: number, attempt = 1): void {
    const host = this.host
    if (host === null) return
    host.after(OPS_DRAWN_MS * attempt, () => {
      void act()
        .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
        .then(deny => {
          if (deny === null) return
          this.trace(`ops: ${what} refused (try ${attempt}): ${deny}`)
          if (attempt < tries && !deny.includes('moved meanwhile')) this.onceDrawn(what, act, tries, attempt + 1)
        })
    })
  }

  setTab(tab: TabId): void {
    const isChange = this.ui.tab !== tab
    this.ui.tab = tab
    this.ui.openPicker = null
    this.publisher.mark('pane')
    // A new section starts at its top, wherever the last one was scrolled to.
    if (isChange) void this.host?.scrollPaneToTop().catch(() => undefined)
  }

  /** Opens one in-place picker (terminal, mobile), or closes it when it is the open one. */
  togglePicker(key: string | null): void {
    this.ui.openPicker = key === null || this.ui.openPicker === key ? null : key
    this.publisher.mark('pane')
  }

  toggleRow(id: string): void {
    if (this.ui.expanded.has(id)) this.ui.expanded.delete(id)
    else this.ui.expanded.add(id)
    this.publisher.mark('focus')
  }

  /**
   * What `/cr handoff` and `/cr fresh` decide from: whether a turn runs, the background work in flight
   * as Claude Code last reported it, and the notes on disk against this handoff.
   */
  async handoffFacts(): Promise<Autopilot.HandoffFacts & { notesAt: number | null }> {
    const notes = await this.lookAtNotes(this.autopilot.handoffSince)
    return {
      isTurnRunning: this.turn.isRunning,
      inFlight: this.lastStop === null ? null : this.lastStop.background,
      notes: notes.state,
      notesAt: notes.mtimeMs,
      handoffFile: this.settings.autopilot.handoffFile,
    }
  }

  /**
   * `/cr handoff` and Hand off now: hands off when no handoff is under way, finishes one whose end
   * went unseen, and otherwise says what the one under way is doing. The words say what happened.
   */
  async requestHandoff(options: { skipWait?: boolean } = {}): Promise<string> {
    const host = this.host
    if (host === null) return 'Project Sentinel is not ready yet.'
    const wasOff = !this.settings.autopilot.enabled
    if (wasOff) {
      this.update(s => {
        s.autopilot.enabled = true
      })
    }
    const facts = await this.handoffFacts()
    const now = await this.engineNow()
    // Decided on the state as it is now, after the awaits: a second request meanwhile sees the first one's step.
    const state = this.autopilot.state
    const verdict = Autopilot.handoffVerdict(this.autopilot, facts)
    this.trace(`autopilot: /cr handoff in ${state} (notes ${facts.notes}, ${facts.isTurnRunning ? 'a turn running' : 'idle'}): ${verdict.action}`)
    if (verdict.action === 'hand-off') this.stepAutopilot({ kind: 'manualHandoff', now, isRestart: state === 'handoff' || state === 'waiting-background', ...(options.skipWait === true ? { skipWait: true } : {}) })
    if (verdict.action === 'start-fresh') this.startFreshNow(now, facts.notesAt)
    return wasOff ? `Context Autopilot is on. ${verdict.text}` : verdict.text
  }

  /**
   * `/cr fresh` and Start fresh context: the fresh context, only when it is safe (no turn running,
   * nothing it must wait for in flight, the notes written for this handoff), through the verified clear
   * path. A handoff whose end went unseen is recovered here instead of being refused. `isForced` (`/cr
   * fresh now`, Hand off now): background work no longer holds it back (it keeps running, and the fresh
   * context is told); the notes still must be current, and a running turn still ends first.
   */
  async startFreshContext(options: { isForced?: boolean } = {}): Promise<string> {
    const host = this.host
    if (host === null) return 'Project Sentinel is not ready yet.'
    const facts = { ...(await this.handoffFacts()), isForced: options.isForced === true }
    const now = await this.engineNow()
    const verdict = Autopilot.freshVerdict(this.autopilot, facts)
    this.trace(`autopilot: /cr fresh${facts.isForced ? ' now' : ''} in ${this.autopilot.state} (notes ${facts.notes}, ${facts.isTurnRunning ? 'a turn running' : 'idle'}, in flight ${facts.inFlight === null ? 'unknown' : facts.inFlight.length}): ${verdict.action}`)
    if (verdict.action === 'start-fresh') this.startFreshNow(now, facts.notesAt)
    return verdict.text
  }

  /**
   * Starts the fresh context of a handoff the person finished. A handoff whose notes the normal path
   * never checked (its end went unseen, or it waited for background work) records its health now. What
   * Claude Code last listed running keeps running, and the fresh context is told.
   */
  private startFreshNow(now: number, notesAt: number | null): void {
    const state = this.autopilot.state
    if (state !== 'awaiting' && state !== 'handoff' && state !== 'waiting-background') return
    const left = state === 'waiting-background' ? this.autopilot.background : (this.inFlight() ?? [])
    if (state !== 'awaiting') {
      this.questEvent('handoff', 'Clean handoff: notes verified')
      this.recordHandoffHealth(true, notesAt, left)
    }
    this.stepAutopilot({ kind: 'manualFresh', now, left })
  }

  /**
   * The person's way out of a wait (`/cr handoff now`, Hand off now, "handoff now", "don't wait for the
   * background process"): the handoff goes on without waiting for background work, which keeps running
   * for the fresh context. Before the handoff it starts one that will not wait; once its turn ended it
   * starts the fresh context (the notes checked first). The words say what happened.
   */
  async handoffNow(): Promise<string> {
    const host = this.host
    if (host === null) return 'Project Sentinel is not ready yet.'
    if (!this.settings.autopilot.enabled) return this.requestHandoff({ skipWait: true })
    const now = await this.engineNow()
    const ap = this.autopilot
    const isTurnRunning = this.turn.isRunning
    this.trace(`autopilot: hand off now in ${ap.state}${isTurnRunning ? ' (a turn running)' : ''}`)
    switch (ap.state) {
      case 'waiting-background': {
        const left = Autopilot.blockingOf(ap.background)
        this.stepAutopilot({ kind: 'skipWait', now, isTurnRunning })
        const keeps = left.length === 0 ? '' : ` ${Autopilot.backgroundWords(left)} keeps running for the fresh context, which is told.`
        return isTurnRunning ? `Not waiting for the background work: the handoff goes on when this turn ends.${keeps}` : `Not waiting for the background work: checking the notes, then starting the fresh context.${keeps}`
      }
      case 'pending':
      case 'requested':
        this.stepAutopilot({ kind: 'skipWait', now, isTurnRunning })
        return ap.state === 'pending' ? 'The handoff starts when this turn ends, and will not wait for background work.' : 'A handoff is starting; it will not wait for background work.'
      case 'handoff':
        if (isTurnRunning) {
          this.stepAutopilot({ kind: 'skipWait', now, isTurnRunning })
          return 'Claude is writing the notes; the fresh context starts as soon as they are checked, without waiting for background work.'
        }
        return this.startFreshContext({ isForced: true })
      case 'awaiting': {
        const text = await this.startFreshContext({ isForced: true })
        // No current notes to start from: write them first, without waiting afterwards.
        return this.autopilot.state === 'awaiting' && !this.turn.isRunning && /handoff to have Claude write/.test(text) ? this.requestHandoff({ skipWait: true }) : text
      }
      case 'off':
      case 'armed':
        return this.requestHandoff({ skipWait: true })
      default:
        return Autopilot.handoffVerdict(ap, await this.handoffFacts()).text
    }
  }

  /**
   * Before the Cold Resume Guard: the person's message while a handoff is under way. A handoff-control
   * instruction ("handoff now", "don't wait for the background process", "start the fresh session now")
   * is acted on and never sent. Any other message is not let into a context about to be cleared unasked:
   * while a written handoff waits, or while Claude writes the notes, the person chooses (hand off and
   * carry it to the fresh context, send it here, or keep it in the prompt box); while the fresh context
   * is already starting, it is carried there. Returns a drop reason, or null to let the message go.
   */
  async handoffGuard(e: { text: string; origin?: PromptOrigin; turnId?: string; attachments?: readonly unknown[] }): Promise<{ drop: string } | null> {
    if (this.host === null || !this.settings.autopilot.enabled || !isPersonOrigin(e.origin) || prompts.ownPromptKind(e.text) !== null) return null
    const state = this.autopilot.state
    if (state === 'off' || state === 'armed' || state === 'resuming') return null
    const intent = handoffIntentOf(e.text)
    if (intent !== null) {
      this.trace(`handoff guard: "${clean(e.text, 60)}" read as "${INTENT_WORDS[intent]}" (${state}${e.turnId === undefined ? '' : ', typed mid-turn'})`)
      const text = await this.actOnIntent(intent)
      this.ops.clearRestored(e.text, 'was acted on as a handoff instruction')
      return { drop: text }
    }
    // Handoff due: the step under way goes on; the prompt carries the reminder (onPromptSubmit).
    if (state === 'pending') return null
    if (state === 'verifying' || state === 'clearing' || state === 'compacting') return this.carryMessage(e, 'The fresh context is starting')
    // Nobody to ask (a headless run): the message goes as it would have.
    if (this.surfaces.length === 0) return null
    return this.askAboutMessage(e)
  }

  /** A handoff-control instruction, carried out; the words say what happened. */
  private async actOnIntent(intent: HandoffIntent): Promise<string> {
    switch (intent) {
      case 'handoff-now':
      case 'skip-wait':
        return this.handoffNow()
      case 'fresh-now':
        // The notes come first: before them, or under a running turn, it is a handoff that will not wait.
        return this.turn.isRunning || this.autopilot.state === 'pending' || this.autopilot.state === 'requested' ? this.handoffNow() : this.startFreshContext({ isForced: true })
      case 'keep-waiting':
        return this.autopilot.state === 'waiting-background' ? this.keepWaiting() : `Nothing was sent. ${Autopilot.handoffVerdict(this.autopilot, await this.handoffFacts()).text}`
      case 'cancel':
        return this.cancelHandoff()
      case 'stop-and-handoff': {
        const ap = this.autopilot
        const waiting = Autopilot.blockingOf(ap.state === 'waiting-background' ? ap.background : (this.inFlight() ?? []))
        if (waiting.length === 0) return this.handoffNow()
        const host = this.host
        let answer: string | null = null
        try {
          answer = host === null || this.surfaces.length === 0 ? null : await host.ask(`Stop ${Autopilot.backgroundWords(waiting)} with Claude Code's TaskStop, then hand off?`, [HANDOFF_CHOICE.stop, HANDOFF_CHOICE.leave, HANDOFF_CHOICE.wait], 'Handoff')
        } catch {
          answer = null
        }
        if (answer === HANDOFF_CHOICE.stop) return this.stopAndHandOff('all')
        if (answer === HANDOFF_CHOICE.leave) return this.handoffNow()
        return `Nothing was stopped. ${ap.state === 'waiting-background' ? 'The handoff keeps waiting for the background work.' : 'The handoff goes on as it was.'}`
      }
    }
  }

  /** Where a message for the fresh context waits: its first message after a clear, or the first boundary after a compaction. */
  private carryTarget(): QueueTarget {
    return this.settings.autopilot.continuation === 'compact' ? 'boundary' : 'fresh'
  }

  /**
   * The message goes to the fresh context, in the Mission Queue (Activity → Operations shows it, and it
   * can be changed there), queued before `then` moves the handoff on. The drop reason says where it went.
   */
  private async carryMessage(e: { text: string; attachments?: readonly unknown[] }, why: string, then: (() => Promise<string>) | null = null): Promise<{ drop: string }> {
    const queued = this.ops.queueAdd(e.text, this.carryTarget())
    if (!queued.ok) {
      this.ops.putBack(e.text, (e.attachments?.length ?? 0) > 0)
      return { drop: `Not sent: ${queued.error} Your message is back in the prompt box.` }
    }
    this.trace(`handoff guard: the message is queued as ${queued.id} for the fresh context`)
    this.ops.clearRestored(e.text, `waits as ${queued.id} for the fresh context`)
    const lost = (e.attachments?.length ?? 0) > 0 ? ' (its attachments could not be kept)' : ''
    const after = then === null ? '' : ` ${await then()}`
    return { drop: `${why}: your message waits as ${queued.id}${lost} and goes to the fresh context first thing.${after}` }
  }

  /** The person's choice for a message typed while a written handoff waits or Claude writes the notes. */
  private async askAboutMessage(e: { text: string; turnId?: string; attachments?: readonly unknown[] }): Promise<{ drop: string } | null> {
    const host = this.host
    if (host === null) return null
    const state = this.autopilot.state
    const isWriting = state === 'requested' || (state === 'handoff' && this.turn.isRunning)
    const hasAttachments = (e.attachments?.length ?? 0) > 0
    const waiting = Autopilot.blockingOf(this.autopilot.background)
    const carry = isWriting ? HANDOFF_CHOICE.queue : state === 'waiting-background' ? HANDOFF_CHOICE.carry : HANDOFF_CHOICE.freshCarry
    const question = isWriting
      ? 'Claude is writing the handoff notes, and this context is cleared next. Give your message to the fresh context first thing, or send it into the handoff turn now?'
      : state === 'waiting-background'
        ? `The handoff is ${this.autopilot.notesWritten === false ? 'under way' : 'written'} and waits for ${waiting.length === 0 ? 'background work' : Autopilot.backgroundWords(waiting)}. Hand off now and give your message to the fresh context first thing, or send it into this context, which is about to be cleared?`
        : 'The handoff waits for you to start the fresh context. Start it now and give your message to it first thing, or send the message into this context?'
    const options = hasAttachments ? [HANDOFF_CHOICE.here, HANDOFF_CHOICE.box] : [carry, HANDOFF_CHOICE.here, HANDOFF_CHOICE.box]
    this.trace(`handoff guard: asking about a message typed in ${state}`)
    let answer: string
    try {
      answer = await host.ask(hasAttachments ? `${question} (A message with attachments cannot be carried over.)` : question, options, 'Handoff')
    } catch {
      answer = HANDOFF_CHOICE.box
    }
    if (answer === HANDOFF_CHOICE.here) {
      this.trace('handoff guard: the person sent the message into this context')
      return null
    }
    if (answer === carry && !hasAttachments) {
      if (isWriting) return this.carryMessage(e, 'Claude finishes the handoff notes first')
      return this.carryMessage(e, 'Handing off', () => (state === 'waiting-background' ? this.handoffNow() : this.startFreshContext({ isForced: true })))
    }
    this.ops.putBack(e.text, hasAttachments)
    return { drop: `Not sent: your message is back in the prompt box. ${state === 'waiting-background' ? 'The handoff keeps waiting for the background work.' : isWriting ? 'Claude is writing the handoff notes.' : 'The handoff waits for you.'}` }
  }

  /** Keep waiting (the person chose to): the wait's patience grows by `ms` from now or its end, whichever is later. */
  async keepWaiting(ms: number = this.autopilotConfig().waitMs ?? Autopilot.DEFAULT_WAIT_MS): Promise<string> {
    const ap = this.autopilot
    if (ap.state !== 'waiting-background') return 'No handoff is waiting for background work.'
    const now = await this.engineNow()
    const span = ms > 0 ? ms : Autopilot.DEFAULT_WAIT_MS
    this.stepAutopilot({ kind: 'keepWaiting', now, ms: span })
    const until = this.autopilot.waitUntil
    return `The handoff keeps waiting for ${Autopilot.backgroundWords(Autopilot.blockingOf(this.autopilot.background))}${until === null ? '' : `, until ${fmt.clock(until)} at most`}; it goes on as soon as that work ends.`
  }

  /** Call the handoff off: this context carries on, the notes stay on disk, and the context's growth decides the next one. */
  cancelHandoff(): string {
    const before = this.autopilot.state
    this.stepAutopilot({ kind: 'cancelHandoff', tokens: this.usage.tokens ?? 0, window: this.usage.window })
    if (this.autopilot.state === before) return before === 'off' || before === 'armed' ? 'No handoff is under way.' : 'The handoff is past the point of calling off: the fresh context is starting.'
    return `Handoff called off: Claude carries on in this context; the notes stay on disk. Autopilot hands off again once the context grows ${fmt.tokens(Math.max(0, (this.autopilot.snoozeUntil ?? 0) - (this.usage.tokens ?? 0)))} further.`
  }

  /**
   * Stop & hand off: Claude Code's TaskStop on the background work the handoff waits for (one task, or
   * all of it), then the handoff goes on. A server beside it keeps running.
   */
  async stopAndHandOff(taskId?: string): Promise<string> {
    const host = this.host
    if (host === null) return 'Project Sentinel is not ready yet.'
    const ap = this.autopilot
    const waiting = Autopilot.blockingOf(ap.state === 'waiting-background' ? ap.background : (this.inFlight() ?? []))
    const targets = taskId === undefined || taskId === 'all' ? waiting : waiting.filter(t => t.id === taskId)
    if (targets.length === 0) return taskId === undefined || taskId === 'all' ? 'Nothing the handoff waits for is running.' : `No background task ${taskId} holds the handoff.`
    const stopped: string[] = []
    const refused: string[] = []
    for (const t of targets) {
      const result = await host.stopTask(t.id).catch(error => ({ deny: error instanceof Error ? error.message : String(error) }) as { deny: string })
      if ('deny' in result && result.deny !== undefined) refused.push(`${t.description} (${clean(String(result.deny), 80)})`)
      else {
        stopped.push(t.description)
        this.noteTaskEnded(t.id, 'killed', 'your Stop', await this.engineNow())
      }
    }
    const done = stopped.length === 0 ? '' : `Stopped ${stopped.join('; ')}. `
    if (refused.length > 0) return `${done}Claude Code did not stop ${refused.join('; ')}: the handoff keeps waiting for it (Hand off now leaves it running).`
    if (this.autopilot.state === 'waiting-background' && Autopilot.blockingOf(this.autopilot.background).length === 0 && !this.turn.isRunning) {
      this.stepAutopilot({ kind: 'unblocked', now: await this.engineNow() })
      return `${done}The handoff goes on: checking the notes, then starting the fresh context.`
    }
    return `${done}${await this.handoffNow()}`
  }

  /** A button's answer (Hand off now, Start fresh context): what happened, as a toast. */
  sayToPerson(text: string): void {
    if (this.settings.ui.toasts) this.host?.toast(text, 6000)
  }

  snoozeAutopilot(): void {
    this.stepAutopilot({ kind: 'snooze', tokens: this.usage.tokens ?? 0, window: this.usage.window })
  }

  async stopBackgroundTask(taskId: string): Promise<void> {
    const host = this.host
    if (host === null) return
    const result = await host.stopTask(taskId).catch(() => null)
    if (result !== null && result.deny === undefined) this.noteTaskEnded(taskId, 'killed', 'your Stop', await this.engineNow())
    this.publisher.mark('resources', 'activity')
  }

  selectChangedFile(path: string | null): void {
    this.ui.selectedPath = path
    this.publisher.mark('activity')
  }

  /** Agents alive now, as the rows reconcile them: a spawn not listed yet and a workflow's agents included. */
  runningSubagents(): number {
    return aliveRows(this.ops.agentRowsNow()).length
  }

  /** The /control-room command. */
  async runCommand(args: string): Promise<CommandRunResult> {
    return handleCommand(this, args)
  }
}
