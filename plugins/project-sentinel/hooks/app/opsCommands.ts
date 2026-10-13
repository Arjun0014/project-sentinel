/**
 * The orchestration layer's sub-commands (docs/ORCHESTRATION.md): `/cr queue`, `/cr watch`,
 * `/cr watchers`, `/cr decisions`, `/cr decide`, `/cr agents` (with no argument), `/cr budget`,
 * `/cr resume`. Each one does what its control in Activity → Operations does, and answers in the
 * panel's words.
 *
 * A slash command's echo and its reply become part of the conversation (Claude reads them with
 * the next request), so these stay plain and short, and none returns `context`. `/cr` is not an
 * immediate command: typed while Claude works, Claude Code runs it when the turn ends, so nothing
 * here reaches a turn under way.
 */

import type { CommandRunResult } from 'claude-code'

import type { AgentRowView, DecisionView, OpsView, QueueItemView, QueueTarget, ResumeView, WatchStrategy, WatcherView } from '../../types'
import * as fmt from '../core/format'
import { sentenceCase } from '../core/text'
import { howWords } from '../features/ops'
import { parseDuration, splitWatchArgs, untilWords, clockAhead } from '../features/when'
import type { Runtime } from './runtime'

/** The field Operations focuses after `/cr queue` with nothing to add. */
export const QUEUE_INPUT_KEY = 'ops-queue-input'
/** The field Operations focuses after `/cr watch` with nothing to arm. */
export const WATCH_INPUT_KEY = 'ops-watch-label'

const QUEUE_ID = /^q-\d+$/i
const WATCH_ID = /^w-\d+$/i
const DECISION_ID = /^d-\d+$/i

/** `--turn`, `--milestone`, `--handoff`, `--next` before the text: when the item goes. */
const TARGET_FLAGS: Record<string, QueueTarget> = {
  '--next': 'boundary',
  '--boundary': 'boundary',
  '--turn': 'turn',
  '--after-turn': 'turn',
  '--milestone': 'milestone',
  '--after-milestone': 'milestone',
  '--handoff': 'fresh',
  '--after-handoff': 'fresh',
  '--fresh': 'fresh',
}

/** `--smart`, `--warm`, `--fresh` anywhere in `/cr watch`: how the run resumes. */
const STRATEGY_FLAGS: Record<string, WatchStrategy> = { '--smart': 'smart', '--warm': 'warm', '--keep-warm': 'warm', '--fresh': 'fresh' }

const indent = (lines: readonly string[]): string[] => lines.map(l => `  ${l}`)

/** The words after the verb, as typed (the command handler lowercases its words; text keeps its case). */
export function rawRest(args: string, skip: number): string {
  let rest = args.trim()
  for (let i = 0; i < skip; i++) rest = rest.replace(/^\S+\s*/, '')
  return rest.trim()
}

// ---------------------------------------------------------------------------
// Mission Queue

function queueLine(q: QueueItemView): string[] {
  const first = q.text.split('\n')[0] ?? q.text
  return [`${q.id.padEnd(5)}${first.length > 90 ? `${first.slice(0, 89)}…` : first}`, `     ${q.when}`]
}

export function queueText(ops: OpsView): string {
  const lines = [`◆ Mission Queue · ${ops.queue.length === 0 ? 'empty' : `${ops.queue.length} waiting`}`]
  for (const q of ops.queue) lines.push(...indent(queueLine(q)))
  if (ops.queueDone.length > 0) lines.push(`Lately: ${ops.queueDone.map(q => `${q.id} ${q.status === 'cancelled' ? 'deleted' : `delivered ${fmt.clock(q.deliveredAt)}`}`).join(', ')}`)
  lines.push('Add: /cr queue <text> (--turn, --milestone or --handoff first to choose when) · /cr queue now|cancel <id>')
  return lines.join('\n')
}

