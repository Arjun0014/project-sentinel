/**
 * Activity: the run in detail, signal before noise.
 *
 * Summary (the default): the run's objective and milestones, what Claude is
 * doing now and next; what it did this turn, in a few counted lines; what
 * needs a look (Attention); how the checks went (Validation); and the files
 * it changed, real project changes first, generated and temporary files
 * folded apart. Operations is the run over time (ui/pane/operations.tsx):
 * what waits for the person, work queued for later, watchers, agents, the
 * budget. Every tool call, in order, is the last view.
 */

import type { RenderElement } from 'claude-code'

import type {
  ActivityItemView,
  ActivityView,
  AttentionView,
  ChangeGroupView,
  FileChangeView,
  OpsView,
  PaneModel,
  QuestView,
  Tone,
  TurnTimelineView,
  ValidationView,
} from '../../../types'
import * as fmt from '../../core/format'
import type { Kit } from '../kit'
import {
  buttons,
  card,
  clip,
  diffSquares,
  dots,
  emptyState,
  field,
  legend,
  levelBadge,
  link,
  listItem,
  meterBar,
  note,
  row,
  segmented,
  subNav,
  switchControl,
  timelineStrip,
  workTrack,
} from '../primitives'
import { ACCENT, G, STATE_MARK, SVG_COLOR, TIMELINE, toneProps } from '../theme'
import { agentsPage } from './agents'
import { operationsPage } from './operations'

const CALL_STATUS: Record<string, { glyph: string; tone: Tone }> = {
  running: { glyph: G.run, tone: 'info' },
  ok: { glyph: G.ok, tone: 'good' },
  error: { glyph: G.fail, tone: 'bad' },
  denied: { glyph: G.stop, tone: 'warn' },
  held: { glyph: G.stop, tone: 'warn' },
}

const elapsed = (kit: Kit, since: number): string => fmt.duration(Math.max(0, kit.now - since))

/** How a milestone reads in the run's list: its glyph, tone, and a word for the states a glyph alone would not say. */
const TASK_LOOK: Record<string, { glyph: string; tone: Tone; word?: string }> = {
  completed: { glyph: G.ok, tone: 'good' },
  in_progress: { glyph: G.arrow, tone: 'info' },
  verifying: { glyph: G.verify, tone: 'info', word: 'verifying' },
  waiting: { glyph: G.wait, tone: 'info', word: 'waiting' },
  blocked: { glyph: G.stop, tone: 'bad', word: 'blocked' },
  pending: { glyph: G.ring, tone: 'muted' },
}

// ---------------------------------------------------------------------------
// Run progress

