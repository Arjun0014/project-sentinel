/**
 * Every word Control Room puts in front of the model, in one place, so the
 * wording can be reviewed as a whole. Pure functions of their inputs: a
 * policy section only changes when its inputs change (prompt cache safe).
 */

import * as fmt from '../core/format'
import type { AnswerStyle, FrontierEffort, ResourceEnforcement, SubagentMode } from '../core/settings'

// ---------------------------------------------------------------------------
// System prompt sections (stable text; delivered by prompt.compose).

export function frontierPolicy(effort: FrontierEffort): string {
  const effortLine =
    effort === 'keep'
      ? ''
      : `\nReasoning effort for this session is set to ${effort === 'max' ? 'the maximum the model supports' : effort}; use it — think the problem through before acting.`
  return [
    '## Frontier Max (Control Room)',
    'This session is being evaluated for frontier-level autonomous capability. It is judged on completeness, depth, implementation quality, persistence, robustness, validation, edge-case handling, self-correction and the work actually accomplished — not on how early you can stop.',
    '',
    'Operating standard:',
    '- Pursue the objective to genuine completion. Do not optimise for the minimum viable answer or the first plausible stopping point.',
    '- Investigate before acting: read the relevant code, documentation and tests, and verify assumptions against the real system instead of guessing.',
    '- Implement fully. No placeholders, stubs, TODOs or "left as an exercise" gaps in work that is in scope and feasible.',
    '- Validate aggressively: run the relevant tests, builds and checks; add tests for new behaviour; exercise edge cases and failure paths; fix what you find.',
    '- Self-correct: when something fails, find the root cause and fix it. Never report unverified success.',
    '- Do not hand feasible work back to the user. Stop to ask only for real external blockers: missing credentials or access, decisions that genuinely belong to the user, or actions outside your permissions.',
    '- When you finish, state what was done and how it was verified, and name any real remaining blocker explicitly.',
    `This standard works inside the session's other active Control Room policies (permissions, resource limits, subagent limits), which take precedence.${effortLine}`,
  ].join('\n')
}

export function qaPolicy(): string {
  return [
    '## Release / QA mode (Control Room)',
    'This session is preparing work for release. Correctness outranks speed and scope:',
    '- Prefer fixing, hardening and verifying existing work over starting new features.',
    '- Run the project\'s real validation (tests, type checks, linters, builds) and report the actual results.',
    '- Check regressions around every change, update user-facing docs and changelogs where behaviour changed, and never claim something works without evidence.',
    '- Flag risky changes (data migrations, public API changes, security-sensitive code) explicitly.',
  ].join('\n')
}

export function resourcePolicy(input: {
  level: string
  cpu: number
  ram: number
  maxHeavy: number
  enforcement: ResourceEnforcement
}): string {
  const enforced =
    input.enforcement === 'inform'
      ? 'Control Room reports pressure but does not block commands.'
      : input.enforcement === 'limit'
        ? 'While the machine is over a ceiling, Control Room refuses additional heavy jobs beyond the limit.'
        : 'While the machine is over a ceiling, Control Room refuses any new heavy job.'
  return [
    `## Resource Governor: ${input.level.toUpperCase()} (Control Room)`,
    `The user's machine has ceilings of CPU ${input.cpu}% and RAM ${input.ram}% for all work combined. They are ceilings, not targets: keep your local workload under them.`,
    `- Run at most ${fmt.plural(input.maxHeavy, 'heavy local job')} at a time (builds, full test suites, installs, containers, compilers, benchmarks).`,
    '- Prefer targeted validation (the tests for what changed) before full-suite runs; run a full suite once, at the end, not repeatedly.',
    '- Do not start parallel builds or test suites. Avoid unnecessary watchers and dev servers, and stop background processes you started once they are no longer needed.',
    '- Live pressure notices from Control Room may arrive mid-task; adapt promptly when they do.',
    enforced,
    'Reasoning depth is not limited by this policy — only local machine load is.',
  ].join('\n')
}

