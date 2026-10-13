/**
 * Guardrails: what Claude may do, how many helpers it may run, and how hard
 * it may push the machine. The permissions come first, one card per group a
 * person thinks in (Project, Network, Git, External, Safety), then Subagents
 * and Machine load. Every value reads as a word ("Ask", "Deny"); its options
 * open in place with one line on what each means.
 */

import type { RenderElement } from 'claude-code'

import type { PaneModel, PermissionCategory, PermissionState, PermissionsView, ResourcesView } from '../../../types'
import * as fmt from '../../core/format'
import { DEFAULT_PERMISSIONS, PERMISSION_CATEGORIES, PERMISSION_LABEL } from '../../core/settings'
import { CATEGORY_INFO } from '../../features/permissions/categories'
import { clampState, statesFor } from '../../features/permissions/decide'
import type { Kit } from '../kit'
import { buttons, card, footnote, gauge, listItem, note, picker, row, spaced, stepper, switchControl } from '../primitives'
import { ACCENT, G, readingTone, toneOfLevel } from '../theme'

const STATE: Record<PermissionState, { label: string; hint: string; sentence: string }> = {
  default: { label: 'Default', hint: 'Claude Code decides', sentence: 'Claude Code decides' },
  ask: { label: 'Ask', hint: 'always asks you first', sentence: 'Asks you first' },
  deny: { label: 'Deny', hint: 'never runs', sentence: 'Never runs' },
}

/** What became of a call, as the log says it. */
const OUTCOME_WORD: Record<string, string> = { denied: 'denied', approved: 'you approved', declined: 'you declined', 'refused-heavy': 'held back' }

const LEVELS = [
  { value: 'off', label: 'Off', hint: 'readings only' },
  { value: 'low', label: 'Low', hint: 'CPU 50% · RAM 75%' },
  { value: 'medium', label: 'Medium', hint: 'CPU 70% · RAM 85%' },
  { value: 'high', label: 'High', hint: 'CPU 90% · RAM 92%' },
  { value: 'custom', label: 'Custom', hint: 'your own ceilings' },
]

/**
 * The permission categories in the groups a person thinks in: what happens
 * to the project's files, what reaches the network, what Git records and
 * sends, what leaves for other systems, and the commands that are never safe.
 */
const GROUPS: readonly { id: string; title: string; categories: readonly PermissionCategory[] }[] = [
  { id: 'project', title: 'Project', categories: ['edit', 'editOutside', 'delete'] },
  { id: 'network', title: 'Network', categories: ['network', 'download', 'install'] },
  { id: 'git', title: 'Git', categories: ['commit', 'push', 'gitDestructive'] },
  { id: 'external', title: 'External', categories: ['deploy'] },
  { id: 'safety', title: 'Safety', categories: ['dangerous'] },
]

const AGENT_HINT: Record<string, string> = {
  unrestricted: 'Claude may run helpers in parallel',
  limit: 'Past the limit, Claude waits or does it itself',
  ask: 'You approve each one',
  block: 'Claude works alone; agent types are hidden from it',
}

