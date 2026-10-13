/**
 * Activity → Agents: the session's agents, as far as Claude Code lets them be observed.
 *
 *   Running now   the main conversation first, then each agent alive: its parent (children under
 *                 their parent; a workflow's agents under their run), name and type, status, how long,
 *                 what it is doing (its latest call) and when it last did anything, its calls and model,
 *                 its own plan as a track when it keeps one, Stop and Message where Claude Code takes them
 *   Earlier       agents that ended in the last few minutes: their result, or why they stopped
 *
 * Nothing made up: no percent from time or calls, no cost per agent (Claude Code reports none).
 */

import type { RenderElement } from 'claude-code'

import type { AgentRowView, OpsView, Tone } from '../../../types'
import * as fmt from '../../core/format'
import type { Kit } from '../kit'
import { buttons, card, isNative, link, listItem, note, row, spaced, workTrack } from '../primitives'
import { ACCENT, G } from '../theme'

const accent = ACCENT.activity

/** Each status as the panel shows it: its mark, its tone, its word. */
export const AGENT_LOOK: Record<string, { glyph: string; tone: Tone; word: string }> = {
  running: { glyph: G.run, tone: 'info', word: 'Running' },
  starting: { glyph: G.ring, tone: 'info', word: 'Starting' },
  pending: { glyph: G.ring, tone: 'muted', word: 'Starting' },
  waiting: { glyph: G.wait, tone: 'info', word: 'Waiting' },
  idle: { glyph: G.ring, tone: 'muted', word: 'Idle' },
  completed: { glyph: G.ok, tone: 'good', word: 'Completed' },
  failed: { glyph: G.fail, tone: 'bad', word: 'Failed' },
  killed: { glyph: G.stop, tone: 'warn', word: 'Stopped' },
  gone: { glyph: G.ring, tone: 'muted', word: 'No longer listed' },
}

const look = (status: string) => AGENT_LOOK[status] ?? { glyph: G.ring, tone: 'muted' as Tone, word: status }

const isAliveRow = (a: AgentRowView): boolean => a.status === 'running' || a.status === 'starting' || a.status === 'pending' || a.status === 'waiting' || a.status === 'idle'

/** A model id as a person reads it: `claude-sonnet-5-5` → `sonnet-5-5`. */
const shortModel = (model: string | null): string | null => (model === null ? null : model.replace(/^claude-/, ''))

const isOpen = (ops: OpsView, id: string): boolean => ops.ui.expanded.includes(id)

/** "12s ago", "3m ago": when an agent last made a call or a request. */
const agoText = (at: number | null, now: number): string | null => (at === null ? null : now - at < 5_000 ? 'just now' : `${fmt.countdown(Math.max(0, now - at)).replace('<1m', `${Math.round((now - at) / 1000)}s`)} ago`)