/** The tool Control Room offers for milestones where Claude Code has no task list of its own. */
export const MILESTONES_TOOL = {
  name: 'milestones',
  description: [
    'Record the milestones of the work in progress, so the person sees how far the run is (Control Room shows done of total, and the milestones carry across context handoffs).',
    'A milestone is an outcome worth reporting, not an action: "Analyse the E-008 results", "Fix the cache scheduler", "Validate the release build", "Document the findings". Never a single read, fetch, search or command ("Read config.ts", "Run npm test", "Fetch the logs"); those are steps inside a milestone.',
    'Keep 3 to 10 milestones for the whole objective, and send the whole list each time: when multi-step work starts, and whenever a milestone starts, moves to verifying, waits, is blocked or finishes. A quick one-step request needs none.',
    'Mark exactly one milestone in_progress while you work on it, with `doing`: what you are doing now, in a few present-tense words ("Rewriting the scheduler").',
    'Use verifying for work that is done but still being checked; completed only once it is verified, with `evidence` (what showed it works). Use waiting for a result that will come by itself (a running job, a scheduled run, a review) and blocked for something only the person can give; for both, say what it waits for in `blocker`.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'The objective of the work in a few words, as the user would put it ("Fix the failing ISS test and document the helpers"). Send it with the first list, and again when it changes.',
      },
      milestones: {
        type: 'array',
        description: 'Every milestone of the work, in order.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The outcome, in a few words ("Fix the renderer"), never a single command or file read.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'verifying', 'waiting', 'blocked', 'completed'] },
            doing: { type: 'string', description: 'While in progress or verifying: what you are doing now, a few present-tense words ("Rewriting the scheduler").' },
            evidence: { type: 'string', description: 'For verifying or completed: what showed it works, in a few words ("42 of 42 tests pass").' },
            blocker: { type: 'string', description: 'For waiting or blocked: what it waits for, in a few words ("the S-002 run to finish", "needs the API key").' },
            outputs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional, for verifying or completed: files this milestone produced that its verification covers and no editing tool wrote (generated files, renders, reports), as paths.',
            },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['milestones'],
  },
} as const

export function milestonesPolicy(tool: string): string {
  return [
    '## Run progress',
    `The person follows this run's progress in Control Room, counted from your milestones. For work with several steps, record its milestones with the \`${tool}\` tool as you begin: the objective in a few words and 3 to 10 milestones, each an outcome worth reporting ("Analyse the E-008 results", "Validate the fix"), never a single read, fetch, search or command. Send the whole list again each time a milestone starts, moves to verifying, waits or is blocked, or finishes. Give the one in progress a short present-tense \`doing\` line. Mark a milestone completed only once it is verified, with its \`evidence\`; while it is being checked it is verifying. Mark it waiting when it waits for a result that will come by itself (a running job, a scheduled run) and blocked when it needs something only the person can give, each with its \`blocker\`. Skip it for quick one-step requests. After a handoff, send the run's milestones as the handoff lists them, under the same titles and objective, before continuing.`,
  ].join('\n')
}

/**
 * How Claude writes to the person, as they chose in Behavior → Answer style.
 * Only for its messages: code, commands, files and commit messages keep the
 * project's own style. Standard adds nothing.
 */
export function answerStylePolicy(style: AnswerStyle): string | null {
  const scope = 'This governs your messages to the user, not code, commands, file contents or commit messages.'
  switch (style) {
    case 'standard':
      return null
    case 'brief':
      return [
        '## Answer style: Brief (Control Room)',
        `The user chose brief answers. ${scope}`,
        '- Put the bottom line first: the answer, the result, or the decision you need from the user, in the first sentence.',
        '- Then give only what the user needs to act on it: a few short lines or a short list. No preamble, no restating the request, no step-by-step recap of what you did, no filler.',
        '- While you work, keep progress notes to one short line, or leave them out.',
        '- Keep exact anything the user may copy: code, commands, paths, numbers and error text.',
        '- Brevity never drops what matters: say plainly what failed, what you could not verify, and what you need from the user.',
      ].join('\n')
    case 'ste':
      return [
        '## Answer style: Simplified Technical English (Control Room)',
        `The user chose Simplified Technical English (STE), after the writing rules of ASD-STE100. ${scope} Use STE for files only when the user asks.`,
        '- Procedures: write each instruction as one sentence in the imperative, with at most 20 words. Put the steps of a procedure in a numbered list, one step per item.',
        '- Descriptions: write sentences of at most 25 words. Write about one topic in a paragraph, with at most six sentences.',
        '- Use the active voice. Use only simple tenses (present, past, future). Do not use -ing forms, except in technical names.',
        '- Use one word for one meaning, and use the same word each time. Prefer short, common words ("use", not "utilize"; "start", not "initiate"; "help", not "facilitate").',
        '- Keep the articles ("the", "a"). Do not leave out words to make the text shorter.',
        '- Write technical names exactly as they are: code, commands, file paths, error text, and numbers with their units.',
        '- Write a condition before its instruction: "If the test fails, read the log."',
        '- Start a warning or a caution with a clear command, then give the risk: "Do not push before the tests pass. The build can fail."',
      ].join('\n')
    case 'mission':
      return [
        '## Answer style: Mission control (Control Room)',
        `The user chose mission-control status calls, as a flight controller reports on the voice loop. ${scope}`,
        '- Open a report with one call and its reason: GO (done and verified), NO-GO (failing or blocked), or HOLD (waiting for a decision, or not yet verified). Example: "GO · tests pass, 42 of 42".',
        '- Follow with a short status board: one line per area you touched, each with GO, NO-GO or HOLD and the fact behind it. Example: "Build · GO · compiles in 12 s".',
        '- End with one line, "NEXT:", that names the next action and who owns it: you or the user.',
        '- Call GO only for what you verified. Something you did not check is HOLD, never GO.',
        '- A quick answer to a quick question needs no board: one call and one sentence.',
      ].join('\n')
    case 'quest':
      return [
        '## Answer style: Quest log (Control Room)',
        `The user chose a quest log: a light game frame around real work. ${scope}`,
        "- Treat the objective as the quest and its milestones as the quest's steps.",
        '- Report in short log entries: the step, the obstacle, and the outcome. A failing test or a hard bug is a boss; say when it is beaten. Example: "Step done: fix the ISS speed. Boss beaten: the orbit test passes."',
        '- End with the next step, as "Next quest step:".',
        '- Control Room awards experience points (XP) for verified progress and shows them to the user. Never state XP, levels, scores or rewards yourself, and never claim progress you did not verify.',
        '- Keep the frame light: the facts first, the flavour second, and no padding.',
      ].join('\n')
  }
}

