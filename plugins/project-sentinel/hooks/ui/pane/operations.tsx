/**
 * Activity → Operations: the run over time, in one place (docs/ORCHESTRATION.md).
 *
 *   NEEDS REVIEW    decisions Claude left for the person; a watcher that waits for them; a held message
 *   MISSION QUEUE   work for later, and when each item goes
 *   WATCHERS        the run parked until a time; Claude Code's own wake-ups beside them, read only
 *   AGENTS          what is actually running, as Claude Code reports it
 *   RUN BUDGET      optional limits; one quiet row while none is set
 *
 * Progressive disclosure: an empty card is one line, a row's details open in place, every form
 * field is one line. The page leads with what needs the person.
 */

import type { RenderElement } from 'claude-code'

import type { DecisionView, OpsView, PaneModel, QueueItemView, QueueTarget, Tone, WatchStrategy, WatcherView } from '../../../types'
import * as fmt from '../../core/format'
import { sentenceCase } from '../../core/text'
import { howWords } from '../../features/ops'
import { clockAhead, untilWords } from '../../features/when'
import type { Kit } from '../kit'
import { buttons, callout, card, clip, footnote, isNative, link, listItem, meterBar, note, picker, row, spaced, stepper, switchControl } from '../primitives'
import { ACCENT, G, toneProps } from '../theme'
import { agentsLink } from './agents'

const accent = ACCENT.activity

const TARGETS: readonly { value: QueueTarget; label: string; hint: string }[] = [
  { value: 'boundary', label: 'Next safe boundary', hint: 'When the milestone under way completes or the turn ends' },
  { value: 'turn', label: 'After this turn', hint: 'When Claude’s current turn ends' },
  { value: 'milestone', label: 'After the current milestone', hint: 'When the milestone under way now is done' },
  { value: 'fresh', label: 'After the handoff', hint: 'In the next fresh context Project Sentinel starts' },
]

const STRATEGIES: readonly { value: WatchStrategy; label: string; hint: string }[] = [
  { value: 'smart', label: 'Smart', hint: 'Holds the cache or wakes fresh, whichever fits the wait' },
  { value: 'warm', label: 'Keep warm', hint: 'Holds this conversation’s cache to the wake (refreshes cost tokens)' },
  { value: 'fresh', label: 'Fresh', hint: 'Spends nothing while it sleeps; wakes in a fresh context' },
]

const STATUS_LOOK: Record<string, { glyph: string; tone: Tone }> = {
  armed: { glyph: G.wait, tone: 'info' },
  paused: { glyph: G.ring, tone: 'muted' },
  due: { glyph: G.warn, tone: 'warn' },
  stale: { glyph: G.warn, tone: 'warn' },
  waking: { glyph: G.run, tone: 'info' },
  done: { glyph: G.ok, tone: 'good' },
  dismissed: { glyph: G.ring, tone: 'muted' },
}

const isOpen = (ops: OpsView, id: string): boolean => ops.ui.expanded.includes(id)

/** A quiet "Details ▾" toggle for a row. */
function detailsLink(kit: Kit, ops: OpsView, id: string) {
  return link(kit, { key: `ops-more-${id}`, label: isOpen(ops, id) ? 'Less' : 'Details', onPress: () => kit.actions.toggleOpsRow(id) })
}

// ---------------------------------------------------------------------------
// Needs review

