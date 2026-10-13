/**
 * Control Room — the hooks module.
 *
 * This file is deliberately thin: it builds the Host adapter from `$` (the
 * one place the engine interface is spelled, as `claude plugin validate`
 * requires) and registers every hook, each a few lines delegating to the
 * Runtime. Gating hooks carry a `.catch` that falls back to Claude Code's
 * own behaviour — never to anything looser.
 */

import { atom, read } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderSurface } from 'claude-code'

import { PANE_ID } from './constants'
import { POLICY_SECTION_ID } from './core/policy'
import { isObviouslyDangerous } from './features/permissions/categories'
import { isEditTool, isShellTool } from './features/permissions/decide'
import { actionsOf } from './app/actions'
import { Runtime } from './app/runtime'
import * as Views from './app/views'
import type { Host } from './host'
import { type Kit, uiOf } from './ui/kit'
import { hudView } from './ui/hud'
import { TAB_NEEDS, paneView } from './ui/pane/frame'
import { collapseBar, compactToolRow, hiddenRow } from './ui/rows'

// ---------------------------------------------------------------------------
// `$.state` atoms: literal references, as the validator requires.

const HUD = { plugin: 'project-sentinel', key: 'hud' } as const
const PANE = { plugin: 'project-sentinel', key: 'pane' } as const
const RESOURCES = { plugin: 'project-sentinel', key: 'resources' } as const
const CHAIN = { plugin: 'project-sentinel', key: 'chain' } as const
const ACTIVITY = { plugin: 'project-sentinel', key: 'activity' } as const
const PERMISSIONS = { plugin: 'project-sentinel', key: 'permissions' } as const
const FOCUS = { plugin: 'project-sentinel', key: 'focus' } as const
const SPINNER = { plugin: 'project-sentinel', key: 'spinner' } as const
const AUTOPILOT = { plugin: 'project-sentinel', key: 'autopilot' } as const
/** Control Room's status bar (the former name), read only: while it runs in this session, Project Sentinel stands by. */
const FORMER_HUD = { plugin: 'control-room', key: 'hud' } as const
/** Whether the standby note was shown in this session: kept across reloads, so it shows once. */
const STANDBY = { plugin: 'project-sentinel', key: 'standby' } as const
/** The policy section this context's system prompt carries: a reload keeps sending it while the cache is warm. */
const POLICY = { plugin: 'project-sentinel', key: 'policy' } as const
/** The orchestration layer's view (Activity → Operations, Overview, Context). */
const OPS = { plugin: 'project-sentinel', key: 'ops' } as const
/** The prompt cache's last request in this context: a reload keeps knowing when it lapses. */
const CACHE_MEMO = { plugin: 'project-sentinel', key: 'cacheMemo' } as const
const AGENT_LEDGER = { plugin: 'project-sentinel', key: 'agents' } as const

const blank = new Runtime()
const hudAtom = atom(HUD, Views.hudOf(blank))
const paneAtom = atom(PANE, Views.paneOf(blank))
const resourcesAtom = atom(RESOURCES, Views.resourcesOf(blank))
const chainAtom = atom(CHAIN, Views.chainOf(blank))
const activityAtom = atom(ACTIVITY, Views.activityOf(blank))
const permissionsAtom = atom(PERMISSIONS, Views.permissionsOf(blank))
const focusAtom = atom(FOCUS, Views.focusOf(blank))
const spinnerAtom = atom(SPINNER, Views.spinnerOf(blank))
const opsAtom = atom(OPS, Views.opsOf(blank))

// ---------------------------------------------------------------------------
// The Host: every engine call Control Room makes, spelled once.