export function subagentPolicy(mode: SubagentMode, limit: number): string | null {
  switch (mode) {
    case 'unrestricted':
      return null
    case 'block':
      return '## Subagents (Control Room)\nSubagents are disabled in this session. Do the work directly in the main conversation; do not try to start agents.'
    case 'ask':
      return '## Subagents (Control Room)\nEvery subagent needs the user\'s approval in this session. Start one only when it clearly helps; a refusal is final for that task.'
    case 'limit':
      return `## Subagents (Control Room)\nAt most ${fmt.plural(limit, 'subagent')} may run at the same time in this session. Wait for running agents to finish before starting more, or do the work directly.`
  }
}

export function autopilotPolicy(thresholdTokens: number | null, handoffFile: string): string {
  const at = thresholdTokens === null ? 'its threshold' : `about ${fmt.tokens(thresholdTokens)} tokens`
  return [
    '## Context Autopilot (Control Room)',
    `When this context window reaches ${at}, Control Room will ask you to finish the current logical unit of work and then to write a handoff (including ${handoffFile}) before the context is cleared and a fresh session continues the work. Keep project documentation and handoff notes truthful and current so that a fresh session can pick up without this conversation.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Cache Guardian.

/** What a Keep warm refresh asks: the shortest possible answer, over the cached conversation. */
export const KEEP_WARM_PROMPT = 'Control Room cache keep-alive (automatic, not from the user): reply with the single word ok and nothing else.'

/**
 * Settings changed while the prompt cache is warm: the system prompt keeps its
 * earlier Control Room section (rewriting it would rebuild the whole cache),
 * so the policies in force now come as this note, which takes precedence.
 */
export function heldPoliciesNotice(changes: readonly string[], policy: string | null): string {
  const what = changes.length === 0 ? 'Control Room settings changed' : `The user changed session settings: ${changes.join('; ')}`
  const body = policy === null ? 'No Control Room policies apply any more; disregard the Control Room sections of your system prompt.' : `These Control Room policies apply from now on and take precedence over the Control Room sections of your system prompt:
${policy}`
  return `Control Room · ${what}. To keep the prompt cache, your system prompt keeps its earlier Control Room sections until the next fresh context. ${body}`
}

/** Settings changed back to what the (held) system prompt already says: the earlier note no longer applies. */
export function policiesRestoredNotice(changes: readonly string[]): string {
  const what = changes.length === 0 ? 'Control Room settings changed back' : `The user changed session settings: ${changes.join('; ')}`
  return `Control Room · ${what}. The Control Room sections of your system prompt apply again as written; disregard the earlier Control Room note about changed policies.`
}

// ---------------------------------------------------------------------------
// Context Autopilot: mid-turn notice, handoff, continuation.

/** How each of Control Room's own prompts begins: a turn is recognised as one of them by its text alone. */
const OWN_PROMPT = {
  handoff: 'Context Autopilot — final handoff for this context window',
  retry: 'Control Room could not find an updated',
  continuation: 'Context Autopilot continuation (session ',
  wake: 'Project Sentinel watcher wake (',
  resume: 'Project Sentinel fresh resume (session ',
  queued: 'Mission Queue · ',
  answer: 'Decision Inbox · ',
  park: 'Project Sentinel · park the run (',
} as const

export type OwnPromptKind = keyof typeof OWN_PROMPT

/**
 * How Claude Code frames a prompt a plugin submits, ahead of its text: "The project-sentinel plugin
 * sent a message:" and a line break (seen live on 2.1.293, in the terminal and on Desktop).
 */
const PLUGIN_FRAME = /^The [^\n]{1,120} plugin sent a message:[ \t]*/

/**
 * Which of Control Room's own prompts a turn began with, if any. Read from
 * the text alone, so it holds across a reload of the plugin and is never
 * fooled by a prompt the person queued in between. The engine's frame around
 * a plugin's prompt is looked past: the prompt may start any of the first
 * three lines, so a frame worded otherwise still never stalls a handoff.
 */
export function ownPromptKind(text: string): OwnPromptKind | null {
  for (const line of text.trimStart().split(/\r?\n/, 3)) {
    const t = line.replace(PLUGIN_FRAME, '').trimStart()
    for (const kind of Object.keys(OWN_PROMPT) as OwnPromptKind[]) if (t.startsWith(OWN_PROMPT[kind])) return kind
  }
  return null
}

export function pendingNotice(input: { tokens: number; threshold: number; window: number | undefined }): string {
  const of = input.window ? ` of ${fmt.tokens(input.window)}` : ''
  return [
    `Control Room · Context Autopilot: this context window has reached ${fmt.tokens(input.tokens)} tokens${of} (handoff threshold ${fmt.tokens(input.threshold)}).`,
    'Finish the logical unit of work you are in the middle of and bring it to a clean, consistent state. Do not begin another large task or a new phase of work.',
    'When that unit is complete, end your turn with a brief summary. Control Room will then start the handoff turn (state check, docs, next-session notes) and continue the work in a fresh context.',
  ].join(' ')
}

export function pendingPromptReminder(): string {
  return 'Control Room · Context Autopilot is in HANDOFF PENDING: handle this request, keep the work in a clean, consistent state, and do not start other large tasks. A handoff and fresh-context continuation will follow.'
}

/**
 * The handoff turn's prompt. The work is left in four places, each for what
 * it is for: the run's milestones (Control Room's run state, which the fresh
 * context is handed), the project's own documentation, CLAUDE.md (durable
 * instructions only) and the handoff notes. Their contents are Claude's to
 * decide; the prompt only says where each kind of knowledge belongs.
 */
export function handoffPrompt(input: {
  tokens: number | undefined
  window: number | undefined
  handoffFile: string
  runNumber: number | null
  sessionNumber: number
  /** Where the run's milestones are kept: Control Room's milestones tool by name, Claude Code's task list, or null for none. */
  planTool?: string | null
  /** How long the handoff waits for finite background work before it goes on and leaves it running (0: never). */
  waitMinutes?: number
  /** Completed milestones whose verification went stale (features/evidence.ts staleText), or null. */
  stale?: string | null
}): string {
  const wait = input.waitMinutes ?? 20
  const used = input.tokens === undefined ? '' : ` (${fmt.tokens(input.tokens)}${input.window ? ` of ${fmt.tokens(input.window)}` : ''} tokens used)`
  const where = input.runNumber === null ? '' : ` — run #${input.runNumber}, session ${input.sessionNumber}`
  const tool = input.planTool ?? null
  const runState =
    tool === null
      ? []
      : [
          `   - The run's milestones, first: the canonical record of progress, which Control Room hands to the fresh context. Send the whole list with ${tool.startsWith('mcp__') ? `\`${tool}\`` : tool}: each milestone verified as completed, the one under way in_progress${tool.startsWith('mcp__') ? ' (or verifying, with its evidence), anything blocked with its blocker' : ''}, the rest pending.`,
        ]
  return [
    `${OWN_PROMPT.handoff}${used}${where}.`,
    '',
    'This context will be cleared after this turn and a fresh session will continue the work, with no memory of this conversation beyond what you leave behind. Before that:',
    '',
    '1. Verify the current state of the work: what is done, what is in progress, what is broken or unverified. Run the sensible minimum validation for what changed recently (targeted, within the active resource policy), so what you leave states verified facts.',
    '2. Leave what the fresh session needs in these places, each for what it is for:',
    ...runState,
    "   - The project's own documentation (README, docs, changelog, plans it already keeps): update it where the work changed what it says, with important unfinished work and open decisions where the project records them.",
    '   - CLAUDE.md: only for durable instructions or invariants every future session must follow. Never use it as a progress log.',
    `   - \`${input.handoffFile}\` at the project root: the prompt you would want to receive to continue this work effectively. You decide its contents from the project and its documentation.`,
    '',
    ...(input.stale === undefined || input.stale === null ? [] : [`${input.stale} If you cannot rerun them in this turn, say in the notes that their verification is stale.`, '']),
    'Do not start new feature work in this turn. When the handoff is written, end your turn with a short summary.',
    'Background work keeps running across the clear, and the fresh context is told what still runs. A server or watcher you started (a dev or preview server, a --watch) is never waited for: name it in the notes (what it serves, its port, its task id) so the fresh session reuses it instead of starting another.',
    wait > 0
      ? `Finite work still running when you end the turn (a build, a render, a test run): leave it running and say so in the notes. The fresh context starts after it finishes and you have recorded its result, or after ${wait} minutes at most; then it keeps running and its result reaches the fresh session instead.`
      : 'Finite work still running when you end the turn (a build, a render, a test run): leave it running and say so in the notes; the fresh context starts at once and its result reaches the fresh session instead.',
  ].join('\n')
}

