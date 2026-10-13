/**
 * Signal from the raw activity: what needs a look (Attention), what the
 * changed files are (grouped, with generated and temporary files apart),
 * what Claude did this turn in a few words, and what it is doing right now.
 *
 * Pure functions over the tracker's records. Nothing here calls a model:
 * every line is counted or read from a tool's own result, so it is cheap and
 * never invented. Where a fact is not knowable (a background command's
 * outcome), the views say so instead of guessing.
 */

import { plural } from '../core/format'
import { relativeTo } from '../core/text'
import type { ActivityItem, ActivityKind, FileChange } from './activity'
import type { Progress } from './plan'
import { VALIDATION_DOING, VALIDATION_LABEL, type ValidationSummary } from './validation'

// ---------------------------------------------------------------------------
// Changed files, grouped

export type ChangeGroup = 'code' | 'tests' | 'docs' | 'config' | 'other' | 'generated'

export const GROUP_LABEL: Record<ChangeGroup, string> = {
  code: 'Code',
  tests: 'Tests',
  docs: 'Docs',
  config: 'Config',
  other: 'Other',
  generated: 'Generated and temporary',
}

/** Real project changes first, in this order; generated and temporary files last and apart. */
export const GROUP_ORDER: readonly ChangeGroup[] = ['code', 'tests', 'docs', 'config', 'other', 'generated']

const TEMP_DIR = /(^|\/)(tmp|temp|\.tmp|scratch|scratchpad|\.cache|node_modules|__pycache__|\.pytest_cache|\.venv|venv|dist|target|coverage|\.next|\.nuxt|\.turbo|bin\/(debug|release)|obj)\//i
const SYSTEM_TEMP = /(^|\/)(appdata\/local\/temp|private\/var\/folders|var\/folders|tmp)\//i
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?|e2e|cypress)\/|[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|exs?)$/i
/** `LordshipTests.cs`, `ParserTest.java`: case matters, so `Contest.cs` is not a test. */
const TEST_CLASS = /[a-z0-9]Tests?\.(cs|java|kt|kts|swift|scala|groovy)$/
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc|txt)$|(^|\/)(docs?|documentation)\//i
const CONFIG_FILE =
  /(^|\/)(\.github|\.vscode|\.devcontainer)\/|(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|jsconfig\.json|\.?eslintrc[^/]*|\.prettierrc[^/]*|\.editorconfig|\.gitignore|\.gitattributes|\.npmrc|\.env\.example|dockerfile|docker-compose[^/]*|makefile|cmakelists\.txt|cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|setup\.(cfg|py)|requirements[^/]*\.txt|gemfile(\.lock)?|[^/]*\.(csproj|sln|props|targets|gradle(\.kts)?)|[^/]*\.config\.(js|cjs|mjs|ts))$|\.(ya?ml|toml|ini|cfg|conf|plist)$/i
const CODE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|fs|php|scala|clj|ex|exs|erl|hs|lua|dart|vue|svelte|astro|sql|sh|bash|zsh|ps1|psm1|r|jl|zig|nim|ml|m|mm|css|scss|less|html|htm|xml|json|graphql|proto|shader|hlsl|glsl|ipynb)$/i

/**
 * Which group a changed file belongs to. Generated and temporary: outside
 * the project, in a temp, cache or build folder, Claude Code's own `.claude`
 * folder, or the handoff notes Context Autopilot asks for.
 */
