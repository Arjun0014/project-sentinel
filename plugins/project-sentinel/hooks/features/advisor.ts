/**
 * Advisor: Claude Code's server-side advisor tool, a stronger model the main model consults at key moments.
 *
 * What Claude Code exposes (2.1.325, read from the engine and its docs, never assumed):
 *   - `/advisor <model|off>`: a built-in command (an interactive variant in the terminal; a non-interactive one
 *     in SDK hosts such as Desktop and `-p`). Its argument hint lists the models this account and engine
 *     support (`[fable|opus|sonnet|off]`); it is not listed at all where the advisor is not available.
 *   - `advisorModel`: the user setting the command saves (the `--advisor` flag sets it for one launch only,
 *     unseen by a settings read).
 *   - Activity: a request's `serverToolUses` named `advisor` (the API ran it inside the request).
 *   - It is session-level: subagents inherit it (Claude Code's own pairing check applies to them); there is
 *     no per-subagent advisor, so Project Sentinel offers none. Changing it keeps the cached prefix.
 *
 * Pure: the Runtime reads the engine and feeds these.
 */

/** The models `/advisor`'s argument hint lists (`[fable|opus|sonnet|off]` → fable, opus, sonnet); null when no hint. */
export function modelsFromHint(hint: string | undefined | null): string[] | null {
  if (typeof hint !== 'string') return null
  const inner = hint.trim().replace(/^[[<(]/, '').replace(/[\]>)]$/, '')
  const words = inner
    .split('|')
    .map(w => w.trim().toLowerCase())
    .filter(w => /^[a-z0-9][a-z0-9.\-[\]]*$/.test(w) && w !== 'off' && w !== 'model')
  return words.length === 0 ? null : [...new Set(words)]
}

/** `advisorModel` as stored: a model name, or null for off / unset / not a string. */
export function configuredOf(settings: unknown): string | null {
  if (typeof settings !== 'object' || settings === null) return null
  const v = (settings as Record<string, unknown>).advisorModel
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' || t.toLowerCase() === 'off' ? null : t
}

const TIER: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 }
const tier = (model: string): number | null => {
  const m = model.toLowerCase()
  const f = Object.keys(TIER).find(k => m.includes(k))
  return f === undefined ? null : (TIER[f] ?? null)
}

/**
 * Whether an advisor can advise this main model: Claude Code pairs an advisor only with a main model it ranks at
 * or above. Null when either model names no family Project Sentinel can rank (then nothing is claimed).
 */
export function pairing(advisor: string, main: string): { isPaired: boolean; text: string } | null {
  const a = tier(advisor)
  const m = tier(main)
  if (a === null || m === null) return null
  return a >= m
    ? { isPaired: true, text: `pairs with ${main.replace(/^claude-/, '')}` }
    : { isPaired: false, text: `ranks below the main model (${main.replace(/^claude-/, '')}): Claude Code does not pair it` }
}

export type AdvisorFacts = {
  /** Models `/advisor` lists here, or null when Claude Code lists no advisor command (not available). */
  available: string[] | null
  /** Whether the command list was read at all (false: not looked at yet, or the read failed). */
  isListed: boolean
  configured: string | null
  /** Advisor calls the API ran in this context: in the main conversation, and in subagents. */
  uses: number
  agentUses: number
  lastUsedAt: number | null
  /** The last change Project Sentinel asked Claude Code for, and what came of it. */
  lastSet: { at: number; to: string; outcome: 'applied' | 'not-applied' | 'failed'; detail: string } | null
}

export const noFacts = (): AdvisorFacts => ({ available: null, isListed: false, configured: null, uses: 0, agentUses: 0, lastUsedAt: null, lastSet: null })

/** The advisor in one line: off, which model, whether it was used in this context. */
export function advisorLine(f: AdvisorFacts, mainModel: string): string {
  if (!f.isListed) return 'Not looked at yet'
  if (f.available === null && f.configured === null) return 'Not available in this Claude Code session'
  if (f.configured === null) return 'Off'
  const p = mainModel === '' ? null : pairing(f.configured, mainModel)
  const used = f.uses + f.agentUses === 0 ? 'not used yet in this context' : `used ${f.uses + f.agentUses}× in this context`
  return `${f.configured}${p === null || p.isPaired ? '' : ' (does not pair)'} · ${used}`
}