function hostOf($: EngineInterface): Host {
  return {
    pluginRoot: $.plugin.root,
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    every: (ms, fn) => $.clock.every(ms, fn),

    sessionId: () => $.session.id(),
    sessionRoot: () => $.session.root(),
    sessionModel: () => $.session.model(),
    usage: () => $.session.usage(),
    usageSummary: () => $.session.usage({ breakdown: 'summary' }),
    version: () => $.session.version(),
    surfaces: () => $.session.surfaces(),
    compact: instructions => $.session.compact({ instructions }),

    submit: text => $.prompt.submit({ text }),
    submitAsUser: text => $.prompt.submit({ text, asUser: true }),
    fillPrompt: text => $.prompt.fill({ text }).then(r => ({ isFilled: r.isFilled, refusal: r.refusal })),
    readPrompt: () => $.prompt.read().then(r => ({ text: r.text })),
    clearContext: () => $.command.run({ command: 'clear', args: '' }),
    compactCommand: instructions => $.command.run({ command: 'compact', args: instructions }),
    registerCommand: spec => $.command.register(spec),
    listCommands: () => $.command.list(),

    listAgents: () => $.agent.list(),
    listTools: () => $.tool.list(),
    registerTool: spec => $.tool.register(spec).then(r => r.tool),
    stopTask: taskId => $.tool.call({ tool: 'TaskStop', task_id: taskId }),
    sendToAgent: (agentId, text) => $.session.send({ to: { agentId }, text }).then(r => ({ isDelivered: r.isDelivered, reason: r.reason })),
    classify: (text, labels, model) => $.model.classify(text, labels, model === undefined ? undefined : { model }),
    fork: prompt => $.model.fork({ prompt }),

    toast: (text, timeoutMs) => $.ui.toast(text, timeoutMs === undefined ? undefined : { timeoutMs }),
    status: text => $.ui.status(text),
    open: pane => $.ui.open(pane),
    close: pane => $.ui.close(pane),
    panes: () => $.ui.panes(),
    scrollPaneToTop: () => $.ui.scroll({ in: PANE_ID, to: 'start' }).then(() => undefined),
    scrollPaneTo: key => $.ui.scroll({ in: PANE_ID, to: { key }, block: 'start' }).then(r => r.deny ?? null),
    focusPane: key => $.ui.focus({ requestId: PANE_ID, key }).then(r => r.deny ?? null),
    ask: (question, options, header) => $.ui.ask(question, header === undefined ? options : { options, header }),
    checkTool: (tool, input) => $.tool.check({ tool, input }),
    copy: (text, surface) => $.ui.copy({ text, surface }).then(r => r.isCopied),

    readText: path => $.fs.read(path),
    stat: (path, resolve) => $.fs.stat(path, { resolve }),
    exists: path => $.fs.exists(path),

    storeGet: key => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    storeDelete: key => $.store.delete(key),

    settings: source => $.settings.read(source === undefined ? undefined : { source }),
    cacheTtlConfig: async () => ({
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
      envTtl: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      setting: ((await $.settings.read().catch(() => ({}))) as Record<string, unknown>).promptCacheTtl,
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
    }),
    configEnv: async () => ({
      claudeConfigDir: await $.env.get('CLAUDE_CONFIG_DIR'),
      userProfile: await $.env.get('USERPROFILE'),
      home: await $.env.get('HOME'),
    }),
    formerHud: () => $.state.get(FORMER_HUD).then(read => read.value),
    isStandbyNoted: () => $.state.get(STANDBY).then(read => read.value?.isNoted === true),
    noteStandby: () => $.state.set(STANDBY, { isNoted: true }).then(() => undefined),
    // The CPU and memory samplers: each one program by name with fixed arguments, no shell, reading
    // machine-wide totals only (the 2 in each is SAMPLER_EVERY_SEC).
    spawnSampler: platform =>
      platform === 'windows'
        ? $.process.spawn({ argv: ['typeperf.exe', '\\Processor(_Total)\\% Processor Time', '\\Memory\\Available Bytes', '-si', '2'] })
        : $.process.spawn({ argv: ['top', '-l', '0', '-s', '2', '-n', '0'] }),
    systemInfo: () => $.process.run(['systeminfo.exe', '/fo', 'csv', '/nh'], { timeoutMs: 30_000 }),
    memoryLevel: () => $.process.run(['sysctl', '-n', 'kern.memorystatus_level'], { timeoutMs: 5_000 }),
    repoRoot: () => $.session.repo().then(r => r?.root ?? null),
    gitStatus: () => $.process.run(['git', 'status', '--porcelain=v1', '--branch', '--untracked-files=normal'], { timeoutMs: 10_000 }),
    hashFiles: paths => $.process.run(['git', 'hash-object', '--no-filters', '--', ...paths], { timeoutMs: 10_000 }),
    gitHead: () => $.process.run(['git', 'rev-parse', '--verify', '-q', 'HEAD'], { timeoutMs: 5_000 }),

    publishHud: v => $.state.set(HUD, v).then(() => undefined),
    publishPane: v => $.state.set(PANE, v).then(() => undefined),
    publishResources: v => $.state.set(RESOURCES, v).then(() => undefined),
    publishChain: v => $.state.set(CHAIN, v).then(() => undefined),
    publishActivity: v => $.state.set(ACTIVITY, v).then(() => undefined),
    publishPermissions: v => $.state.set(PERMISSIONS, v).then(() => undefined),
    publishFocus: v => $.state.set(FOCUS, v).then(() => undefined),
    publishSpinner: v => $.state.set(SPINNER, v).then(() => undefined),
    publishOps: v => $.state.set(OPS, v).then(() => undefined),

    saveAutopilotRecord: record => $.state.set(AUTOPILOT, { record }).then(() => undefined),
    loadAutopilotRecord: () => $.state.get(AUTOPILOT).then(read => read.value?.record ?? null),
    savePolicyMemo: memo => $.state.set(POLICY, memo).then(() => undefined),
    loadPolicyMemo: () => $.state.get(POLICY).then(read => read.value ?? null),
    saveCacheMemo: memo => $.state.set(CACHE_MEMO, memo).then(() => undefined),
    loadCacheMemo: () => $.state.get(CACHE_MEMO).then(read => read.value ?? null),
    saveAgentLedger: list => $.state.set(AGENT_LEDGER, list).then(() => undefined),
    loadAgentLedger: () => $.state.get(AGENT_LEDGER).then(read => read.value ?? null),

    invalidateDescribes: () => $.ui.invalidate('tool.describe'),
    invalidatePromptContext: () => $.ui.invalidate('prompt.context'),
    trace: text => $.ui.log(text, { to: 'debug' }),
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const register: Register = on => {
  const rt = new Runtime()
  const actions = actionsOf(rt)
  const kitOf = (table: Parameters<typeof uiOf>[0], columns: number, surface: RenderSurface, placement?: Kit['placement']): Kit => ({
    ui: uiOf(table, surface),
    actions,
    columns: Math.max(20, columns),
    surface,
    now: Date.now(),
    openPicker: null,
    placement,
  })

  // -------------------------------------------------------------------------
  // Session lifecycle

  on('session.start', async ($, e, next) => {
    if (rt.host === null) rt.bind(hostOf($))
    const started = await next(e)
    // Control Room still runs in this session (an update loaded both): stand by until it restarts.
    if (await rt.checkStandby()) return started
    await rt.onSessionStart(e)
    return started
  })

  on('session.end', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (rt.host === null) rt.bind(hostOf($))
    await rt.onSessionEnd(e).catch(() => undefined)
    return next(e)
  })

  // A session begins, or a fresh context after /clear: noted, and passed on unchanged (the fresh
  // context's notes ride its first prompt instead, so the session's start is Claude Code's own).
  on('classic.SessionStart', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (rt.host === null) rt.bind(hostOf($))
    if (e.permission_mode !== undefined) rt.permissionMode = e.permission_mode
    await rt.onClassicSessionStart({
      source: e.source,
      sessionId: e.session_id,
      model: e.model,
      transcriptPath: e.transcript_path,
      // A resumed session: Claude Code's own word on its cache (the Cold Resume Guard's facts).
      secondsSince: e.seconds_since_last_response,
      contextTokens: e.context_tokens,
      isCacheExpired: e.prompt_cache_likely_expired,
      usd: e.estimated_cache_write_usd,
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (e.permission_mode !== undefined) rt.permissionMode = e.permission_mode
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.attach', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const answer = await next(e)
    if (!rt.surfaces.includes(e.surface)) rt.surfaces = [...rt.surfaces, e.surface]
    rt.publisher.mark('pane')
    return answer
  })

  on('session.measure', ($, e, next) => {
    if (rt.isStandby) return next(e)
    rt.onMeasure(e)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const answer = await next(e)
    if (e.agentId === undefined) rt.onCompacted(e.trigger, answer)
    return answer
  }).catch(($, e, next) => next(e))

  // -------------------------------------------------------------------------
  // Prompts and the system prompt

  on('prompt.submit', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (rt.host === null) rt.bind(hostOf($))
    await rt.ensureLoaded()
    // A handoff under way first: an instruction about it ("handoff now") is acted on and never sent, and
    // other words are not let into a context about to be cleared unasked. Then the Cold Resume Guard:
    // before a message re-reads a large context whose cache has surely lapsed, ask (nothing is sent
    // yet). The Run Budget asks once at a limit set to Ask. Any of them may keep the message.
    const held = (await rt.handoffGuard(e)) ?? (await rt.ops.coldGuard(e)) ?? (await rt.ops.budgetGuard(e))
    if (held !== null) return held
    // The origin tells a background task's notification (and the turn it starts) from the person's prompt;
    // its end is timed by the engine's clock, as the handoff's other steps are.
    const origin: { kind: string } | undefined = e.origin
    const now = origin?.kind === 'task-notification' ? await $.clock.now() : undefined
    const extra = rt.onPromptSubmit(e.text, e.origin, e.turnId, now)
    return next(extra.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...extra] })
  }).catch(($, e, next) => next(e))

  // The fresh context after Control Room's own handoff: its first message carries the notes as one
  // more context block, once (the run, the notes file's path, the milestones, the objective).
  on('prompt.context', ($, e, next) => {
    if (rt.isStandby) return next(e)
    const notes = rt.takeFreshContext()
    return next(notes === null ? e : { ...e, blocks: [...e.blocks, { name: 'contextAutopilot', text: notes }] })
  }).catch(($, e, next) => next(e))

  // The system prompt's own section. The settings are loaded first, whichever hook is the session's
  // first: a request is never composed from defaults while the person's settings are still loading.
  on('prompt.compose', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (rt.host === null) rt.bind(hostOf($))
    await rt.ensureLoaded()
    const answer = await next(e)
    const section = rt.composeSection(e.outputStyle, e.traits)
    if (section === null) return answer
    return { sections: [...answer.sections.filter(s => s.id !== POLICY_SECTION_ID), section] }
  }).catch(($, e, next) => next(e))

  // -------------------------------------------------------------------------
  // Turns

  on('turn.start', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    await rt.onTurnStart({ turnId: e.turnId, text: e.text })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (rt.isStandby) return yield* next(e)
    if (rt.host === null) rt.bind(hostOf($))
    await rt.ensureLoaded()
    const want = rt.stepRequest(e)
    const request = want.model === undefined && want.effort === undefined ? e : { ...e, ...want }
    const answer = yield* next(request)
    rt.stepResponse(e, want, answer)
    return answer
  })

  on('turn.complete', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const answer = await next(e)
    await rt.onTurnComplete({ agentId: e.agentId, reason: e.reason, answer: e.answer })
    return answer
  })

  // Model switches: the engine reports the cache's state and lifetime. With a large
  // warm cache, a switch the person makes is confirmed first (Cache Guardian).
  on('classic.PreModelSwitch', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const answer = await next(e)
    if (answer.permissionDecision === 'deny' || answer.permissionDecision === 'ask') return answer
    const reason = rt.onPreModelSwitch(e)
    return reason === null ? answer : { ...answer, permissionDecision: 'ask' as const, permissionDecisionReason: reason }
  }).catch(($, e, next) => next(e))

  on('classic.PostModelSwitch', ($, e, next) => {
    if (rt.isStandby) return next(e)
    rt.onPostModelSwitch(e)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Notes for Claude while it works (a setting changed, the machine is busy, the handoff is coming)
  // go with the next batch of tool results, as Claude Code's own hook context: filed with that batch,
  // so every later request reads the conversation exactly as this one did (app/notes.ts). Main
  // conversation only: a subagent's batch carries its `agent_id`.
  on('classic.PostToolBatch', async ($, e, next) => {
    const answer = await next(e)
    if (rt.isStandby || e.agent_id !== undefined) return answer
    const notes = rt.notesForBatch()
    return notes.length === 0 ? answer : { ...answer, additionalContext: [...(answer.additionalContext ?? []), ...notes] }
  }).catch(($, e, next) => next(e))

  // Claude Code's record that the API found the conversation's earlier part changed and dropped the
  // thinking made over it (`thinking_drop`): proof of why the next request rebuilds the cache. Only
  // the row's kind is read; the row is passed on unchanged.
  on('session.append', { door: 'attachment' }, async ($, e, next) => {
    if (!rt.isStandby && e.agentId === undefined && e.message.name === 'thinking_drop') rt.cache.noteHistoryChanged(rt.clock())
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const answer = await next(e)
    if (answer.block !== undefined || answer.preventContinuation === true) return answer
    const block = await rt.onStop({
      stopHookActive: e.stop_hook_active,
      lastMessage: e.last_assistant_message ?? '',
      background: e.background_tasks ?? [],
      wakeups: e.session_crons ?? [],
      permissionMode: e.permission_mode,
    })
    return block === null ? answer : { ...answer, block }
  }).catch(($, e, next) => next(e))

  // A turn Claude Code ended on an API error: a rate limit is the plan's limit reached (the status bar's 5H reads it).
  on('classic.StopFailure', ($, e, next) => {
    if (!rt.isStandby) rt.onStopFailure(e.error)
    return next(e)
  }).catch(($, e, next) => next(e))

  // -------------------------------------------------------------------------
  // Tools: permissions, resources, activity

  // Control Room's own milestones tool, offered only where Claude Code has no task list.
  // Registered before the general hook, so it answers the call itself.
  on('tool.call', { tool: /^mcp__project-sentinel__milestones$/ }, async ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (rt.host === null) rt.bind(hostOf($))
    await rt.ensureLoaded()
    return { result: rt.recordMilestones(isRecord(e) ? { ...e } : {}, e.agentId) }
  })

  // The Decision Inbox's tool (Behavior → Decisions): the question waits for the person; Claude is told what to do meanwhile.
  on('tool.call', { tool: /^mcp__project-sentinel__decision_request$/ }, async ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (rt.host === null) rt.bind(hostOf($))
    await rt.ensureLoaded()
    return { result: rt.ops.decisionTool(isRecord(e) ? { ...e } : {}, e.agentId) }
  })

  on('tool.call', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (rt.host === null) rt.bind(hostOf($))
    const tool = String(e.tool)
    const input: Record<string, unknown> = isRecord(e) ? { ...e } : {}
    const refusal = await rt.beforeTool(tool, input, e.tool_use_id, e.agentId)
    if (refusal !== null) return { deny: refusal }
    let answer: Awaited<ReturnType<typeof next>> | undefined
    try {
      answer = await next(e)
      return answer
    } finally {
      rt.afterTool(tool, input, e.tool_use_id, answer, e.agentId)
    }
  }).catch(($, e, next) => {
    // Fail safe: a crash in the full classifier still never lets an obvious catastrophe through.
    const raw = (e as unknown as Record<string, unknown>).command
    const command = isShellTool(String(e.tool)) && typeof raw === 'string' ? raw : ''
    if (!next.called && command !== '' && isObviouslyDangerous(command)) {
      return { deny: 'Control Room Permission Policy: refused a dangerous command (safety fallback).' }
    }
    return next(e)
  })

  // -------------------------------------------------------------------------
  // Subagents

  on('agent.offer', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (rt.host === null) rt.bind(hostOf($))
    await rt.ensureLoaded()
    return rt.isAgentOffered(e) ? next(e) : { isOffered: false }
  }).catch(($, e, next) => (rt.settings.subagents.mode === 'block' ? { isOffered: false } : next(e)))

  on('agent.spawn', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (rt.host === null) rt.bind(hostOf($))
    const decision = await rt.onAgentSpawn(e)
    if (decision.deny !== undefined) return { deny: decision.deny }
    // The agent shows from its spawn (its id, model, background, fork, parent, a workflow run's place);
    // its slot is released whatever the start's outcome.
    let answer: Awaited<ReturnType<typeof next>> | undefined
    try {
      answer = await next(decision.model === undefined ? e : { ...e, model: decision.model })
      return answer
    } finally {
      rt.onAgentSpawned(e, answer, decision.isReserved === true)
    }
  }).catch(($, e, next) =>
    rt.settings.subagents.mode === 'block' && !next.called ? { deny: 'Control Room: subagents are disabled in this session.' } : next(e),
  )

  // -------------------------------------------------------------------------
  // Commands

  on('command.run', { command: ['control-room', 'cr'] }, async ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (rt.host === null) rt.bind(hostOf($))
    if (!rt.isOwnCommand(e.command)) return next(e)
    await rt.ensureLoaded()
    return rt.runCommand(e.args)
  }).catch(($, e, next) =>
    next.called ? next(e) : { text: 'Control Room could not complete that command (details in the debug log: claude --debug).' },
  )

  // Kit's module reports that it could not draw: leave it out from now on, so the status bar draws without it.
  on('ui.message', async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const answer = await next(e)
    if (e.element === 'kit' && isRecord(e.data) && typeof e.data.fault === 'string') {
      rt.companionFault = e.data.fault.slice(0, 160)
      rt.publisher.mark('hud')
    }
    return answer
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const answer = await next(e)
    if (answer.deny === undefined) {
      rt.ui.isPaneOpen = false
      rt.publisher.mark('hud')
    }
    return answer
  }).catch(($, e, next) => next(e))

  // -------------------------------------------------------------------------
  // Drawing

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (rt.isStandby) return next(e)
    if (e.props.hasSurvey || e.surface === 'mobile') return next(e)
    const hud = await read($, hudAtom)
    if (!hud.isVisible) return next(e)
    const below = await next(e)
    // Kit, the companion, on a lane of its own: its surface module plays it on the surface's own clock.
    let stage: RenderElement | null = null
    if (hud.companion !== null && (e.surface === 'terminal' || e.surface === 'desktop')) {
      const ui = $.ui.resolve(e)
      const kitProps = { ...hud.companion, surface: e.surface }
      // Five rows in the terminal; on Desktop the lane is as tall as the image the module draws.
      stage =
        e.surface === 'terminal' ? (
          <ui.Client key="kit" module="./kit.client.tsx" props={kitProps} height={5} flexGrow={1} />
        ) : (
          <ui.Client key="kit" module="./kit.client.tsx" props={kitProps} flexGrow={1} />
        )
    }
    const own = hudView(kitOf($.ui.resolve(e), e.props.bodyColumns, e.surface), hud, stage)
    if (below.type === 'engine') return own
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {own}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const pane = await read($, paneAtom)
    const hud = await read($, hudAtom)
    const needs = TAB_NEEDS[pane.tab]
    const data = {
      pane,
      hud,
      resources: needs.includes('resources') ? await read($, resourcesAtom) : undefined,
      chain: needs.includes('chain') ? await read($, chainAtom) : undefined,
      activity: needs.includes('activity') ? await read($, activityAtom) : undefined,
      permissions: needs.includes('permissions') ? await read($, permissionsAtom) : undefined,
      ops: needs.includes('ops') ? await read($, opsAtom) : undefined,
    }
    return paneView(kitOf($.ui.resolve(e), e.props.bodyColumns, e.surface, e.props.placement), data)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const focus = await read($, focusAtom)
    if (!focus.isOn) return next(e)
    const kit = kitOf($.ui.resolve(e), e.viewport?.columns ?? 100, e.surface)
    if (focus.expanded.includes(e.props.tool_use_id)) {
      const { Box } = kit.ui
      return (
        <Box flexDirection="column">
          {collapseBar(kit, e.props.tool_use_id)}
          {await next(e)}
        </Box>
      )
    }
    if (focus.tools === 'hidden') return hiddenRow(kit)
    return compactToolRow(kit, e.props)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const focus = await read($, focusAtom)
    if (!focus.isOn || focus.expanded.includes(e.props.tool_use_id)) return next(e)
    const isDiff = isEditTool(e.props.tool)
    const isShown = isDiff ? focus.diffs : focus.results
    if (isShown || e.props.isErrored) return next(e)
    return hiddenRow(kitOf($.ui.resolve(e), 40, e.surface))
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const focus = await read($, focusAtom)
    if (!focus.isOn || focus.tools !== 'hidden' || e.props.isExpanded) return next(e)
    return hiddenRow(kitOf($.ui.resolve(e), 40, e.surface))
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const spinner = await read($, spinnerAtom)
    if (spinner.line === null) return next(e)
    return next({ ...e, props: { ...e.props, message: spinner.line } })
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (rt.isStandby) return next(e)
    const hud = await read($, hudAtom)
    const label = hud.frontier.isOn && hud.profile.id !== 'frontier' ? 'Frontier Max' : hud.profile.id === 'normal' ? null : hud.profile.name
    if (label === null) return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, `◆ ${label}`] } })
  })

}
