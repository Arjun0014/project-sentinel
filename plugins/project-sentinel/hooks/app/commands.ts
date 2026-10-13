/**
 * `/control-room [sub-command]` (alias `/cr`): everything the panel does,
 * typeable — handy over Remote Control, in `-p` runs and for muscle memory.
 * With no argument it opens or closes the panel. Replies use the panel's words.
 */

import type { CommandRunResult } from 'claude-code'

import { ANSWER_STYLE_INFO, answerStyleLabel } from '../core/answers'
import * as fmt from '../core/format'
import { listProfiles } from '../core/profiles'
import { ANSWER_STYLES, type AnswerStyle, defaultSettings } from '../core/settings'
import type { CacheView } from '../../types'
import { VERSION } from '../constants'
import * as Chain from '../features/chain'
import type { Runtime } from './runtime'
import { recordLine } from './ledger'
import { opsCommand } from './opsCommands'
import { cacheState, keepWarmProof, keepWarmStatus } from '../ui/pane/cache'
import { frontierDeliveryText } from '../ui/pane/behavior'
import { hudOf, paneOf, profileOf, runLabelOf, statusOf } from './views'
import { planDetail } from '../ui/hud'

const HELP = [
  'Control Room  (/cr or /control-room)',
  '  /cr                       open or close Control Room',
  '  /cr status                everything at a glance',
  '  /cr profile [name]        list profiles, or switch (normal, classic, frontier, low-resource, release-qa, yours)',
  '  /cr autopilot on|off|70%|700k',
  '  /cr handoff               hand off now, then continue in a fresh context',
  '  /cr handoff now           hand off without waiting for background work (it keeps running for the fresh context)',
  '  /cr handoff wait [30m]    keep waiting for it · stop [id|all]: stop it, then hand off · cancel: call the handoff off',
  '  /cr fresh [now]           start the fresh context of a written handoff (notes checked; now: leave background work running)',
  '  /cr frontier|guard|qa|focus on|off',
  '  /cr resources off|low|medium|high|60/80',
  '  /cr agents                what is running (Activity → Agents) · /cr agents unlimited|off|ask|<n>: what Claude may start',
  '  /cr router off|balanced|performance|economy|custom',
  '  /cr style standard|brief|ste|mission|quest   how Claude writes to you',
  '  /cr cache                 the prompt cache: lifetime, Keep warm, recent rebuilds',
  '  /cr cache keep on|off · idle 2h · stable on|off · guard on|off',
  '  /cr diagnostics           evidence: each request\'s policies and effort, notes to Claude, Keep warm checks',
  'Operations: the run over time (Activity → Operations)',
  '  /cr queue <text>          work for Claude at the next safe boundary (--turn, --milestone or --handoff first to choose)',
  '  /cr queue [list]          open the queue to add work, or list it · /cr queue now|cancel <id>',
  '  /cr watch in 2h <what>    park the run until a time, then wake Claude to check · at 14:00 · tomorrow at 9am · --warm|--fresh',
  '  /cr watchers              the watchers · /cr watch now|pause|resume|cancel <id>',
  '  /cr decisions             what Claude left for you to decide · /cr decide <id> [answer]',
  '  /cr budget [$30|6h|handoffs 5|notify|ask|finish|off|continue]   an optional run budget',
  '  /cr resume                what a fresh context would get now (Ready to resume)',
  '  /cr evidence              what each verified milestone stood on · check · accept [n|all]',
  '  /cr hud band|status|both|off',
  '  /cr companion on|off      Kit, a small companion on the status bar · /cr motion on|off',
  '  /cr reset confirm         back to Normal (custom profiles are kept)',
].join('\n')

const onOff = (word: string | undefined): boolean | null =>
  word === undefined ? null : ['on', 'true', 'yes', '1', 'enable', 'enabled'].includes(word) ? true : ['off', 'false', 'no', '0', 'disable', 'disabled'].includes(word) ? false : null