/** One agent: its line, what it is doing, its own plan, its details, Stop and Message. */
function agentBlock(k: Kit, ops: OpsView, a: AgentRowView, depth: number): RenderElement {
  const { Box, Input, Text } = k.ui
  const l = look(a.status)
  const alive = isAliveRow(a)
  const elapsed = a.startedAt === null ? null : fmt.duration((a.endedAt ?? k.now) - a.startedAt)
  const name = a.name ?? (a.description || a.type)
  const isMessaging = ops.ui.messaging === a.id
  const gap = isNative(k) ? 1 : 0
  // What it is doing now, when it last did anything, and how much: observed, never estimated.
  const now = alive ? spaced(k, [a.activity ?? (a.calls === 0 ? 'No calls yet' : null), agoText(a.activeAt, k.now) === null ? null : `last call ${agoText(a.activeAt, k.now)}`, fmt.plural(a.calls, 'call')]) : (a.result ?? null)
  return (
    <Box key={`agent-${a.id}`} flexDirection="column" rowGap={gap} marginLeft={Math.min(3, depth) * 2}>
      {listItem(k, {
        key: `agent-${a.id}-line`,
        glyph: l.glyph,
        tone: l.tone,
        text: spaced(k, [name, a.name !== null && a.description !== '' ? a.description : a.type !== name ? a.type : null]),
        right: spaced(k, [l.word, elapsed]),
        rightTone: a.isFailed ? 'bad' : l.tone === 'info' ? 'info' : 'muted',
        detail: now,
        isDim: !alive,
      })}
      {a.plan === null ? null : (
        <Box key={`agent-${a.id}-plan`} marginLeft={3} flexDirection="column">
          {workTrack(k, { key: `agent-${a.id}-track`, done: a.plan.done, total: a.plan.total, hasCurrent: a.plan.current !== null, max: 12, caption: `${a.plan.done} of ${a.plan.total}${a.plan.current === null ? '' : ` · ${a.plan.current}`}` })}
        </Box>
      )}
      {a.note === null ? null : (
        <Box key={`agent-${a.id}-note`} marginLeft={3}>
          <Text dimColor wrap="truncate-end">
            {a.note}
          </Text>
        </Box>
      )}
      {isOpen(ops, a.id) ? (
        <Box key={`agent-${a.id}-details`} marginLeft={3} flexDirection="column">
          <Text dimColor wrap="wrap">{spaced(k, [a.type, a.model === null ? 'model not known' : a.model, a.isBackground === null ? null : a.isBackground ? 'background' : 'foreground', a.isFork ? 'fork' : null, a.isTeammate ? 'teammate' : null])}</Text>
          <Text dimColor wrap="wrap">
            {spaced(k, [
              a.workflow !== null ? `workflow ${a.workflow.runId}, agent ${a.workflow.index}` : a.parentId === null ? 'started by the main conversation' : `started by ${a.parentId}`,
              a.startedAt === null ? 'started before a reload' : `started ${fmt.clock(a.startedAt)}`,
              a.isListed ? 'listed by Claude Code' : a.workflow !== null ? "a workflow's agents are not in Claude Code's list" : null,
            ])}
          </Text>
          {a.result === null ? null : <Text wrap="wrap">{a.result}</Text>}
          <Text dimColor wrap="truncate-end">{a.id}</Text>
        </Box>
      ) : null}
      {isMessaging && Input !== undefined ? (
        <Box key={`agent-${a.id}-msg`} marginLeft={3} flexDirection="column" rowGap={gap}>
          <Input key={`agent-${a.id}-text`} value="" placeholder="Stop after this file" submitLabel={isNative(k) ? 'Send' : 'send'} onSubmit={text => k.actions.agentMessage(a.id, text)} />
          {buttons(k, [{ key: `agent-${a.id}-msg-cancel`, label: 'Cancel', onPress: () => k.actions.editMessage(null) }], `agent-${a.id}-msg-acts`, true)}
        </Box>
      ) : (
        <Box key={`agent-${a.id}-acts`} marginLeft={3} flexDirection="row" columnGap={2} flexWrap="wrap">
          {buttons(
            k,
            [
              { key: `agent-${a.id}-stop`, label: 'Stop', onPress: () => k.actions.agentStop(a.id), isHidden: !a.canStop },
              { key: `agent-${a.id}-message`, label: 'Message', onPress: () => k.actions.editMessage(a.id), isHidden: !a.canMessage || Input === undefined },
            ],
            `agent-${a.id}-buttons`,
            true,
          )}
          {link(k, { key: `ops-more-${a.id}`, label: isOpen(ops, a.id) ? 'Less' : 'Details', onPress: () => k.actions.toggleOpsRow(a.id) }).element}
        </Box>
      )}
    </Box>
  )
}

type Entry = { kind: 'agent'; row: AgentRowView; depth: number } | { kind: 'workflow'; runId: string; rows: AgentRowView[]; depth: number }

/**
 * The rows in their hierarchy: each agent after its parent (deeper agents indented), a workflow's agents
 * together under their run, in their order. A parent not shown here leaves its child at the top level.
 */
