/**
 * The prompt cache, as Project Sentinel can know it: from what the engine
 * reports about each main-thread request (tokens read from the cache,
 * written to it, sent uncached) and the events around it.
 *
 * Claude Code reports no expiry, hit ratio or miss cause to a plugin. Each is
 * derived here from reported figures, and named as derived where it is shown:
 * the expiry is the last request's time plus the TTL; the TTL is the engine's
 * own (a model switch reports it), or observed (a request after more than
 * five idle minutes that still read the cache proves the one-hour TTL); a
 * rebuild is a request that read noticeably less than the one before it sent
 * (re-sending at least 4,096 tokens and 5% of that prompt); its cause the
 * change seen before it, with how sure that is: proven (the engine reported it,
 * or the request itself shows it), likely (a change Project Sentinel saw that
 * usually rebuilds), or unknown. Nothing is blamed on the server without
 * evidence.
 *
 * Keep warm refreshes the cache before it lapses by re-sending the last
 * request (a fork, which the transcript never sees). Every refresh is a
 * record: sent, then HIT or MISS by what the fork read, then checked against
 * the main conversation's next request. A hit after the expiry the refresh
 * replaced proves it (VERIFIED); a rebuild before the refreshed expiry with
 * nothing changed proves it failed (FAILED), and Keep warm pauses itself.
 *
 * Pure: the Runtime supplies times and figures and performs the fork.
 */

export type TtlValue = '5m' | '1h'
/**
 * Where the lifetime came from: Claude Code reported it (a model switch), Claude Code is configured
 * to use it (an environment variable or the `promptCacheTtl` setting), Keep warm's probe or a
 * request's gap proved it, an earlier session learned it (a hint), or the plan's default (a hint):
 * Claude Code gives a claude.ai plan's main conversation the one-hour cache unless a setting or an
 * environment variable says otherwise, and the session reports the plan's rate-limit windows.
 */
export type TtlSource = 'engine' | 'config' | 'observed' | 'probe' | 'stored' | 'plan'

/** A lifetime that is only a hint: what this context observes corrects it. */
export const isTtlHint = (source: TtlSource | undefined): boolean => source === 'stored' || source === 'plan'

export const TTL_MS: Record<TtlValue, number> = { '5m': 300_000, '1h': 3_600_000 }

/**
 * The Cold Resume Guard's price in words: an estimate, and a floor (the re-read also sends what is
 * new, and Claude Code's estimate leaves out the answer; seen live: its $0.36 cost $0.52). Null with
 * no price from Claude Code. `sentence` follows the token count in the question; `short` is the
 * Cache card's line.
 */
export function coldCostWords(cold: { usd: number | null; priceNote: string | null }): { sentence: string; short: string } | null {
  if (cold.usd === null || !Number.isFinite(cold.usd)) return null
  const usd = `~${cold.usd < 0.01 ? '$0.01' : `$${cold.usd.toFixed(2)}`}`
  const note = cold.priceNote
  if (note !== null && note.startsWith('at ')) return { sentence: `At ${note.slice(3)}, that is at least ${usd}.`, short: `At least ${usd} to re-cache, ${note}` }
  return { sentence: `Claude Code currently estimates at least ${usd}.`, short: `At least ${usd} to re-cache: Claude Code's own estimate` }
}

/** What Claude Code's environment and settings say of the main conversation's cache lifetime, as read. */
export type TtlConfig = { force5m?: string; envTtl?: string; setting?: unknown; enable1h?: string }

/** An environment variable Claude Code reads as on. */
const isEnvOn = (v: string | undefined): boolean => v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())

/**
 * The lifetime Claude Code is configured to give the main conversation, by its own precedence
 * (2.1.295): `FORCE_PROMPT_CACHING_5M`, then `CLAUDE_CODE_PROMPT_CACHE_TTL`, then the
 * `promptCacheTtl` setting, then `ENABLE_PROMPT_CACHING_1H`. Null where none is set: the
 * account's default applies (the plan's hint).
 */
export function configuredTtl(c: TtlConfig): TtlValue | null {
  if (isEnvOn(c.force5m)) return '5m'
  const env = c.envTtl?.trim()
  if (env === '5m' || env === '1h') return env
  if (c.setting === '5m' || c.setting === '1h') return c.setting
  return isEnvOn(c.enable1h) ? '1h' : null
}

/** Below this, a request's prompt is not worth calling a miss over (and may sit under the model's cache minimum). */
export const MIN_PREFIX = 4096

/** A request that re-sends less than this share of the prompt before it (and under MIN_PREFIX tokens) read the cache. */
const REBUILD_SHARE = 0.05

/** A rebuild that read less than this share of the prompt before it rebuilt nearly all of it. */
const FULL_SHARE = 0.15

/**
 * With the five-minute cache a refresh goes every four minutes. Each reads
 * the prompt at a tenth of the input price, and a rebuild costs about 1.15×
 * more than a read (a 1.25× write instead of a 0.1× read), so past about
 * eleven refreshes keeping it warm costs more than letting it lapse.
 */
export const FIVE_MINUTE_IDLE_CAP_MS = 45 * 60_000

/**
 * Changes Project Sentinel can see that rebuild the cache on the next request. `history`: Claude
 * Code reported that the conversation's earlier part no longer matched what the API had cached (it
 * dropped the thinking made over it: a `thinking_drop`, read at `session.append`).
 */
export type CacheChange = 'compact' | 'model' | 'policy' | 'style' | 'tools' | 'effort' | 'history'

/**
 * Who made a change: the person, or the engine itself. `router` is only ever read back from a record kept by
 * 1.7 (its model router, removed in 1.8: Project Sentinel no longer switches the main conversation's model).
 */
export type ChangeBy = 'person' | 'router' | 'engine'

/** `refresh`: Keep warm refreshed the cache, yet the conversation rebuilt it before the refreshed expiry, with nothing changed. */
export type MissCause = CacheChange | 'expired' | 'refresh' | 'unexplained'