function runCard(kit: Kit, view: ActivityView, isAnimated: boolean): RenderElement {
  const { Box, Text } = kit.ui
  const m = view.mission
  const accent = ACCENT.activity
  const checks = view.validation
  const aside = `Session ${m.session}${m.handoffs > 0 ? ` · ${fmt.plural(m.handoffs, 'handoff')}` : ''}`
  return card(kit, {
    key: 'run',
    title: 'Run progress',
    accent,
    aside,
    rows: k => {
      const strip = Math.max(4, Math.min(12, k.columns - 10 - 16))
      const plan = m.plan
      return [
        m.objective === null
          ? null
          : (
              <Box key="run-objective" flexDirection="row">
                <Box width={10} flexShrink={0}>
                  <Text dimColor>Objective</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} {...clip(k)}>
                  <Text wrap="wrap">{m.objective}</Text>
                </Box>
              </Box>
            ),
        plan === null ? (
          note(k, 'No milestones yet. They appear here when Claude keeps a task list for the work.', 'run-no-plan')
        ) : (
          <Box key="run-plan" flexDirection="column">
            {field(k, {
              key: 'run-progress',
              label: 'Progress',
              content: workTrack(k, { key: 'run-strip', done: plan.done, total: plan.total, hasCurrent: plan.tasks.some(t => t.isCurrent), max: strip, caption: `${plan.done} of ${fmt.plural(plan.total, 'milestone')}`, isAnimated }),
            })}
            <Box key="run-milestones" flexDirection="column" marginLeft={10} marginTop={1} marginBottom={1}>
              {plan.earlier > 0 ? <Text key="run-earlier" dimColor>{`${plan.earlier} earlier done`}</Text> : null}
              {plan.tasks.map((t, i) => {
                const look = TASK_LOOK[t.status] ?? TASK_LOOK.pending!
                // A finished milestone whose files changed since it was verified: amber, with what changed and what to rerun.
                const ev = t.evidence
                const isStale = ev !== null && ev.status === 'stale'
                return listItem(k, {
                  key: `milestone-${i}`,
                  glyph: isStale ? G.warn : t.isCurrent && t.status === 'in_progress' ? G.arrow : look.glyph,
                  tone: isStale ? 'warn' : t.isCurrent && t.status === 'in_progress' ? 'info' : look.tone,
                  text: t.subject,
                  right: isStale ? 'verification stale' : (look.word ?? (ev?.status === 'changing' ? 'being changed' : undefined)),
                  rightTone: isStale ? 'warn' : t.status === 'blocked' ? 'bad' : t.status === 'waiting' ? 'info' : 'muted',
                  // What it waits for, how it is being verified, or what became of its evidence.
                  detail: t.status === 'blocked' || t.status === 'waiting' || t.status === 'verifying' ? t.detail : (ev?.line ?? null),
                  isDim: (t.status === 'completed' && !isStale) || (!t.isCurrent && t.status === 'pending'),
                  isBold: t.isCurrent,
                })
              })}
              {plan.staleEarlier.map((e, i) =>
                listItem(k, { key: `milestone-stale-${i}`, glyph: G.warn, tone: 'warn', text: e.subject, right: 'verification stale', rightTone: 'warn', detail: e.line }),
              )}
              {plan.later > 0 ? <Text key="run-later" dimColor>{`${plan.later} more to come`}</Text> : null}
            </Box>
          </Box>
        ),
        <Box key="run-fields" flexDirection="column">
          {field(k, {
            key: 'run-now',
            label: 'Now',
            content: (
              <Text wrap="truncate-end">
                <Text {...toneProps(STATE_MARK[m.nowState].tone)}>{`${STATE_MARK[m.nowState].glyph} `}</Text>
                <Text dimColor={m.nowState === 'idle' || m.nowState === 'ready' || m.nowState === 'thinking' ? true : undefined}>{m.now ?? 'Working'}</Text>
              </Text>
            ),
          })}
          {m.next === null ? null : field(k, { key: 'run-next', label: 'Next', content: <Text wrap="truncate-end">{m.next}</Text> })}
          {field(k, {
            key: 'run-checks',
            label: 'Checks',
            content:
              checks.length === 0 ? (
                <Text dimColor>None run yet</Text>
              ) : (
                <Text wrap="truncate-end">
                  {checks.map((c, i) => {
                    const s = CHECK_STATUS[c.status] ?? CHECK_STATUS.passed!
                    return (
                      <Text key={`run-check-${c.kind}`}>
                        {i > 0 ? '   ' : ''}
                        <Text {...toneProps(s.tone)}>{s.glyph}</Text>
                        {` ${c.label}`}
                      </Text>
                    )
                  })}
                </Text>
              ),
          })}
        </Box>,
      ]
    },
  })
}

// ---------------------------------------------------------------------------
// Quest log