export function statusText(rt: Runtime): string {
  const hud = hudOf(rt)
  const st = statusOf(rt)
  const p = profileOf(rt)
  const totals = rt.run === null ? null : Chain.totals(rt.run, Date.now())
  const ctx = hud.ctx.pct === null ? 'waiting for the first response' : `${hud.ctx.pct}% · ${fmt.tokens(hud.ctx.tokens)} of ${fmt.tokens(hud.ctx.window)} tokens`
  const runCost = totals !== null && totals.sessions > 1 ? ` · ${fmt.cost(totals.costUsd)}${totals.isCostPartial ? '+' : ''} this run` : ''
  const lines: [string, string][] = [
    ['Context', ctx],
    ['Cost', `${fmt.cost(hud.cost.usd)} this session${runCost}`],
    ['Plan usage', planDetail(hud.plan, rt.clock())],
    ['Autopilot', rt.settings.autopilot.enabled ? `${st.autopilot.text} · ${rt.autopilot.note}` : st.autopilot.text],
    ['Frontier Max', rt.settings.frontier.enabled || paneOf(rt).frontier.delivery.state === 'stale' ? `${st.frontier.text} · ${frontierDeliveryText(paneOf(rt).frontier.delivery).text}` : st.frontier.text],
    ['Lazy-exit guard', st.guard.text],
    ['Release check', st.qa.text],
    ['Model router', st.router.text],
    ['Subagents', st.subagents.text],
    ['Machine load', st.load.text],
    ['Focus view', st.focus.text],
    ['Answer style', st.answers.text],
    ['Prompt cache', cacheLine(rt)],
    ...(hud.git === null ? [] : [['Git', hud.git] as [string, string]]),
  ]
  const head = `◆ Control Room · ${p.name}${p.isModified ? ' (edited)' : ''} · ${runLabelOf(rt)}`
  return [head, ...lines.map(([label, value]) => `${label.padEnd(17)}${value}`)].join('\n')
}

/** The prompt cache in one line, for /cr status. */
function cacheLine(rt: Runtime): string {
  const cache = paneOf(rt).cache
  const state = cacheState(cache, rt.clock())
  if (cache.warmth === 'none') return state.text
  return `${state.text} · ${fmt.tokens(cache.cachedTokens)} cached · Keep warm ${cache.keepWarm.isOn ? 'on' : 'off'}`
}

/** /cr cache: what the cache holds, how long, Keep warm, and the recent rebuilds with what would have avoided them. */
export function cacheText(rt: Runtime): string {
  const cache = paneOf(rt).cache
  const now = rt.clock()
  const state = cacheState(cache, now)
  const s = rt.settings.cache
  const lifetime = cache.ttl === null ? 'not known yet' : `${cache.ttl === '1h' ? '1 hour' : '5 minutes'} (${cache.ttlSource === 'engine' ? 'as Claude Code reports it' : cache.ttlSource === 'config' ? 'as Claude Code is configured' : cache.ttlSource === 'probe' ? 'learned by Keep warm' : cache.ttlSource === 'stored' ? 'learned earlier' : cache.ttlSource === 'plan' ? "the plan's default" : 'observed'})`
  const lines: [string, string][] = [
    ['State', state.text],
    ['Lifetime', lifetime],
    ['Cached', cache.warmth === 'none' ? '—' : `${fmt.tokens(cache.cachedTokens)} tokens · ${fmt.plural(cache.requests, 'request')}${cache.hitRatio === null ? '' : ` · ${Math.round(cache.hitRatio * 100)}% read from cache`}`],
    ['Keep warm', `${s.keepWarm ? 'On' : 'Off'} · ${keepWarmStatus(cache).text} · stops after ${fmt.minutes(s.maxIdleMinutes)} idle`],
    ['Model switch', s.guardModelSwitch ? 'Asks first when 100k+ cached tokens would be re-sent' : 'Does not ask'],
    ['Policies', s.stablePolicies ? (cache.policies.isHolding ? 'Held stable: changes reach Claude as notes' : 'Kept stable while the cache is warm') : 'Rewritten on every change'],
  ]
  const certainty = { proven: 'proven cause', likely: 'likely cause', unknown: 'cause unknown' } as const
  const misses = cache.misses.slice(0, 5).flatMap(m => [
    `  ${fmt.clock(m.at)}  ${m.label}: ${m.detail} · ${m.isPartial ? `partial, re-sent ${fmt.tokens(m.recached)} of ${fmt.tokens(m.prefix)}, read ${fmt.tokens(m.read)}` : `full, re-sent ${fmt.tokens(m.recached)} of ${fmt.tokens(m.prefix)}`} (${certainty[m.certainty]})`,
    `         ${m.advice}`,
  ])
  // The timeline behind the state, to the second: what a check of Keep warm reads.
  const k = cache.keepWarm
  const proof = keepWarmProof(cache)
  const timeline: [string, string][] =
    cache.warmth === 'none'
      ? []
      : [
          ['Last request', `${fmt.clockSeconds(cache.lastRequestAt)}${cache.expiresAt === null ? '' : ` · expires ${fmt.clockSeconds(cache.expiresAt)} (derived)`}`],
          ...(proof === null ? [] : ([['Refreshes', proof.refreshes], ['Fork', (proof.fork?.text ?? '—').replace(/^Fork: /, '')], ['Main cache', proof.main.text]] as [string, string][])),
          ...(k.isOn && k.nextAt !== null ? [['Next refresh', `${fmt.clockSeconds(k.nextAt)}${k.isProbe ? ' (learns the lifetime)' : ''}`] as [string, string]] : []),
          ...(k.pausedReason === null ? [] : [['Paused', k.pausedReason] as [string, string]]),
        ]
  const refreshes = k.log.slice(0, 4).map(refreshLine)
  return [
    '◆ Prompt cache',
    ...lines.map(([label, value]) => `${label.padEnd(14)}${value}`),
    ...timeline.map(([label, value]) => `${label.padEnd(14)}${value}`),
    ...(refreshes.length === 0 ? [] : ['Keep warm refreshes (newest first)', ...refreshes]),
    ...(misses.length === 0 ? [] : ['Recent rebuilds', ...misses]),
    'Expiry, hit ratio and causes are derived from the tokens Claude Code reports. A cause is called proven only when the engine or the request shows it.',
  ].join('\n')
}