/** Preventable: a change someone made, or idling past the TTL. Lifecycle: expected. Unavoidable: no cause Project Sentinel can show. */
export type MissKind = 'preventable' | 'lifecycle' | 'unavoidable'

/** How sure the cause is: the engine or the request itself shows it; a change seen that usually rebuilds; nothing seen. */
export type Certainty = 'proven' | 'likely' | 'unknown'

export type CacheMiss = {
  at: number
  cause: MissCause
  kind: MissKind
  severity: 'info' | 'warn'
  certainty: Certainty
  /** Tokens the request had to write afresh that the one before it had cached. */
  recached: number
  /** The prompt the request before sent (what should have been found). */
  prefix: number
  read: number
  /** It read part of the prompt (at least FULL_SHARE of it): something changed part-way, not at the start. */
  isPartial: boolean
  /** Time since the request before. */
  gapMs: number
  /** What happened, in a few words ("Model changed: opus → sonnet"). */
  detail: string
  /** True when it was a Keep warm refresh that missed. */
  isRefresh: boolean
  /** True when it was Keep warm's one probe, sent to learn the lifetime: its miss is the price of learning. */
  isProbe?: boolean
  /** Who made the change behind it, when one was seen. */
  by?: ChangeBy
}

export type CacheEvent = { cause: CacheChange; at: number; detail: string; by?: ChangeBy }

/**
 * What a request's prompt was made of, as far as Project Sentinel can see it: the things the cache
 * keys on that change between requests. Fingerprints only (core/hash.ts), never text.
 */
export type CacheFingerprint = {
  model: string | null
  effort: string | null
  /** The tools offered, by name, as the turn began. */
  tools: string | null
  /** Project Sentinel's own section of the system prompt as it was sent. */
  policy: string | null
  /** The person's Claude Code output style (its name), or null for the default. */
  style: string | null
}

const FINGERPRINT_LABEL: Record<keyof CacheFingerprint, string> = { model: 'model', effort: 'effort', tools: 'tools offered', policy: 'Project Sentinel policies', style: 'output style' }

/** What differs between two fingerprints, in words ("model, tools offered"); a part unknown on either side is not compared. */
export function fingerprintChanges(before: CacheFingerprint | null, after: CacheFingerprint | null): string[] {
  if (before === null || after === null) return []
  return (Object.keys(FINGERPRINT_LABEL) as (keyof CacheFingerprint)[])
    .filter(k => before[k] !== null && after[k] !== null && before[k] !== after[k])
    .map(k => FINGERPRINT_LABEL[k])
}

/**
 * One Keep warm refresh, from the fork to the main conversation's next request:
 *   sent → hit (the fork read the conversation's prompt) or missed → awaiting the next request →
 *   verified (a hit after the expiry it replaced: it kept the cache alive),
 *   consistent (a hit before that expiry: the conversation reused the refreshed prompt, no proof yet),
 *   failed (a rebuild before the refreshed expiry with nothing changed),
 *   untested (the request changed something, or came after the refreshed expiry too),
 *   renewed (a later refresh took over before any request came).
 */
export type RefreshStatus = 'sent' | 'hit' | 'missed' | 'awaiting' | 'verified' | 'consistent' | 'failed' | 'untested' | 'renewed'

export type RefreshPhase = 'before-old-expiry' | 'after-old-expiry' | 'after-new-expiry'

export type RefreshRecord = {
  /** When the fork went out. */
  at: number
  /** When it was planned for (its timer). */
  plannedAt: number | null
  ttl: TtlValue | null
  /** The expiry before this refresh: the last request plus the TTL. */
  oldExpiry: number | null
  /** The prompt the next request should find cached: the last request's. */
  expected: number
  read: number
  written: number
  input: number
  isProbe: boolean
  /** The fork read the conversation's prompt from the cache. */
  isHit: boolean
  /** When the cache lapses now, if the fork hit. */
  newExpiry: number | null
  /** The last request's fingerprint: what the fork re-sent. */
  fingerprint: CacheFingerprint | null
  status: RefreshStatus
  /** The main conversation's first request after it. */
  main: { at: number; read: number; written: number; input: number; phase: RefreshPhase; changed: string[] } | null
  /** Why it is untested or failed, in words. */
  note: string | null
}

export type KeepWarmState = {
  refreshes: number
  lastAt: number | null
  lastRead: number | null
  lastHit: boolean | null
  /** Whether a refresh has been seen to carry the cache past its old expiry. */
  verified: 'unknown' | 'yes' | 'no'
  /** The expiry a refresh replaced: the first request after it proves (or disproves) the refresh. */
  provingAfter: number | null
  /**
   * The expiry the first refresh since the conversation's last request replaced, while every refresh
   * since read the cache: a read by the conversation after it proves the refreshes held the cache,
   * though the newest refresh may be too recent to prove by itself (seen live: a watcher woke six
   * seconds after the third refresh of a 12-minute hold, and the hold read as unproven).
   */
  chainFrom?: number | null
  /** Refreshes sent before the expiry that still found the cache gone: two and Keep warm stops. */
  failures: number
  /** The refreshes of this context, newest first. */
  log: RefreshRecord[]
  /** Why Keep warm paused itself in this context (a failed verification), in words; null while it runs. */
  pausedReason: string | null
}

export type CacheState = {
  requests: number
  read: number
  written: number
  uncached: number
  /** When the last main-thread request (or refresh) went out. */
  lastRequestAt: number | null
  /** The prompt the last real request sent: what the next request should find cached. */
  lastPrefix: number
  model: string | null
  effort: string | null
  /** The last real request's fingerprint. */
  fingerprint: CacheFingerprint | null
  ttl: { value: TtlValue; source: TtlSource } | null
  /** Newest first, at most MISSES_KEPT. */
  misses: CacheMiss[]
  /** Changes seen since the last request, which may rebuild the cache on the next one. */
  pending: CacheEvent[]
  keepWarm: KeepWarmState
}

