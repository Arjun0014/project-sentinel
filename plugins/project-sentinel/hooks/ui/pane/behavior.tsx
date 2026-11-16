/**
 * Behavior: how Claude works, and how it writes to you. One card per system,
 * so each reads on its own: the card title names the system and carries its
 * live state, the first row says what it does and holds its switch, and its
 * finer settings follow only while it is on. A row never repeats its card's
 * title.
 */

import type { RenderElement } from 'claude-code'

import type { AgentModelChoice, PaneModel } from '../../../types'
import { ANSWER_STYLE_INFO } from '../../core/answers'
import { AGENT_CATEGORIES, ANSWER_STYLES } from '../../core/settings'
import { CATEGORY_LABEL as AGENT_CATEGORY_LABEL, SUGGESTED as SUGGESTED_AGENT_MODELS } from '../../features/agentModels'
import type { Kit } from '../kit'
import { card, link, picker, row, segmented, stepper, switchControl } from '../primitives'
import { ACCENT } from '../theme'

/** A subagent's model under the Agent Model Policy: only what Claude Code takes at a spawn. */
const AGENT_MODEL_OPTIONS: readonly { value: AgentModelChoice; label: string; hint: string }[] = [
  { value: 'agent', label: 'Agent’s own', hint: 'its definition’s model, or Claude’s choice' },
  { value: 'session', label: 'Session model', hint: 'the main conversation’s model' },
  { value: 'haiku', label: 'Haiku', hint: 'fastest, lowest cost' },
  { value: 'sonnet', label: 'Sonnet', hint: 'balanced' },
  { value: 'opus', label: 'Opus', hint: 'deep work' },
  { value: 'fable', label: 'Fable', hint: 'the most capable' },
]

const asChoice = (v: string): AgentModelChoice => AGENT_MODEL_OPTIONS.find(m => m.value === v)?.value ?? 'agent'

/**
 * The session's advisor: Claude Code's server-side advisor tool, a stronger model Claude consults at key moments.
 * One per session (subagents inherit it where Claude Code pairs it with their model); set with Claude Code's own
 * /advisor, and shown as the setting reads back, with its calls in this context.
 */
function advisorRow(k: Kit, a: PaneModel['models']['advisor']) {
  const used = a.uses + a.agentUses
  const subtitle =
    a.available === null
      ? 'Claude Code offers no advisor in this session'
      : a.configured === null
        ? 'A stronger model Claude can consult at key moments. Session-wide: subagents inherit it'
        : [a.pairing !== null && !a.pairing.isPaired ? `Not used: it ${a.pairing.text}` : used === 0 ? 'Not consulted yet in this context' : `Consulted ${used}× in this context${a.agentUses > 0 ? ` (${a.agentUses} by subagents)` : ''}`, a.lastSet !== null && a.lastSet.outcome !== 'applied' ? `last change not applied: run /advisor ${a.lastSet.to}` : null].filter(Boolean).join(' · ')
  if (a.available === null) return row(k, { key: 'mo-advisor', label: 'Advisor', subtitle, value: a.configured ?? 'Not available', valueTone: 'muted' })
  const hint = a.isConfirmed ? 'consulted at key moments' : 'if this account has it: Claude Code says if not'
  const options = [{ value: 'off', label: 'Off', hint: 'no advisor' }, ...a.available.map(m => ({ value: m, label: m.charAt(0).toUpperCase() + m.slice(1), hint }))]
  return row(k, {
    key: 'mo-advisor',
    label: 'Advisor',
    subtitle,
    control: picker(k, { key: 'mo-advisor', value: a.configured ?? 'off', options, onSelect: v => k.actions.setAdvisor(v) }),
  })
}

/**
 * A model as Claude Code names it in its own footer: `claude-opus-5-5[1m]` → `Opus 5.5`,
 * `claude-haiku-4-5-20251001` → `Haiku 4.5`, the alias `sonnet` → `Sonnet`. Any other id keeps its
 * own spelling without the `claude-` prefix and a date suffix.
 */
export function modelName(id: string): string {
  const bare = id.replace(/\[1m\]$/i, '')
  const m = /^(?:claude-)?(haiku|sonnet|opus|fable)(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?=$|-\d{8}$)/i.exec(bare)
  if (m === null) return bare.replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return m[2] === undefined ? family : `${family} ${m[2]}${m[3] === undefined ? '' : `.${m[3]}`}`
}