export function guardrailsPage(kit: Kit, pane: PaneModel, permissions: PermissionsView | undefined, resources: ResourcesView | undefined): RenderElement {
  const { Box } = kit.ui
  const s = pane.settings
  const u = kit.actions.update
  const p = s.permissions
  const accent = ACCENT.guardrails
  const isDefault = PERMISSION_CATEGORIES.every(c => p[c] === DEFAULT_PERMISSIONS[c])
  const r = s.resources
  const ceilings = resources?.ceilings ?? null
  const recent = permissions?.recent ?? []
  const live = resources !== undefined && resources.status === 'live' ? resources : null
  const activity = permissions === undefined || permissions.asked + permissions.denied === 0 ? undefined : `${permissions.asked} asked · ${permissions.denied} denied`

  return (
    <Box flexDirection="column">
      {/* The permissions: one card per group, each titled in the section's accent, then what they share. */}
      {GROUPS.map((g, gi) =>
        card(kit, {
          key: `perm-${g.id}`,
          title: g.title,
          accent,
          aside: gi === 0 ? activity : undefined,
          rows: k =>
            g.categories.map(c =>
              row(k, {
                key: `perm-${c}`,
                label: PERMISSION_LABEL[c],
                // What the value means, and whether it is Sentinel's default (visible without knowing profiles).
                subtitle:
                  kit.openPicker === `perm-${c}`
                    ? `e.g. ${CATEGORY_INFO[c].examples}`
                    : p[c] === DEFAULT_PERMISSIONS[c]
                      ? `${STATE[p[c]].sentence} · default`
                      : `${STATE[p[c]].sentence} · changed (default: ${STATE[DEFAULT_PERMISSIONS[c]].sentence.toLowerCase()})`,
                subtitleTone: kit.openPicker !== `perm-${c}` && p[c] !== DEFAULT_PERMISSIONS[c] ? 'warn' : undefined,
                control: picker(k, {
                  key: `perm-${c}`,
                  value: p[c],
                  options: statesFor(c).map(state => ({ value: state, label: STATE[state].label, hint: STATE[state].hint })),
                  onSelect: v => u(d => void (d.permissions[c] = clampState(c, v))),
                }),
              }),
            ),
        }),
      )}
      {footnote(kit, {
        key: 'permissions',
        actions: isDefault ? undefined : [{ key: 'perm-reset', label: 'Restore safe defaults', onPress: () => u(d => void (d.permissions = { ...DEFAULT_PERMISSIONS })) }],
        text: 'Ask always asks you first and Deny always stops an action, in every mode; Claude Code’s own rules still apply after a yes. Shell commands are matched by pattern: this narrows what Claude does, it is not a sandbox.',
      })}
      {pane.allowRemoved.length === 0
        ? null
        : footnote(kit, {
            key: 'allow-removed',
            text: `Allow was removed in 1.4.0: ${pane.allowRemoved.join(', ')} now use${pane.allowRemoved.length === 1 ? 's' : ''} Default, so Claude Code’s own rules decide. To skip those prompts, add allow rules in Claude Code’s permissions.`,
          })}

      {recent.length === 0
        ? null
        : card(kit, {
            key: 'perm-recent',
            title: 'Recent decisions',
            accent,
            rows: k =>
              recent.slice(0, 6).map((e, i) =>
                listItem(k, {
                  key: `perm-log-${i}`,
                  glyph: e.outcome === 'approved' ? G.ok : G.fail,
                  tone: e.outcome === 'approved' ? 'good' : e.outcome === 'declined' ? 'warn' : 'bad',
                  text: spaced(kit, [OUTCOME_WORD[e.outcome] ?? e.outcome, e.evidence]),
                  right: fmt.clock(e.at),
                }),
              ),
          })}

      {card(kit, {
        key: 'agents',
        title: 'Subagents',
        accent,
        aside: pane.agents.running.length > 0 ? `${pane.agents.running.length} running` : undefined,
        // What may be started lives here; what runs, with its controls, in Activity → Operations.
        link: { label: 'See what is running', onPress: () => kit.actions.openAgents() },
        rows: k => [
          row(k, {
            key: 'sa-mode',
            label: 'Allowed',
            subtitle: AGENT_HINT[s.subagents.mode],
            control: picker(k, {
              key: 'sa-mode',
              value: s.subagents.mode,
              options: [
                { value: 'unrestricted', label: 'No limit', hint: 'helpers run in parallel' },
                { value: 'limit', label: 'Up to a number', hint: 'at most a few at once' },
                { value: 'ask', label: 'Ask each time', hint: 'you approve each one' },
                { value: 'block', label: 'None', hint: 'Claude works alone' },
              ],
              onSelect: v => u(d => void (d.subagents.mode = (['unrestricted', 'limit', 'ask', 'block'].includes(v) ? v : 'unrestricted') as typeof d.subagents.mode)),
            }),
          }),
          s.subagents.mode === 'limit' &&
            row(k, {
              key: 'sa-limit',
              label: 'At most',
              control: stepper(k, {
                key: 'sa-limit',
                display: String(s.subagents.limit),
                onDecrease: s.subagents.limit > 1 ? () => u(d => void (d.subagents.limit -= 1)) : undefined,
                onIncrease: s.subagents.limit < 16 ? () => u(d => void (d.subagents.limit += 1)) : undefined,
              }),
            }),
          s.subagents.mode === 'limit' &&
            row(k, {
              key: 'sa-team',
              label: 'Count teammates',
              subtitle: 'Agent-team teammates count toward the limit',
              control: switchControl(k, { key: 'sa-team', isOn: s.subagents.countTeammates, onPress: () => u(d => void (d.subagents.countTeammates = !d.subagents.countTeammates)) }),
            }),
          ...pane.agents.running.map(a => listItem(k, { key: `agent-${a.id}`, glyph: G.dot, tone: 'info', text: `${a.type}  ${a.description}`, right: a.status })),
        ],
      })}

      {card(kit, {
        key: 'load',
        title: 'Machine load',
        accent,
        aside: live === null ? undefined : `every ${r.intervalSec} s`,
        footer:
          r.level === 'off'
            ? 'Readings only. Set a limit to have Claude ease off when your machine is busy.'
            : 'Advisory and machine-wide: Claude is told about pressure and slows down. Not an OS limit, and other programs are never touched.',
        rows: k => [
          live !== null && gauge(k, { key: 'cpu', label: 'CPU', value: live.cpu, ceiling: ceilings?.cpu ?? null, series: live.cpuSeries, tone: readingTone(live.cpu, ceilings?.cpu ?? null, { warn: 75, bad: 90 }) }),
          live !== null && gauge(k, { key: 'ram', label: 'Memory', value: live.ram, ceiling: ceilings?.ram ?? null, series: live.ramSeries, tone: readingTone(live.ram, ceilings?.ram ?? null, { warn: 80, bad: 92 }) }),
          live === null &&
            note(
              k,
              resources?.status === 'unavailable'
                ? `Readings unavailable${resources.error === null ? '' : `: ${resources.error}`}`
                : resources?.status === 'starting'
                  ? 'Starting the sampler…'
                  : 'Turn on live readings in Setup, or set a limit, to see CPU and memory.',
              'res-status',
            ),
          row(k, {
            key: 'res-level',
            label: 'Limit',
            subtitle: r.level === 'off' ? 'No ceilings' : r.level === 'custom' ? 'Your own ceilings' : `Ceilings at CPU ${ceilings?.cpu ?? r.cpu}% · RAM ${ceilings?.ram ?? r.ram}%`,
            control: picker(k, { key: 'res-level', value: r.level, options: LEVELS, onSelect: v => u(d => void (d.resources.level = (['off', 'low', 'medium', 'high', 'custom'].includes(v) ? v : 'off') as typeof d.resources.level)) }),
          }),
          r.level === 'custom' &&
            row(k, {
              key: 'res-cpu',
              label: 'CPU ceiling',
              control: stepper(k, {
                key: 'res-cpu',
                display: `${r.cpu}%`,
                onDecrease: r.cpu > 10 ? () => u(d => void (d.resources.cpu = Math.max(10, d.resources.cpu - 5))) : undefined,
                onIncrease: r.cpu < 100 ? () => u(d => void (d.resources.cpu = Math.min(100, d.resources.cpu + 5))) : undefined,
              }),
            }),
          r.level === 'custom' &&
            row(k, {
              key: 'res-ram',
              label: 'Memory ceiling',
              control: stepper(k, {
                key: 'res-ram',
                display: `${r.ram}%`,
                onDecrease: r.ram > 10 ? () => u(d => void (d.resources.ram = Math.max(10, d.resources.ram - 5))) : undefined,
                onIncrease: r.ram < 100 ? () => u(d => void (d.resources.ram = Math.min(100, d.resources.ram + 5))) : undefined,
              }),
            }),
          r.level !== 'off' &&
            row(k, {
              key: 'res-enf',
              label: 'When over',
              control: picker(k, {
                key: 'res-enf',
                value: r.enforcement,
                options: [
                  { value: 'inform', label: 'Just tell Claude' },
                  { value: 'limit', label: 'Hold extra heavy jobs' },
                  { value: 'strict', label: 'Hold all heavy jobs' },
                ],
                onSelect: v => u(d => void (d.resources.enforcement = (['inform', 'limit', 'strict'].includes(v) ? v : 'limit') as typeof d.resources.enforcement)),
              }),
            }),
          r.level !== 'off' && resources !== undefined && (resources.noticesSent > 0 || resources.refused > 0) && note(k, `${fmt.plural(resources.noticesSent, 'notice')} to Claude · ${fmt.plural(resources.refused, 'heavy job')} held back`, 'res-stats'),
          ...(resources === undefined
            ? []
            : resources.background.map(b => {
                const stop = buttons(k, [{ key: `stop-${b.id}`, label: 'Stop', onPress: () => kit.actions.stopTask(b.id) }], `stop-wrap-${b.id}`, true)
                return row(k, {
                  key: `bg-${b.id}`,
                  label: b.label,
                  subtitle: `Background job · ${fmt.duration(kit.now - b.since)}`,
                  subtitleTone: toneOfLevel(resources.level) === 'bad' ? 'bad' : 'muted',
                  ...(stop === null ? {} : { control: { element: stop, width: 8 } }),
                })
              })),
        ],
      })}
    </Box>
  )
}