const MISSES_KEPT = 20
const REFRESHES_KEPT = 12

export const emptyKeepWarm = (verified: KeepWarmState['verified'] = 'unknown'): KeepWarmState => ({
  refreshes: 0,
  lastAt: null,
  lastRead: null,
  lastHit: null,
  verified,
  provingAfter: null,
  chainFrom: null,
  failures: 0,
  log: [],
  pausedReason: null,
})

/** A fresh context's cache: nothing sent yet. What is known across contexts (the TTL, Keep warm's verdict) carries in. */
export function emptyCache(carry?: { ttl?: CacheState['ttl']; verified?: KeepWarmState['verified'] }): CacheState {
  return {
    requests: 0,
    read: 0,
    written: 0,
    uncached: 0,
    lastRequestAt: null,
    lastPrefix: 0,
    model: null,
    effort: null,
    fingerprint: null,
    ttl: carry?.ttl ?? null,
    misses: [],
    pending: [],
    keepWarm: emptyKeepWarm(carry?.verified ?? 'unknown'),
  }
}

/** A change Project Sentinel saw that may rebuild the cache on the next request. */
export function noteChange(state: CacheState, event: CacheEvent): CacheState {
  if (state.requests === 0) return state
  return { ...state, pending: [...state.pending.filter(p => p.cause !== event.cause), event].slice(-8) }
}

/** The TTL as the engine reported it (a model switch), which outranks anything observed. */
export function withTtl(state: CacheState, value: TtlValue, source: TtlSource): CacheState {
  const rank: Record<TtlSource, number> = { engine: 4, config: 3, probe: 3, observed: 2, stored: 1, plan: 0 }
  if (state.ttl !== null && state.ttl.value === value && rank[state.ttl.source] >= rank[source]) return state
  if (state.ttl !== null && rank[state.ttl.source] > rank[source]) return state
  return { ...state, ttl: { value, source } }
}

export const ttlMs = (state: CacheState): number | null => (state.ttl === null ? null : TTL_MS[state.ttl.value])

/** When the cache lapses: the last request plus the TTL; null while either is unknown. */
export function expiresAt(state: CacheState): number | null {
  const ms = ttlMs(state)
  return ms === null || state.lastRequestAt === null ? null : state.lastRequestAt + ms
}

export type Warmth = 'none' | 'warm' | 'cold' | 'unknown'

/**
 * Warm until the expiry. With the TTL unknown: warm for five minutes (every TTL lasts that long),
 * and for as long as a turn is running (`isInUse`): a long tool call sends no requests, but nothing
 * says the cache is gone, and the next request finds it on the one-hour cache; unknown after.
 */
export function warmthOf(state: CacheState, now: number, isInUse = false): Warmth {
  if (state.lastRequestAt === null || state.lastPrefix < MIN_PREFIX) return 'none'
  const at = expiresAt(state)
  if (at !== null) return now < at ? 'warm' : 'cold'
  return isInUse || now - state.lastRequestAt < TTL_MS['5m'] ? 'warm' : 'unknown'
}

/** Share of the prompt tokens served from the cache, over the conversation's requests in this context (Keep warm's refreshes left out). */
export function hitRatio(state: CacheState): number | null {
  const total = state.read + state.written + state.uncached
  return total === 0 ? null : state.read / total
}

/** How long before the expiry a refresh goes: a sixth of the TTL, between one and ten minutes. */
export const leadMs = (ttl: number): number => Math.min(600_000, Math.max(60_000, Math.round(ttl / 6)))

/** Whether a request with this prompt before it (`expected`) and this much read from the cache rebuilt it. */
export function isRebuild(expected: number, read: number): boolean {
  const recached = Math.max(0, expected - read)
  return expected >= MIN_PREFIX && recached >= Math.max(MIN_PREFIX, Math.round(expected * REBUILD_SHARE))
}

const ORDER: readonly CacheChange[] = ['compact', 'history', 'model', 'policy', 'style', 'tools', 'effort']

/** How sure each seen change is to be the cause. */
const CERTAINTY: Record<CacheChange, Certainty> = {
  compact: 'proven',
  history: 'proven',
  model: 'proven',
  policy: 'proven',
  style: 'proven',
  tools: 'likely',
  effort: 'likely',
}