/**
 * What a fresh context is told of the background work the old one left running (Claude Code keeps it
 * across the clear and reports each task's end to the fresh context: seen live). Null with none.
 */
export function leftRunningText(tasks: readonly { id: string; description: string; class?: string }[]): string | null {
  if (tasks.length === 0) return null
  const services = tasks.filter(t => t.class === 'persistent')
  const work = tasks.filter(t => t.class !== 'persistent')
  const list = (ts: readonly { id: string; description: string }[]) => ts.map(t => `${t.description} (task ${t.id})`).join('; ')
  const parts: string[] = []
  if (services.length > 0) parts.push(`Still running from the previous context: ${list(services)}. ${services.length === 1 ? 'It is a long-running service' : 'They are long-running services'}: reuse ${services.length === 1 ? 'it' : 'them'}, and do not start another on the same port; stop ${services.length === 1 ? 'it' : 'them'} (TaskStop) only when no longer needed.`)
  if (work.length > 0) parts.push(`Still running from the previous context, not waited for: ${list(work)}. ${work.length === 1 ? 'Its result arrives' : 'Their results arrive'} here as a task notification; when ${work.length === 1 ? 'it does' : 'each does'}, record the outcome in the handoff notes and the milestones.`)
  return parts.join(' ')
}

/** After a handoff that compacted instead of clearing: the same word on what still runs, as a note with the first prompt. */
export function leftRunningNote(tasks: readonly { id: string; description: string; class?: string }[]): string | null {
  const text = leftRunningText(tasks)
  return text === null ? null : `Control Room · Context Autopilot: ${text}`
}