function questCard(kit: Kit, quest: QuestView): RenderElement {
  const { Box, Text } = kit.ui
  const fraction = quest.levelSpan > 0 ? quest.intoLevel / quest.levelSpan : 0
  const toNext = quest.levelSpan - quest.intoLevel
  return card(kit, {
    key: 'quest',
    title: 'Quest',
    accent: ACCENT.activity,
    aside: quest.runXp > 0 ? `+${quest.runXp} XP this run` : undefined,
    footer: 'XP counts verified progress only: milestones done, checks turning green, finished plans and clean handoffs. Never lines written or tools used.',
    rows: k => [
      <Box key="quest-level" flexDirection="row" columnGap={2} alignItems="center">
        <Box flexShrink={0}>{levelBadge(k, { key: 'quest-badge', level: quest.level, fraction })}</Box>
        <Box flexGrow={1} flexShrink={1} {...clip(k)}>
          {meterBar(k, { key: 'quest-meter', fraction, tone: 'accent', width: Math.max(8, k.columns - 34), alt: `${quest.intoLevel} of ${quest.levelSpan} XP into level ${quest.level}` })}
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{`${toNext} XP to ${quest.level + 1}`}</Text>
        </Box>
      </Box>,
      ...quest.recent.map((r, i) => listItem(k, { key: `quest-award-${i}`, glyph: '+', tone: 'accent', text: r.text, right: `${r.xp} XP`, rightTone: 'muted' })),
      quest.recent.length === 0 ? emptyState(k, 'No XP yet. Finish a milestone or turn a check green.', 'quest-empty') : null,
      <Box key="quest-achievements" flexDirection="row" flexWrap="wrap" columnGap={2}>
        {quest.achievements.map(a => (
          <Text key={`quest-ach-${a.id}`} dimColor={a.unlockedAt === null ? true : undefined}>
            <Text color={a.unlockedAt === null ? undefined : 'claude'}>{`${a.unlockedAt === null ? G.starOpen : G.star} `}</Text>
            {a.name}
          </Text>
        ))}
      </Box>,
    ],
  })
}

// ---------------------------------------------------------------------------
// This turn

/** The legend under a turn's time strip: the kinds of work that appear in it. */
function timelineLegend(kit: Kit, timeline: TurnTimelineView): RenderElement {
  const kinds = (['read', 'edit', 'run', 'check', 'web', 'agent', 'other'] as const).filter(kind => timeline.spans.some(s => s.kind === kind))
  const items = kinds.map(kind => ({ label: TIMELINE[kind].label, color: TIMELINE[kind].key, svg: TIMELINE[kind].svg }))
  if (timeline.spans.some(s => s.isFailed)) items.push({ label: 'failed', color: 'error', svg: SVG_COLOR.bad })
  return legend(kit, 'turn-legend', items)
}

function turnCard(kit: Kit, view: ActivityView): RenderElement {
  const { Box, Text } = kit.ui
  const t = view.turnSummary
  const time = t.durationMs === null ? null : fmt.duration(t.durationMs)
  const aside = view.turn === 0 ? undefined : t.isRunning ? `Running${time === null ? '' : ` · ${time}`}` : `${time === null ? '' : `${time} · `}${fmt.plural(t.tools, 'tool call')}`
  const timeline = view.timeline
  return card(kit, {
    key: 'turn',
    title: 'This turn',
    accent: ACCENT.activity,
    aside,
    rows: k => [
      ...(timeline === null
        ? []
        : [
            // The chart and its legend, a blank line apart from the counted lines under them.
            <Box key="turn-chart" flexDirection="column" marginBottom={t.lines.length === 0 ? 0 : 1}>
              {timelineStrip(k, { key: 'turn-strip', spans: timeline.spans, from: timeline.from, to: timeline.to, width: k.columns })}
              {timelineLegend(k, timeline)}
            </Box>,
          ]),
      ...(t.lines.length === 0
        ? [emptyState(k, view.turn === 0 ? 'Nothing yet. Claude’s work shows here as it happens.' : 'No tool calls in this turn.', 'turn-empty')]
        : t.lines.map((line, i) => (
            <Text key={`turn-line-${i}`} wrap="wrap">
              {line}
            </Text>
          ))),
    ],
  })
}

// ---------------------------------------------------------------------------
// Attention

