/**
 * Overview: how the run is doing, then a map of everything that is on, in the order the eye needs it:
 *
 *   1. what needs the person (a handoff to start, a watcher due, a message held: a callout on top);
 *   2. what is happening now: the run (its number, the session, the whole run's cost), what Claude is
 *      doing in the status bar's words, a failing check, and the run's operations while anything is
 *      in them (decisions to review, queued work, a watcher, agents, the budget);
 *   3. the three lifecycles, each a card with its own graphic and one line on how it starts over:
 *        WORK     the objective's milestones; carries across handoffs
 *        CONTEXT  the reasoning window; starts over at each handoff
 *        CACHE    the prompt cache; starts over with each fresh context, lapses when idle
 *   4. one card per remaining section (Behavior, Guardrails, Activity, Setup), each system with its
 *      switch and one line of state, and a quiet "Open ›" to the section itself, so the page also
 *      teaches where everything lives.
 */

import type { RenderElement } from 'claude-code'

import type { PermissionCategory, StatusView, Tone } from '../../../types'
import * as fmt from '../../core/format'
import { listProfiles } from '../../core/profiles'
import { PERMISSION_CATEGORIES } from '../../core/settings'
import type { Kit } from '../kit'
import { apart, buttons, cacheClock, callout, card, clip, emptyState, link, listItem, meterBar, pair, picker, row, stateLine, switchControl, textRuns, workTrack } from '../primitives'
import { ACCENT, G } from '../theme'
import { alertActions } from '../hud'
import { cacheState, cacheSummary, lifetimeWords } from './cache'
import type { PaneData } from './frame'

/** A status as a row's subtitle: quiet unless it needs a look. */
export const subtitleOf = (s: StatusView): { subtitle: string; subtitleTone: Tone } => ({
  subtitle: s.text,
  subtitleTone: s.tone === 'warn' || s.tone === 'bad' ? s.tone : 'muted',
})

export function alertCallout(kit: Kit, data: PaneData): RenderElement | null {
  const alert = data.hud.alert
  if (alert === null) return null
  if (alert.kind === 'pending') {
    return callout(kit, {
      key: 'alert',
      tone: 'warn',
      title: 'Handing off soon',
      text: 'Claude is finishing the current step. Then it writes handoff notes and continues in a fresh context.',
      actions: [
        { key: 'alert-handoff', label: 'Hand off now', onPress: kit.actions.handoff, isPrimary: true },
        { key: 'alert-later', label: 'Later', onPress: kit.actions.snooze },
      ],
    })
  }
  if (alert.kind === 'awaiting') {
    return callout(kit, {
      key: 'alert',
      tone: alert.tone,
      title: 'Waiting for you',
      text: alert.text,
      actions: [
        { key: 'alert-fresh', label: 'Start fresh context', onPress: kit.actions.fresh, isPrimary: true },
        { key: 'alert-later', label: 'Later', onPress: kit.actions.snooze },
      ],
    })
  }
  if (alert.kind === 'load') return callout(kit, { key: 'alert', tone: 'bad', title: 'Machine under heavy load', text: alert.text })
  // The orchestration layer's: the status bar's line, with the same actions.
  const title = { waiting: 'Handoff waiting for background work', stuck: 'Handoff needs a look', watcher: 'Watcher due', held: 'Your message was not sent', budget: 'Run budget reached', suggest: 'Watcher suggestion' }[alert.kind]
  return callout(kit, { key: 'alert', tone: alert.tone, title, text: alert.text, actions: alertActions(kit, alert).map(a => ({ ...a, key: `alert-${a.key}` })) })
}