export function durationWords(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`
}

/** Why a miss happened, in kind, severity and certainty, from the change seen before it or the gap. */
function classify(
  state: CacheState,
  gapMs: number,
  recached: number,
  isRefresh: boolean,
  at: number,
): Omit<CacheMiss, 'at' | 'recached' | 'prefix' | 'read' | 'gapMs' | 'isRefresh' | 'isPartial'> {
  const change = ORDER.map(c => state.pending.find(p => p.cause === c)).find(p => p !== undefined)
  // A lifetime remembered from an earlier session, or the plan's default, is a hint, not a fact: the
  // account or a setting may give another one now (an API key, usage over the plan's limit), so only
  // five minutes are sure.
  const isHint = isTtlHint(state.ttl?.source)
  const ttl = isHint ? null : ttlMs(state)
  // A cache known to have lapsed already was not lost to a change made after it.
  const isSurelyExpired = ttl !== null && gapMs > ttl
  if (change !== undefined && (change.cause === 'compact' || change.cause === 'history' || !isSurelyExpired)) {
    const by = change.by === undefined ? {} : { by: change.by }
    if (change.cause === 'compact') return { cause: 'compact', kind: 'lifecycle', severity: 'info', certainty: 'proven', detail: change.detail, ...by }
    // A model switch usually changes the effort too (each model has its own default); Claude Code names both.
    const isEffortToo = change.cause === 'model' && state.pending.some(p => p.cause === 'effort')
    const kind: MissKind = change.cause === 'history' ? 'unavoidable' : 'preventable'
    return { cause: change.cause, kind, severity: recached >= 20_000 ? 'warn' : 'info', certainty: CERTAINTY[change.cause], detail: isEffortToo ? `${change.detail}, effort too` : change.detail, ...by }
  }
  const isExpired = ttl === null ? gapMs > TTL_MS['5m'] : gapMs > ttl
  if (isExpired) {
    return {
      cause: 'expired',
      kind: 'preventable',
      severity: recached >= 50_000 && !isRefresh ? 'warn' : 'info',
      // Past a lifetime Claude Code reported or this context proved: certain. Past five minutes with the lifetime only hinted: likely.
      certainty: ttl === null ? 'likely' : 'proven',
      detail: `Idle ${durationWords(gapMs)}${ttl === null ? '' : `, past the ${state.ttl?.value === '1h' ? '1-hour' : '5-minute'} cache`}`,
    }
  }
  const recent = state.misses.filter(m => m.cause === 'unexplained' && at - m.at < 30 * 60_000).length
  return {
    cause: 'unexplained',
    kind: 'unavoidable',
    severity: recent >= 1 || recached >= 50_000 ? 'warn' : 'info',
    certainty: 'unknown',
    detail: recent >= 1 ? `Again, with nothing Project Sentinel can see changed (${recent + 1} in 30 min)` : 'Nothing Project Sentinel can see changed',
  }
}

export type Observed = {
  state: CacheState
  miss: CacheMiss | null
  /** Keep warm's verdict, when this request settled it. */
  verdict: 'yes' | 'no' | null
}

/** The refresh a request settles: the newest one still waiting for the main conversation. */
function settleRefresh(
  record: RefreshRecord,
  req: { at: number; read: number; written: number; input: number },
  input: { isMiss: boolean; changed: string[]; missDetail: string | null; chainFrom?: number | null },
): RefreshRecord {
  const phase: RefreshPhase =
    record.oldExpiry !== null && req.at <= record.oldExpiry ? 'before-old-expiry' : record.newExpiry !== null && req.at <= record.newExpiry ? 'after-old-expiry' : 'after-new-expiry'
  const main = { at: req.at, read: req.read, written: req.written, input: req.input, phase, changed: input.changed }
  if (!input.isMiss) {
    // Back before this refresh's old expiry, but after the expiry the first of its chain replaced: the chain held it.
    const isChainProof = phase === 'before-old-expiry' && input.chainFrom != null && req.at > input.chainFrom
    return {
      ...record,
      main,
      status: phase === 'after-old-expiry' || isChainProof ? 'verified' : 'consistent',
      note:
        phase === 'after-old-expiry'
          ? 'The conversation read the cache after the expiry this refresh replaced'
          : isChainProof
            ? `The conversation read the cache after ${clockOf(input.chainFrom!)}, when it would have lapsed without Keep warm's refreshes`
            : phase === 'before-old-expiry'
              ? 'The conversation came back before the old expiry and read the cache: no proof yet'
              : 'The conversation read the cache after this refresh’s expiry (a later refresh or a longer lifetime)',
    }
  }
  if (input.changed.length > 0) return { ...record, main, status: 'untested', note: `The request changed: ${input.changed.join(', ')}` }
  if (phase === 'after-new-expiry') return { ...record, main, status: 'untested', note: 'The conversation came back after this refresh’s expiry too' }
  return {
    ...record,
    main,
    status: 'failed',
    note: `Rebuilt ${Math.max(0, record.expected - req.read)} tokens before the refreshed expiry with nothing Project Sentinel can see changed${input.missDetail === null ? '' : ` (${input.missDetail})`}`,
  }
}

/**
 * One main-thread request's usage. `isRefresh` marks a Keep warm fork: it
 * re-sends the last request, so it keeps that request's prompt as the one
 * to find, and its own tail is never cached.
 */