/** One refresh, to the second: the fork's reading, the expiries, and what the conversation's next request showed. */
function refreshLine(r: CacheView['keepWarm']['log'][number]): string {
  const fork = `fork ${r.isHit ? 'HIT' : 'MISS'} read ${fmt.tokens(r.read)} wrote ${fmt.tokens(r.written)} uncached ${fmt.tokens(r.input)}`
  const expiries = `old expiry ${fmt.clockSeconds(r.oldExpiry)}${r.newExpiry === null ? '' : ` → ${fmt.clockSeconds(r.newExpiry)}`}`
  const main = r.main === null ? '' : ` · next request ${fmt.clockSeconds(r.main.at)} (${r.main.phase.replace(/-/g, ' ')}) read ${fmt.tokens(r.main.read)} wrote ${fmt.tokens(r.main.written)}`
  return `  ${fmt.clockSeconds(r.at)}  ${fork} · ${expiries}${main} · ${r.status.toUpperCase()}${r.note === null ? '' : ` · ${r.note}`}`
}

/**
 * /cr diagnostics: the evidence behind the panel's words. Each model request of this context with
 * how the policies reached it (fingerprints only: no prompt text), the notes delivered to Claude and
 * how, and Keep warm's refreshes with the conversation's check of each.
 */
export function diagnosticsText(rt: Runtime): string {
  const f = rt.ledger.frontier(rt.settings.frontier.enabled)
  const requests = rt.ledger.records.slice(0, 12).map(r => `  ${fmt.clockSeconds(r.at)}  ${recordLine(r)}`)
  const notes = rt.notesBox.delivered.slice(0, 10).map(n => `  ${fmt.clockSeconds(n.deliveredAt)}  ${n.kind} · ${n.chars} chars · with the ${n.channel === 'tool-batch' ? 'batch of tool results' : 'prompt'} (waited ${Math.round((n.deliveredAt - n.at) / 1000)} s)`)
  const waiting = rt.notesBox.kinds()
  const cache = paneOf(rt).cache
  const first = rt.ledger.first
  return [
    `◆ Diagnostics · session ${rt.sessionId ?? '?'} · Project Sentinel ${VERSION}`,
    `Frontier Max     ${rt.settings.frontier.enabled ? 'on' : 'off'} · ${f.state}${f.method === null ? '' : ` via ${f.method}`}${f.effort === null ? '' : ` · last effort ${f.effort}`}${f.effortAsked === null ? '' : ` (asked ${f.effortAsked})`}`,
    `First request    ${first === null ? 'none yet in this context' : recordLine(first)}`,
    `Settings         ${rt.isLoaded ? 'loaded from the store' : 'NOT LOADED (defaults)'} · system prompt hook ${rt.compose.isReached ? 'reached' : rt.composeObserved ? 'NOT reached (policies ride the prompt)' : 'not yet called'}`,
    'Requests (newest first)',
    ...(requests.length === 0 ? ['  none yet in this context'] : requests),
    `Notes for Claude ${waiting.length === 0 ? 'none waiting' : `waiting: ${waiting.join(', ')}`} · never appended to the transcript`,
    ...(notes.length === 0 ? [] : notes),
    'Keep warm refreshes (newest first)',
    ...(cache.keepWarm.log.length === 0 ? ['  none in this context'] : cache.keepWarm.log.map(refreshLine)),
  ].join('\n')
}