export function groupOf(path: string, ctx: { root: string; handoffFile: string }): ChangeGroup {
  const abs = path.replace(/\\/g, '/')
  const root = ctx.root.replace(/\\/g, '/').replace(/\/+$/, '')
  const isInside = root !== '' && (abs.toLowerCase() === root.toLowerCase() || abs.toLowerCase().startsWith(`${root.toLowerCase()}/`))
  const rel = isInside ? relativeTo(abs, root) : abs
  const handoff = ctx.handoffFile.replace(/\\/g, '/').replace(/^\.\//, '')
  if (root !== '' && !isInside && /^([a-z]:)?\//i.test(abs)) return 'generated'
  if (SYSTEM_TEMP.test(abs) || TEMP_DIR.test(`/${rel}`) || /(^|\/)\.claude\//i.test(`/${rel}`)) return 'generated'
  if (rel.toLowerCase() === handoff.toLowerCase()) return 'generated'
  if (TEST_FILE.test(rel) || TEST_CLASS.test(rel)) return 'tests'
  if (CONFIG_FILE.test(rel)) return 'config'
  if (DOC_FILE.test(rel)) return 'docs'
  if (CODE_FILE.test(rel)) return 'code'
  return 'other'
}

// ---------------------------------------------------------------------------
// Attention

export type AttentionKind = 'failed' | 'blocked' | 'held' | 'running' | 'slow'

export type Attention = {
  id: string
  kind: AttentionKind
  tool: string
  title: string
  reason: string | null
  /** Failed calls: whether a later attempt of the same thing succeeded. */
  state: 'unresolved' | 'recovered' | null
  attempts: number
  durationMs: number | null
  since: number
  at: number
}

/** A long-running call is worth a look after this; a check or a build takes longer as a rule. */
const RUNNING_AFTER_MS = 20_000
const SLOW_MS: Record<'tool' | 'shell' | 'check', number> = { tool: 45_000, shell: 120_000, check: 600_000 }

/** What a retry of a call would look like: the same tool on the same thing. */
const signatureOf = (i: ActivityItem): string => `${i.kind === 'edit' ? 'edit' : i.tool}\u0000${i.label}`

const slowLimitOf = (i: ActivityItem): number => (i.validation !== null ? SLOW_MS.check : i.kind === 'shell' ? SLOW_MS.shell : SLOW_MS.tool)

/**
 * The calls that need a look, in this order: failures nothing has fixed,
 * refusals, calls held back by the Resource Governor, long-running calls,
 * unusually slow ones, then failures a later attempt recovered from.
 * `items` are the main conversation's calls of one turn, oldest first.
 */
export function attentionOf(items: readonly ActivityItem[], now: number): Attention[] {
  const out: Attention[] = []
  const failures = new Map<string, Attention>()
  for (const i of items) {
    const sig = signatureOf(i)
    const open = failures.get(sig)
    if (i.status === 'ok' && open !== undefined) {
      open.state = 'recovered'
      failures.delete(sig)
    }
    if (i.status === 'error') {
      if (open !== undefined) {
        open.attempts += 1
        open.reason = i.reason ?? open.reason
        open.at = i.endedAt ?? i.startedAt
        continue
      }
      const entry: Attention = { id: i.id, kind: 'failed', tool: i.tool, title: i.label || i.tool, reason: i.reason, state: 'unresolved', attempts: 1, durationMs: null, since: i.startedAt, at: i.endedAt ?? i.startedAt }
      failures.set(sig, entry)
      out.push(entry)
      continue
    }
    if (i.status === 'denied' || i.status === 'held') {
      out.push({ id: i.id, kind: i.status === 'held' ? 'held' : 'blocked', tool: i.tool, title: i.label || i.tool, reason: i.reason, state: null, attempts: 1, durationMs: null, since: i.startedAt, at: i.startedAt })
      continue
    }
    const duration = (i.endedAt ?? now) - i.startedAt
    if (i.status === 'running' && duration >= RUNNING_AFTER_MS) {
      out.push({ id: i.id, kind: 'running', tool: i.tool, title: i.label || i.tool, reason: null, state: null, attempts: 1, durationMs: null, since: i.startedAt, at: i.startedAt })
    } else if (i.status === 'ok' && i.backgroundTaskId === null && duration >= slowLimitOf(i)) {
      out.push({ id: i.id, kind: 'slow', tool: i.tool, title: i.label || i.tool, reason: null, state: null, attempts: 1, durationMs: duration, since: i.startedAt, at: i.startedAt })
    }
  }
  const rank = (a: Attention): number =>
    a.kind === 'failed' ? (a.state === 'unresolved' ? 0 : 5) : a.kind === 'blocked' ? 1 : a.kind === 'held' ? 2 : a.kind === 'running' ? 3 : 4
  return out.sort((a, b) => rank(a) - rank(b) || b.at - a.at)
}

/** Attention that is still open: an unresolved failure, a refusal, a held call. */
export const isOpen = (a: Attention): boolean => (a.kind === 'failed' && a.state === 'unresolved') || a.kind === 'blocked' || a.kind === 'held'

// ---------------------------------------------------------------------------
// What Claude did this turn

const KIND_WORD: Partial<Record<ActivityKind, [string, string]>> = {
  search: ['search', 'searches'],
  web: ['web lookup', 'web lookups'],
  agent: ['subagent', 'subagents'],
  mcp: ['connector call', 'connector calls'],
}

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n}×`)

/**
 * A few plain lines on the turn, from counts alone: what changed, which
 * checks ran and how they ended, how much was read, what went wrong and
 * whether it was fixed, and the milestones finished.
 */
export function turnSummaryOf(input: {
  items: readonly ActivityItem[]
  changed: readonly FileChange[]
  groupOf: (path: string) => ChangeGroup
  validation: readonly ValidationSummary[]
  attention: readonly Attention[]
  milestonesDone: number
}): string[] {
  const lines: string[] = []
  const real = input.changed.filter(c => input.groupOf(c.path) !== 'generated')
  if (real.length > 0) {
    const counts = new Map<ChangeGroup, number>()
    for (const c of real) counts.set(input.groupOf(c.path), (counts.get(input.groupOf(c.path)) ?? 0) + 1)
    const parts = GROUP_ORDER.filter(g => counts.has(g)).map(g => `${counts.get(g)} in ${GROUP_LABEL[g].toLowerCase()}`)
    lines.push(`Changed ${plural(real.length, 'file')}${counts.size > 1 ? ` · ${parts.join(', ')}` : ''}`)
  }
  const checks: string[] = []
  for (const v of input.validation) {
    const ran = input.items.filter(i => i.validation === v.kind).length
    if (ran === 0) continue
    const outcome =
      v.status === 'running' ? 'running now' : v.status === 'failed' ? 'failing' : v.status === 'passed' ? (v.isRecovered ? 'passing after a fix' : 'passing') : v.status === 'background' ? 'in the background' : v.status
    checks.push(`${VALIDATION_LABEL[v.kind].toLowerCase()} ${times(ran)}, ${outcome}`)
  }
  if (checks.length > 0) lines.push(`Ran ${checks.join(' · ')}`)
  const reads = new Set(input.items.filter(i => i.kind === 'read' && i.status === 'ok').map(i => i.label)).size
  const looked: string[] = reads > 0 ? [`Read ${plural(reads, 'file')}`] : []
  for (const [kind, [one, many]] of Object.entries(KIND_WORD) as [ActivityKind, [string, string]][]) {
    const n = input.items.filter(i => i.kind === kind).length
    if (n > 0) looked.push(`${n} ${n === 1 ? one : many}`)
  }
  if (looked.length > 0) lines.push(looked.join(' · '))
  const failed = input.attention.filter(a => a.kind === 'failed')
  const fixed = failed.filter(a => a.state === 'recovered').length
  const open = failed.length - fixed
  const refused = input.attention.filter(a => a.kind === 'blocked' || a.kind === 'held').length
  const trouble: string[] = []
  if (fixed > 0) trouble.push(`${plural(fixed, 'failure')} recovered`)
  if (open > 0) trouble.push(`${open} still failing`)
  if (refused > 0) trouble.push(`${refused} blocked`)
  if (trouble.length > 0) lines.push(trouble.join(' · '))
  if (input.milestonesDone > 0) lines.push(`Finished ${plural(input.milestonesDone, 'milestone')}`)
  return lines
}

// ---------------------------------------------------------------------------
// What Claude is doing right now

const fileOf = (label: string): string => label.split('/').pop() ?? label

const RANK: Partial<Record<ActivityKind, number>> = { shell: 0, agent: 1, web: 2, edit: 3, mcp: 4, read: 5, search: 6, task: 7 }

/** Commands that only set up where or how the next one runs: `cd app && npm run build` is a build, not a cd. */
const SETUP_PROGRAM = /^(cd|chdir|pushd|set-location|sl|export|set|source|\.)$/i
/** An environment setting ahead of a command: `NODE_ENV=production node …`, PowerShell's `$env:DEBUG='1'`. */
const ASSIGNMENT = /^(\$env:)?[A-Za-z_]\w*=/i

const programOf = (word: string): string => word.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? word

/** The words of the command a shell line runs for its work: past a change of directory or an environment setting. */
function workWords(line: string): string[] {
  let first: string[] | null = null
  for (const part of line.split(/&&|\|\||;/)) {
    const words = part.trim().split(/\s+/).filter(w => w !== '')
    while (words.length > 1 && ASSIGNMENT.test(words[0] ?? '')) words.shift()
    if (words.length === 0 || ASSIGNMENT.test(words[0] ?? '')) continue
    first ??= words
    if (!SETUP_PROGRAM.test(programOf(words[0] ?? ''))) return words
  }
  return first ?? []
}

/** A running call in a few words: "Running tests", "Editing renderer.ts", "Searching the code". */
export function doingOf(i: ActivityItem): string {
  if (i.validation !== null) return VALIDATION_DOING[i.validation]
  switch (i.kind) {
    case 'shell': {
      const words = workWords(i.label)
      const program = programOf(words[0] ?? '')
      if (i.heavy.includes('install')) return 'Installing packages'
      if (/^git$/i.test(program)) return `Running git ${words[1] ?? ''}`.trim()
      return program === '' ? 'Running a command' : `Running ${program}`
    }
    case 'edit':
      return `Editing ${fileOf(i.label)}`
    case 'read':
      return `Reading ${fileOf(i.label)}`
    case 'search':
      return 'Searching the code'
    case 'web':
      return 'Looking things up'
    case 'agent':
      return i.label === '' ? 'Running a subagent' : `Subagent: ${i.label}`
    case 'task':
      return 'Updating the plan'
    case 'mcp':
      return `Using ${i.label.split(' · ')[0] ?? 'a connector'}`
    default:
      return `Using ${i.tool}`
  }
}

/**
 * The work line: the milestone in progress in Claude's own words when it
 * named one; else what the running call is doing; else, mid-turn, that it is
 * thinking. Null between turns.
 */
export function nowOf(input: { isTurnRunning: boolean; running: readonly ActivityItem[]; progress: Progress }): { text: string; source: 'plan' | 'tool' | 'thinking' } | null {
  if (!input.isTurnRunning) return null
  const current = input.progress.current
  const check = input.running.find(i => i.validation !== null && i.agentId === null)
  // A check running now says more than the milestone it serves.
  if (check !== undefined) return { text: doingOf(check), source: 'tool' }
  if (current !== null) return { text: current.activeForm ?? current.subject, source: 'plan' }
  const main = [...input.running].filter(i => i.agentId === null).sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9) || a.startedAt - b.startedAt)[0]
  if (main !== undefined) return { text: doingOf(main), source: 'tool' }
  return { text: 'Thinking', source: 'thinking' }
}