/** The run's operations at a glance, only while something is in them; Activity → Operations has them in full. */
function operationsCard(kit: Kit, data: PaneData): RenderElement | null {
  const ops = data.hud.ops
  if (ops === null) return null
  const w = ops.watcher
  return card(kit, {
    key: 'operations',
    title: 'Operations',
    accent: ACCENT.activity,
    link: { label: 'Open', onPress: () => kit.actions.openOps() },
    rows: k => [
      ops.review === 0
        ? null
        : listItem(k, { key: 'ops-review', glyph: G.warn, tone: 'warn', text: `Review ${ops.review}`, detail: ops.blocking > 0 ? `${fmt.plural(ops.blocking, 'decision')} block${ops.blocking === 1 ? 's' : ''} the run` : 'Decisions Claude left for you', isBold: true }),
      w === null
        ? null
        : listItem(k, {
            key: 'ops-watcher',
            glyph: G.wait,
            tone: w.needs !== null ? 'warn' : 'info',
            text: w.needs !== null ? `Watcher due · ${w.label}` : w.status === 'armed' ? `Watcher · wakes in ${w.left}` : `Watcher · ${w.label}`,
            right: w.status === 'armed' ? w.at : undefined,
            detail: w.needs ?? (w.status === 'armed' ? spacedWords([w.label, w.isHeldWarm ? 'cache held warm' : w.mode === 'fresh' ? 'wakes fresh' : null, ops.watchers > 1 ? `${ops.watchers} watchers` : null]) : 'Goes when this turn ends'),
          }),
      ops.queued === 0 ? null : listItem(k, { key: 'ops-queued', glyph: G.dot, tone: 'info', text: `Queued ${ops.queued}`, detail: ops.due > 0 ? `${ops.due} due at the next boundary` : 'Work for later' }),
      ops.agents === 0 ? null : listItem(k, { key: 'ops-agents', glyph: G.run, tone: 'info', text: `Agents ${ops.agents} active` }),
      ops.budget === null ? null : listItem(k, { key: 'ops-budget', glyph: ops.budget.isReached ? G.warn : G.dot, tone: ops.budget.tone === 'muted' ? 'muted' : ops.budget.tone, text: ops.budget.text }),
    ],
  })
}

const spacedWords = (parts: readonly (string | null)[]): string => parts.filter((p): p is string => p !== null && p !== '').join(' · ')

/**
 * A fresh install's first look, once: what Sentinel does out of the box and where things live, in five
 * lines and a "Got it". Not a tutorial: each line names a place to open.
 */
function firstRunCard(kit: Kit, data: PaneData): RenderElement | null {
  const f = data.pane.firstRun
  if (f === null) return null
  const go = (tab: Parameters<Kit['actions']['setTab']>[0], label: string) => link(kit, { key: `first-${tab}`, label, onPress: () => kit.actions.setTab(tab) })
  return card(kit, {
    key: 'first-run',
    title: 'Sentinel is on',
    footer: 'Every default is a setting: change any of them, or pick another profile in Setup (Classic turns Autopilot and Frontier Max off).',
    rows: k => [
      row(k, {
        key: 'first-autopilot',
        label: f.autopilot === null ? 'Context Autopilot is off' : `Autopilot protects the context at ${f.autopilot}`,
        subtitle: f.autopilot === null ? undefined : 'Claude writes handoff notes, then carries on in a fresh context',
        control: go('context', 'Context'),
      }),
      row(k, {
        key: 'first-frontier',
        label: f.frontier === null ? 'Frontier Max is off' : `Frontier Max at ${f.frontier}`,
        subtitle: f.frontier === null ? undefined : 'A finish-and-verify policy; never changes the model',
        control: go('behavior', 'Behavior'),
      }),
      row(k, { key: 'first-guardrails', label: 'Guardrails: what Claude may do', subtitle: f.guardrails, control: go('guardrails', 'Guardrails') }),
      row(k, { key: 'first-activity', label: 'Activity has views', subtitle: 'Summary · Operations · Agents · Tool calls', control: go('activity', 'Activity') }),
      row(k, { key: 'first-work', label: 'Work carries on; Context starts over', subtitle: 'Milestones carry across handoffs; the context window starts fresh at each one' }),
      buttons(k, [{ key: 'first-dismiss', label: 'Got it', onPress: kit.actions.dismissOnboarding, isPrimary: true }], 'first-actions'),
    ],
  })
}

function permissionSummary(p: Record<PermissionCategory, string>): string {
  const count = (state: string) => PERMISSION_CATEGORIES.filter(c => p[c] === state).length
  const parts = [count('ask') > 0 ? `${count('ask')} ask` : '', count('deny') > 0 ? `${count('deny')} deny` : ''].filter(Boolean)
  return parts.length === 0 ? 'Claude Code decides' : parts.join(' · ')
}