async function queueCommand(rt: Runtime, args: string, words: readonly string[]): Promise<CommandRunResult> {
  const [, a1, a2] = words
  if (a1 === undefined) {
    if (await rt.openOps(QUEUE_INPUT_KEY)) {
      return { text: 'Mission Queue: type the work under Add work for later (Activity → Operations). Nothing reaches Claude until its boundary.' }
    }
    return { text: queueText(rt.ops.view()) }
  }
  if ((a1 === 'list' || a1 === 'ls') && words.length === 2) return { text: queueText(rt.ops.view()) }
  if ((a1 === 'cancel' || a1 === 'delete' || a1 === 'remove' || a1 === 'now' || a1 === 'send') && a2 !== undefined && QUEUE_ID.test(a2) && words.length === 3) {
    const id = a2.toUpperCase()
    const item = rt.ops.current().queue.find(q => q.id === id)
    if (item === undefined) return { text: `No queued item ${id}. /cr queue list shows them.` }
    if (a1 === 'now' || a1 === 'send') {
      if (item.status !== 'queued' && item.status !== 'due' && item.status !== 'unsure') return { text: `${id} is ${item.status === 'sending' ? 'on its way' : item.status}.` }
      rt.ops.queueNow(id)
      return { text: rt.turn.isRunning ? `${id} goes when Claude's turn ends.` : `${id} goes now.` }
    }
    if (item.status === 'sending') return { text: `${id} is already on its way.` }
    if (item.status === 'delivered' || item.status === 'cancelled') return { text: `${id} is already ${item.status === 'delivered' ? 'delivered' : 'deleted'}.` }
    rt.ops.queueCancel(id)
    return { text: `${id} deleted.` }
  }
  let text = rawRest(args, 1)
  let target: QueueTarget = 'boundary'
  const flag = /^(--[a-z-]+)\s+/i.exec(text)
  if (flag !== null && TARGET_FLAGS[flag[1]!.toLowerCase()] !== undefined) {
    target = TARGET_FLAGS[flag[1]!.toLowerCase()]!
    text = text.slice(flag[0].length).trim()
  }
  const done = rt.ops.queueAdd(text, target)
  if (!done.ok) return { text: done.error }
  return { text: `Queued ${done.id} · ${done.when}.` }
}

// ---------------------------------------------------------------------------
// Watchers

function watcherLines(w: WatcherView, now: number): string[] {
  const when = w.status === 'armed' ? `wakes ${clockAhead(w.wakeAt, now)} (in ${untilWords(w.wakeAt - now)})` : w.status === 'paused' ? `paused (was ${clockAhead(w.wakeAt, now)})` : w.status === 'waking' ? 'waking now' : 'due'
  const how = howWords(w)
  const lines = [`${w.id.padEnd(5)}${w.label} · ${when} · ${how}`]
  if (w.strategy === 'smart' && w.decided !== null) lines.push(`     Smart chose ${w.decided.mode === 'fresh' ? 'Fresh' : w.decided.hold ? 'Keep warm' : 'this context'}: ${w.decided.reason}`)
  if (w.needs !== null) lines.push(`     Waits for you: ${w.needs} (/cr watch now ${w.id}, or Check now in Operations)`)
  return lines
}

const STRATEGY_WORD: Record<WatchStrategy, string> = { smart: 'Smart', warm: 'Keep warm', fresh: 'Fresh' }

