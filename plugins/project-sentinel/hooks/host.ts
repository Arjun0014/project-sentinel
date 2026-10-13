/**
 * The Host: Control Room's one door to the engine.
 *
 * `register.tsx` builds it from `$` (the only file that spells `$.noun.method`,
 * as `claude plugin validate` requires); every other module works against
 * this interface. Members are thin and named for the engine call they make.
 */

import type {
  AgentInfo,
  CommandInfo,
  CommandRunResult,
  CommandSpec,
  FsStat,
  ModelForkResult,
  PaneCloseArgs,
  PaneOpenArgs,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  PromptSubmitResult,
  RenderSurface,
  ToolInfo,
  ToolSpec,
  SessionCompactResult,
  SessionUsage,
  SessionVersion,
  Settings as EngineSettings,
  Timer,
  ToolCallResult,
  UiOpenResult,
  UiPane,
} from 'claude-code'

import type {
  ActivityView,
  AgentMemo,
  AutopilotRecord,
  CacheMemo,
  ChainView,
  FocusModel,
  HudModel,
  OpsView,
  PaneModel,
  PermissionsView,
  ResourcesView,
  SpinnerModel,
} from '../types'
import type { ConfigEnv } from './app/formerStore'
import type { TtlConfig } from './features/cache'

export type SpawnStream = AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> & { readonly result: Promise<ProcessSpawnResult> }