/** The run at the top: which run and session, the whole run's cost, and what it is for. */
function runHeader(kit: Kit, data: PaneData): RenderElement {
  const { Box, Text } = kit.ui
  const { hud } = data
  const run = hud.cost.runUsd ?? hud.cost.usd
  const s = hud.session
  const title = s.run === null ? 'No run yet' : `Run ${s.run} · Session ${s.index}`
  const under = [s.handoffs > 0 ? fmt.plural(s.handoffs, 'handoff') : '', s.handoffs > 0 && hud.cost.usd !== null ? `${fmt.cost(hud.cost.usd)} this session` : ''].filter(Boolean).join(' · ')
  return (
    <Box key="run-head" flexDirection="column" marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexShrink={1} {...clip(kit)}>
          <Text bold wrap="truncate-end">
            <Text color="claude">{`${G.brand} `}</Text>
            {title}
          </Text>
        </Box>
        <Text bold dimColor={run === null ? true : undefined}>{`${fmt.cost(run)}${run !== null && hud.cost.isRunPartial ? '+' : ''}`}</Text>
      </Box>
      {hud.objective === null && under === '' ? null : pair(kit, { key: 'run-under', left: hud.objective ?? '', right: under === '' ? undefined : under })}
      {hud.git === null || kit.surface !== 'terminal' ? null : pair(kit, { key: 'run-git', left: `Git   ${hud.git}` })}
    </Box>
  )
}

/**
 * What is happening now, right under the run and unboxed: the status bar's headline in full, with its
 * mark, and a failing check or calls that need a look, in amber, with the way to Activity.
 */
function nowBlock(kit: Kit, data: PaneData): RenderElement {
  const { Box } = kit.ui
  const { hud } = data
  const line = hud.headline
  const needsLook = hud.attention + hud.failing.length
  return (
    <Box key="now" flexDirection="column" marginTop={1}>
      {stateLine(kit, {
        key: 'now-line',
        state: line.state,
        text: line.text,
        detail: line.detail,
        isBold: line.state === 'working' || line.state === 'validating' || line.state === 'handoff' || line.state === 'blocked' || line.state === 'waitingUser' || line.state === 'waitingExternal',
        isDim: line.state === 'ready' || line.state === 'thinking',
      })}
      {needsLook === 0
        ? null
        : row(kit, {
            key: 'now-attention',
            label: hud.failing.length > 0 ? `${hud.failing.join(', ')} failing` : `${fmt.plural(hud.attention, 'call')} need${hud.attention === 1 ? 's' : ''} a look`,
            control: link(kit, { key: 'now-attention', label: 'Activity', onPress: () => kit.actions.setTab('activity') }),
            isDim: false,
          })}
    </Box>
  )
}