function attentionRow(kit: Kit, a: AttentionView): RenderElement {
  const tried = a.attempts > 1 ? `tried ${a.attempts}×` : null
  const detail = [a.reason, tried].filter((x): x is string => x !== null && x !== '').join(' · ')
  switch (a.kind) {
    case 'failed':
      return a.state === 'recovered'
        ? listItem(kit, { key: `att-${a.id}`, glyph: G.ok, tone: 'good', text: a.title, detail, right: 'recovered', rightTone: 'good', isDim: true })
        : listItem(kit, { key: `att-${a.id}`, glyph: G.fail, tone: 'bad', text: a.title, detail, right: 'unresolved', rightTone: 'bad' })
    case 'blocked':
      return listItem(kit, { key: `att-${a.id}`, glyph: G.stop, tone: 'warn', text: a.title, detail, right: 'blocked', rightTone: 'warn' })
    case 'held':
      return listItem(kit, { key: `att-${a.id}`, glyph: G.stop, tone: 'warn', text: a.title, detail, right: 'held back', rightTone: 'warn' })
    case 'running':
      return listItem(kit, { key: `att-${a.id}`, glyph: G.run, tone: 'info', text: a.title, right: `running ${elapsed(kit, a.since)}`, rightTone: 'info' })
    case 'slow':
      return listItem(kit, { key: `att-${a.id}`, glyph: G.warn, tone: 'warn', text: a.title, detail: 'Took longer than usual', right: a.durationMs === null ? 'slow' : fmt.duration(a.durationMs) })
    // A finished milestone whose files changed since it was verified: its verification is stale, never "wrong".
    case 'stale':
      return listItem(kit, { key: `att-${a.id}`, glyph: G.warn, tone: 'warn', text: a.title, detail: a.reason, right: 'verification stale', rightTone: 'warn' })
  }
}

function attentionCard(kit: Kit, view: ActivityView): RenderElement | null {
  if (view.attention.length === 0) return null
  const open = view.attention.filter(a => (a.kind === 'failed' && a.state === 'unresolved') || a.kind === 'blocked' || a.kind === 'held' || a.kind === 'stale').length
  const running = view.attention.filter(a => a.kind === 'running').length
  return card(kit, {
    key: 'attention',
    title: 'Attention',
    accent: ACCENT.activity,
    aside: open > 0 ? `${open} open` : running > 0 ? `${running} still running` : 'all clear',
    rows: k => [
      ...view.attention.map(a => attentionRow(k, a)),
      // Stale verification: rerun the checks (Claude is told), or accept the files as they are now.
      view.attention.some(a => a.kind === 'stale')
        ? buttons(k, [{ key: 'evidence-accept', label: 'Accept files as they are', onPress: () => k.actions.acceptEvidence(null) }], 'attention-evidence')
        : null,
    ],
  })
}

// ---------------------------------------------------------------------------
// Validation

const CHECK_STATUS: Record<string, { glyph: string; tone: Tone }> = {
  passed: { glyph: G.ok, tone: 'good' },
  failed: { glyph: G.fail, tone: 'bad' },
  running: { glyph: G.run, tone: 'info' },
  blocked: { glyph: G.stop, tone: 'warn' },
  background: { glyph: G.ring, tone: 'muted' },
  stopped: { glyph: G.stop, tone: 'muted' },
}

function checkRow(kit: Kit, v: ValidationView): RenderElement {
  const s = CHECK_STATUS[v.status] ?? CHECK_STATUS.passed!
  const time = v.durationMs === null ? '' : fmt.duration(v.durationMs)
  const right =
    v.status === 'passed'
      ? time
      : v.status === 'failed'
        ? `failed${time === '' ? '' : ` · ${time}`}`
        : v.status === 'running'
          ? `running${time === '' ? '' : ` · ${time}`}`
          : v.status === 'background'
            ? 'in the background'
            : v.status
  const history = v.runs > 1 ? (v.isRecovered ? `passed after ${fmt.plural(v.failures, 'failure')}` : `${v.runs} runs`) : null
  const { Box, Text } = kit.ui
  const rightTone: Tone = v.status === 'failed' ? 'bad' : v.status === 'running' ? 'info' : 'muted'
  return (
    <Box key={`check-${v.kind}`} flexDirection="row" columnGap={1}>
      <Box width={2} flexShrink={0}>
        <Text {...toneProps(s.tone)}>{s.glyph}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column" {...clip(kit)}>
        <Text bold wrap="truncate-end">
          {v.label}
        </Text>
        <Text dimColor wrap="truncate-end">
          {[v.command, history].filter((x): x is string => x !== null).join(' · ')}
        </Text>
      </Box>
      {/* Every run of this check, oldest first: how the fixes went. */}
      {v.history.length > 1 ? <Box flexShrink={0}>{dots(kit, { key: `check-${v.kind}-dots`, statuses: v.history })}</Box> : null}
      <Box flexShrink={0}>
        <Text {...toneProps(rightTone)} dimColor={rightTone === 'muted' ? true : undefined}>
          {right}
        </Text>
      </Box>
    </Box>
  )
}