function decisionBlock(k: Kit, d: DecisionView): RenderElement {
  const { Box, Input, Text } = k.ui
  const isAnswered = d.status !== 'open'
  const meta = spaced(k, [d.id, d.milestone, d.isBlocking ? 'blocks the run' : d.urgency === 'high' ? 'urgent' : null])
  return (
    <Box key={`dec-${d.id}`} flexDirection="column" rowGap={isNative(k) ? 1 : 0}>
      {listItem(k, { key: `dec-${d.id}-q`, glyph: isAnswered ? G.ok : G.warn, tone: isAnswered ? 'good' : d.isBlocking ? 'bad' : 'warn', text: d.question, right: isAnswered ? 'answered' : undefined, detail: meta })}
      {d.context === null ? null : (
        <Box key={`dec-${d.id}-ctx`} marginLeft={3} {...clip(k)}>
          <Text dimColor wrap="wrap">
            {d.context}
          </Text>
        </Box>
      )}
      {isAnswered ? (
        <Box key={`dec-${d.id}-ans`} marginLeft={3} flexDirection="column">
          <Text wrap="wrap">{`${G.arrow} ${d.answer ?? ''}`}</Text>
          {d.route === null ? null : <Text dimColor wrap="wrap">{d.route}</Text>}
          {buttons(k, [{ key: `dec-${d.id}-now`, label: d.status === 'unsure' ? 'Send again' : 'Send now', onPress: () => k.actions.answerNow(d.id), isHidden: d.status === 'sending' || d.isBlocking }], `dec-${d.id}-acts`, true)}
        </Box>
      ) : (
        <Box key={`dec-${d.id}-acts`} marginLeft={3} flexDirection="column" rowGap={isNative(k) ? 1 : 0}>
          {buttons(
            k,
            d.options.map((o, i) => ({ key: `dec-${d.id}-opt-${i}`, label: o, onPress: () => k.actions.answer(d.id, o), isPrimary: i === 0 })),
            `dec-${d.id}-opts`,
            true,
          )}
          {d.allowText && Input !== undefined ? (
            <Input key={`dec-${d.id}-text`} value="" placeholder={d.options.length === 0 ? 'Your answer' : 'Or say something else'} submitLabel={isNative(k) ? 'Answer' : 'answer'} onSubmit={text => k.actions.answer(d.id, text)} />
          ) : null}
          {buttons(k, [{ key: `dec-${d.id}-withdraw`, label: 'Not needed', onPress: () => k.actions.withdraw(d.id) }], `dec-${d.id}-more`, true)}
        </Box>
      )}
    </Box>
  )
}

function watcherNeeds(k: Kit, w: WatcherView, ops: OpsView): RenderElement {
  const canFresh = ops.resume.isHealthy && (w.strategy !== 'warm')
  return callout(k, {
    key: `needs-${w.id}`,
    tone: 'warn',
    title: `Watcher due · ${w.label}`,
    text: w.needs ?? undefined,
    actions: [
      { key: `needs-${w.id}-check`, label: 'Check now', onPress: () => k.actions.watchCheck(w.id), isPrimary: true },
      ...(canFresh ? [{ key: `needs-${w.id}-fresh`, label: 'Start fresh', onPress: () => k.actions.watchFresh(w.id) }] : []),
      { key: `needs-${w.id}-snooze`, label: 'Reschedule 30m', onPress: () => k.actions.watchSnooze(w.id, 30) },
      { key: `needs-${w.id}-dismiss`, label: 'Dismiss', onPress: () => k.actions.watchDismiss(w.id) },
    ],
  })
}

function reviewCard(kit: Kit, pane: PaneModel, ops: OpsView): RenderElement {
  const open = ops.decisions.filter(d => d.status === 'open')
  const waiting = ops.decisions.filter(d => d.status !== 'open')
  const count = open.length + (ops.held === null ? 0 : 1)
  const u = kit.actions.update
  return card(kit, {
    key: 'ops-review',
    title: 'Needs review',
    accent,
    aside: count === 0 ? 'Nothing waits for you' : String(count),
    footer: 'Claude leaves a decision here when it is yours and need not stop the work. Permission prompts and confirmations stay Claude Code’s own and are never deferred here.',
    rows: k => [
      ...open.map(d => decisionBlock(k, d)),
      ...waiting.map(d => decisionBlock(k, d)),
      open.length + waiting.length === 0 ? note(k, 'No decisions waiting.', 'ops-review-none') : null,
      row(k, {
        key: 'ops-decisions',
        label: 'Let Claude leave decisions here',
        subtitle: pane.settings.ops.decisions ? 'Offered as a tool for choices that are yours' : 'Claude asks you directly instead',
        control: switchControl(k, { key: 'ops-decisions', isOn: pane.settings.ops.decisions, onPress: () => u(d => void (d.ops.decisions = !d.ops.decisions)) }),
      }),
    ],
  })
}