export function overviewPage(kit: Kit, data: PaneData): RenderElement {
  const { Box } = kit.ui
  const { pane, hud } = data
  const s = pane.settings
  const st = pane.status
  const u = kit.actions.update
  const ctx = hud.ctx
  const go = (tab: Parameters<Kit['actions']['setTab']>[0]) => ({ label: 'Open', onPress: () => kit.actions.setTab(tab) })

  const fraction = ctx.tokens !== null && ctx.window !== null && ctx.window > 0 ? ctx.tokens / ctx.window : 0
  const marker = ctx.threshold !== null && ctx.window !== null && ctx.window > 0 ? ctx.threshold / ctx.window : null
  const load = hud.load
  const pct = (n: number | null) => (n === null ? G.none : `${Math.round(n)}%`)
  const readingTone = (t: Tone): Tone => (t === 'warn' || t === 'bad' ? t : 'normal')

  const toggle = (k: Kit, key: string, label: string, isOn: boolean, onPress: () => void, status: StatusView) =>
    row(k, { key, label, control: switchControl(k, { key, isOn, onPress }), ...(isOn ? subtitleOf(status) : {}) })

  const profiles = listProfiles(s).map(p => ({ value: p.id, label: p.name, hint: p.tagline }))
  const activeProfile = profiles.find(p => p.value === s.profile)

  const work = hud.work
  const cache = pane.cache
  const cacheNow = cacheState(cache, kit.now)
  const lapses = cache.ttl === '5m' ? 'lapses after five idle minutes' : cache.ttl === '1h' ? 'lapses after an idle hour' : 'lapses when left idle'
  const isLoadHigh = load !== null && (readingTone(load.cpuTone) !== 'normal' || readingTone(load.ramTone) !== 'normal')

  return (
    <Box flexDirection="column">
      {alertCallout(kit, data)}

      {firstRunCard(kit, data)}

      {runHeader(kit, data)}
      {nowBlock(kit, data)}

      {operationsCard(kit, data)}

      {card(kit, {
        key: 'life-work',
        title: 'Work',
        accent: ACCENT.activity,
        aside: work === null ? undefined : `${work.done} of ${work.total}`,
        link: go('activity'),
        footer: 'Carries across handoffs, counted from Claude’s own milestones.',
        rows: k =>
          work === null
            ? [emptyState(k, 'Claude lists milestones when the work has several steps.', 'work-empty')]
            : [
                workTrack(k, {
                  key: 'work-track',
                  done: work.done,
                  total: work.total,
                  hasCurrent: work.current !== null,
                  max: Math.max(4, Math.min(12, Math.floor((k.columns - 24) / 2))),
                  caption: work.done === work.total ? 'All milestones done' : `${work.done} of ${fmt.plural(work.total, 'milestone')}`,
                  isAnimated: hud.isAnimated,
                }),
                work.current === null ? null : listItem(k, { key: 'work-now', glyph: G.run, tone: 'info', text: work.current }),
              ],
      })}

      {card(kit, {
        key: 'life-context',
        title: 'Context',
        accent: ACCENT.context,
        aside: ctx.pct === null ? undefined : `${ctx.pct}%`,
        link: go('context'),
        footer: s.autopilot.enabled ? 'Starts over at each handoff.' : 'Starts over when you clear it; Autopilot hands off before it fills.',
        rows: k => [
          meterBar(k, { key: 'ctx-meter', fraction, marker, tone: ctx.tone === 'muted' ? 'good' : ctx.tone, width: k.columns, alt: `Context ${ctx.pct ?? 0}% used` }),
          pair(k, {
            key: 'ctx-under',
            left: ctx.tokens === null ? 'Waiting for the first response' : `${fmt.tokens(ctx.tokens)}${ctx.window === null ? '' : ` of ${fmt.tokens(ctx.window)}`} tokens`,
            right: hud.autopilot.isOn && ctx.threshold !== null ? `hands off at ${fmt.tokens(ctx.threshold)}` : undefined,
          }),
          apart(k, 'sys-autopilot', toggle(k, 'sys-autopilot', 'Autopilot', s.autopilot.enabled, () => u(d => void (d.autopilot.enabled = !d.autopilot.enabled)), st.autopilot)),
        ],
      })}

      {card(kit, {
        key: 'life-cache',
        title: 'Cache',
        accent: ACCENT.context,
        // The state is the card's first line; the aside says how long the cache lasts.
        aside: lifetimeWords(cache) ?? undefined,
        link: go('context'),
        footer: cache.warmth === 'none' ? undefined : `Starts over with each fresh context, and ${lapses}.${s.cache.keepWarm ? ' Keep warm holds it while you are away.' : ''}`,
        rows: k =>
          cache.warmth === 'none'
            ? [
                // Nothing cached yet: one row, the switch beside what the cache will be.
                row(k, {
                  key: 'sys-keepwarm',
                  label: 'Keep warm',
                  subtitle: 'Nothing cached yet',
                  control: switchControl(k, { key: 'sys-keepwarm', isOn: s.cache.keepWarm, onPress: () => u(d => void (d.cache.keepWarm = !d.cache.keepWarm)) }),
                }),
              ]
            : [
                cacheClock(k, { key: 'cache-clock', fraction: cacheNow.fraction, tone: cacheNow.tone, text: cacheNow.text, isBold: cache.warmth === 'warm' }),
                pair(k, { key: 'cache-under', left: cacheSummary(cache) }),
                apart(
                  k,
                  'sys-keepwarm',
                  row(k, {
                    key: 'sys-keepwarm',
                    label: 'Keep warm',
                    control: switchControl(k, { key: 'sys-keepwarm', isOn: s.cache.keepWarm, onPress: () => u(d => void (d.cache.keepWarm = !d.cache.keepWarm)) }),
                  }),
                ),
              ],
      })}

      {card(kit, {
        key: 'sys-behavior',
        title: 'Behavior',
        accent: ACCENT.behavior,
        link: go('behavior'),
        rows: k => [
          toggle(k, 'sys-frontier', 'Frontier Max', s.frontier.enabled, () => u(d => void (d.frontier.enabled = !d.frontier.enabled)), st.frontier),
          toggle(k, 'sys-guard', 'Lazy-exit guard', s.guard.enabled, () => u(d => void (d.guard.enabled = !d.guard.enabled)), st.guard),
          toggle(k, 'sys-qa', 'Release check', s.qa.enabled, () => u(d => void (d.qa.enabled = !d.qa.enabled)), st.qa),
          row(k, { key: 'sys-router', label: 'Model router', control: link(k, { key: 'sys-router', label: st.router.text, onPress: () => kit.actions.setTab('behavior') }) }),
          row(k, { key: 'sys-answers', label: 'Answer style', control: link(k, { key: 'sys-answers', label: st.answers.text, onPress: () => kit.actions.setTab('behavior') }) }),
        ],
      })}

      {card(kit, {
        key: 'sys-guardrails',
        title: 'Guardrails',
        accent: ACCENT.guardrails,
        link: go('guardrails'),
        rows: k => [
          row(k, { key: 'sys-perms', label: 'Permissions', control: link(k, { key: 'sys-perms', label: permissionSummary(s.permissions), onPress: () => kit.actions.setTab('guardrails') }) }),
          row(k, { key: 'sys-agents', label: 'Subagents', control: link(k, { key: 'sys-agents', label: st.subagents.text, onPress: () => kit.actions.setTab('guardrails') }) }),
          load === null
            ? null
            : textRuns(k, 'machine-value', [
                { text: k.surface === 'terminal' ? 'Machine   CPU ' : 'Machine · CPU ', tone: 'muted' },
                { text: pct(load.cpu), tone: readingTone(load.cpuTone), isBold: load.cpuTone === 'bad' },
                { text: k.surface === 'terminal' ? '   Memory ' : ' · Memory ', tone: 'muted' },
                { text: pct(load.ram), tone: readingTone(load.ramTone), isBold: load.ramTone === 'bad' },
                ...(isLoadHigh ? [{ text: kit.surface === 'terminal' ? '   busy' : ' · busy', tone: 'warn' as const }] : []),
              ]),
          row(k, {
            key: 'sys-load',
            label: 'Machine load limit',
            control: switchControl(k, { key: 'sys-load', isOn: s.resources.level !== 'off', onPress: () => u(d => void (d.resources.level = d.resources.level === 'off' ? 'medium' : 'off')) }),
            ...(s.resources.level === 'off'
              ? {}
              : { subtitle: data.resources?.ceilings === null || data.resources === undefined ? st.load.text : `${st.load.text.split(' · ')[0]} · CPU ${data.resources.ceilings.cpu}% · RAM ${data.resources.ceilings.ram}%` }),
          }),
          ...pane.agents.running.map(ag => listItem(k, { key: `agent-${ag.id}`, glyph: G.dot, tone: 'info', text: `${ag.type}  ${ag.description}`, right: ag.status })),
        ],
      })}

      {card(kit, {
        key: 'sys-activity',
        title: 'Activity',
        accent: ACCENT.activity,
        link: go('activity'),
        rows: k => [toggle(k, 'sys-focus', 'Focus view', s.focus.enabled, kit.actions.toggleFocus, st.focus)],
      })}

      {card(kit, {
        key: 'sys-setup',
        title: 'Setup',
        accent: ACCENT.setup,
        link: go('setup'),
        rows: k => [
          row(k, {
            key: 'profile',
            label: 'Profile',
            subtitle: hud.profile.isModified ? 'Edited since you applied it' : activeProfile?.hint,
            control: picker(k, { key: 'profile', value: s.profile, options: profiles, onSelect: v => kit.actions.applyProfile(v) }),
          }),
        ],
      })}
    </Box>
  )
}