function validationCard(kit: Kit, view: ActivityView): RenderElement | null {
  if (view.validation.length === 0) return null
  const failing = view.validation.filter(v => v.status === 'failed').length
  return card(kit, {
    key: 'validation',
    title: 'Validation',
    accent: ACCENT.activity,
    aside: failing > 0 ? `${failing} failing` : view.validation.some(v => v.status === 'running') ? 'running' : 'passing',
    rows: k => view.validation.map(v => checkRow(k, v)),
  })
}

// ---------------------------------------------------------------------------
// Changes

function changeNote(f: FileChangeView): { text: string; tone: Tone }[] {
  if (f.isDeleted) return [{ text: 'deleted', tone: 'muted' }]
  if (!f.hasDiff) return [{ text: f.isCreated ? 'new · diff unavailable' : 'diff unavailable', tone: 'muted' }]
  const counts: { text: string; tone: Tone }[] = [{ text: `+${f.added}`, tone: 'good' }]
  if (f.removed > 0 || !f.isCreated) counts.push({ text: `−${f.removed}`, tone: 'bad' })
  if (f.isCreated) counts.push({ text: 'new', tone: 'muted' })
  return counts
}

function fileRow(kit: Kit, f: FileChangeView, view: ActivityView, isDim: boolean): RenderElement {
  const { Box, Button, Code, Text } = kit.ui
  const isSelected = view.selectedPath === f.path
  const parts = changeNote(f)
  return (
    <Box key={`file-${f.path}`} flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Box flexGrow={1} flexShrink={1} {...clip(kit)}>
          <Button
            key={`pick-${f.path}`}
            label={`${isSelected ? G.down : G.arrow} ${f.display}`}
            plain
            dimColor={!isSelected}
            onPress={() => kit.actions.selectFile(isSelected ? null : f.path)}
          />
        </Box>
        {f.hasDiff && !f.isDeleted ? (
          <Box flexShrink={0} alignItems="center">
            {diffSquares(kit, { key: `file-${f.path}-squares`, added: f.added, removed: f.removed })}
          </Box>
        ) : null}
        <Box flexShrink={0}>
          <Text>
            {parts.map((p, i) => (
              <Text key={`file-${f.path}-${i}`} color={p.tone === 'good' ? 'success' : p.tone === 'bad' ? 'error' : undefined} dimColor={p.tone === 'muted' || isDim ? true : undefined}>
                {`${i > 0 ? ' ' : ''}${p.text}`}
              </Text>
            ))}
          </Text>
        </Box>
      </Box>
      {isSelected ? (
        <Box key={`diff-${f.path}`} flexDirection="column" marginLeft={2}>
          {view.selectedHunks === '' ? (
            emptyState(kit, f.hasDiff ? 'No line-level diff recorded for this change.' : 'No tool reported the lines of this change.', 'diff-empty')
          ) : (
            <Code source={view.selectedHunks} format="diff" path={f.path} wrap="truncate-end" />
          )}
        </Box>
      ) : null}
    </Box>
  )
}

function groupBlock(kit: Kit, g: ChangeGroupView, view: ActivityView): RenderElement {
  const { Box, Text } = kit.ui
  return (
    <Box key={`group-${g.id}`} flexDirection="column">
      <Text dimColor bold>{`${g.label.toUpperCase()}  ${g.files.length}`}</Text>
      {g.files.map(f => fileRow(kit, f, view, false))}
    </Box>
  )
}