export type Host = {
  pluginRoot: string
  /** A synchronous clock for tests (a manual one); absent, the system clock. Not an engine call. */
  time?: () => number

  now(): Promise<number>
  after(ms: number, fn: () => void): Timer
  every(ms: number, fn: () => void): Timer

  sessionId(): Promise<string>
  sessionRoot(): Promise<string>
  sessionModel(): Promise<string>
  usage(): Promise<SessionUsage>
  /** Usage with the local `summary` breakdown (auto-compact threshold); no network. */
  usageSummary(): Promise<SessionUsage>
  version(): Promise<SessionVersion>
  surfaces(): Promise<readonly RenderSurface[]>
  // No member appends to the transcript: a row appended while Claude works moves when the next turn
  // rebuilds the conversation, and the prompt cache is lost from there (app/notes.ts). Notes for
  // Claude travel with a batch of tool results or with a prompt instead.
  compact(instructions: string): Promise<SessionCompactResult>

  submit(text: string): Promise<PromptSubmitResult>
  /** Submits the person's own words (a message the Cold Resume Guard held while it compacted): read bare, as theirs. */
  submitAsUser(text: string): Promise<PromptSubmitResult>
  /** Puts text back in the prompt box as the person's draft (a message the Cold Resume Guard did not send). */
  fillPrompt(text: string): Promise<{ isFilled: boolean; refusal?: string }>
  /** The prompt box's draft as it stands ('' where the session draws none). */
  readPrompt(): Promise<{ text: string }>
  /** Runs /clear (an Autopilot handoff's fresh context). */
  clearContext(): Promise<CommandRunResult>
  /**
   * Runs /compact with the handoff's instructions: where `compact` is refused because the session
   * compacts only inside a turn (headless and SDK sessions). The engine's compaction follows.
   */
  compactCommand(instructions: string): Promise<CommandRunResult>
  registerCommand(spec: CommandSpec): Promise<unknown>
  listCommands(): Promise<CommandInfo[]>

  listAgents(): Promise<AgentInfo[]>
  /** The tools the model can call now (to see whether Claude Code offers a task list). */
  listTools(): Promise<readonly ToolInfo[]>
  /** Offers the model one of Control Room's own tools; resolves to its full name (`mcp__project-sentinel__<name>`). */
  registerTool(spec: ToolSpec): Promise<string>
  stopTask(taskId: string): Promise<ToolCallResult>
  /** Claude Code's own SendMessage delivery to one of the session's agents (a background agent or a teammate). */
  sendToAgent(agentId: string, text: string): Promise<{ isDelivered: boolean; reason?: string }>
  classify(text: string, labels: readonly string[], model?: string): Promise<string | undefined>
  /** One tool-less completion over the main thread's last request (Keep warm): never added to the transcript. */
  fork(prompt: string): Promise<ModelForkResult>

  toast(text: string, timeoutMs?: number): void
  status(text: string | undefined): void
  open(pane: PaneOpenArgs): Promise<UiOpenResult>
  close(pane: PaneCloseArgs): Promise<void>
  panes(): Promise<readonly UiPane[]>
  /** Brings the top of the Control Room pane into view (after a section change, or "Back to top"). */
  scrollPaneToTop(): Promise<void>
  /**
   * Brings one of the pane's elements to the top of its view, by the key it is drawn under (an
   * Operations card's `card-ops-agents`). Resolves to why Claude Code did not move it, or null once it did.
   */
  scrollPaneTo(key: string): Promise<string | null>
  /** Moves the pane's focus ring onto one of its fields (the Mission Queue's, after `/cr queue`): why not, or null once it did. */
  focusPane(key: string): Promise<string | null>
  /** Asks the person in Claude Code's own question dialog (AskUserQuestion); rejects when dismissed or with nobody to ask. */
  ask(question: string, options: readonly string[], header?: string): Promise<string>
  /** What Claude Code's own permission check would decide for a call (its rules and the mode), running nothing. */
  checkTool(tool: string, input: Record<string, unknown>): Promise<{ decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string }>
  copy(text: string, surface?: RenderSurface): Promise<boolean>

  readText(path: string): Promise<string>
  stat(path: string, resolve: boolean): Promise<FsStat>
  exists(path: string): Promise<boolean>

  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
  storeDelete(key: string): Promise<void>

  settings(source?: 'policy' | 'user' | 'project' | 'local'): Promise<EngineSettings>
  /** What sets the main conversation's cache lifetime in Claude Code: its environment variables and the `promptCacheTtl` setting. */
  cacheTtlConfig(): Promise<TtlConfig>
  /** `CLAUDE_CONFIG_DIR`, `USERPROFILE` and `HOME`: only to find the store kept under the former name. */
  configEnv(): Promise<ConfigEnv>
  /** The status bar Control Room (the former name) last published in this session's `$.state`, or undefined. */
  formerHud(): Promise<unknown>
  /** Whether the standby note was shown in this session (`$.state`: kept across reloads, gone at a restart). */
  isStandbyNoted(): Promise<boolean>
  noteStandby(): Promise<void>

  /**
   * Starts the machine-wide CPU and memory sampler for the platform, one program by name with fixed
   * arguments (no shell), a reading every SAMPLER_EVERY_SEC: `typeperf` on Windows, `top` on macOS.
   */
  spawnSampler(platform: 'windows' | 'macos'): SpawnStream
  /** Windows: `systeminfo /fo csv /nh`, once, for the machine's total physical memory. */
  systemInfo(): Promise<ProcessRunResult>
  /** macOS: `sysctl -n kern.memorystatus_level`, the percentage of memory the kernel counts free. */
  memoryLevel(): Promise<ProcessRunResult>
  /** Whether the session's folder is in a Git repository (its root), else null. */
  repoRoot(): Promise<string | null>
  /** `git status --porcelain=v1 --branch` in the session's folder (read-only; Git runs with repo hooks off). */
  gitStatus(): Promise<ProcessRunResult>
  /**
   * Milestone evidence: `git hash-object --no-filters -- <paths>`, Git's blob id of each file's content,
   * one per line in order (read-only: nothing is written to the repository; `--no-filters` runs no
   * filter a repository's configuration names). Only the ids are kept, never the content.
   */
  hashFiles(paths: readonly string[]): Promise<ProcessRunResult>
  /** Milestone evidence: `git rev-parse --verify -q HEAD`, the commit the work tree is on. */
  gitHead(): Promise<ProcessRunResult>

  publishHud(value: HudModel): Promise<void>
  publishPane(value: PaneModel): Promise<void>
  publishResources(value: ResourcesView): Promise<void>
  publishChain(value: ChainView): Promise<void>
  publishActivity(value: ActivityView): Promise<void>
  publishPermissions(value: PermissionsView): Promise<void>
  publishFocus(value: FocusModel): Promise<void>
  publishSpinner(value: SpinnerModel): Promise<void>
  publishOps(value: OpsView): Promise<void>

  /** The handoff in flight, in `$.state`: survives a reload of the plugin, not a restart or /clear. */
  saveAutopilotRecord(record: AutopilotRecord | null): Promise<void>
  loadAutopilotRecord(): Promise<AutopilotRecord | null>
  /** The policy section this context's system prompt carries, in `$.state`: a reload keeps it while the cache is warm. */
  savePolicyMemo(memo: { sessionId: string; text: string } | null): Promise<void>
  loadPolicyMemo(): Promise<{ sessionId: string; text: string } | null>
  /** The prompt cache's last request, in `$.state`: a reload keeps knowing when the cache lapses. */
  saveCacheMemo(memo: CacheMemo | null): Promise<void>
  loadCacheMemo(): Promise<CacheMemo | null>
  /** What this session saw of its agents, in `$.state`: a reload keeps it (gone at a restart, as the agents are). */
  saveAgentLedger(list: AgentMemo[]): Promise<void>
  loadAgentLedger(): Promise<AgentMemo[] | null>

  /** Re-runs agent listings (Subagent Control changed what is offered). */
  invalidateDescribes(): void
  /** Has the engine ask for a fresh conversation's first-message context blocks again (after Control Room's own /clear). */
  invalidatePromptContext(): void

  /** One line in Claude Code's debug log only (`claude --debug`), never on screen. Absent in tests. */
  trace?(text: string): void
}
