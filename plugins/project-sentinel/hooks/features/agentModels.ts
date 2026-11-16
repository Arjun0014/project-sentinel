/**
 * The Agent Model Policy: which model a subagent runs on, by the kind of task it is given.
 *
 * The main conversation is never routed. A prompt cache belongs to one model: switching the main conversation's
 * model re-sends the whole context uncached, and a long run (300k, 500k, 700k tokens) holds one large cache that
 * Cache Guardian keeps warm. 1.8.0 removed the main-loop router for that reason: the main conversation stays on
 * the model the person chose in Claude Code. Subagents are where a model choice is free: each starts a fresh,
 * isolated context, so its model never touches the main conversation's cache.
 *
 * A spawn's category comes from Claude Code's facts at `agent.spawn`, never from a model call: its agent type
 * (`Explore`, `Plan`, a plugin's agent) and the few words of its description. The choice per category is the
 * person's (Behavior → Models); `agent` leaves the agent's own definition (or Claude's choice) as it is,
 * `session` gives it the main conversation's model. Only models Claude Code takes as an alias at a spawn are
 * offered (sonnet, opus, haiku; fable once the session has seen it answer), and a family the engine refused
 * this session is never asked for again. Claude naming a model in its Agent call is a deliberate choice: kept.
 * A fork inherits its parent (Claude Code ignores a model there) and a workflow's agents keep the script's.
 *
 * Pure: the Runtime asks at `agent.spawn` and sets the spawn's model.
 */

import type { AgentCategory, AgentModelChoice, Settings } from '../core/settings'

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'

/** haiku 1 < sonnet 2 < opus 3 < fable 4; unknown ids read as opus-class (never assumed cheap). */
export function tierOf(model: string): 1 | 2 | 3 | 4 {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 1
  if (m.includes('sonnet')) return 2
  if (m.includes('fable')) return 4
  return 3
}

/** The family a model id belongs to, or null for an id that names none (a gateway's own name). */
export function familyOf(model: string): Family | null {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus')) return 'opus'
  if (m.includes('fable')) return 'fable'
  return null
}

/** Ids the engine reported answering this session, by family. */
export type KnownModels = ReadonlyMap<Family, string>

/** The aliases Claude Code documents for a subagent's model at a spawn; another family needs an id seen answering. */
const SPAWN_ALIASES: ReadonlySet<Family> = new Set(['haiku', 'sonnet', 'opus'])

export const CATEGORIES: readonly AgentCategory[] = ['explore', 'research', 'planning', 'implementation', 'debugging', 'review', 'security', 'general']

export const CATEGORY_LABEL: Record<AgentCategory, string> = {
  explore: 'Explore / search',
  research: 'Research',
  planning: 'Planning / architecture',
  implementation: 'Implementation',
  debugging: 'Debugging',
  review: 'Review / QA',
  security: 'Security',
  general: 'General',
}

/** The policy the person is offered when they turn it on: cheap search, careful planning and debugging, implementation on the session's model. */
export const SUGGESTED: Record<AgentCategory, AgentModelChoice> = {
  explore: 'haiku',
  research: 'sonnet',
  planning: 'sonnet',
  implementation: 'session',
  debugging: 'opus',
  review: 'sonnet',
  security: 'opus',
  general: 'agent',
}

// The words of a spawn's description that tell its kind of work, strongest first.
const SECURITY = /\b(security|secur(e|ity)\s+(review|audit)|vulnerab\w*|cve|threat model|pentest|secrets?\b|owasp|injection|xss|csrf)\b/i
const DEBUGGING = /\b(debug\w*|root cause|failing|failure|crash\w*|bug\b|bugs\b|regression|flaky|stack ?trace|exception|broken|why (does|is|do))\b/i
const REVIEW = /\b(review\w*|qa\b|verify|verification|validate|check (the|that|for)|audit\w*|lint\w*|test (the|that|plan)|code review)\b/i
const PLANNING = /\b(plan\w*|design\w*|architect\w*|approach|strategy|outline|spec\b|proposal)\b/i
const RESEARCH = /\b(research\w*|docs?\b|documentation|investigat\w*|compare|look into|read up|survey|api reference|changelog)\b/i
const EXPLORE = /\b(explore|search\w*|find\w*|locate|look up|grep|scan\w*|list (all|the)|where (is|are)|map the)\b/i
const IMPLEMENT = /\b(implement\w*|build\w*|write\w*|add\w*|create\w*|refactor\w*|port\w*|migrat\w*|fix(es|ed)?\b|wire\w*|update\w*)\b/i