// ---------------------------------------------------------------------------
// Mission Queue

function queueItem(k: Kit, ops: OpsView, q: QueueItemView, index: number, total: number): RenderElement {
  const { Box, Input } = k.ui
  const isEditing = ops.ui.editing === q.id
  const look = q.status === 'due' || q.status === 'sending' ? { glyph: G.run, tone: 'info' as Tone } : q.status === 'unsure' ? { glyph: G.warn, tone: 'warn' as Tone } : { glyph: `${index + 1}.`, tone: 'muted' as Tone }
  return (
    <Box key={`q-${q.id}`} flexDirection="column" rowGap={isNative(k) ? 1 : 0}>
      {listItem(k, { key: `q-${q.id}-line`, glyph: look.glyph, tone: look.tone, text: q.text.split('\n')[0] ?? q.text, detail: spaced(k, [q.id, q.when]) })}
      {isEditing && Input !== undefined ? (
        <Box key={`q-${q.id}-edit`} marginLeft={3} flexDirection="column" rowGap={isNative(k) ? 1 : 0}>
          <Input key={`q-${q.id}-text`} value={q.text} submitLabel={isNative(k) ? 'Save' : 'save'} onSubmit={text => k.actions.queueEdit(q.id, text)} />
          {row(k, {
            key: `q-${q.id}-target`,
            label: 'Deliver',
            control: picker(k, { key: `q-${q.id}-target`, value: q.target, options: TARGETS, onSelect: v => k.actions.queueRetarget(q.id, v as QueueTarget) }),
          })}
          {buttons(k, [{ key: `q-${q.id}-done`, label: 'Done', onPress: () => k.actions.editQueue(null) }], `q-${q.id}-edit-acts`, true)}
        </Box>
      ) : (
        <Box key={`q-${q.id}-acts`} marginLeft={3}>
          {buttons(
            k,
            [
              { key: `q-${q.id}-up`, label: G.up, onPress: () => k.actions.queueMove(q.id, -1), isHidden: index === 0 || q.status === 'sending' },
              { key: `q-${q.id}-down`, label: G.down, onPress: () => k.actions.queueMove(q.id, 1), isHidden: index === total - 1 || q.status === 'sending' },
              { key: `q-${q.id}-edit`, label: 'Edit', onPress: () => k.actions.editQueue(q.id), isHidden: q.status === 'sending' || q.status === 'unsure' },
              { key: `q-${q.id}-now`, label: q.status === 'unsure' ? 'Send again' : 'Deliver now', onPress: () => k.actions.queueNow(q.id), isHidden: q.status === 'sending' },
              { key: `q-${q.id}-delete`, label: 'Delete', onPress: () => k.actions.queueCancel(q.id), isHidden: q.status === 'sending' },
            ],
            `q-${q.id}-buttons`,
            true,
          )}
        </Box>
      )}
    </Box>
  )
}