export function observeRequest(
  state: CacheState,
  req: {
    at: number
    input: number
    read: number
    written: number
    model: string | null
    effort: string | null
    isRefresh?: boolean
    isProbe?: boolean
    /** A refresh: when its timer was set for. */
    plannedAt?: number | null
    /**
     * A refresh: when its reply came. Claude Code retries a request that fails to connect, so a refresh
     * sent before the expiry may reach the API after it (seen live: sent during a network outage, it
     * was answered 2 minutes later, after the cache had lapsed): it is in time only if answered in time.
     */
    endAt?: number
    /** A main request: what its prompt was made of. */
    fingerprint?: CacheFingerprint | null
  },
): Observed {
  const isProbe = req.isProbe === true
  const isRefresh = req.isRefresh === true || isProbe
  const prompt = req.input + req.read + req.written
  const gapMs = state.lastRequestAt === null ? 0 : Math.max(0, req.at - state.lastRequestAt)
  let next: CacheState = { ...state }
  // A change of model or effort is itself a change the cache may not survive
  // (unless one was already noted with more to say, such as Claude Code's own report of a switch).
  const isNoted = (cause: CacheChange) => next.pending.some(p => p.cause === cause)
  if (!isRefresh && state.requests > 0 && req.model !== null && state.model !== null && req.model !== state.model && !isNoted('model')) {
    next = noteChange(next, { cause: 'model', at: req.at, detail: `Model changed: ${shortModel(state.model)} → ${shortModel(req.model)}` })
  }
  if (!isRefresh && state.requests > 0 && req.effort !== null && state.effort !== null && req.effort !== state.effort && !isNoted('effort')) {
    next = noteChange(next, { cause: 'effort', at: req.at, detail: `Effort changed: ${state.effort} → ${req.effort}` })
  }
  const expected = state.lastPrefix
  const isComparable = state.requests > 0 && expected >= MIN_PREFIX
  const isMiss = isComparable && isRebuild(expected, req.read)
  let miss: CacheMiss | null = null
  if (isMiss) {
    const recached = Math.max(0, expected - req.read)
    const isPartial = req.read >= expected * FULL_SHARE
    miss = { at: req.at, recached, prefix: expected, read: req.read, isPartial, gapMs, isRefresh, ...classify(next, gapMs, recached, isRefresh, req.at) }
  }
  // What the TTL must be: a hit after more than five idle minutes proves the hour;
  // a lapse between five minutes and the hour, with nothing else to blame, points to five
  // (also against an hour remembered from an earlier session, which this context may not have).
  if (isComparable && !isMiss && gapMs > TTL_MS['5m'] + 15_000) next = withTtl(next, '1h', isProbe ? 'probe' : 'observed')
  const isUnsure = next.ttl === null || isTtlHint(next.ttl.source)
  if (miss !== null && miss.cause === 'expired' && isUnsure && gapMs < TTL_MS['1h']) next = withTtl(next, '5m', isProbe ? 'probe' : 'observed')
  // The probe goes out past five minutes on purpose: finding the cache gone is how it learns the five-minute cache.
  if (miss !== null && isProbe && miss.cause === 'expired') miss = { ...miss, kind: 'lifecycle', severity: 'info', isProbe: true, detail: `Keep warm's probe after ${durationWords(gapMs)}: the cache lasts 5 minutes here` }
  // A refresh timed by a remembered lifetime that turned out wrong did not fail: it was told the wrong expiry.
  const wasTtlWrong = isTtlHint(state.ttl?.source) && next.ttl !== null && state.ttl !== null && next.ttl.value !== state.ttl.value

  let verdict: Observed['verdict'] = null
  let kw: KeepWarmState = { ...next.keepWarm, log: [...next.keepWarm.log] }

  if (!isRefresh) {
    // The main conversation's request settles the newest refresh still waiting for it.
    const waiting = kw.log.findIndex(r => r.status === 'awaiting')
    if (waiting >= 0 && isComparable) {
      const record = kw.log[waiting]!
      // Everything seen to change since the request the fork re-sent: a rebuild after any of it does not test Keep warm.
      const seen = next.pending.map(p => CHANGE_WORD[p.cause])
      const changed = [...new Set([...fingerprintChanges(record.fingerprint, req.fingerprint ?? null), ...seen])]
      const settled = settleRefresh(record, req, { isMiss, changed, missDetail: null, chainFrom: kw.chainFrom ?? null })
      kw.log[waiting] = settled
      if (settled.status === 'verified' && kw.verified !== 'yes') {
        kw.verified = 'yes'
        verdict = 'yes'
      }
      if (settled.status === 'failed') {
        kw.verified = 'no'
        kw.pausedReason = settled.note
        verdict = 'no'
        // The rebuild is Keep warm's failure, whatever else may be behind it: say so, not "unexplained".
        if (miss !== null && miss.cause === 'unexplained') {
          miss = {
            ...miss,
            cause: 'refresh',
            kind: 'unavoidable',
            severity: 'warn',
            certainty: 'unknown',
            detail: `Rebuilt though Keep warm refreshed it at ${clockOf(record.at)}, good until ${record.newExpiry === null ? '?' : clockOf(record.newExpiry)}: cause unknown`,
          }
        }
      }
      kw.provingAfter = null
    }
    // The conversation's own request: the next refresh starts a new chain.
    kw.chainFrom = null
  }

  if (isRefresh) {
    const oldExpiry = expiresAt(state)
    // A hit read the cache, so it was in time; a miss was in time only if it was answered before the expiry.
    const isInTime = oldExpiry !== null && (isMiss ? (req.endAt ?? req.at) : req.at) < oldExpiry
    const isLate = oldExpiry !== null && req.at < oldExpiry && !isInTime
    const ttl = ttlMs(next)
    // Earlier refreshes still waiting are taken over by this one.
    kw.log = kw.log.map(r => (r.status === 'awaiting' ? { ...r, status: 'renewed' as const, note: 'A later refresh took over before the conversation came back' } : r))
    const record: RefreshRecord = {
      at: req.at,
      plannedAt: req.plannedAt ?? null,
      ttl: next.ttl?.value ?? null,
      oldExpiry,
      expected,
      read: req.read,
      written: req.written,
      input: req.input,
      isProbe,
      isHit: !isMiss,
      newExpiry: !isMiss && ttl !== null ? req.at + ttl : null,
      fingerprint: state.fingerprint,
      status: !isMiss ? 'awaiting' : 'missed',
      main: null,
      note: isMiss
        ? isInTime
          ? 'The fork found the cache gone before its expiry'
          : isLate
            ? `Sent before the expiry, answered after it (${durationWords((req.endAt ?? req.at) - req.at)} later: Claude Code retried it): the cache had lapsed, so it tests nothing`
            : 'The fork came after the expiry'
        : null,
    }
    kw.log = [record, ...kw.log].slice(0, REFRESHES_KEPT)
    kw.refreshes += 1
    kw.lastAt = req.at
    kw.lastRead = req.read
    kw.lastHit = !isMiss
    // A refresh that read the cache before it lapsed is what the next request will test.
    if (!isMiss && isInTime && kw.verified !== 'yes') kw.provingAfter = oldExpiry
    // The chain since the conversation's last request: its first refresh's old expiry, while each one read the cache in time.
    kw.chainFrom = !isMiss && isInTime ? (kw.chainFrom ?? oldExpiry) : null
    // A refresh timed by a remembered lifetime that proved wrong: the lifetime is corrected, and the
    // refresh it rebuilt is the test, so one more miss in time is conclusive.
    if (isMiss && wasTtlWrong) kw.failures = Math.max(kw.failures, 1)
    // One sent in time that found the cache gone may be chance; twice is the method.
    else if (isMiss && isInTime && !isProbe) {
      kw.failures += 1
      if (kw.failures >= 2 && kw.verified !== 'yes') {
        kw.verified = 'no'
        kw.pausedReason = 'Two refreshes sent before the expiry found the cache gone'
        verdict = 'no'
      }
    }
  }
  // The conversation's figures count its own requests, as Claude Code's do: a refresh is no request
  // of the conversation (the engine counts it as a touch), and its reads would flatter the hit ratio.
  next = {
    ...next,
    requests: isRefresh ? next.requests : next.requests + 1,
    read: isRefresh ? next.read : next.read + req.read,
    written: isRefresh ? next.written : next.written + req.written,
    uncached: isRefresh ? next.uncached : next.uncached + req.input,
    lastRequestAt: req.at,
    lastPrefix: isRefresh ? state.lastPrefix || prompt : prompt,
    model: isRefresh ? state.model : (req.model ?? state.model),
    effort: isRefresh ? state.effort : (req.effort ?? state.effort),
    fingerprint: isRefresh ? state.fingerprint : (req.fingerprint ?? state.fingerprint),
    pending: isRefresh ? next.pending : [],
    misses: miss === null ? next.misses : [miss, ...next.misses].slice(0, MISSES_KEPT),
    keepWarm: kw,
  }
  return { state: next, miss, verdict }
}