function changesCard(kit: Kit, view: ActivityView): RenderElement {
  const { Box, Button } = kit.ui
  const real = view.groups.filter(g => g.id !== 'generated')
  const generated = view.groups.find(g => g.id === 'generated')
  let added = 0
  let removed = 0
  for (const g of real) for (const f of g.files) if (f.hasDiff) (added += f.added), (removed += f.removed)
  const count = real.reduce((n, g) => n + g.files.length, 0)
  return card(kit, {
    key: 'files',
    title: 'Changes',
    accent: ACCENT.activity,
    aside: count === 0 ? undefined : `${fmt.plural(count, 'file')}  +${added} −${removed}`,
    footer: 'From the edit tools’ own results. A file a command created shows without a diff when Claude Code reports none.',
    rows: k => [
      count === 0 && generated === undefined ? emptyState(k, 'Claude has not changed any files yet.', 'files-empty') : null,
      count === 0 && generated !== undefined ? emptyState(k, 'No project files changed yet.', 'files-none-real') : null,
      ...real.map(g => groupBlock(k, g, view)),
      generated === undefined ? null : (
        <Box key="group-generated" flexDirection="column">
          <Button
            key="toggle-generated"
            label={`${view.showGenerated ? G.down : G.arrow} ${generated.label} · ${generated.files.length}`}
            plain
            dimColor
            onPress={kit.actions.toggleGenerated}
          />
          {view.showGenerated ? generated.files.map(f => fileRow(k, f, view, true)) : null}
        </Box>
      ),
      count === 0 && generated === undefined ? null : buttons(k, [{ key: 'act-clear', label: 'Clear list', onPress: kit.actions.clearChanges }], 'files-actions'),
    ],
  })
}

// ---------------------------------------------------------------------------
// Every tool call (the secondary view)

function callItem(kit: Kit, item: ActivityItemView): RenderElement {
  const s = CALL_STATUS[item.status] ?? CALL_STATUS.ok!
  return listItem(kit, {
    key: `call-${item.id}`,
    glyph: s.glyph,
    tone: s.tone,
    text: `${item.isSubagent ? '↳ ' : ''}${item.tool}  ${item.label}`,
    detail: item.status === 'ok' || item.status === 'running' ? null : item.reason,
    right: item.endedAt === null ? 'running' : fmt.duration(item.endedAt - item.startedAt),
    isDim: item.status === 'ok' && item.heavy.length === 0,
  })
}

function rawCard(kit: Kit, view: ActivityView): RenderElement {
  const { Text } = kit.ui
  return card(kit, {
    key: 'calls',
    title: 'All tool calls',
    accent: ACCENT.activity,
    aside: view.sessionTools === 0 ? undefined : `${view.sessionTools} in this context`,
    footer: 'Newest first. Subagents’ calls are marked ↳.',
    rows: k =>
      view.items.length === 0
        ? [emptyState(k, 'No tool calls yet.', 'calls-empty')]
        : [
            ...view.items.slice(0, 60).map(item => callItem(k, item)),
            view.items.length > 60 ? (
              <Text key="calls-more" dimColor>
                {`${view.items.length - 60} more`}
              </Text>
            ) : null,
          ],
  })
}

// ---------------------------------------------------------------------------
// The page

/** Operations' label in the switch: a count of what waits for the person, when anything does. */
function opsLabel(ops: OpsView | undefined): string {
  if (ops === undefined) return 'Operations'
  const review = ops.decisions.filter(d => d.status === 'open').length + (ops.held === null ? 0 : 1) + ops.watchers.filter(w => w.needs !== null).length
  return review === 0 ? 'Operations' : `Operations (${review})`
}