/**
 * Rides a background task's notification while a written handoff waits for background work (as the
 * prompt's context): Claude records the result where the fresh session looks, then ends its turn.
 */
export function backgroundResultNote(input: { handoffFile: string; planTool: string | null; left: readonly string[] }): string {
  const plan = input.planTool === null ? '' : ` and the milestones (${input.planTool.startsWith('mcp__') ? `\`${input.planTool}\`` : input.planTool})`
  const after =
    input.left.length === 0
      ? 'The context is cleared after this turn and a fresh session continues from the notes.'
      : `${input.left.length === 1 ? 'Other background work is' : `${input.left.length} other background tasks are`} still running (${input.left.slice(0, 3).join('; ')}): the context is cleared after the last of it finishes and you have recorded it.`
  return `Control Room · Context Autopilot: the handoff is waiting for this background work. Record its outcome where the fresh session will look (\`${input.handoffFile}\` at the project root${plan}), without starting new work, then end your turn. ${after}`
}

export function handoffRetryPrompt(handoffFile: string): string {
  return `${OWN_PROMPT.retry} \`${handoffFile}\` at the project root. The context will be cleared next, so this file is the fresh session's only link to this work: create or update it now (at the project root), then end your turn.`
}

export function continuationContext(input: {
  runNumber: number | null
  sessionNumber: number
  handoffPath: string
  policies: string[]
  /** The run's milestones as the previous context left its task list. */
  milestones?: readonly { subject: string; status: string; detail?: string | null }[]
  /** The run's objective as Claude stated it, kept across contexts. */
  objective?: string | null
  /** Why the previous context was cleared, when it was not a handoff ("for a watcher's fresh wake"). */
  cause?: string
  /** Background work the old context left running (servers, work not waited for). */
  leftRunning?: readonly { id: string; description: string; class?: string }[]
  /** Completed milestones whose verification went stale (features/evidence.ts staleText), or null. */
  stale?: string | null
}): string {
  const run = input.runNumber === null ? '' : ` (Control Room run #${input.runNumber}, session ${input.sessionNumber})`
  const lines = [
    `Control Room · Context Autopilot: this is a fresh context continuing earlier work${run}. The previous context was cleared on purpose ${input.cause ?? 'after a handoff'}.`,
    `The handoff notes are in ${input.handoffPath}. Read them and the project documentation they point to before acting.`,
  ]
  const left = leftRunningText(input.leftRunning ?? [])
  if (left !== null) lines.push(left)
  if (input.stale !== undefined && input.stale !== null) lines.push(input.stale)
  if (input.policies.length > 0) lines.push(`Active Control Room policies remain in force: ${input.policies.join(', ')}.`)
  const milestones = input.milestones ?? []
  const open = milestones.filter(m => m.status !== 'completed')
  if (open.length > 0) {
    const done = milestones.length - open.length
    const tag = (m: { status: string; detail?: string | null }) =>
      m.status === 'completed'
        ? '[done] '
        : m.status === 'in_progress'
          ? '[in progress] '
          : m.status === 'verifying'
            ? '[verifying] '
            : m.status === 'blocked' || m.status === 'waiting'
              ? `[${m.status}${m.detail ? `: ${m.detail}` : ''}] `
              : ''
    const list = milestones.map(m => `${tag(m)}${m.subject}`).join('; ')
    const objective = input.objective ? ` toward the run's objective, "${input.objective}"` : ''
    lines.push(
      `The run's milestones${objective}, ${done} of ${milestones.length} done: ${list}.`,
      'Carry this list on: send it again with your milestones (or your task list) under the same titles and the same objective, the done ones still done, updating only what changes, checked against the handoff notes. Add a milestone only for an outcome not on it; reading the notes or re-checking finished work is part of the milestone it serves, never one of its own.',
    )
  }
  return lines.join(' ')
}