export function watchersText(ops: OpsView, now: number): string {
  const lines = [`◆ Watchers · ${ops.watchers.length === 0 ? (ops.settings.watchers ? 'none armed' : 'off') : `${ops.watchers.length} open`}`]
  for (const w of ops.watchers) lines.push(...indent(watcherLines(w, now)))
  for (const e of ops.externalWakes) lines.push(`  Claude Code wake-up${e.isRecurring ? ` (${e.schedule})` : ''}${e.at === null ? '' : ` · ${clockAhead(e.at, now)}`}: Claude Code's own, read only`)
  if (ops.watchersDone.length > 0) lines.push(`Lately: ${ops.watchersDone.map(w => `${w.id} ${w.outcome ?? w.status}`).join(' · ')}`)
  lines.push('Arm: /cr watch in 2h <what it waits for> · /cr watch at 14:00 <what> (--warm or --fresh to choose; Smart by default) · /cr watch now|cancel <id>')
  lines.push('Watchers run while Claude Code runs: closed, nothing wakes, and an overdue one waits for you when the session is open again.')
  return lines.join('\n')
}

async function watchCommand(rt: Runtime, args: string, words: readonly string[]): Promise<CommandRunResult> {
  const [, a1, a2] = words
  const now = rt.clock()
  if (a1 === undefined) {
    if (await rt.openOps(WATCH_INPUT_KEY)) {
      return { text: 'Watchers: say what it waits for and when it wakes (Activity → Operations), or /cr watch in 2h <what it waits for>.' }
    }
    return { text: watchersText(rt.ops.view(), now) }
  }
  if (a1 === 'list' && words.length === 2) return { text: watchersText(rt.ops.view(), now) }
  if (['cancel', 'delete', 'dismiss', 'remove', 'now', 'wake', 'pause', 'resume'].includes(a1) && a2 !== undefined && WATCH_ID.test(a2)) {
    const id = a2.toUpperCase()
    const w = rt.ops.current().watchers.find(x => x.id === id)
    if (w === undefined) return { text: `No watcher ${id}. /cr watchers shows them.` }
    if (w.status === 'done' || w.status === 'dismissed') return { text: `${id} has ended (${w.outcome ?? w.status}).` }
    if (a1 === 'now' || a1 === 'wake') {
      await rt.ops.wakeNow(id)
      return { text: rt.turn.isRunning ? `${id} wakes the run when Claude's turn ends.` : `${id} wakes the run now (${STRATEGY_WORD[w.strategy]}).` }
    }
    if (a1 === 'pause') {
      rt.ops.pause(id)
      return { text: `${id} paused. /cr watch resume ${id} arms it again.` }
    }
    if (a1 === 'resume') {
      rt.ops.resume(id)
      const after = rt.ops.current().watchers.find(x => x.id === id)
      return { text: after?.status === 'armed' ? `${id} armed again: wakes ${clockAhead(after.wakeAt, now)}.` : `${id}: its time passed while paused, so it waits for you in Operations.` }
    }
    rt.ops.dismiss(id)
    return { text: `${id} dismissed.` }
  }
  // Strategy flags anywhere; the rest is "<when> <what it waits for>".
  let strategy: WatchStrategy = 'smart'
  const kept: string[] = []
  for (const word of rawRest(args, 1).split(/\s+/).filter(Boolean)) {
    const s = STRATEGY_FLAGS[word.toLowerCase()]
    if (s === undefined) kept.push(word)
    else strategy = s
  }
  const split = splitWatchArgs(kept.join(' '), now)
  if (split === null) return { text: 'When should it wake? /cr watch in 2h <what it waits for>, or /cr watch at 14:00 <what>. Times are local, at least a minute and at most a week ahead.' }
  let when = split.result
  if (when.kind === 'error') return { text: when.message }
  if (when.kind === 'ambiguous') {
    const host = rt.host
    const options = when.options
    let picked: string | null = null
    if (host !== null) picked = await host.ask(`"${split.when}" could be either. When should ${split.label === '' ? 'the watcher' : `"${split.label}"`} wake?`, options.map(o => o.label), 'Watcher').catch(() => null)
    const choice = options.find(o => o.label === picked)
    if (choice === undefined) return { text: `Not armed: "${split.when}" could be ${options.map(o => o.label).join(' or ')}. Say am or pm, or use the 24-hour clock (at 14:30).` }
    when = { kind: 'at', at: choice.at, words: choice.label }
  }
  const armed = rt.ops.armAt(split.label, when, strategy)
  if (!armed.ok) return { text: armed.error }
  return { text: `Watcher ${armed.words}.` }
}