export function activityPage(kit: Kit, pane: PaneModel, view: ActivityView | undefined, ops?: OpsView): RenderElement {
  const { Box } = kit.ui
  const sub = pane.activitySub
  const focus = pane.settings.focus
  const u = kit.actions.update
  const accent = ACCENT.activity

  // Agents is a view only while agents run or ran lately (or it is the one open).
  const agentCount = ops === undefined ? 0 : ops.agents.filter(a => ['running', 'starting', 'pending', 'waiting', 'idle'].includes(a.status)).length
  const hasAgents = (ops !== undefined && ops.agents.length > 0) || sub === 'agents'
  // The second level of navigation: Activity's views, never drawn like a setting's choice.
  const switcher = subNav(kit, {
    key: 'sub',
    section: 'Activity',
    accent,
    current: sub,
    options: [
      { value: 'summary', label: 'Summary' },
      { value: 'ops', label: opsLabel(ops) },
      ...(hasAgents ? [{ value: 'agents' as const, label: agentCount > 0 ? `Agents (${agentCount})` : 'Agents' }] : []),
      { value: 'raw', label: view === undefined || view.sessionTools === 0 ? 'Tool calls' : `Tool calls (${view.sessionTools})` },
    ],
    onSelect: v => kit.actions.setActivitySub(v),
  })

  if (sub === 'agents') {
    return (
      <Box flexDirection="column">
        {switcher}
        {agentsPage(kit, ops)}
      </Box>
    )
  }

  if (sub === 'ops') {
    return (
      <Box flexDirection="column">
        {switcher}
        {operationsPage(kit, pane, ops)}
      </Box>
    )
  }

  if (view === undefined) {
    return (
      <Box flexDirection="column">
        {switcher}
        {note(kit, 'Loading…', 'activity-loading')}
      </Box>
    )
  }

  if (sub === 'raw') {
    return (
      <Box flexDirection="column">
        {switcher}
        {rawCard(kit, view)}
      </Box>
    )
  }

  const transcript = card(kit, {
    key: 'transcript',
    title: 'Transcript',
    accent,
    footer: 'Focus view changes what you see, never what Claude reads. Press ▸ on a row to open it.',
    rows: k => [
      row(k, {
        key: 'act-answers',
        label: 'Answer style',
        subtitle: 'How Claude writes to you',
        control: link(k, { key: 'act-answers', label: pane.status.answers.text, onPress: () => kit.actions.setTab('behavior') }),
      }),
      row(k, {
        key: 'act-focus',
        label: 'Focus view',
        subtitle: 'One quiet line per tool call',
        control: switchControl(k, { key: 'act-focus', isOn: focus.enabled, onPress: kit.actions.toggleFocus }),
      }),
      focus.enabled &&
        row(k, {
          key: 'act-tools',
          label: 'Tool calls',
          control: segmented(k, {
            key: 'act-tools',
            value: focus.tools,
            options: [
              { value: 'compact', label: 'One line' },
              { value: 'hidden', label: 'Hidden' },
            ],
            onSelect: v => u(d => void (d.focus.tools = v === 'hidden' ? 'hidden' : 'compact')),
          }),
        }),
      focus.enabled && row(k, { key: 'act-results', label: 'Tool results', control: switchControl(k, { key: 'act-results', isOn: focus.results, onPress: () => u(d => void (d.focus.results = !d.focus.results)) }) }),
      focus.enabled && row(k, { key: 'act-diffs', label: 'Inline file diffs', control: switchControl(k, { key: 'act-diffs', isOn: focus.diffs, onPress: () => u(d => void (d.focus.diffs = !d.focus.diffs)) }) }),
      focus.enabled &&
        row(k, {
          key: 'act-spinner',
          label: 'Activity line',
          subtitle: 'A summary in the spinner while Claude works',
          control: switchControl(k, { key: 'act-spinner', isOn: focus.spinner, onPress: () => u(d => void (d.focus.spinner = !d.focus.spinner)) }),
        }),
    ],
  })

  return (
    <Box flexDirection="column">
      {switcher}
      {view.quest === null ? null : questCard(kit, view.quest)}
      {runCard(kit, view, !pane.settings.ui.reducedMotion)}
      {turnCard(kit, view)}
      {attentionCard(kit, view)}
      {validationCard(kit, view)}
      {changesCard(kit, view)}
      {transcript}
    </Box>
  )
}