export function hierarchyOf(rows: readonly AgentRowView[]): Entry[] {
  const ids = new Set(rows.map(r => r.id))
  const children = new Map<string, AgentRowView[]>()
  const top: (AgentRowView | { runId: string; rows: AgentRowView[] })[] = []
  const runs = new Map<string, AgentRowView[]>()
  for (const r of rows) {
    if (r.workflow !== null && (r.parentId === null || !ids.has(r.parentId))) {
      const list = runs.get(r.workflow.runId)
      if (list === undefined) {
        const fresh = [r]
        runs.set(r.workflow.runId, fresh)
        top.push({ runId: r.workflow.runId, rows: fresh })
      } else list.push(r)
      continue
    }
    if (r.parentId !== null && ids.has(r.parentId)) {
      const list = children.get(r.parentId) ?? []
      list.push(r)
      children.set(r.parentId, list)
      continue
    }
    top.push(r)
  }
  const out: Entry[] = []
  const walk = (r: AgentRowView, depth: number, seen: Set<string>) => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    out.push({ kind: 'agent', row: r, depth })
    for (const c of children.get(r.id) ?? []) walk(c, depth + 1, seen)
  }
  const seen = new Set<string>()
  for (const t of top) {
    if ('runId' in t) {
      out.push({ kind: 'workflow', runId: t.runId, rows: [...t.rows].sort((a, b) => (a.workflow?.index ?? 0) - (b.workflow?.index ?? 0)), depth: 0 })
      continue
    }
    walk(t, 0, seen)
  }
  return out
}

function entries(k: Kit, ops: OpsView, list: readonly Entry[]): RenderElement[] {
  const out: RenderElement[] = []
  for (const e of list) {
    if (e.kind === 'agent') {
      out.push(agentBlock(k, ops, e.row, e.depth))
      continue
    }
    const done = e.rows.filter(r => !isAliveRow(r)).length
    out.push(
      listItem(k, {
        key: `workflow-${e.runId}`,
        glyph: G.chevron,
        tone: done === e.rows.length ? 'muted' : 'info',
        text: `Workflow ${e.runId}`,
        right: `${done} of ${fmt.plural(e.rows.length, 'agent')} ended`,
        detail: "Its agents, from their spawns and their own calls (Claude Code does not list a workflow's agents)",
      }),
    )
    for (const r of e.rows) out.push(agentBlock(k, ops, r, 1))
  }
  return out
}

/** Activity → Agents. */
export function agentsPage(kit: Kit, ops: OpsView | undefined): RenderElement {
  const { Box } = kit.ui
  if (ops === undefined) return note(kit, 'Loading…', 'agents-loading')
  const alive = ops.agents.filter(isAliveRow)
  const ended = ops.agents.filter(a => !isAliveRow(a))
  return (
    <Box key="agents-page" flexDirection="column">
      {card(kit, {
        key: 'ops-agents',
        title: 'Running now',
        accent,
        aside: alive.length === 0 ? 'No subagents' : fmt.plural(alive.length, 'agent'),
        link: { label: 'What Claude may start', onPress: () => kit.actions.setTab('guardrails') },
        rows: k => [
          listItem(k, { key: 'agent-main', glyph: G.dot, tone: ops.isTurnRunning ? 'info' : 'muted', text: 'Claude', right: 'Main conversation', detail: ops.main.text }),
          ...entries(k, ops, hierarchyOf(alive)),
          alive.length === 0 ? note(k, ended.length === 0 ? 'No subagents in this context.' : 'No subagent is running now.', 'agents-none') : null,
        ],
      })}
      {ended.length === 0
        ? null
        : card(kit, {
            key: 'agents-ended',
            title: 'Earlier',
            accent,
            aside: 'last 10 minutes',
            rows: k => entries(k, ops, hierarchyOf(ended)),
          })}
      {note(kit, 'As Claude Code reports them: status from its agent list, activity from each agent’s own calls. Stop and Message are its TaskStop and SendMessage, offered where it takes them. No progress is estimated and no cost per agent is reported.', 'agents-footer')}
    </Box>
  )
}

/** Operations' one line about agents, leading to their own view; nothing while there are none. */
export function agentsLink(kit: Kit, ops: OpsView): RenderElement | null {
  if (ops.agents.length === 0) return null
  const alive = ops.agents.filter(isAliveRow).length
  return card(kit, {
    key: 'ops-agents-link',
    rows: k => [
      row(k, {
        key: 'ops-agents-link',
        label: alive > 0 ? `${fmt.plural(alive, 'agent')} running` : 'Agents that ended lately',
        subtitle: 'Each one’s status, activity, plan and controls',
        control: link(k, { key: 'ops-agents-open', label: 'Activity › Agents', onPress: () => kit.actions.openAgents() }),
      }),
    ],
  })
}