const CHANGE_WORD: Record<CacheChange, string> = {
  compact: 'compacted',
  history: 'earlier conversation',
  model: 'model',
  policy: 'Project Sentinel policies',
  style: 'output style',
  tools: 'tools offered',
  effort: 'effort',
}

const clockOf = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const shortModel = (id: string): string => id.replace(/^claude-/, '').replace(/-\d{8}$/, '')

export type RefreshPlan = { at: number; isProbe: boolean } | { at: null; reason: string }

/**
 * When Keep warm refreshes next, or why it does not: only while it has a
 * chance to matter (the person away, the context worth keeping) and never
 * while the cache is about to be thrown away.
 */
export function nextRefresh(
  state: CacheState,
  input: {
    now: number
    isOn: boolean
    isTurnRunning: boolean
    contextTokens: number
    minTokens: number
    /** When the last turn ended (the person's idle time starts there). */
    idleSince: number | null
    maxIdleMs: number
    /** Why Autopilot makes a refresh pointless now (a handoff about to clear), else null. */
    standDown: string | null
    /**
     * A watcher holds the cache until then (its Keep warm strategy, or Smart's hold): refreshes go on
     * to that time, past the idle limit, and past the five-minute cache's cap when the person chose it.
     */
    holdUntil?: number | null
  },
): RefreshPlan {
  if (!input.isOn) return { at: null, reason: 'Off' }
  if (state.keepWarm.verified === 'no') return { at: null, reason: state.keepWarm.pausedReason === null ? 'Paused: it did not keep the cache warm here' : 'Paused: its last check failed' }
  if (state.lastRequestAt === null || state.lastPrefix < MIN_PREFIX) return { at: null, reason: 'Nothing cached yet' }
  if (input.isTurnRunning) return { at: null, reason: 'Claude is working: its requests keep the cache warm' }
  if (input.standDown !== null) return { at: null, reason: input.standDown }
  if (input.contextTokens < input.minTokens) return { at: null, reason: 'The context is small: starting cold costs little' }
  // The five-minute cache is only worth holding for so long (FIVE_MINUTE_IDLE_CAP_MS).
  const isShortCache = state.ttl?.value === '5m'
  const maxIdleMs = isShortCache ? Math.min(input.maxIdleMs, FIVE_MINUTE_IDLE_CAP_MS) : input.maxIdleMs
  const isCapped = maxIdleMs < input.maxIdleMs
  const hold = input.holdUntil ?? null
  const limitEnd = input.idleSince === null ? null : input.idleSince + maxIdleMs
  const idleEnd = hold === null ? limitEnd : Math.max(limitEnd ?? 0, hold + 60_000)
  const why = isCapped ? ' (past that, refreshing the 5-minute cache costs more than rebuilding it)' : ''
  if (idleEnd !== null && input.now >= idleEnd) return { at: null, reason: hold !== null && idleEnd > (limitEnd ?? 0) ? 'The watcher it held the cache for has woken' : `Paused after ${durationWords(maxIdleMs)} idle${why}` }
  const ttl = ttlMs(state)
  if (ttl === null) {
    // The TTL is unknown: one refresh at six idle minutes tells. A hit means the hour.
    const at = state.lastRequestAt + TTL_MS['5m'] + 60_000
    return input.now > at + 120_000 ? { at: null, reason: 'Waiting to learn the cache lifetime' } : { at: Math.max(input.now, at), isProbe: true }
  }
  const expiry = state.lastRequestAt + ttl
  if (input.now >= expiry) return { at: null, reason: 'The cache lapsed before a refresh' }
  const at = Math.max(input.now, expiry - leadMs(ttl))
  if (idleEnd !== null && at > idleEnd) return { at: null, reason: hold !== null && idleEnd > (limitEnd ?? 0) ? 'Held until the watcher wakes: no refresh is needed before it' : `Paused at the ${durationWords(maxIdleMs)} idle limit${why}` }
  return { at, isProbe: false }
}

/**
 * Keep warm's clocks, as the person reads them (Context → Cache). Two clocks, never mixed:
 *   - the cache's lifetime (TTL): each request or refresh that reads the cache renews it from that moment;
 *   - the idle allowance ("Stop after 3 h"): counts from when the last turn ended, and a refresh never resets it
 *     (only a turn ends it: the next turn's end starts it again).
 * While Claude works the allowance has not started (its requests keep the cache warm). The allowance in force can
 * be shorter than the one asked for (the 5-minute cache's cap) or longer (a watcher holding the cache until it
 * wakes): both are said, with why. Every time is a state or clock reading, never an estimate.
 */