export async function handleCommand(rt: Runtime, args: string): Promise<CommandRunResult> {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [verb, a1, a2] = words
  // The orchestration layer's (queue, watch, decisions, budget, resume; agents with no argument).
  const ops = await opsCommand(rt, args, words)
  if (ops !== null) return ops

  switch (verb) {
    case undefined: {
      const result = await rt.togglePane()
      if (result === 'closed') return { text: 'Control Room closed.' }
      if (result === 'opened') return { text: 'Control Room opened.' }
      return { text: `${statusText(rt)}\n(The panel is not shown on this surface. Every control is a sub-command: /cr help.)` }
    }
    case 'help':
    case '?':
      return { text: HELP }
    case 'status':
      return { text: statusText(rt) }
    case 'diagnostics':
    case 'diag':
      return { text: diagnosticsText(rt) }
    case 'open':
      await rt.openPane(true)
      return { text: 'Control Room opened.' }
    case 'close':
      await rt.closePane()
      return { text: 'Control Room closed.' }
    case 'profile':
    case 'profiles': {
      if (a1 === undefined) {
        const list = listProfiles(rt.settings).map(p => `  ${p.id.padEnd(20)} ${p.name} — ${p.tagline}`)
        return { text: `Active: ${rt.profileLabel()}\n${list.join('\n')}` }
      }
      const name = words.slice(1).join(' ')
      return rt.applyProfileById(name) ? { text: `Profile ${rt.profileLabel()} applied.` } : { text: `No profile named "${name}". Try /cr profile.` }
    }
    case 'autopilot':
    case 'auto': {
      const toggle = onOff(a1)
      if (toggle !== null) {
        rt.update(s => {
          s.autopilot.enabled = toggle
        })
        return { text: `Autopilot ${toggle ? 'on' : 'off'}.` }
      }
      const m = a1 === undefined ? null : /^(\d+(?:\.\d+)?)(%|k|m)?$/.exec(a1)
      if (m === null) return { text: 'Usage: /cr autopilot on|off|70%|700k' }
      const n = Number(m[1])
      rt.update(s => {
        s.autopilot.enabled = true
        if (m[2] === '%') {
          s.autopilot.thresholdMode = 'percent'
          s.autopilot.thresholdPercent = n
        } else {
          s.autopilot.thresholdMode = 'tokens'
          s.autopilot.thresholdTokens = m[2] === 'k' ? n * 1000 : m[2] === 'm' ? n * 1_000_000 : n
        }
      })
      return { text: `Autopilot on. Hands off at ${m[2] === '%' ? `${rt.settings.autopilot.thresholdPercent}%` : fmt.tokens(rt.settings.autopilot.thresholdTokens)}.` }
    }
    // Each says what really happened: a handoff begun, a fresh context started, or why not.
    case 'handoff': {
      if (a1 === undefined) return { text: await rt.requestHandoff() }
      // The ways out of a wait: never only natural language.
      if (a1 === 'now' || a1 === 'force') return { text: await rt.handoffNow() }
      if (a1 === 'wait' || a1 === 'keep') {
        const m = a2 === undefined ? null : /^(\d+(?:\.\d+)?)(m|min|h)?$/.exec(a2)
        if (a2 !== undefined && m === null) return { text: 'Usage: /cr handoff wait [30m|2h]' }
        return { text: await rt.keepWaiting(m === null ? undefined : Math.round(Number(m[1]) * (m[2] === 'h' ? 60 : 1)) * 60_000) }
      }
      if (a1 === 'cancel' || a1 === 'off') return { text: rt.cancelHandoff() }
      if (a1 === 'stop') return { text: await rt.stopAndHandOff(args.trim().split(/\s+/)[2]) }
      return { text: 'Usage: /cr handoff [now|wait [30m]|stop [task id|all]|cancel]' }
    }
    // Milestone evidence: what each verified milestone stood on; a stale one accepted as it is now.
    case 'evidence': {
      if (a1 === undefined) return { text: rt.evidenceText() }
      if (a1 === 'check') {
        await rt.checkEvidence('/cr evidence check')
        return { text: rt.evidenceText() }
      }
      if (a1 === 'accept') {
        const what = words.slice(2).join(' ')
        if (what === '' || what === 'all') return { text: await rt.acceptEvidence(null) }
        const key = rt.staleEvidenceKey(what)
        return { text: key === null ? `No stale milestone matches "${what}". /cr evidence lists them.` : await rt.acceptEvidence(key) }
      }
      return { text: 'Usage: /cr evidence [check|accept [all|<number>|<milestone>]]' }
    }
    case 'fresh':
      if (a1 === 'now' || a1 === 'force') return { text: await rt.startFreshContext({ isForced: true }) }
      if (a1 !== undefined) return { text: 'Usage: /cr fresh [now]' }
      return { text: await rt.startFreshContext() }
    case 'frontier':
    case 'guard':
    case 'qa':
    case 'focus': {
      const toggle = onOff(a1)
      if (toggle === null) return { text: `Usage: /cr ${verb} on|off` }
      rt.update(s => {
        if (verb === 'frontier') s.frontier.enabled = toggle
        if (verb === 'guard') s.guard.enabled = toggle
        if (verb === 'qa') s.qa.enabled = toggle
        if (verb === 'focus') s.focus.enabled = toggle
      })
      const name = { frontier: 'Frontier Max', guard: 'Lazy-exit guard', qa: 'Release check', focus: 'Focus view' }[verb]
      return { text: `${name} ${toggle ? 'on' : 'off'}.` }
    }
    case 'resources':
    case 'res': {
      if (a1 === undefined) return { text: 'Usage: /cr resources off|low|medium|high|<cpu>/<ram>' }
      const custom = /^(\d{2,3})\/(\d{2,3})$/.exec(a1)
      if (['off', 'low', 'medium', 'high'].includes(a1)) {
        rt.update(s => {
          s.resources.level = a1 as 'off' | 'low' | 'medium' | 'high'
        })
      } else if (custom !== null) {
        rt.update(s => {
          s.resources.level = 'custom'
          s.resources.cpu = Number(custom[1])
          s.resources.ram = Number(custom[2])
        })
      } else return { text: 'Usage: /cr resources off|low|medium|high|<cpu>/<ram>' }
      const r = rt.settings.resources
      if (r.level === 'off') return { text: 'Machine load limit off. Readings only.' }
      const ceilings = rt.effective().resources.ceilings
      return { text: `Machine load ${r.level.charAt(0).toUpperCase()}${r.level.slice(1)}: ceilings at CPU ${ceilings?.cpu ?? r.cpu}% · RAM ${ceilings?.ram ?? r.ram}%. Claude was told.` }
    }
    case 'agents':
    case 'subagents': {
      if (a1 === undefined) return { text: 'Usage: /cr agents unlimited|off|ask|<n>' }
      const n = Number(a1)
      rt.update(s => {
        if (a1 === 'unlimited' || a1 === 'unrestricted') s.subagents.mode = 'unrestricted'
        else if (a1 === 'off' || a1 === 'block' || a1 === 'none') s.subagents.mode = 'block'
        else if (a1 === 'ask') s.subagents.mode = 'ask'
        else if (Number.isInteger(n) && n > 0) {
          s.subagents.mode = 'limit'
          s.subagents.limit = n
        }
      })
      return { text: `Subagents: ${rt.subagentLabel()}.` }
    }
    case 'router': {
      const valid = ['off', 'balanced', 'performance', 'economy', 'custom']
      if (a1 === undefined || !valid.includes(a1)) return { text: `Usage: /cr router ${valid.join('|')}` }
      rt.update(s => {
        s.router.strategy = a1 as 'off' | 'balanced' | 'performance' | 'economy' | 'custom'
      })
      return { text: `Model router ${a1 === 'off' ? 'off' : `${a1.charAt(0).toUpperCase()}${a1.slice(1)}`}.` }
    }
    case 'style':
    case 'answers': {
      const aliases: Record<string, AnswerStyle> = { standard: 'standard', default: 'standard', normal: 'standard', brief: 'brief', short: 'brief', ste: 'ste', plain: 'ste', simplified: 'ste', mission: 'mission', quest: 'quest', game: 'quest' }
      const style = a1 === undefined ? undefined : aliases[a1]
      if (style === undefined) {
        const list = ANSWER_STYLES.map(s => `  ${s.padEnd(10)} ${ANSWER_STYLE_INFO[s].label}: ${ANSWER_STYLE_INFO[s].hint}`)
        return { text: `Answer style: ${answerStyleLabel(rt.settings.answers.style)}\n${list.join('\n')}\nUsage: /cr style ${ANSWER_STYLES.join('|')}` }
      }
      rt.update(s => {
        s.answers.style = style
      })
      const native = rt.nativeOutputStyle === null ? '' : ` Claude Code's own output style, ${rt.nativeOutputStyle}, is in use and takes precedence until you set it back to Default.`
      return { text: `Answer style ${answerStyleLabel(style)}.${native}` }
    }
    case 'cache': {
      if (a1 === undefined) return { text: cacheText(rt) }
      const usage = 'Usage: /cr cache [keep on|off] [idle 45m|2h] [stable on|off] [guard on|off]'
      if (a1 === 'idle' || a1 === 'stop') {
        const m = a2 === undefined ? null : /^(\d+(?:\.\d+)?)(m|min|h)?$/.exec(a2)
        if (m === null) return { text: usage }
        const minutes = Math.round(Number(m[1]) * (m[2] === 'h' ? 60 : 1))
        rt.update(s => void (s.cache.maxIdleMinutes = minutes))
        return { text: `Keep warm stops after ${fmt.minutes(rt.settings.cache.maxIdleMinutes)} idle.` }
      }
      const toggle = onOff(a2 ?? (onOff(a1) !== null ? a1 : undefined))
      const what = onOff(a1) !== null ? 'keep' : a1
      if (toggle === null || !['keep', 'warm', 'keepwarm', 'stable', 'policies', 'guard', 'switch'].includes(what)) return { text: usage }
      rt.update(s => {
        if (what === 'keep' || what === 'warm' || what === 'keepwarm') s.cache.keepWarm = toggle
        if (what === 'stable' || what === 'policies') s.cache.stablePolicies = toggle
        if (what === 'guard' || what === 'switch') s.cache.guardModelSwitch = toggle
      })
      const name = what === 'stable' || what === 'policies' ? 'Keep policies stable' : what === 'guard' || what === 'switch' ? 'Ask before a model switch' : 'Keep warm'
      return { text: `${name} ${toggle ? 'on' : 'off'}.${name === 'Keep warm' && toggle ? ` It refreshes the cache before it lapses while you are away, for up to ${fmt.minutes(rt.settings.cache.maxIdleMinutes)}, and checks that it worked.` : ''}` }
    }
    case 'companion':
    case 'kit':
    case 'motion': {
      const toggle = onOff(a1)
      if (toggle === null) return { text: `Usage: /cr ${verb} on|off` }
      rt.update(s => {
        if (verb === 'motion') s.ui.reducedMotion = !toggle
        else s.ui.companion = toggle
      })
      if (verb === 'motion') return { text: toggle ? 'Animation on.' : 'Reduced motion: still drawings instead of animation.' }
      return { text: toggle ? 'Companion on: Kit lives above the status bar and shows what Claude is doing. Give it a click now and then.' : 'Companion off.' }
    }
    case 'hud': {
      const valid = ['band', 'status', 'both', 'off']
      if (a1 === undefined || !valid.includes(a1)) return { text: `Usage: /cr hud ${valid.join('|')}` }
      rt.update(s => {
        s.ui.hud = a1 as 'band' | 'status' | 'both' | 'off'
      })
      const where = { band: 'above the prompt', status: "in Claude Code's status line", both: "above the prompt and in the status line", off: 'hidden' }[a1 as 'band' | 'status' | 'both' | 'off']
      return { text: `Status bar ${where}.` }
    }
    case 'reset': {
      if (a1 !== 'confirm') return { text: 'This resets every Control Room setting (custom profiles kept). Run /cr reset confirm to proceed.' }
      rt.update(s => ({ ...defaultSettings(), customProfiles: s.customProfiles }))
      return { text: 'Settings reset to Normal. Your profiles are kept.' }
    }
    default:
      void a2
      return { text: `Unknown sub-command "${verb}".\n${HELP}` }
  }
}