export function continuationPrompt(input: { handoffPath: string; sessionNumber: number }): string {
  return [
    `${OWN_PROMPT.continuation}${input.sessionNumber}). Start by reading \`${input.handoffPath}\` and the project documentation it refers to, then verify the current state of the work.`,
    'Then continue the work autonomously from where the previous session left off.',
    'If the handoff records a decision that genuinely needs the user, ask for it instead of guessing; otherwise keep going.',
  ].join(' ')
}

// ---------------------------------------------------------------------------
// Operations: the Decision Inbox's tool, queued work, answers, watcher wakes, fresh resumes, the budget.

/** The tool Claude is offered for a decision that is the person's to make (Behavior → Decisions). */
export const DECISION_TOOL = {
  name: 'decision_request',
  description: [
    "Leave the user a decision that is genuinely theirs to make, without stopping the work: it waits in their Decision Inbox (Project Sentinel → Needs review), and their answer reaches you with a later message or with tool results.",
    'Use it for a real user-owned choice that need not interrupt them now: which of two approaches or visual directions, whether to delete generated artifacts, whether to publish once CI passes, which experiment configuration to run next.',
    'Do not use it for status updates or progress reports, for choices you can make yourself from the task and the project, or for permission, safety or destructive-action confirmations (Claude Code asks those itself; never route them here).',
    'Set blocking when the current milestone cannot go on without the answer: then finish what you can without it and end your turn with a short summary. Otherwise keep working on what does not depend on it.',
    'Give 2 to 4 short options when the choice is between known alternatives, and allowText when a free-text answer fits.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The decision, as one question ending in a question mark ("Which GPU configuration should S-004 use?").' },
      context: { type: 'string', description: 'Why it matters and what each option means, in a sentence or two.' },
      options: { type: 'array', items: { type: 'string' }, maxItems: 4, description: '2 to 4 short option labels, when the choice is between known alternatives.' },
      allowText: { type: 'boolean', description: 'Whether a free-text answer fits (always true when no options are given).' },
      blocking: { type: 'boolean', description: 'True when the current milestone cannot go on without the answer.' },
      urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
      milestone: { type: 'string', description: 'The milestone the decision belongs to, under its title in your milestones.' },
    },
    required: ['question'],
  },
} as const

/** What the decision tool answers Claude: where the question went and what to do meanwhile. */
export function decisionRecorded(input: { id: string; isBlocking: boolean; isRepeat: boolean }): string {
  const where = `${input.isRepeat ? `Already in the user's Decision Inbox as ${input.id}` : `Recorded as ${input.id} in the user's Decision Inbox`}. Their answer will reach you with a later message (or with tool results while you work).`
  return input.isBlocking
    ? `${where} It blocks the current milestone: finish what you can without it, then end your turn with a short summary; the run waits for the user.`
    : `${where} It does not block: carry on with the work that does not depend on it.`
}