function queueCard(kit: Kit, ops: OpsView): RenderElement {
  const { Input } = kit.ui
  const target = TARGETS.find(t => t.value === ops.ui.queueTarget) ?? TARGETS[0]!
  return card(kit, {
    key: 'ops-queue',
    title: 'Mission Queue',
    accent,
    aside: ops.queue.length === 0 ? 'Empty' : String(ops.queue.length),
    footer: 'Work you give Claude for later, without interrupting it now. It is kept with the run (across /clear and handoffs) and goes only at the boundary you choose, never into a turn under way. /cr queue <text> adds one from the prompt box.',
    rows: k => [
      Input === undefined
        ? note(k, 'Add work for later with /cr queue <text>.', 'ops-queue-cmd')
        : row(k, {
            key: 'ops-queue-input',
            label: 'Add work for later',
            control: { element: <Input key="ops-queue-input" value="" placeholder="Update the README with the final cache findings" submitLabel={isNative(k) ? 'Add to queue' : 'add'} onSubmit={text => k.actions.queueAdd(text)} />, width: isNative(k) ? 44 : 30, stack: true },
          }),
      row(k, {
        key: 'ops-queue-target',
        label: 'Deliver',
        subtitle: target.hint,
        control: picker(k, { key: 'ops-queue-target', value: ops.ui.queueTarget, options: TARGETS, onSelect: v => k.actions.setQueueTarget(v as QueueTarget) }),
      }),
      ops.ui.error === null ? null : note(k, ops.ui.error, 'ops-queue-error', 'warn'),
      ...ops.queue.map((q, i) => queueItem(k, ops, q, i, ops.queue.length)),
      ops.queueDone.length === 0
        ? null
        : note(k, `Lately: ${ops.queueDone.map(q => `${q.id} ${q.status === 'cancelled' ? 'deleted' : `delivered ${fmt.clock(q.deliveredAt)}`}`).join(', ')}`, 'ops-queue-done'),
    ],
  })
}

// ---------------------------------------------------------------------------
// Watchers

function watcherBlock(k: Kit, ops: OpsView, w: WatcherView): RenderElement {
  const { Box, Input, Text } = k.ui
  const look = STATUS_LOOK[w.status] ?? STATUS_LOOK.armed!
  const left = w.status === 'armed' ? `in ${untilWords(w.wakeAt - k.now)}` : w.status === 'paused' ? 'paused' : w.status === 'waking' ? 'waking' : 'due'
  const how = howWords(w)
  const isEditing = ops.ui.rescheduling === w.id
  return (
    <Box key={`w-${w.id}`} flexDirection="column" rowGap={isNative(k) ? 1 : 0}>
      {listItem(k, { key: `w-${w.id}-line`, glyph: look.glyph, tone: look.tone, text: w.label, right: spaced(k, [clockAhead(w.wakeAt, k.now), left]), rightTone: w.status === 'armed' ? 'info' : look.tone, detail: spaced(k, [w.id, how]) })}
      {isOpen(ops, w.id) ? (
        <Box key={`w-${w.id}-details`} marginLeft={3} flexDirection="column">
          {w.decided === null ? null : <Text dimColor wrap="wrap">{`${w.strategy === 'smart' ? 'Smart chose' : 'Strategy'} ${w.decided.mode === 'fresh' ? 'Fresh' : w.decided.hold ? 'Keep warm' : 'In this context'} · ${w.decided.reason}`}</Text>}
          <Text dimColor wrap="wrap">{spaced(k, [`Armed ${fmt.clock(w.createdAt)}`, w.milestone === null ? null : `milestone: ${w.milestone}`, w.isCheckpointPending ? 'parks when this turn ends' : 'parked at its checkpoint', w.source === 'scout' ? 'suggested by the Scout' : w.source === 'carried' ? 'from an earlier run' : null])}</Text>
          {w.strategy !== 'warm' && !ops.resume.isHealthy ? <Text {...toneProps('warn')} wrap="wrap">{`A fresh wake needs: ${ops.resume.problems[0] ?? 'resume state'}.`}</Text> : null}
        </Box>
      ) : null}
      {isEditing && Input !== undefined ? (
        <Box key={`w-${w.id}-edit`} marginLeft={3} flexDirection="column" rowGap={isNative(k) ? 1 : 0}>
          <Input key={`w-${w.id}-when`} value="" placeholder="in 2h or at 14:00" submitLabel={isNative(k) ? 'Reschedule' : 'set'} onSubmit={when => k.actions.watchReschedule(w.id, when)} />
          {row(k, { key: `w-${w.id}-strategy`, label: 'Resume', control: picker(k, { key: `w-${w.id}-strategy`, value: w.strategy, options: STRATEGIES, onSelect: v => k.actions.watchStrategy(w.id, v as WatchStrategy) }) })}
          {buttons(k, [{ key: `w-${w.id}-edit-done`, label: 'Done', onPress: () => k.actions.editWatch(null) }], `w-${w.id}-edit-acts`, true)}
        </Box>
      ) : (
        <Box key={`w-${w.id}-acts`} marginLeft={3} flexDirection="row" columnGap={2} flexWrap="wrap">
          {buttons(
            k,
            [
              { key: `w-${w.id}-wake`, label: 'Wake now', onPress: () => k.actions.watchWake(w.id), isHidden: w.status === 'waking' || w.needs !== null },
              { key: `w-${w.id}-reschedule`, label: 'Edit', onPress: () => k.actions.editWatch(w.id), isHidden: w.status === 'waking' },
              { key: `w-${w.id}-pause`, label: w.status === 'paused' ? 'Resume' : 'Pause', onPress: () => (w.status === 'paused' ? k.actions.watchResume(w.id) : k.actions.watchPause(w.id)), isHidden: w.status !== 'armed' && w.status !== 'paused' },
              { key: `w-${w.id}-notes`, label: 'Write notes first', onPress: () => k.actions.watchNotes(w.id), isHidden: w.strategy === 'warm' || ops.resume.isHealthy || ops.isTurnRunning || w.status !== 'armed' },
              { key: `w-${w.id}-delete`, label: 'Delete', onPress: () => k.actions.watchDismiss(w.id), isHidden: w.status === 'waking' },
            ],
            `w-${w.id}-buttons`,
            true,
          )}
          {detailsLink(k, ops, w.id).element}
        </Box>
      )}
    </Box>
  )
}