const EFFORT_WORD: Record<string, string> = { max: 'Maximum', xhigh: 'Extra high', high: 'High', medium: 'Medium', low: 'Low' }

/**
 * Whether Frontier Max reached Claude in this context, from the requests themselves (app/ledger.ts):
 * how it travelled and the effort the latest request was sent with. One quiet line; amber only when
 * a request went out without it, or when it is off but a held section still says it is on.
 */
export function frontierDeliveryText(d: PaneModel['frontier']['delivery']): { text: string; tone: 'normal' | 'muted' | 'warn' } {
  const effort = d.effort === null ? '' : ` · sent with ${EFFORT_WORD[d.effort] ?? d.effort} effort`
  const how: Record<string, string> = {
    system: 'in the system prompt',
    'held+note': 'as a note (the cached system prompt keeps its earlier section)',
    held: 'in the held system prompt',
    context: 'with the prompt (this setup skips the system prompt’s hook)',
    none: 'nowhere',
  }
  switch (d.state) {
    case 'delivered':
      return { text: `Delivered ${how[d.method ?? 'system']}${d.isFirstRequest === true ? ' from the first request' : ''}${effort}`, tone: 'normal' }
    case 'waiting':
      return { text: 'Reaches Claude with its next request', tone: 'muted' }
    case 'missing':
      return { text: `Not delivered: the last request went out without it${effort}`, tone: 'warn' }
    case 'stale':
      return { text: 'Off, but the cached system prompt still has it until the note saying so goes with Claude’s next tool results or prompt', tone: 'warn' }
    case 'off':
      return { text: 'Off', tone: 'muted' }
  }
}

function frontierDeliveryRow(k: Kit, d: PaneModel['frontier']['delivery']): RenderElement {
  const t = frontierDeliveryText(d)
  return row(k, { key: 'fr-delivery', label: 'Reached Claude in this context', subtitle: t.text, subtitleTone: t.tone })
}

const STRICTNESS_HINT: Record<string, string> = {
  lenient: 'Only obvious hand-backs',
  standard: 'Clear signs the job is unfinished',
  strict: 'Any unverified or unfinished work',
}