export type KeepWarmTiming = {
  phase: 'off' | 'ready' | 'idle' | 'stopped'
  /** One line: what Keep warm is doing now. */
  headline: string
  requestedMs: number
  effectiveMs: number
  /** Why the allowance in force differs from the one asked for; null when it does not. */
  capWhy: string | null
  idleSince: number | null
  idleForMs: number | null
  /** When Keep warm stops refreshing (the allowance's end, or a watcher's hold past it); null before the idle clock starts. */
  stopsAt: number | null
  leftMs: number | null
  hold: { until: number; label: string | null } | null
  nextRefreshAt: number | null
  /** Why no refresh is planned (the plan's own words), when none is. */
  noRefreshWhy: string | null
  ttl: '5m' | '1h' | null
  ttlSource: string | null
  /** When the cache lapses if nothing reads it again (the last request or refresh plus the lifetime). */
  expiresAt: number | null
  refreshes: number
  lastRefresh: { at: number; status: string } | null
}

export function keepWarmTiming(
  state: CacheState,
  input: {
    now: number
    isOn: boolean
    isTurnRunning: boolean
    idleSince: number | null
    maxIdleMinutes: number
    hold: { until: number; label?: string | null } | null
    plan: RefreshPlan
  },
): KeepWarmTiming {
  const requestedMs = input.maxIdleMinutes * 60_000
  const isShort = state.ttl?.value === '5m'
  const effectiveMs = isShort ? Math.min(requestedMs, FIVE_MINUTE_IDLE_CAP_MS) : requestedMs
  const capWhy = effectiveMs < requestedMs ? `the cache lives 5 minutes: past ${durationWords(effectiveMs)} idle, refreshing it costs more than rebuilding it` : null
  const hold = input.hold === null ? null : { until: input.hold.until, label: input.hold.label ?? null }
  const latest = state.keepWarm.log[0]
  const base = {
    requestedMs,
    effectiveMs,
    capWhy,
    hold,
    ttl: state.ttl?.value ?? null,
    ttlSource: state.ttl?.source ?? null,
    expiresAt: expiresAt(state),
    refreshes: state.keepWarm.refreshes,
    lastRefresh: latest === undefined ? null : { at: latest.at, status: latest.status },
    nextRefreshAt: input.plan.at,
    noRefreshWhy: input.plan.at === null ? input.plan.reason : null,
  }
  const allowance = durationWords(effectiveMs)
  if (!input.isOn) return { ...base, phase: 'off', headline: 'Off: the cache lapses after its lifetime', idleSince: null, idleForMs: null, stopsAt: null, leftMs: null }
  if (input.isTurnRunning || input.idleSince === null) {
    const when = input.isTurnRunning ? 'when this turn finishes' : 'when the next turn finishes'
    return { ...base, phase: 'ready', headline: `Ready: starts ${when}, then holds the cache for up to ${allowance} of idle time. The countdown has not started.`, idleSince: null, idleForMs: null, stopsAt: null, leftMs: null }
  }
  const limitEnd = input.idleSince + effectiveMs
  const stopsAt = hold === null ? limitEnd : Math.max(limitEnd, hold.until + 60_000)
  const idleForMs = Math.max(0, input.now - input.idleSince)
  const leftMs = Math.max(0, stopsAt - input.now)
  const isStopped = state.keepWarm.verified === 'no' || input.now >= stopsAt || (input.plan.at === null && /^Paused/.test(input.plan.reason))
  const stopped = state.keepWarm.verified === 'no' ? (state.keepWarm.pausedReason ?? 'it did not keep the cache warm here') : input.plan.at === null ? input.plan.reason : `the ${allowance} idle allowance ended`
  return {
    ...base,
    phase: isStopped ? 'stopped' : 'idle',
    headline: isStopped ? `Stopped: ${stopped.charAt(0).toLowerCase()}${stopped.slice(1)}` : `Holding the cache: idle ${durationWords(idleForMs)}, ${durationWords(leftMs)} of Keep warm left`,
    idleSince: input.idleSince,
    idleForMs,
    stopsAt,
    leftMs: isStopped ? 0 : leftMs,
  }
}

/** Keep warm starts over (turned on again by the person): its verdict, failures and pause are forgotten. */
export function withVerdictReset(state: CacheState): CacheState {
  return { ...state, keepWarm: { ...state.keepWarm, verified: 'unknown', provingAfter: null, failures: 0, pausedReason: null } }
}

/** The main conversation's verdict on Keep warm in this context, from its newest settled or waiting refresh. */
export type MainVerification = 'none' | 'awaiting' | 'verified' | 'consistent' | 'failed' | 'untested'

export function mainVerification(kw: KeepWarmState): MainVerification {
  const r = kw.log.find(x => x.status !== 'renewed')
  if (r === undefined) return 'none'
  switch (r.status) {
    case 'awaiting':
    case 'hit':
      return 'awaiting'
    case 'verified':
    case 'consistent':
    case 'failed':
    case 'untested':
      return r.status
    default:
      // The fork itself missed: there was nothing for the conversation to verify.
      return 'none'
  }
}