function watchersCard(kit: Kit, pane: PaneModel, ops: OpsView): RenderElement {
  const { Box, Input } = kit.ui
  const u = kit.actions.update
  const isOn = pane.settings.ops.watchers
  const strategy = STRATEGIES.find(s => s.value === ops.ui.watchStrategy) ?? STRATEGIES[0]!
  return card(kit, {
    key: 'ops-watchers',
    title: 'Watchers',
    accent,
    aside: ops.watchers.length === 0 ? (isOn ? 'None armed' : 'Off') : String(ops.watchers.length),
    footer: 'A watcher parks the run until a time, then wakes Claude to check what it was waiting for. It never clears a run that moved on since it was armed. Watchers run while Claude Code runs: closed, nothing wakes, and an overdue one waits for you when the session is open again. No background service is installed.',
    rows: k => [
      ...ops.watchers.filter(w => w.needs === null).map(w => watcherBlock(k, ops, w)),
      ...ops.externalWakes.map((e, i) =>
        listItem(k, { key: `wake-ext-${i}`, glyph: G.wait, tone: 'muted', text: e.isRecurring ? `Claude Code wake-up · ${e.schedule}` : 'Claude Code wake-up', right: e.at === null ? undefined : clockAhead(e.at, k.now), detail: 'Claude Code’s own; it ends with the session', isDim: true }),
      ),
      !isOn
        ? null
        : Input === undefined
          ? note(k, 'Add one with /cr watch in 2h <what it waits for>.', 'ops-watch-cmd')
          : (
              <Box key="ops-watch-form" flexDirection="column" rowGap={isNative(k) ? 1 : 0}>
                {row(k, {
                  key: 'ops-watch-label',
                  label: 'Waiting for',
                  control: { element: <Input key="ops-watch-label" value={ops.ui.watchLabel} placeholder="S-002 result" submitLabel={isNative(k) ? 'Next' : 'next'} onInput={v => k.actions.watchLabel(v)} onSubmit={v => k.actions.watchLabel(v)} />, width: isNative(k) ? 36 : 24 },
                })}
                {row(k, {
                  key: 'ops-watch-when',
                  label: 'Wake',
                  control: { element: <Input key="ops-watch-when" value="" placeholder="in 2h or at 14:00" submitLabel={isNative(k) ? 'Add watcher' : 'add'} onSubmit={v => k.actions.watchAdd(v)} />, width: isNative(k) ? 36 : 24 },
                })}
                {buttons(
                  k,
                  [30, 60, 120, 240].map(m => ({ key: `ops-watch-in-${m}`, label: `In ${m < 60 ? `${m}m` : `${m / 60}h`}`, onPress: () => k.actions.watchAdd(`in ${m}m`) })),
                  'ops-watch-quick',
                  true,
                )}
                {ops.ui.choices === null
                  ? null
                  : buttons(
                      k,
                      ops.ui.choices.map((c, i) => ({ key: `ops-watch-pick-${i}`, label: c.label, onPress: () => k.actions.watchPick(c.at), isPrimary: i === 0 })),
                      'ops-watch-choices',
                      true,
                    )}
                {ops.ui.error === null ? null : note(k, ops.ui.error, 'ops-watch-error', 'warn')}
                {row(k, { key: 'ops-watch-strategy', label: 'Resume', subtitle: strategy.hint, control: picker(k, { key: 'ops-watch-strategy', value: ops.ui.watchStrategy, options: STRATEGIES, onSelect: v => k.actions.setWatchStrategy(v as WatchStrategy) }) })}
              </Box>
            ),
      row(k, {
        key: 'ops-watchers-on',
        label: 'Watchers',
        subtitle: isOn ? 'Park the run until a time, then wake it' : 'Off: nothing parks or wakes the run',
        control: switchControl(k, { key: 'ops-watchers-on', isOn, onPress: () => u(d => void (d.ops.watchers = !d.ops.watchers)) }),
      }),
      isOn
        ? row(k, {
            key: 'ops-scout',
            label: 'Suggestions',
            subtitle: pane.settings.ops.scout === 'auto' ? 'Arms one for an explicit wait; suggests the rest' : pane.settings.ops.scout === 'suggest' ? 'Suggests one when Claude waits for a future result' : 'Never suggests one',
            control: picker(k, {
              key: 'ops-scout',
              value: pane.settings.ops.scout,
              options: [
                { value: 'off', label: 'Off' },
                { value: 'suggest', label: 'Suggest', hint: 'After a turn that waits for a result' },
                { value: 'auto', label: 'Arm explicit waits', hint: 'A waiting milestone, or a check with a time' },
              ],
              onSelect: v => u(d => void (d.ops.scout = v === 'auto' ? 'auto' : v === 'off' ? 'off' : 'suggest')),
            }),
          })
        : null,
      ops.watchersDone.length === 0 ? null : note(k, `Lately: ${ops.watchersDone.map(w => `${w.id} ${w.outcome ?? w.status}`).join(' · ')}`, 'ops-watch-done'),
    ],
  })
}

