/**
 * The model / effort cache guard: what a change of the main conversation's model or effort costs, and whether to
 * ask before it.
 *
 * A prompt cache belongs to one model: a request on another model reads none of the conversation's cache and
 * writes it all again. On most models it also belongs to one effort level; Claude Code's docs name the models
 * that keep their cache across effort changes (Fable 5.1 and later, Opus 5.5, Sonnet 5.5, Haiku 5.5). Thinking
 * settings are not documented either way: they are traced, never guessed.
 *
 * Four layers, each with what it can see (none is enough alone; Desktop's model picker reaches the first only as
 * `source: 'sdk'`, where Claude Code documents no confirmation dialog):
 *   1. `classic.PreModelSwitch`: a /model or picker switch (`command`, `picker`) is confirmed in Claude Code's
 *      own dialog. A set_model switch (`sdk`: Desktop, Remote Control, an IDE) is traced and left to layer 2.
 *   2. `prompt.submit`: the session's model, read again, against the model the warm cache was made on: a large
 *      warm cache on another model is asked about before the message is sent (switchVerdict).
 *   3. `turn.step`, before the request: its own model and effort against the last request's (requestChange).
 *      Nothing is changed (the request is the person's); the change is traced, and a large rebuild is said.
 *   4. Cache Guardian's fingerprint of the answered request: the rebuild's proven cause.
 *
 * Pure: the Runtime and Operations ask; every verdict carries its reason in words for the debug log.
 */

/** A model id as compared: lower case, without the `[1m]` window suffix Claude Code adds to a session's model. */
export function normalizeModel(id: string): string {
  return id.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
}

const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const
type Family = (typeof FAMILIES)[number]

function familyOf(id: string): Family | null {
  const m = normalizeModel(id)
  return FAMILIES.find(f => m.includes(f)) ?? null
}

/** An alias names a family, not a version (`opus`, `sonnet[1m]`, `default`). */
function isAlias(id: string): boolean {
  const m = normalizeModel(id)
  return m === 'default' || (FAMILIES as readonly string[]).includes(m) || m === 'opusplan' || m === 'best'
}

/**
 * Two model ids compared: `same`, `different`, or `inconclusive` when one is only an alias of the other's family
 * (an alias names no version, so the cache may or may not be the same: never asked on).
 */
export function compareModels(a: string, b: string): 'same' | 'different' | 'inconclusive' {
  const x = normalizeModel(a)
  const y = normalizeModel(b)
  if (x === '' || y === '') return 'inconclusive'
  if (x === y) return 'same'
  if (isAlias(x) || isAlias(y)) {
    const fx = familyOf(x)
    const fy = familyOf(y)
    return fx !== null && fy !== null && fx !== fy ? 'different' : 'inconclusive'
  }
  return 'different'
}

export function sameModel(a: string, b: string): boolean {
  return compareModels(a, b) === 'same'
}

/** The version a model id names (`claude-opus-5-5` → [5, 5]), or null. */
function versionOf(id: string): [number, number] | null {
  const m = /(haiku|sonnet|opus|fable)-(\d+)(?:-(\d{1,2}))?(?:-|$|\b)/.exec(normalizeModel(id))
  if (m === null) return null
  return [Number(m[2]), m[3] === undefined ? 0 : Number(m[3])]
}

/**
 * Whether changing effort rebuilds this model's cache: `no` where Claude Code's docs say it keeps the cache,
 * `yes` where this machine saw it rebuild, `likely` otherwise (the docs: most models keep a cache per effort level).
 */
export function effortRebuilds(model: string, learned: boolean): 'yes' | 'no' | 'likely' {
  if (learned) return 'yes'
  const family = familyOf(model)
  const v = versionOf(model)
  if (family === null || v === null) return 'likely'
  const atLeast = (major: number, minor: number) => v[0] > major || (v[0] === major && v[1] >= minor)
  if (family === 'fable' && atLeast(5, 1)) return 'no'
  if ((family === 'opus' || family === 'sonnet' || family === 'haiku') && atLeast(5, 5)) return 'no'
  return 'likely'
}

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

export type RequestChange = {
  cause: 'model' | 'effort'
  /** Whether the cache is rebuilt by it: a model change always; an effort change by the model (effortRebuilds). */
  rebuilds: 'yes' | 'no' | 'likely'
  /** True when it is worth saying: a warm cache at least `threshold` tokens rebuilt. */
  isCostly: boolean
  line: string
}