const quoted = (text: string, max = 3000): string => {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** Queued work delivered as a prompt of its own, at a boundary the user chose: their words, in order. */
export function queuedPrompt(items: readonly { id: string; text: string; createdAt: number; when: string }[]): string {
  if (items.length === 1) {
    const q = items[0]!
    return `${OWN_PROMPT.queued}${q.id}, queued by the user at ${fmt.clock(q.createdAt)} for ${q.when.toLowerCase()}. Do this now:\n\n${quoted(q.text)}`
  }
  const list = items.map((q, i) => `${i + 1}. (${q.id}, queued at ${fmt.clock(q.createdAt)})\n${quoted(q.text, 1500)}`).join('\n\n')
  return `${OWN_PROMPT.queued}${items.length} items the user queued for now, in their order. Do them in turn:\n\n${list}`
}

/** Queued work due at a milestone that just completed, mid-turn: with the next batch of tool results. */
export function queuedNote(items: readonly { id: string; text: string; createdAt: number }[]): string {
  const list = items.map(q => `(${q.id}, queued at ${fmt.clock(q.createdAt)}) ${quoted(q.text, 1500)}`).join('\n')
  return [
    `Project Sentinel · Mission Queue: the user queued work for after the milestone you just completed${items.length === 1 ? '' : ' (in their order)'}:`,
    list,
    'Take it up next, before you start the next milestone, unless it depends on work still to be done; then carry on with the plan.',
  ].join('\n')
}

/** Answers from the Decision Inbox: their questions, the user's words. */
const answersText = (items: readonly { id: string; question: string; answer: string; milestone: string | null }[]): string =>
  items.map(d => `${d.id}${d.milestone === null ? '' : ` (milestone "${d.milestone}")`}: ${d.question} → ${quoted(d.answer, 2000)}`).join('\n')

/** Answers delivered as a prompt of their own (the run waited on them). */
export function answersPrompt(items: readonly { id: string; question: string; answer: string; milestone: string | null }[]): string {
  return `${OWN_PROMPT.answer}the user answered ${items.length === 1 ? 'your decision' : `${items.length} of your decisions`}:\n${answersText(items)}\n\nContinue the work with ${items.length === 1 ? 'this answer' : 'these answers'}.`
}

/** Answers delivered with tool results or with a prompt: context, not a turn of their own. */
export function answersNote(items: readonly { id: string; question: string; answer: string; milestone: string | null }[]): string {
  return `Project Sentinel · Decision Inbox: the user answered:\n${answersText(items)}`
}

/** A watcher woke the run in its own context: what it waited for, and to carry on. */
export function wakePrompt(input: { id: string; label: string; armedAt: number; milestone: string | null; lateMs: number; queued: number }): string {
  const late = input.lateMs > 5 * 60_000 ? ` It was due ${fmt.duration(input.lateMs)} ago (Claude Code was not running then).` : ''
  const milestone = input.milestone === null ? '' : ` The milestone under way was "${input.milestone}".`
  const queued = input.queued > 0 ? ` The user queued ${input.queued === 1 ? 'one item' : `${input.queued} items`} meanwhile; it follows when this turn ends.` : ''
  return `${OWN_PROMPT.wake}${input.id}): the run was parked at ${fmt.clock(input.armedAt)} waiting for ${input.label}.${late}${milestone} Check it now and continue the work from where it was parked. If it is not ready yet, say so and mark the milestone waiting again with its blocker; the user can set another watcher.${queued}`
}

/** The first prompt of a fresh context Project Sentinel started outside a handoff: a watcher's fresh wake, or the Cold Resume Guard. */
export function freshResumePrompt(input: { sessionNumber: number; handoffPath: string; why: string; then: string }): string {
  return [
    `${OWN_PROMPT.resume}${input.sessionNumber}): ${input.why}`,
    `Start by reading \`${input.handoffPath}\` and the project documentation it refers to, then verify the current state of the work.`,
    input.then,
    'If something genuinely needs the user, ask for it (the Decision Inbox for a non-urgent choice); otherwise keep going.',
  ].join(' ')
}

/** What a fresh context Project Sentinel started carries beside the run's milestones: the wake, queued work for it, open decisions. */
export function freshExtras(input: {
  why: string | null
  queued: readonly { id: string; text: string; createdAt: number }[]
  decisions: readonly { id: string; question: string; answer: string | null }[]
}): string | null {
  const parts: string[] = []
  if (input.why !== null) parts.push(input.why)
  if (input.queued.length > 0) {
    parts.push(`The user queued this work for the fresh context, in order: ${input.queued.map(q => `(${q.id}, ${fmt.clock(q.createdAt)}) ${quoted(q.text, 1200)}`).join(' · ')}. Take it up after you have read in.`)
  }
  const open = input.decisions.filter(d => d.answer === null)
  const answered = input.decisions.filter(d => d.answer !== null)
  if (answered.length > 0) parts.push(`The user answered earlier decisions: ${answered.map(d => `${d.id}: ${d.question} → ${quoted(d.answer ?? '', 600)}`).join(' · ')}.`)
  if (open.length > 0) parts.push(`Still waiting in the user's Decision Inbox: ${open.map(d => `${d.id}: ${d.question}`).join(' · ')}. Do not ask them again; their answers will come.`)
  return parts.length === 0 ? null : parts.join(' ')
}

/** Before a fresh park: notes first, so the fresh wake has them (the person asked for it). */
export function parkPrompt(input: { id: string; label: string; wakeAt: number; handoffFile: string; planTool: string | null }): string {
  const tool = input.planTool === null ? '' : ` record the run's milestones (${input.planTool.startsWith('mcp__') ? `\`${input.planTool}\`` : input.planTool}), marking the one that waits as waiting with what it waits for, and`
  return `${OWN_PROMPT.park}${input.id}): the user is parking this run until ${fmt.clock(input.wakeAt)}, waiting for ${input.label}, and it will wake in a fresh context. Do not continue the work now. Before the park:${tool} update \`${input.handoffFile}\` at the project root with what the fresh context needs to check ${input.label} and carry on. Then end your turn with one line.`
}