// ---------------------------------------------------------------------------
// Run budget

/** A wall-clock span without its trailing zero: "6h", "2h 14m", "5m 3s". */
const span = (ms: number): string => fmt.duration(ms).replace(/ 0[sm]$/, '')

function budgetCard(kit: Kit, ops: OpsView): RenderElement {
  const { Input } = kit.ui
  const b = ops.budget
  const isEditing = ops.ui.budgetOpen || b.isSet
  const meter = (k: Kit, key: string, label: string, used: number | null, limit: number | null, tone: Tone, words: (n: number) => string) =>
    limit === null
      ? null
      : row(k, {
          key: `budget-${key}`,
          label,
          subtitle: `${used === null ? '—' : words(used)} of ${words(limit)}`,
          subtitleTone: tone === 'normal' ? 'muted' : tone,
          control: { element: meterBar(k, { key: `budget-${key}-bar`, fraction: used === null ? 0 : Math.min(1, used / limit), tone: tone === 'normal' ? 'info' : tone, width: 16, alt: `${label} ${used === null ? '—' : words(used)} of ${words(limit)}` }), width: 16 },
        })
  return card(kit, {
    key: 'ops-budget',
    title: 'Run budget',
    accent,
    aside: !b.isSet ? 'Off' : b.state === 'reached' ? 'Reached' : b.state === 'near' ? 'Near a limit' : undefined,
    footer: isEditing ? 'Limits only what Project Sentinel can measure: cost as Claude Code reports it, wall-clock time, handoffs. At a limit, nothing stops a turn under way: automation waits at the next boundary.' : undefined,
    rows: k =>
      !isEditing
        ? [row(k, { key: 'budget-off', label: 'No budget for this run', subtitle: 'Limit its cost, time or handoffs', control: link(k, { key: 'budget-set', label: 'Set a budget', onPress: () => k.actions.budgetOpen(true) }) })]
        : [
            meter(k, 'cost', 'Cost', b.cost.used, b.cost.limit, b.cost.tone, n => `$${n.toFixed(2)}${b.cost.isPartial === true ? '+' : ''}`),
            meter(k, 'time', 'Time', b.time.used, b.time.limit, b.time.tone, span),
            meter(k, 'handoffs', 'Handoffs', b.handoffs.used, b.handoffs.limit, b.handoffs.tone, n => String(n)),
            b.reached.length === 0 ? null : note(k, `Reached: ${b.reached.join('; ')}${b.held === null ? '' : `. ${sentenceCase(b.held)} waits for you.`}`, 'budget-reached', 'warn'),
            Input === undefined
              ? null
              : row(k, {
                  key: 'budget-cost-input',
                  label: 'Cost limit',
                  subtitle: 'US dollars, as Claude Code reports cost',
                  control: { element: <Input key="budget-cost-input" value={b.cost.limit === null ? '' : String(b.cost.limit)} placeholder="30" submitLabel={isNative(k) ? 'Set' : 'set'} onSubmit={v => k.actions.budgetCost(v)} />, width: isNative(k) ? 20 : 12 },
                }),
            Input === undefined
              ? null
              : row(k, {
                  key: 'budget-time-input',
                  label: 'Time limit',
                  subtitle: 'Wall-clock, since the run began',
                  control: { element: <Input key="budget-time-input" value="" placeholder="6h" submitLabel={isNative(k) ? 'Set' : 'set'} onSubmit={v => k.actions.budgetTime(v)} />, width: isNative(k) ? 20 : 12 },
                }),
            row(k, {
              key: 'budget-handoffs-step',
              label: 'Handoffs at most',
              control: stepper(k, { key: 'budget-handoffs', display: b.handoffs.limit === null ? 'Off' : String(b.handoffs.limit), onDecrease: () => k.actions.budgetHandoffs(-1), onIncrease: () => k.actions.budgetHandoffs(1) }),
            }),
            row(k, {
              key: 'budget-at-limit',
              label: 'At a limit',
              control: picker(k, {
                key: 'budget-at-limit',
                value: b.atLimit,
                options: [
                  { value: 'notify', label: 'Notify only', hint: 'Say so; nothing else changes' },
                  { value: 'ask', label: 'Ask before continuing', hint: 'Automation waits for your yes' },
                  { value: 'finish', label: 'Finish the milestone, then pause', hint: 'Claude stops after the milestone it is on' },
                ],
                onSelect: v => k.actions.budgetAtLimit(v === 'notify' ? 'notify' : v === 'finish' ? 'finish' : 'ask'),
              }),
            }),
            ops.ui.error === null || !ops.ui.budgetOpen ? null : note(k, ops.ui.error, 'budget-error', 'warn'),
            buttons(
              k,
              [
                { key: 'budget-approve', label: 'Continue anyway', onPress: () => k.actions.budgetApprove(), isPrimary: true, isHidden: b.state !== 'reached' },
                { key: 'budget-clear', label: b.isSet ? 'Remove the budget' : 'Not now', onPress: () => k.actions.budgetClear() },
              ],
              'budget-actions',
            ),
          ],
  })
}