// ---------------------------------------------------------------------------
// Decision Inbox

function decisionLines(d: DecisionView): string[] {
  const head = `${d.id.padEnd(5)}${d.question}${d.isBlocking ? ' (blocks the run)' : d.urgency === 'high' ? ' (urgent)' : ''}`
  if (d.status === 'open') {
    const options = d.options.length === 0 ? 'Free answer' : `Options: ${d.options.join(' · ')}${d.allowText ? ' · or your own words' : ''}`
    return [head, `     ${options} · /cr decide ${d.id}`]
  }
  return [head, `     Answered: ${d.answer ?? ''}${d.route === null ? '' : ` · ${d.route}`}`]
}

export function decisionsText(ops: OpsView): string {
  const open = ops.decisions.filter(d => d.status === 'open')
  const lines = [`◆ Needs review · ${open.length === 0 ? 'nothing waits for you' : `${open.length} open`}`]
  for (const d of ops.decisions) lines.push(...indent(decisionLines(d)))
  if (ops.held !== null) lines.push(`  A message the Cold Resume Guard kept: "${ops.held.text.slice(0, 80)}${ops.held.text.length > 80 ? '…' : ''}" (Operations: Put back, Send now)`)
  if (ops.decisionsDone.length > 0) lines.push(`Lately: ${ops.decisionsDone.map(d => `${d.id} ${d.status === 'withdrawn' ? 'not needed' : `delivered ${fmt.clock(d.deliveredAt)}`}`).join(', ')}`)
  if (!ops.settings.decisions) lines.push('The Decision Inbox is off: Claude asks you directly instead.')
  lines.push("Answer: /cr decide <id> (Claude Code's question dialog) or /cr decide <id> <your answer>. Permission prompts are never deferred here.")
  return lines.join('\n')
}

async function decideCommand(rt: Runtime, args: string, words: readonly string[]): Promise<CommandRunResult> {
  const a1 = words[1]
  if (a1 === undefined || !DECISION_ID.test(a1)) return { text: `Which decision? /cr decide D-2, or /cr decide D-2 <your answer>.\n${decisionsText(rt.ops.view())}` }
  const id = a1.toUpperCase()
  const answer = rawRest(args, 2)
  if (answer === '') return { text: await rt.ops.askDecision(id) }
  const d = rt.ops.current().decisions.find(x => x.id === id)
  if (d === undefined) return { text: `No decision ${id}.` }
  if (d.status !== 'open') return { text: `${id} is already answered${d.answer === null ? '' : `: ${d.answer}`}.` }
  // A typed answer that names an option (by its number or its words) is that option.
  const n = Number(answer)
  const option = Number.isInteger(n) && n >= 1 && n <= d.options.length ? d.options[n - 1]! : (d.options.find(o => o.toLowerCase() === answer.toLowerCase()) ?? answer)
  const done = rt.ops.answer(id, option)
  if (!done.ok) return { text: done.error }
  return { text: `${id} answered: ${option}. ${rt.turn.isRunning ? 'It reaches Claude with its next tool results.' : d.isBlocking ? 'Claude continues with it now.' : 'It reaches Claude with your next message (Send now in Operations sends it at once).'}` }
}

// ---------------------------------------------------------------------------
// Agents

function agentLine(a: AgentRowView, now: number): string {
  const elapsed = a.startedAt === null ? null : fmt.duration((a.endedAt ?? now) - a.startedAt)
  const name = a.name ?? (a.description || a.type)
  const parts = [`${a.status}${elapsed === null ? '' : ` ${elapsed}`}`, a.type, a.model?.replace(/^claude-/, '') ?? null, a.activity ?? a.result]
  return `${name} · ${parts.filter((p): p is string => p !== null && p !== '').join(' · ')}${a.canStop ? ` · stop: Operations (${a.id})` : ''}`
}