/** What to do about a miss, in one sentence. */
export function adviceFor(miss: CacheMiss, input: { keepWarm: boolean; stablePolicies: boolean }): string {
  switch (miss.cause) {
    case 'expired':
      if (miss.isProbe === true) return 'Expected once: Keep warm learned the lifetime, and from now on refreshes before each expiry.'
      return input.keepWarm
        ? 'Keep warm was paused or idle past its limit; raise the limit if you return later than that.'
        : 'Turn on Keep warm to hold the cache while you are away.'
    case 'model':
      return miss.by === 'router'
        ? 'Project Sentinel 1.7’s model router switched models here; 1.8 never switches the main conversation’s model.'
        : 'Switch models at the start of a fresh context; Project Sentinel asks first when the cache is large.'
    case 'effort':
      return 'Change effort at the start of a fresh context: on this model the change rebuilds the cache.'
    case 'policy':
      return input.stablePolicies
        ? 'A Project Sentinel policy changed the system prompt; it is kept stable while the cache is warm.'
        : 'Turn on Keep policies stable: setting changes then reach Claude as notes, not a new system prompt.'
    case 'style':
      return 'Change the output style at the start of a fresh context.'
    case 'tools':
      return 'Connect MCP servers and plugins before the work starts; a new tool rebuilds the whole cache.'
    case 'compact':
      return 'Expected: compaction always rebuilds the cache.'
    case 'history':
      return 'Something rewrote earlier messages: another plugin adding notes while Claude works, a rewind, or Claude Code clearing old tool results. Project Sentinel no longer does this itself (1.5.0).'
    case 'refresh':
      return 'Keep warm paused itself in this context. Turn it on again to retry; Context → Cache → Keep warm has each refresh and the request that failed it.'
    case 'unexplained':
      return miss.severity === 'warn'
        ? 'Cause unknown. If it repeats, look for another plugin, a hook or a proxy that changes requests, and compare with /cr diagnostics.'
        : 'Cause unknown: no model, effort, tool, policy, style or history change was seen. Nothing to do unless it repeats.'
  }
}

export const CAUSE_LABEL: Record<MissCause, string> = {
  expired: 'Lapsed while idle',
  model: 'Model changed',
  effort: 'Effort changed',
  policy: 'Policies changed',
  style: 'Output style changed',
  tools: 'Tools changed',
  compact: 'Compacted',
  history: 'Earlier conversation changed',
  refresh: 'Keep warm did not hold it',
  unexplained: 'Cause unknown',
}

export const CERTAINTY_WORD: Record<Certainty, string> = { proven: 'Proven', likely: 'Likely', unknown: 'Unknown' }

/**
 * What is remembered across sessions (store `cache.v1`): the TTL learned,
 * Keep warm's verdict, and the models on which a change of effort was seen
 * to rebuild the cache.
 */
export type CacheMemory = {
  v: 1
  ttl: TtlValue | null
  ttlSource: TtlSource | null
  verified: KeepWarmState['verified']
  verifiedAt: number | null
  /** Short model names ("opus-5-5") on which an effort change was followed by a miss. */
  effortRebuilds: string[]
  /**
   * Claude Code's own cache-write price per model, as its estimates gave it (`estimated_cache_write_usd`
   * over `context_tokens`, at a model switch or a resume; the managed `modelPricing` or the list
   * price): the Cold Resume Guard's dollar figure. Never a price of Project Sentinel's own.
   */
  writeRates: WriteRate[]
}

export type WriteRate = { model: string; ttl: TtlValue | null; usdPerMTok: number; pricing: 'configured' | 'catalog'; at: number }

/** How long a remembered price is trusted: prices change rarely, but they do. */
export const WRITE_RATE_MAX_AGE_MS = 30 * 24 * 60 * 60_000

/**
 * The rate Claude Code's estimate implies, kept per model and lifetime (a one-hour cache write costs
 * more than a five-minute one). An estimate priced at an assumed default tier is not kept.
 */
export function withWriteRate(rates: readonly WriteRate[], input: { model: string; ttl: TtlValue | null; usd: number; tokens: number; pricing: string | undefined; at: number }): WriteRate[] {
  if (!Number.isFinite(input.usd) || input.usd <= 0 || !Number.isFinite(input.tokens) || input.tokens < 1000 || input.model === '') return [...rates]
  if (input.pricing !== undefined && input.pricing !== 'configured' && input.pricing !== 'catalog') return [...rates]
  const rate: WriteRate = { model: input.model, ttl: input.ttl, usdPerMTok: (input.usd / input.tokens) * 1_000_000, pricing: input.pricing === 'configured' ? 'configured' : 'catalog', at: input.at }
  return [...rates.filter(r => !(r.model === rate.model && r.ttl === rate.ttl)), rate].slice(-8)
}

/** The price to use for this model and lifetime, if Claude Code gave one lately: one for this lifetime, else one whose lifetime it did not say. */
export function writeRateFor(rates: readonly WriteRate[], model: string, ttl: TtlValue | null, now: number): WriteRate | null {
  const fresh = rates.filter(r => r.model === model && now - r.at <= WRITE_RATE_MAX_AGE_MS)
  return fresh.find(r => r.ttl === ttl && ttl !== null) ?? fresh.find(r => r.ttl === null) ?? (ttl === null ? (fresh.at(-1) ?? null) : null)
}

export function memoryOf(raw: unknown): CacheMemory {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const ttl = r.ttl === '5m' || r.ttl === '1h' ? r.ttl : null
  const src = r.ttlSource === 'engine' || r.ttlSource === 'observed' || r.ttlSource === 'probe' ? r.ttlSource : null
  const verified = r.verified === 'yes' || r.verified === 'no' ? r.verified : 'unknown'
  const rebuilds = Array.isArray(r.effortRebuilds) ? r.effortRebuilds.filter((m): m is string => typeof m === 'string' && m.length > 0 && m.length <= 80).slice(-12) : []
  const rates: WriteRate[] = Array.isArray(r.writeRates)
    ? r.writeRates
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x))
        .filter(x => typeof x.model === 'string' && x.model !== '' && x.model.length <= 120 && typeof x.usdPerMTok === 'number' && Number.isFinite(x.usdPerMTok) && x.usdPerMTok > 0 && typeof x.at === 'number')
        .map((x): WriteRate => ({ model: x.model as string, ttl: x.ttl === '5m' || x.ttl === '1h' ? x.ttl : null, usdPerMTok: x.usdPerMTok as number, pricing: x.pricing === 'configured' ? 'configured' : 'catalog', at: x.at as number }))
        .slice(-8)
    : []
  return { v: 1, ttl, ttlSource: ttl === null ? null : src, verified, verifiedAt: typeof r.verifiedAt === 'number' ? r.verifiedAt : null, effortRebuilds: rebuilds, writeRates: rates }
}