// ---------------------------------------------------------------------------
// The page

export function operationsPage(kit: Kit, pane: PaneModel, ops: OpsView | undefined): RenderElement {
  const { Box } = kit.ui
  if (ops === undefined) return note(kit, 'Loading…', 'ops-loading')
  const needs = ops.watchers.filter(w => w.needs !== null)
  const f = ops.foreign
  return (
    <Box key="ops-page" flexDirection="column">
      {f === null
        ? null
        : callout(kit, {
            key: 'ops-foreign',
            tone: 'info',
            title: `Run ${f.runNumber} left open work`,
            text: `${spaced(kit, [f.watchers > 0 ? fmt.plural(f.watchers, 'watcher') : null, f.queued > 0 ? `${f.queued} queued` : null, f.decisions > 0 ? fmt.plural(f.decisions, 'open decision') : null])}${f.overdue === null ? '' : ` (${f.overdue})`}. Resume that session to carry it on there, or bring it into this run.`,
            actions: [
              { key: 'ops-foreign-bring', label: 'Bring them here', onPress: () => kit.actions.foreignBring(), isPrimary: true },
              { key: 'ops-foreign-dismiss', label: 'Not now', onPress: () => kit.actions.foreignDismiss() },
            ],
          })}
      {ops.held === null
        ? null
        : callout(kit, {
            key: 'ops-held',
            tone: 'warn',
            title: 'Your message was not sent',
            text: `${ops.held.text.length > 300 ? `${ops.held.text.slice(0, 300)}…` : ops.held.text}${ops.held.hasAttachments ? ' (its attachments were not kept)' : ''}`,
            actions: [
              { key: 'ops-held-back', label: 'Put back in the box', onPress: () => kit.actions.heldPutBack(), isPrimary: !isNative(kit) },
              { key: 'ops-held-send', label: 'Send now', onPress: () => kit.actions.heldSend(), isPrimary: isNative(kit) },
              { key: 'ops-held-discard', label: 'Discard', onPress: () => kit.actions.heldDiscard() },
            ],
          })}
      {ops.suggestion === null
        ? null
        : callout(kit, {
            key: 'ops-suggest',
            tone: 'info',
            title: 'Claude appears to be waiting for a future result',
            text: `${ops.suggestion.reason}. ${ops.suggestion.question}`,
            actions: [
              ...(ops.suggestion.wakeAt === null ? [] : [{ key: 'ops-suggest-take', label: 'Create watcher', onPress: () => kit.actions.suggestTake(), isPrimary: true }]),
              ...[60, 120].map(m => ({ key: `ops-suggest-${m}`, label: `In ${m / 60}h`, onPress: () => kit.actions.suggestAt(`in ${m}m`) })),
              { key: 'ops-suggest-ignore', label: 'Ignore', onPress: () => kit.actions.suggestIgnore() },
            ],
          })}
      {needs.map(w => watcherNeeds(kit, w, ops))}
      {reviewCard(kit, pane, ops)}
      {queueCard(kit, ops)}
      {watchersCard(kit, pane, ops)}
      {agentsLink(kit, ops)}
      {budgetCard(kit, ops)}
      {ops.log.length === 0
        ? null
        : (
          // Apart from the Run budget card it follows: the run's operations, not the budget's (read as budget history in review).
          <Box key="ops-log-wrap" marginTop={1} flexDirection="column">
            {footnote(kit, { key: 'ops-log', text: `Recent operations: ${ops.log.slice(0, 4).map(e => `${fmt.clock(e.at)} ${e.text}`).join(' · ')}` })}
          </Box>
        )}
    </Box>
  )
}
