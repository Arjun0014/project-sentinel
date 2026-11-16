/**
 * The priority system. Every hook asks this module what is in force *now*,
 * so feature interactions are decided in one place instead of by whichever
 * hook runs first. Order of precedence (higher wins):
 *
 *   1. Organisation & engine safety (deny rules, plan mode)    — never loosened
 *   2. Permission Policy                                       — deny > ask > allow
 *   3. The person's live actions (abort, typed prompts)
 *   4. Context Autopilot handoff                               — suspends the guard
 *   5. Resource Governor                                       — how, not whether
 *   6. Subagent Control                                        — hard spawn limits
 *   7. Frontier Max                                            — policy and effort; never the model
 *   8. No-Lazy-Exit Guard
 *   9. Agent Model Policy                                      — subagents only, never the main conversation
 *  10. Focus View                                              — presentation only
 */

import type { ModelEffort } from 'claude-code'

import { type AutopilotState, isHandoffActive } from '../features/autopilot'
import * as prompts from '../features/prompts'
import { type Ceilings, type PressureLevel, ceilingsOf } from '../features/resources/pressure'
import type { Settings } from './settings'

export type Live = {
  autopilot: AutopilotState
  autopilotThreshold: number | null
  pressure: PressureLevel
  permissionMode: string | undefined
}

export type Effective = {
  frontier: { isActive: boolean; effort: ModelEffort | null }
  qa: { isActive: boolean }
  guard: { isActive: boolean; reason: string | null }
  /** The Agent Model Policy: subagents' models by kind of work. The main conversation is never routed (1.8.0). */
  agentModels: { isActive: boolean }
  subagents: { mode: Settings['subagents']['mode']; limit: number }
  resources: { ceilings: Ceilings | null }
  autopilot: { isActive: boolean; isHandoff: boolean }
}

const EFFORT: Record<Settings['frontier']['effort'], ModelEffort | null> = { max: 'max', xhigh: 'xhigh', high: 'high', keep: null }

export function effective(settings: Settings, live: Live): Effective {
  const isHandoff = settings.autopilot.enabled && isHandoffActive(live.autopilot)
  const isPlan = live.permissionMode === 'plan'

  let guardReason: string | null = null
  if (!settings.guard.enabled) guardReason = 'Off'
  else if (isHandoff) guardReason = 'Paused during the handoff'
  else if (isPlan) guardReason = 'Paused in plan mode'

  return {
    frontier: { isActive: settings.frontier.enabled, effort: settings.frontier.enabled ? EFFORT[settings.frontier.effort] : null },
    qa: { isActive: settings.qa.enabled },
    guard: { isActive: guardReason === null, reason: guardReason },
    agentModels: { isActive: settings.agentModels.enabled },
    subagents: { mode: settings.subagents.mode, limit: settings.subagents.limit },
    resources: { ceilings: ceilingsOf(settings.resources) },
    autopilot: { isActive: settings.autopilot.enabled, isHandoff },
  }
}

export type PolicySection = { name: string; text: string }

/**
 * The system-prompt sections in force. Each is a pure function of settings
 * (never of live figures), so the prompt only changes when the person
 * changes a setting: one prompt-cache miss per change, none per turn.
 */
export function policySections(
  settings: Settings,
  autopilotThreshold: number | null,
  live: { milestonesTool?: string | null; nativeOutputStyle?: string | null } = {},
): PolicySection[] {
  const sections: PolicySection[] = []
  // Only where Control Room offered its milestones tool (Claude Code has no task list of its own here).
  if (settings.progress.milestones && live.milestonesTool !== undefined && live.milestonesTool !== null) {
    sections.push({ name: 'Run progress', text: prompts.milestonesPolicy(live.milestonesTool) })
  }
  if (settings.frontier.enabled) sections.push({ name: 'Frontier Max', text: prompts.frontierPolicy(settings.frontier.effort) })
  if (settings.qa.enabled) sections.push({ name: 'Release/QA', text: prompts.qaPolicy() })
  const ceilings = ceilingsOf(settings.resources)
  if (ceilings !== null) {
    sections.push({
      name: `Resource Governor ${ceilings.level}`,
      text: prompts.resourcePolicy({ level: ceilings.level, cpu: ceilings.cpu, ram: ceilings.ram, maxHeavy: ceilings.maxHeavy, enforcement: ceilings.enforcement }),
    })
  }
  const sub = prompts.subagentPolicy(settings.subagents.mode, settings.subagents.limit)
  if (sub !== null) sections.push({ name: 'Subagent limits', text: sub })
  if (settings.autopilot.enabled) {
    // Rounded so small window measurements do not churn the prompt cache.
    const rounded = autopilotThreshold === null ? null : Math.round(autopilotThreshold / 10_000) * 10_000
    sections.push({ name: 'Context Autopilot', text: prompts.autopilotPolicy(rounded, settings.autopilot.handoffFile) })
  }
  // The person's own Claude Code output style is the more specific choice: it wins, and this stands down.
  const style = live.nativeOutputStyle === undefined || live.nativeOutputStyle === null ? prompts.answerStylePolicy(settings.answers.style) : null
  if (style !== null) sections.push({ name: 'Answer style', text: style })
  return sections
}

export const POLICY_SECTION_ID = 'project-sentinel:policies'

export function policyText(sections: readonly PolicySection[]): string | null {
  if (sections.length === 0) return null
  return ['# Project Sentinel — active session policies', 'Set by the user in Control Room, the Project Sentinel plugin’s panel.', '', ...sections.map(s => s.text)].join('\n\n')
}