/** Layer 3: the request about to go, against the last one of this context. Null when neither model nor effort changed. */
export function requestChange(input: {
  last: { model: string; effort: string | null }
  model: string
  effort: string | null
  cachedTokens: number
  isWarm: boolean
  /** This machine saw an effort change rebuild the cache on the last request's model. */
  isEffortLearned: boolean
  threshold: number
}): RequestChange | null {
  const size = `${k(input.cachedTokens)}-token cache (${input.isWarm ? 'warm' : 'not warm'})`
  if (compareModels(input.last.model, input.model) === 'different') {
    const effortToo = input.last.effort !== input.effort ? `, effort ${input.last.effort ?? 'none'} → ${input.effort ?? 'none'} too` : ''
    return {
      cause: 'model',
      rebuilds: 'yes',
      isCostly: input.isWarm && input.cachedTokens >= input.threshold,
      line: `the request goes to ${input.model}, the last went to ${input.last.model}${effortToo}: a prompt cache belongs to one model, so the ${size} is written again`,
    }
  }
  if (input.last.effort === input.effort) return null
  const rebuilds = effortRebuilds(input.model, input.isEffortLearned)
  const why =
    rebuilds === 'no'
      ? 'Claude Code documents that this model keeps its cache across effort levels'
      : rebuilds === 'yes'
        ? `an effort change rebuilt this model's cache before on this machine, so the ${size} is likely written again`
        : `most models keep one cache per effort level, so the ${size} may be written again`
  return {
    cause: 'effort',
    rebuilds,
    isCostly: rebuilds !== 'no' && input.isWarm && input.cachedTokens >= input.threshold,
    line: `effort ${input.last.effort ?? 'none'} → ${input.effort ?? 'none'} on ${input.model}: ${why}`,
  }
}

export type SwitchVerdict = { isArmed: true; from: string; to: string; line: string } | { isArmed: false; line: string }

/**
 * Layer 2, at a message the person sends: is the session now on another model than the one the warm cache was
 * made on? Armed only when a large warm cache would be rebuilt and nobody confirmed the switch yet.
 */
export function switchVerdict(input: {
  isOn: boolean
  /** The model the next request names (the session's, read again). */
  sessionModel: string
  /** The model the cache was made on (the last main request answered in this context), or null. */
  cacheModel: string | null
  cachedTokens: number
  isWarm: boolean
  threshold: number
  /** A switch the person already confirmed (Claude Code's dialog, or this guard's "Send anyway"). */
  confirmed: { from: string; to: string } | null
}): SwitchVerdict {
  const off = (line: string): SwitchVerdict => ({ isArmed: false, line })
  if (!input.isOn) return off('did not arm: the model switch guard is off (Context → Cache)')
  if (input.cacheModel === null) return off('did not arm: no request in this context yet, so no cache to protect')
  if (input.sessionModel === '') return off('unavailable: Claude Code did not say the session model')
  const cmp = compareModels(input.cacheModel, input.sessionModel)
  if (cmp === 'same') return off(`did not arm: the session is still on ${input.cacheModel}, the cache's model`)
  if (cmp === 'inconclusive') return off(`inconclusive: the session model ${input.sessionModel} and the cache's ${input.cacheModel} may be the same version; not asked`)
  if (input.confirmed !== null && sameModel(input.confirmed.from, input.cacheModel) && sameModel(input.confirmed.to, input.sessionModel)) {
    return off(`did not arm: the switch ${input.cacheModel} → ${input.sessionModel} was already confirmed`)
  }
  if (!input.isWarm) return off(`did not arm for the switch: the cache on ${input.cacheModel} is not warm (the Cold Resume Guard covers a lapsed cache)`)
  if (input.cachedTokens < input.threshold) return off(`did not arm: the switch ${input.cacheModel} → ${input.sessionModel} re-sends ${k(input.cachedTokens)} tokens, under ${k(input.threshold)}`)
  return {
    isArmed: true,
    from: input.cacheModel,
    to: input.sessionModel,
    line: `armed: the session switched ${input.cacheModel} → ${input.sessionModel} while a ${k(input.cachedTokens)}-token cache is warm on ${input.cacheModel}`,
  }
}