export function agentsText(ops: OpsView, now: number): string {
  const active = ops.agents.filter(a => ['running', 'pending', 'waiting', 'idle'].includes(a.status)).length
  const lines = [`◆ Agents · ${active === 0 ? 'none running' : `${active} active`}`, `  Claude (main) · ${ops.main.text}`]
  for (const a of ops.agents) lines.push(`  ${agentLine(a, now)}`)
  if (ops.agents.length === 0) lines.push('  No subagents in this context.')
  lines.push('As Claude Code reports them. Stop and Message are in Activity → Agents, where Claude Code accepts them. What Claude may start: /cr agents unlimited|off|ask|<n>.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Run Budget

/** A cost limit as money: "$30", "$1.20" (was "$1.2", seen live). */
const limitWords = (usd: number): string => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`

/** A wall-clock span without its trailing zero: "6h", "2h 14m". */
const span = (ms: number): string => fmt.duration(ms).replace(/ 0[sm]$/, '')

export function budgetText(ops: OpsView): string {
  const b = ops.budget
  if (!b.isSet) return '◆ Run budget · off\nSet one: /cr budget $30 · /cr budget 6h · /cr budget handoffs 5 · at a limit: /cr budget notify|ask|finish'
  const money = (n: number) => `$${n.toFixed(2)}${b.cost.isPartial === true ? '+' : ''}`
  const parts = [
    b.cost.limit === null ? null : `Cost ${b.cost.used === null ? '—' : money(b.cost.used)} of ${limitWords(b.cost.limit)}`,
    b.time.limit === null ? null : `Time ${span(b.time.used ?? 0)} of ${span(b.time.limit)}`,
    b.handoffs.limit === null ? null : `Handoffs ${b.handoffs.used ?? 0} of ${b.handoffs.limit}`,
  ].filter((p): p is string => p !== null)
  const at = { notify: 'Notify only', ask: 'Ask before continuing', finish: 'Finish the milestone, then pause' }[b.atLimit]
  const lines = [`◆ Run budget · ${b.state === 'reached' ? 'reached' : b.state === 'near' ? 'near a limit' : 'within limits'}`, `  ${parts.join(' · ')}`, `  At a limit: ${at}`]
  if (b.reached.length > 0) lines.push(`  Reached: ${b.reached.join('; ')}${b.held === null ? '' : `. ${sentenceCase(b.held)} waits for you: /cr budget continue`}`)
  lines.push('Change: /cr budget $30 · 6h · handoffs 5 · notify|ask|finish · off')
  return lines.join('\n')
}

function budgetCommand(rt: Runtime, words: readonly string[]): CommandRunResult {
  const rest = words.slice(1)
  if (rest.length === 0) return { text: budgetText(rt.ops.view()) }
  if (rest.length === 1 && ['off', 'clear', 'remove', 'none'].includes(rest[0]!)) {
    rt.ops.setBudget(null)
    return { text: 'Run budget removed.' }
  }
  if (rest.length === 1 && ['continue', 'go', 'approve', 'ok'].includes(rest[0]!)) {
    if ((rt.ops.budgetCheck()?.reached.length ?? 0) === 0) return { text: 'No limit is reached: nothing waits.' }
    rt.ops.approveBudget()
    return { text: 'The run goes on past its budget. A new limit reached asks again.' }
  }
  const patch: { costUsd?: number | null; durationMs?: number | null; handoffs?: number | null; atLimit?: 'notify' | 'ask' | 'finish' } = {}
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!
    if (w === 'at' || w === 'then') continue
    if (w === 'notify' || w === 'ask' || w === 'finish') {
      patch.atLimit = w
      continue
    }
    if (w === 'handoffs' || w === 'handoff') {
      const n = Number(rest[i + 1])
      if (!Number.isInteger(n) || n < 0 || n > 50) return { text: 'Handoffs: a whole number up to 50 (0 removes the limit), e.g. /cr budget handoffs 5.' }
      patch.handoffs = n === 0 ? null : n
      i += 1
      continue
    }
    const money = /^\$?(\d+(?:\.\d{1,2})?)\$?(usd)?$/.exec(w)
    if (money !== null && !/^\d+(\.\d+)?(h|m|d)$/.test(w)) {
      const n = Number(money[1])
      patch.costUsd = n === 0 ? null : Math.round(n * 100) / 100
      continue
    }
    const ms = parseDuration(w)
    if (ms !== null) {
      patch.durationMs = ms
      continue
    }
    return { text: `"${w}" is not a budget: try $30, 6h, handoffs 5, or notify|ask|finish.` }
  }
  rt.ops.setBudget(patch)
  return { text: budgetText(rt.ops.view()) }
}

// ---------------------------------------------------------------------------
// Resume Preview

export function resumeText(r: ResumeView): string {
  const lines = [`◆ Ready to resume · ${r.isHealthy ? 'ready' : 'not ready'}`]
  if (r.run !== null || r.objective !== null) lines.push(`Run        ${[r.run === null ? null : `Run ${r.run}`, r.objective].filter(Boolean).join(' · ')}`)
  lines.push(`Done       ${r.total === 0 ? 'no milestones' : `${r.doneCount} of ${fmt.plural(r.total, 'milestone')}`}`)
  if (r.current !== null) lines.push(`Under way  ${r.current}`)
  lines.push(`Reads      ${r.reads.map(x => `${x.isOk ? '✓' : '✗'} ${x.label}`).join(' · ')}`)
  const carries = [r.queued > 0 ? fmt.plural(r.queued, 'queued item') : '', r.decisions > 0 ? fmt.plural(r.decisions, 'open decision') : ''].filter(Boolean).join(' · ')
  if (carries !== '') lines.push(`Carries    ${carries}`)
  if (r.next !== null) lines.push(`Next       ${r.next}`)
  for (const p of r.problems) lines.push(`▲ ${p}`)
  lines.push(r.isHealthy ? 'A fresh context would start from this: a watcher’s fresh wake and the Cold Resume Guard’s Start fresh are offered.' : 'A fresh start is not offered until this is ready (Claude writes the handoff notes; /cr handoff does it).')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------

/** Routes an orchestration sub-command; null when the verb is not one (`/cr agents <mode>` stays the subagent policy). */
export async function opsCommand(rt: Runtime, args: string, words: readonly string[]): Promise<CommandRunResult | null> {
  const verb = words[0]
  switch (verb) {
    case 'queue':
    case 'q':
      return queueCommand(rt, args, words)
    case 'watch':
      return watchCommand(rt, args, words)
    case 'watchers':
      await rt.openOps(undefined, 'ops-watchers')
      return { text: watchersText(rt.ops.view(), rt.clock()) }
    case 'decisions':
    case 'review':
      await rt.openOps(undefined, 'ops-review')
      return { text: decisionsText(rt.ops.view()) }
    case 'decide':
    case 'answer':
      return decideCommand(rt, args, words)
    case 'agents':
    case 'subagents':
      if (words.length > 1) return null
      await rt.openActivity('agents')
      return { text: agentsText(rt.ops.view(), Date.now()) }
    case 'budget':
      return budgetCommand(rt, words)
    case 'resume':
    case 'preview':
      await rt.ops.refreshNotes(true)
      return { text: resumeText(rt.ops.resumePreview()) }
    case 'ops':
    case 'operations':
      await rt.openOps()
      return { text: [queueText(rt.ops.view()), watchersText(rt.ops.view(), rt.clock()), decisionsText(rt.ops.view()), budgetText(rt.ops.view())].join('\n') }
    default:
      return null
  }
}