/** A spawn's kind of work, from its agent type first, then its description's words. */
export function categoryOf(input: { subagentType: string; description: string }): AgentCategory {
  const type = input.subagentType.toLowerCase()
  if (type === 'explore' || type.includes('explore') || type.includes('search')) return 'explore'
  if (type === 'plan' || type.includes('plan') || type.includes('architect')) return 'planning'
  if (type.includes('guide') || type.includes('research') || type.includes('docs')) return 'research'
  if (type.includes('security') || type === 'cso') return 'security'
  if (type.includes('review') || type.includes('qa') || type.includes('test')) return 'review'
  if (type.includes('debug')) return 'debugging'
  const d = input.description
  if (SECURITY.test(d)) return 'security'
  if (DEBUGGING.test(d)) return 'debugging'
  if (REVIEW.test(d)) return 'review'
  if (PLANNING.test(d)) return 'planning'
  if (RESEARCH.test(d)) return 'research'
  if (EXPLORE.test(d)) return 'explore'
  if (IMPLEMENT.test(d)) return 'implementation'
  return 'general'
}

export type AgentModelDecision = {
  /** The model to set on the spawn (an alias Claude Code resolves, or the session model's id); null leaves it. */
  model: string | null
  category: AgentCategory
  /** In words, for the trace and Activity → Agents ("Explore / search → haiku"). */
  why: string
}

/** The model a subagent runs on under the policy, or null to leave the spawn as Claude Code would start it. */
export function decideAgentModel(input: {
  policy: Settings['agentModels']
  subagentType: string
  description: string
  /** The Agent call's own model: Claude chose it, and it is kept. */
  requested: string | undefined
  isFork: boolean
  isWorkflow: boolean
  /** The parent's effective model (what `session` gives a subagent). */
  parentModel: string
  unavailable: ReadonlySet<string>
  known: KnownModels
}): AgentModelDecision {
  const category = categoryOf(input)
  const label = CATEGORY_LABEL[category]
  const none = (why: string): AgentModelDecision => ({ model: null, category, why })
  if (!input.policy.enabled) return none('Agent Model Policy off')
  if (input.isFork) return none('a fork runs on its parent’s model')
  if (input.isWorkflow) return none('a workflow’s agents keep the script’s models')
  if (input.requested !== undefined && input.requested !== '') return none(`Claude chose ${input.requested} for it`)
  const override = input.policy.overrides.find(o => o.type.toLowerCase() === input.subagentType.toLowerCase())
  const choice = override?.model ?? input.policy[category]
  const by = override === undefined ? label : `${override.type} (your override)`
  if (choice === 'agent') return none(`${by} → the agent’s own model`)
  if (choice === 'session') return { model: input.parentModel === '' ? null : input.parentModel, category, why: `${by} → the session’s model` }
  if (input.unavailable.has(choice)) return none(`${by} → ${choice}, refused by Claude Code this session: the agent’s own model`)
  const model = input.known.get(choice) ?? (SPAWN_ALIASES.has(choice) ? choice : null)
  if (model === null) return none(`${by} → ${choice}, not seen answering in this session yet: the agent’s own model`)
  return { model, category, why: `${by} → ${choice}` }
}

/**
 * A 1.7 Model router's subagent choices, carried into the policy at the update (its main-conversation routing is
 * gone): its explore, plan and general picks; the rest left to each agent. Null when the router was off for subagents.
 */
export function policyFromRouter(router: unknown): Settings['agentModels'] | null {
  if (typeof router !== 'object' || router === null) return null
  const r = router as Record<string, unknown>
  const strategy = typeof r.strategy === 'string' ? r.strategy : 'off'
  if (strategy === 'off' || r.subagents === false) return null
  const TABLES: Record<string, { explore: string; plan: string; general: string }> = {
    balanced: { explore: 'haiku', plan: 'session', general: 'sonnet' },
    performance: { explore: 'sonnet', plan: 'opus', general: 'opus' },
    economy: { explore: 'haiku', plan: 'sonnet', general: 'haiku' },
  }
  const custom = typeof r.custom === 'object' && r.custom !== null ? (r.custom as Record<string, unknown>) : {}
  const table = strategy === 'custom' ? { explore: String(custom.explore ?? 'haiku'), plan: String(custom.plan ?? 'session'), general: String(custom.general ?? 'sonnet') } : TABLES[strategy]
  if (table === undefined) return null
  const pick = (v: string): AgentModelChoice => (v === 'haiku' || v === 'sonnet' || v === 'opus' || v === 'fable' || v === 'session' ? v : 'agent')
  return {
    enabled: true,
    explore: pick(table.explore),
    research: 'agent',
    planning: pick(table.plan),
    implementation: 'agent',
    debugging: 'agent',
    review: 'agent',
    security: 'agent',
    general: pick(table.general),
    overrides: [],
  }
}