export function behaviorPage(kit: Kit, pane: PaneModel): RenderElement {
  const { Box } = kit.ui
  const s = pane.settings
  const st = pane.status
  const u = kit.actions.update
  const accent = ACCENT.behavior

  const style = s.answers.style
  const info = ANSWER_STYLE_INFO[style]
  const native = pane.nativeOutputStyle

  return (
    <Box flexDirection="column">
      {card(kit, {
        key: 'answers',
        title: 'Answer style',
        accent,
        aside: native === null ? undefined : 'Paused',
        footer:
          native !== null
            ? `Claude Code’s own output style, ${native}, is in use and takes precedence. Set it back to Default in Claude Code (/config) to use these.`
            : (info.note ?? undefined),
        rows: k => [
          row(k, {
            key: 'an-style',
            label: 'How Claude writes to you',
            subtitle: info.hint,
            control: picker(k, {
              key: 'an-style',
              value: style,
              options: ANSWER_STYLES.map(v => ({ value: v, label: ANSWER_STYLE_INFO[v].label, hint: ANSWER_STYLE_INFO[v].hint })),
              onSelect: v => u(d => void (d.answers.style = ANSWER_STYLES.find(x => x === v) ?? 'standard')),
            }),
          }),
          native === null && info.sample !== null && row(k, { key: 'an-sample', label: 'For example', subtitle: `“${info.sample}”` }),
          native === null &&
            style === 'quest' &&
            row(k, { key: 'an-quest', label: 'Your progress', control: link(k, { key: 'an-quest', label: 'Activity', onPress: () => kit.actions.setTab('activity') }) }),
        ],
      })}

      {card(kit, {
        key: 'frontier',
        title: 'Frontier Max',
        accent,
        aside: s.frontier.enabled ? st.frontier.text : undefined,
        // What it is, plainly: a policy in Claude's instructions and an effort request. Never the model.
        footer: s.frontier.enabled
          ? 'Frontier Max gives Claude Sentinel’s strongest engineering policy (investigate before acting, finish the job, verify before calling it done); requests the effort above on each request where the model takes an effort setting; and never switches the main model. “This context” is read from the requests themselves, not from what Claude says.'
          : 'Gives Claude a finish-and-verify engineering policy and requests more reasoning effort where the model supports it. It never switches the main model.',
        rows: k => [
          row(k, {
            key: 'fr-on',
            label: 'Hold Claude to senior-engineer standards',
            control: switchControl(k, { key: 'fr-on', isOn: s.frontier.enabled, onPress: () => u(d => void (d.frontier.enabled = !d.frontier.enabled)) }),
          }),
          s.frontier.enabled &&
            row(k, {
              key: 'fr-effort',
              label: 'Effort',
              subtitle: s.frontier.effort === 'keep' ? 'Policy only: the effort is left as it is' : pane.frontier.isEffortSupported === false ? 'This model takes no effort setting: the policy alone applies' : 'Requested on each request where the model supports it',
              control: picker(k, {
                key: 'fr-effort',
                value: s.frontier.effort,
                options: [
                  { value: 'max', label: 'Maximum', hint: "the model's highest" },
                  { value: 'xhigh', label: 'Extra high', hint: 'one step below' },
                  { value: 'high', label: 'High', hint: 'quicker, still careful' },
                  { value: 'keep', label: 'Leave as is', hint: 'policy only' },
                ],
                onSelect: v => u(d => void (d.frontier.effort = (['max', 'xhigh', 'high', 'keep'].includes(v) ? v : 'max') as typeof d.frontier.effort)),
              }),
            }),
          s.frontier.enabled &&
            row(k, {
              key: 'fr-sub',
              label: 'Subagents too',
              subtitle: 'Raises their effort as well; costs more',
              control: switchControl(k, { key: 'fr-sub', isOn: s.frontier.subagentEffort, onPress: () => u(d => void (d.frontier.subagentEffort = !d.frontier.subagentEffort)) }),
            }),
          (s.frontier.enabled || pane.frontier.delivery.state === 'stale') && frontierDeliveryRow(k, pane.frontier.delivery),
        ],
      })}

      {card(kit, {
        key: 'guard',
        title: 'Lazy-exit guard',
        accent,
        aside: s.guard.enabled ? st.guard.text : undefined,
        rows: k => [
          row(k, {
            key: 'gu-on',
            label: 'Keep Claude going when it stops early',
            control: switchControl(k, { key: 'gu-on', isOn: s.guard.enabled, onPress: () => u(d => void (d.guard.enabled = !d.guard.enabled)) }),
          }),
          s.guard.enabled &&
            row(k, {
              key: 'gu-strict',
              label: 'Strictness',
              subtitle: STRICTNESS_HINT[s.guard.strictness],
              control: segmented(k, {
                key: 'gu-strict',
                value: s.guard.strictness,
                options: [
                  { value: 'lenient', label: 'Lenient' },
                  { value: 'standard', label: 'Standard' },
                  { value: 'strict', label: 'Strict' },
                ],
                onSelect: v => u(d => void (d.guard.strictness = (['lenient', 'standard', 'strict'].includes(v) ? v : 'standard') as typeof d.guard.strictness)),
              }),
            }),
          s.guard.enabled &&
            row(k, {
              key: 'gu-turn',
              label: 'Times per turn',
              subtitle: 'At most this many nudges in one turn',
              control: stepper(k, {
                key: 'gu-turn',
                display: String(s.guard.maxPerTurn),
                onDecrease: s.guard.maxPerTurn > 1 ? () => u(d => void (d.guard.maxPerTurn -= 1)) : undefined,
                onIncrease: s.guard.maxPerTurn < 5 ? () => u(d => void (d.guard.maxPerTurn += 1)) : undefined,
              }),
            }),
          s.guard.enabled &&
            row(k, {
              key: 'gu-model',
              label: 'Smart check',
              subtitle: 'A small model call when the signs are unclear',
              control: switchControl(k, { key: 'gu-model', isOn: s.guard.modelCheck, onPress: () => u(d => void (d.guard.modelCheck = !d.guard.modelCheck)) }),
            }),
        ],
      })}

      {card(kit, {
        key: 'qa',
        title: 'Release check',
        accent,
        rows: k => [
          row(k, {
            key: 'qa-on',
            label: 'Test before calling work done',
            subtitle: 'And say plainly what could not be checked',
            control: switchControl(k, { key: 'qa-on', isOn: s.qa.enabled, onPress: () => u(d => void (d.qa.enabled = !d.qa.enabled)) }),
          }),
        ],
      })}

      {card(kit, {
        key: 'models',
        title: 'Models',
        accent,
        footer: 'A prompt cache belongs to one model: switching the main conversation re-sends its whole context uncached. A subagent starts a fresh context of its own, so its model costs the main cache nothing.',
        rows: k => {
          const p = s.agentModels
          const known = new Set(pane.models.resolved.map(r => r.alias))
          const options = AGENT_MODEL_OPTIONS.filter(o => o.value !== 'fable' || known.has('fable') || AGENT_CATEGORIES.some(c => p[c] === 'fable'))
          const last = pane.models.decisions.at(-1)
          return [
            row(k, {
              key: 'mo-main',
              label: 'Main conversation',
              subtitle: 'Chosen in Claude Code (/model). Control Room never switches it',
              value: pane.models.session === '' ? 'Claude Code’s' : modelName(pane.models.session),
              valueTone: 'muted',
            }),
            row(k, {
              key: 'mo-guard',
              label: 'Cache protection',
              subtitle: s.cache.guardModelSwitch ? 'Asks before a model switch re-sends 100k+ warm cached tokens' : 'A model switch is not asked about',
              control: link(k, { key: 'mo-guard', label: s.cache.guardModelSwitch ? 'On' : 'Off', onPress: () => kit.actions.setTab('context') }),
            }),
            row(k, {
              key: 'mo-agents',
              label: 'Agent models by kind of work',
              subtitle: p.enabled ? 'Each subagent gets the model set for its kind of work' : 'Each subagent runs on its own definition’s model, or Claude’s choice',
              control: switchControl(k, {
                key: 'mo-agents',
                isOn: p.enabled,
                onPress: () =>
                  u(d => {
                    d.agentModels.enabled = !d.agentModels.enabled
                    // Turned on with nothing chosen yet: start from the suggested policy (cheap search, careful debugging).
                    if (d.agentModels.enabled && AGENT_CATEGORIES.every(c => d.agentModels[c] === 'agent')) for (const c of AGENT_CATEGORIES) d.agentModels[c] = SUGGESTED_AGENT_MODELS[c]
                  }),
              }),
            }),
            ...(p.enabled
              ? AGENT_CATEGORIES.map(c =>
                  row(k, {
                    key: `mo-${c}`,
                    label: AGENT_CATEGORY_LABEL[c],
                    control: picker(k, { key: `mo-${c}`, value: p[c], options, onSelect: v => u(d => void (d.agentModels[c] = asChoice(v))) }),
                  }),
                )
              : []),
            p.enabled && p.overrides.length > 0 && row(k, { key: 'mo-overrides', label: 'Per agent', subtitle: p.overrides.map(o => `${o.type} → ${o.model}`).join(' · ') }),
            p.enabled && last !== undefined && row(k, { key: 'mo-last', label: 'Latest agent', subtitle: last.agent, value: last.model === null ? 'its own model' : modelName(last.model), valueTone: 'muted' }),
            advisorRow(k, pane.models.advisor),
          ]
        },
      })}

      {card(kit, {
        key: 'progress',
        title: 'Run progress',
        accent,
        footer:
          pane.planSource === 'tasks'
            ? 'Counted from Claude Code’s own task list.'
            : 'Claude Code offers no task list here, so Control Room gives Claude a small milestones tool. Progress is done of total, never estimated.',
        rows: k => [
          pane.planSource === 'tasks'
            ? row(k, { key: 'pr-source', label: 'Milestones', subtitle: 'From Claude’s task list', value: 'Automatic', valueTone: 'muted' })
            : row(k, {
                key: 'pr-milestones',
                label: 'Keep milestones for the run',
                subtitle: s.progress.milestones ? 'Claude records its steps; Activity and the status bar count them' : 'No run progress is shown',
                control: switchControl(k, { key: 'pr-milestones', isOn: s.progress.milestones, onPress: () => u(d => void (d.progress.milestones = !d.progress.milestones)) }),
              }),
        ],
      })}
    </Box>
  )
}