/** The run budget reached, mid-turn: finish the milestone, then stop (Finish the milestone, then pause). */
/** What the person did to agents from Project Sentinel's Operations: Claude Code reports a plugin's TaskStop as Claude's own (seen live). */
export function agentActionsNote(actions: readonly string[]): string {
  return `Project Sentinel · From the Agents panel, the user ${actions.join('; then the user ')}. These were the user's actions, not yours.`
}

export function budgetNote(reached: readonly string[]): string {
  return `Project Sentinel · Run budget reached (${reached.join('; ')}). Finish the milestone you are on and leave the work in a clean, consistent state, then end your turn with a short summary and wait for the user. Do not start the next milestone.`
}

// ---------------------------------------------------------------------------
// Resource Governor notices (mid-turn, via session.append).

export function pressureNotice(input: {
  level: string
  cpu: number | null
  ram: number | null
  cpuCeiling: number
  ramCeiling: number
  backgroundTasks: string[]
}): string {
  const cpu = input.cpu === null ? 'CPU n/a' : `CPU ${Math.round(input.cpu)}% (ceiling ${input.cpuCeiling}%)`
  const ram = input.ram === null ? 'RAM n/a' : `RAM ${Math.round(input.ram)}% (ceiling ${input.ramCeiling}%)`
  const tasks =
    input.backgroundTasks.length === 0
      ? ''
      : ` Background work you started that is still running: ${input.backgroundTasks.join('; ')} — stop what is no longer needed (TaskStop).`
  return `Control Room · Resource pressure ${input.level.toUpperCase()}: ${cpu}, ${ram}. Reduce local load now: let running heavy jobs finish, do not launch additional builds or test suites until pressure drops, and prefer targeted checks.${tasks}`
}

export function pressureRecoveredNotice(input: { cpu: number | null; ram: number | null }): string {
  const cpu = input.cpu === null ? '' : ` CPU ${Math.round(input.cpu)}%`
  const ram = input.ram === null ? '' : ` RAM ${Math.round(input.ram)}%`
  return `Control Room · Resource pressure is back under the ceilings (${`${cpu}${ram}`.trim()}). Normal pacing within the resource policy may resume.`
}

export function resourceLevelChangedNotice(policy: string | null): string {
  return policy === null
    ? 'Control Room · The Resource Governor was turned off by the user: no machine-load ceilings apply any more.'
    : `Control Room · The user changed the resource policy. It applies from now on:\n${policy}`
}

export function heavyCommandRefusal(input: {
  reason: string
  cpu: number | null
  ram: number | null
  running: string[]
}): string {
  const now = [input.cpu === null ? null : `CPU ${Math.round(input.cpu)}%`, input.ram === null ? null : `RAM ${Math.round(input.ram)}%`]
    .filter(Boolean)
    .join(', ')
  const running = input.running.length === 0 ? '' : ` Already running: ${input.running.join('; ')}.`
  return `Control Room Resource Governor: not starting another heavy job now — ${input.reason}${now === '' ? '' : ` (${now})`}.${running} Wait for running work to finish, run a narrower command (targeted tests, one package), or continue with work that does not load the machine.`
}

// ---------------------------------------------------------------------------
// No-Lazy-Exit Guard.

export function guardBlock(input: { reasons: string[]; items: string[]; attempt: number; max: number }): string {
  const items = input.items.length === 0 ? '' : `\nUnfinished items you mentioned:\n${input.items.map(i => `- ${i}`).join('\n')}`
  return [
    `Control Room · No-Lazy-Exit Guard (${input.attempt}/${input.max}): this looks like a premature stop — ${input.reasons.join('; ')}.${items}`,
    'Complete the remaining in-scope, feasible work yourself now (implementation, tests, cleanup, validation) instead of handing it to the user.',
    'If something is genuinely blocked (missing credentials or access, a decision only the user can make, an action outside your permissions), say exactly that and stop. If everything in scope is done and verified, say so plainly and stop.',
  ].join('\n')
}

export const GUARD_CLASSIFIER_LABELS = ['complete', 'blocked', 'needs_user', 'optional_only', 'premature'] as const

export function guardClassifierText(request: string, answer: string): string {
  return [
    'Decide how an AI coding agent ended its turn.',
    'complete = the requested work is done (and verified where feasible).',
    'blocked = a real external blocker stops it (credentials, access, missing resources, permissions).',
    'needs_user = it needs a genuine decision or information only the user has.',
    'optional_only = the work is done; it merely suggests optional extras.',
    'premature = feasible in-scope work (implementation, tests, cleanup, validation) was left for the user or deferred without a real reason.',
    '',
    `USER REQUEST:\n${request}`,
    '',
    `AGENT'S FINAL MESSAGE:\n${answer}`,
  ].join('\n')
}
