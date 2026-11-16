/**
 * The prompt cache, in Context: how warm it is and for how long, what it
 * holds, Keep warm and the other cache-aware settings, then its health (the
 * recent rebuilds, why each happened and what would have avoided it).
 *
 * Claude Code reports each request's tokens read from the cache and written
 * to it, never an expiry, a hit ratio or a cause: those are derived, and the
 * card says so.
 */

import type { RenderElement } from 'claude-code'

import type { CacheMissView, CacheView, ColdResumeView, Tone } from '../../../types'
import * as fmt from '../../core/format'
import { coldCostWords } from '../../features/cache'
import type { Kit } from '../kit'
import { apart, card, listItem, meterBar, note, pair, row, spaced, stepper, switchControl, textRuns } from '../primitives'
import { ACCENT, G, clockGlyph } from '../theme'

/** The idle limits Keep warm offers, in minutes. */
const IDLE_STEPS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 420, 480] as const

const LIFETIME: Record<string, string> = { '5m': '5-minute', '1h': '1-hour' }

const SOURCE: Record<string, string> = { engine: 'as Claude Code reports it', config: 'as Claude Code is configured', observed: 'observed', probe: 'learned by Keep warm', stored: 'learned earlier', plan: 'the plan’s default' }

/** The cache's state in one line, with the tone it needs. */
export function cacheState(cache: CacheView, now: number): { glyph: string; text: string; tone: Tone; fraction: number | null } {
  switch (cache.warmth) {
    case 'none':
      return { glyph: G.ring, text: 'Nothing cached yet', tone: 'muted', fraction: null }
    case 'cold':
      return { glyph: clockGlyph(0), text: 'Lapsed: the next request rebuilds it', tone: 'muted', fraction: 0 }
    case 'unknown':
      return { glyph: clockGlyph(0), text: 'May have lapsed: its lifetime is not known yet', tone: 'muted', fraction: null }
    case 'warm': {
      if (cache.expiresAt === null || cache.ttl === null) return { glyph: clockGlyph(1), text: 'Warm', tone: 'normal', fraction: 1 }
      const left = Math.max(0, cache.expiresAt - now)
      const ttl = cache.ttl === '1h' ? 3_600_000 : 300_000
      const words = left < 60_000 ? 'within a minute' : `in about ${fmt.minutes(Math.ceil(left / 60_000))}`
      return { glyph: clockGlyph(left / ttl), text: `Warm · lapses ${words}`, tone: 'normal', fraction: left / ttl }
    }
  }
}

/** What Keep warm is doing, in a line: the next refresh, or why there is none. */
export function keepWarmStatus(cache: CacheView): { text: string; tone: Tone } {
  const k = cache.keepWarm
  if (!k.isOn) return { text: 'Refreshes the cache before it lapses while you are away', tone: 'muted' }
  if (k.error !== null) return { text: `Retrying in 2 min: ${k.error}`, tone: 'warn' }
  if (k.isRefreshing) return { text: 'Refreshing now', tone: 'muted' }
  if (k.nextAt !== null) return { text: `Next refresh at ${fmt.clock(k.nextAt)}${k.isProbe ? ', to learn its lifetime' : ''}`, tone: 'muted' }
  return { text: k.reason ?? 'Waiting', tone: k.verified === 'no' ? 'warn' : 'muted' }
}

/** The conversation's check of the newest refresh, as the proof line says it. */
const MAIN_WORD: Record<CacheView['keepWarm']['main'], { text: string; tone: Tone }> = {
  none: { text: 'nothing to verify yet', tone: 'muted' },
  awaiting: { text: 'AWAITING VERIFICATION · the next request tells', tone: 'muted' },
  verified: { text: 'VERIFIED · read after the old expiry', tone: 'good' },
  consistent: { text: 'READ IT · back before the old expiry, no proof yet', tone: 'normal' },
  failed: { text: 'FAILED · rebuilt before the refreshed expiry', tone: 'bad' },
  untested: { text: 'NOT TESTED · something changed first', tone: 'muted' },
}

/**
 * Keep warm's proof, under its switch once it has refreshed: how many refreshes and when the last
 * went, what that fork read (HIT or MISS), and what the conversation's next request showed.
 */
export function keepWarmProof(cache: CacheView): { refreshes: string; fork: { text: string; tone: Tone } | null; main: { text: string; tone: Tone } } | null {
  const k = cache.keepWarm
  if (k.refreshes === 0 && k.log.length === 0) return null
  const last = k.log[0] ?? null
  const refreshes = `${fmt.plural(k.refreshes, 'refresh', 'refreshes')}${last === null ? '' : ` · last ${fmt.clock(last.at)}`}`
  const fork = last === null ? null : { text: `Fork: ${last.isHit ? 'HIT' : 'MISS'} · read ${fmt.tokens(last.read)} · wrote ${fmt.tokens(last.written)}`, tone: (last.isHit ? 'normal' : 'warn') as Tone }
  const main = { ...MAIN_WORD[k.main] }
  const settled = k.log.find(r => r.status !== 'renewed')
  if (k.main === 'untested' && settled?.note) main.text = `NOT TESTED · ${settled.note.replace(/^The request changed: /, 'changed: ')}`
  return { refreshes, fork, main }
}

/** Keep warm's proof as rows: the refreshes, the last fork's reading, the conversation's verdict. */
/**
 * Keep warm's clocks in words (KeepWarmTimingView): ready while Claude works; while idle, how long, how much is
 * left, when it started and stops, the next refresh and when the cache lapses without it; the allowance asked
 * for and the one in force when they differ, and a watcher's hold. Times are readings, never estimates.
 */
export function keepWarmTimingLines(t: CacheView['keepWarm']['timing'], now: number): { key: string; left: string; right?: string; tone?: Tone }[] {
  const at = (ms: number) => fmt.clock(ms)
  // Time gone, to the minute and never more than it is; time left, never less than it is; a setting as said.
  const gone = (ms: number) => (ms < 60_000 ? 'under a minute' : fmt.minutes(Math.floor(ms / 60_000)))
  const left = (ms: number) => fmt.countdown(ms)
  const span = (ms: number) => fmt.minutes(ms / 60_000)
  const inWords = (ms: number) => (ms <= now ? 'now' : `in ${left(ms - now)}`)
  const lines: { key: string; left: string; right?: string; tone?: Tone }[] = []
  if (t.phase === 'off') return lines
  // While idle the lines below say it all (idle for, left, stops); the headline says what they cannot: ready, or stopped.
  if (t.phase !== 'idle') lines.push({ key: 'kw-headline', left: t.headline, tone: t.phase === 'stopped' ? 'warn' : 'muted' })
  if (t.phase === 'idle' || t.phase === 'stopped') {
    lines.push({ key: 'kw-idle', left: `Idle for ${gone(t.idleForMs ?? 0)}`, right: t.phase === 'idle' ? `Keep warm left ${left(t.leftMs ?? 0)}` : 'Keep warm stopped' })
    if (t.idleSince !== null && t.stopsAt !== null) lines.push({ key: 'kw-window', left: `Started ${at(t.idleSince)}`, right: `${t.phase === 'idle' ? 'Stops' : 'Stopped'} ${at(Math.min(t.stopsAt, t.phase === 'stopped' ? now : t.stopsAt))}` })
    lines.push({
      key: 'kw-next',
      left: t.nextRefreshAt !== null ? `Next refresh ${at(t.nextRefreshAt)} (${inWords(t.nextRefreshAt)})` : `No refresh planned: ${t.noRefreshWhy ?? 'none needed'}`,
      right: t.expiresAt === null ? undefined : t.expiresAt > now ? `Cache expires ${inWords(t.expiresAt)} without one` : `Cache lapsed ${at(t.expiresAt)}`,
    })
  }
  const ttl = t.ttl === null ? 'Cache lifetime not known yet' : `Cache lifetime ${t.ttl === '1h' ? '1 hour' : '5 minutes'}${t.ttlSource === null ? '' : ` (${t.ttlSource === 'engine' ? 'Claude Code' : t.ttlSource})`}`
  lines.push({ key: 'kw-ttl', left: ttl, right: t.refreshes === 0 ? 'No refresh yet' : `${fmt.plural(t.refreshes, 'refresh')}${t.lastRefresh === null ? '' : ` · last ${t.lastRefresh.status}`}` })
  if (t.capWhy !== null) lines.push({ key: 'kw-cap', left: `Requested ${span(t.requestedMs)} · Effective ${span(t.effectiveMs)}`, right: undefined, tone: 'muted' })
  if (t.capWhy !== null) lines.push({ key: 'kw-cap-why', left: `Why: ${t.capWhy}`, tone: 'muted' })
  if (t.hold !== null && t.hold.until + 60_000 > (t.idleSince ?? now) + t.effectiveMs) {
    lines.push({ key: 'kw-hold', left: `Requested idle limit ${span(t.requestedMs)} · Watcher holds until ${at(t.hold.until)}`, tone: 'muted' })
    lines.push({ key: 'kw-hold-why', left: `Reason: warm watcher resume${t.hold.label === null ? '' : ` (${t.hold.label})`}`, tone: 'muted' })
  }
  return lines
}

function keepWarmRows(k: Kit, cache: CacheView): RenderElement[] {
  const timing = keepWarmTimingLines(cache.keepWarm.timing, k.now).map(l => (l.right === undefined ? textRuns(k, l.key, [{ text: l.left, tone: l.tone ?? 'muted' }]) : pair(k, { key: l.key, left: l.left, right: l.right })))
  const proof = keepWarmProof(cache)
  if (proof === null) return timing
  const out: RenderElement[] = [...timing, pair(k, { key: 'kw-count', left: proof.refreshes })]
  if (proof.fork !== null) out.push(textRuns(k, 'kw-fork', [{ text: proof.fork.text, tone: proof.fork.tone }]))
  out.push(textRuns(k, 'kw-main', [{ text: 'Main cache: ', tone: 'muted' }, { text: proof.main.text, tone: proof.main.tone, isBold: proof.main.tone === 'good' || proof.main.tone === 'bad' }]))
  if (cache.keepWarm.pausedReason !== null) out.push(note(k, `Paused: ${cache.keepWarm.pausedReason}. Turn Keep warm on again to retry.`, 'kw-paused', 'warn'))
  return out
}

/**
 * One rebuild: what happened and when, what it cost (partial or full, and what it still read), then
 * (wrapping, under it) how sure the cause is and what would avoid it. A cause is stated only as far
 * as the evidence goes: proven, likely, or unknown; nothing is put on the server without evidence.
 */
function missItem(kit: Kit, m: CacheMissView, i: number): RenderElement {
  const { Box } = kit.ui
  const size = m.isPartial ? `partial · re-sent ${fmt.tokens(m.recached)}, read ${fmt.tokens(m.read)}` : `full · re-sent ${fmt.tokens(m.recached)}`
  return (
    <Box key={`miss-${i}`} flexDirection="column">
      {listItem(kit, {
        key: `miss-${i}-line`,
        glyph: m.severity === 'warn' ? G.warn : m.kind === 'lifecycle' ? G.ring : G.dot,
        tone: m.severity === 'warn' ? 'warn' : 'muted',
        text: `${m.label}: ${m.detail}`,
        right: spaced(kit, [size, fmt.clock(m.at)]),
        rightTone: m.severity === 'warn' ? 'warn' : 'muted',
        isDim: m.kind === 'lifecycle',
      })}
      <Box key={`miss-${i}-advice`} marginLeft={3}>
        {note(kit, `${CERTAINTY_WORD[m.certainty]}. ${m.advice}`, `miss-${i}-note`)}
      </Box>
    </Box>
  )
}

const CERTAINTY_WORD: Record<CacheMissView['certainty'], string> = { proven: 'Proven cause', likely: 'Likely cause', unknown: 'Cause unknown' }

export function cacheCards(kit: Kit, cache: CacheView, settings: { keepWarm: boolean; maxIdleMinutes: number; guardModelSwitch: boolean; stablePolicies: boolean }): RenderElement[] {
  const u = kit.actions.update
  const accent = ACCENT.context
  const state = cacheState(cache, kit.now)
  const kw = keepWarmStatus(cache)
  const idle = settings.maxIdleMinutes
  const lower = [...IDLE_STEPS].reverse().find(m => m < idle)
  const higher = IDLE_STEPS.find(m => m > idle)
  const lifetime = cache.ttl === null ? 'Lifetime not known yet' : `${LIFETIME[cache.ttl]} cache · ${SOURCE[cache.ttlSource ?? 'observed'] ?? 'observed'}`
  const hit = cache.hitRatio === null ? null : `${Math.round(cache.hitRatio * 100)}% read from cache`
  const preventable = cache.misses.filter(m => m.kind === 'preventable').length

  const out: RenderElement[] = [
    card(kit, {
      key: 'cache',
      title: 'Cache',
      accent,
      aside: cache.warmth === 'none' ? 'Nothing cached yet' : lifetime,
      footer: cache.warmth === 'none' ? undefined : 'The expiry, the hit ratio and the causes are derived from the tokens Claude Code reports.',
      rows: k => [
        cache.warmth === 'none'
          ? null
          : textRuns(k, 'cache-state', [
              { text: `${state.glyph} `, tone: state.tone === 'normal' ? 'info' : state.tone },
              { text: state.text, isBold: cache.warmth === 'warm', tone: cache.warmth === 'warm' ? 'normal' : 'muted' },
            ]),
        cache.warmth === 'none'
          ? null
          : meterBar(k, { key: 'cache-left', fraction: state.fraction ?? 0, tone: cache.warmth === 'warm' ? 'info' : 'muted', width: k.columns, alt: state.text }),
        cache.warmth === 'none' ? null : pair(k, { key: 'cache-under', left: `${fmt.tokens(cache.cachedTokens)} tokens cached · ${fmt.plural(cache.requests, 'request')}`, right: hit ?? undefined }),
        (cache.warmth === 'none' ? (_k: Kit, _key: string, el: RenderElement) => el : apart)(
          k,
          'cache-keep',
          row(k, {
            key: 'cache-keep',
            label: 'Keep warm while you are away',
            subtitle: kw.text,
            subtitleTone: kw.tone,
            control: switchControl(k, { key: 'cache-keep', isOn: settings.keepWarm, onPress: () => u(d => void (d.cache.keepWarm = !d.cache.keepWarm)) }),
          }),
        ),
        ...(settings.keepWarm ? keepWarmRows(k, cache) : []),
        settings.keepWarm &&
          row(k, {
            key: 'cache-idle',
            label: 'Stop after',
            subtitle: cache.ttl === '5m' && idle > 45 ? 'The 5-minute cache stops at 45 min: refreshing longer costs more' : 'Of idle time, if you have not come back',
            control: stepper(k, {
              key: 'cache-idle',
              display: fmt.minutes(idle),
              onDecrease: lower === undefined ? undefined : () => u(d => void (d.cache.maxIdleMinutes = lower)),
              onIncrease: higher === undefined ? undefined : () => u(d => void (d.cache.maxIdleMinutes = higher)),
            }),
          }),
        row(k, {
          key: 'cache-guard',
          label: 'Ask before a model switch',
          subtitle: 'When it would re-send 100k+ cached tokens',
          control: switchControl(k, { key: 'cache-guard', isOn: settings.guardModelSwitch, onPress: () => u(d => void (d.cache.guardModelSwitch = !d.cache.guardModelSwitch)) }),
        }),
        row(k, {
          key: 'cache-stable',
          label: 'Keep policies stable',
          subtitle: cache.policies.isHolding && settings.stablePolicies ? 'Holding: setting changes reach Claude as notes' : 'While the cache is warm, setting changes reach Claude as notes',
          control: switchControl(k, { key: 'cache-stable', isOn: settings.stablePolicies, onPress: () => u(d => void (d.cache.stablePolicies = !d.cache.stablePolicies)) }),
        }),
      ],
    }),
  ]
  if (cache.misses.length > 0) {
    out.push(
      card(kit, {
        key: 'cache-health',
        title: 'Cache health',
        accent,
        aside: preventable > 0 ? `${fmt.plural(cache.misses.length, 'rebuild')} · ${preventable} preventable` : fmt.plural(cache.misses.length, 'rebuild'),
        rows: k => cache.misses.slice(0, 4).map((m, i) => missItem(k, m, i)),
      }),
    )
  }
  return out
}

/** The sizes the Cold Resume Guard's threshold steps through, in tokens. */
const COLD_STEPS = [20_000, 50_000, 100_000, 150_000, 200_000, 300_000, 400_000, 500_000, 750_000, 1_000_000, 1_500_000, 2_000_000] as const

/**
 * The Cold Resume Guard: before a message re-reads a large context whose cache has surely lapsed,
 * Project Sentinel asks first. The card says whether it would ask now, why the cache lapsed, and
 * what re-reading costs: dollars only from Claude Code's own estimate, tokens otherwise.
 */
export function coldResumeCard(kit: Kit, cold: ColdResumeView, cache: CacheView, settings: { coldResume: boolean; coldResumeTokens: number }): RenderElement {
  const u = kit.actions.update
  const at = settings.coldResumeTokens
  const lower = [...COLD_STEPS].reverse().find(n => n < at)
  const higher = COLD_STEPS.find(n => n > at)
  const tokens = cold.tokens
  const state: { text: string; tone: Tone } = !settings.coldResume
    ? { text: 'Off: a cold resume re-reads the context without asking', tone: 'muted' }
    : cold.isArmed
      ? { text: `Armed: the cache lapsed over ${fmt.tokens(tokens ?? 0)} tokens, so your next message is asked about first`, tone: 'warn' }
      : cache.warmth === 'warm'
        ? { text: 'The cache is warm: nothing to ask', tone: 'muted' }
        : tokens !== null && tokens < at && cache.warmth !== 'none'
          ? { text: `${fmt.tokens(tokens)} of context: under the ${fmt.tokens(at)} it asks above`, tone: 'muted' }
          : { text: 'Asks only when the cache has surely lapsed', tone: 'muted' }
  const price = coldCostWords(cold)?.short ?? (cold.isArmed ? 'Tokens only: Claude Code has given no price for this model in this session' : null)
  return card(kit, {
    key: 'cold-resume',
    title: 'Cold Resume Guard',
    accent: ACCENT.context,
    aside: settings.coldResume ? `Asks above ${fmt.tokens(at)}` : 'Off',
    footer: 'Asks in Claude Code’s own dialog before the message goes: Continue, Start fresh (only when Ready to resume is ready), Compact first (it reads the context once), or Cancel (your message comes back). Never while Claude works.',
    rows: k => [
      row(k, {
        key: 'cold-on',
        label: 'Ask before a cold resume',
        subtitle: state.text,
        subtitleTone: state.tone,
        control: switchControl(k, { key: 'cold-on', isOn: settings.coldResume, onPress: () => u(d => void (d.cache.coldResume = !d.cache.coldResume)) }),
      }),
      settings.coldResume &&
        row(k, {
          key: 'cold-at',
          label: 'Warn above',
          subtitle: 'Tokens of earlier context a message would re-read',
          control: stepper(k, {
            key: 'cold-at',
            display: fmt.tokens(at),
            onDecrease: lower === undefined ? undefined : () => u(d => void (d.cache.coldResumeTokens = lower)),
            onIncrease: higher === undefined ? undefined : () => u(d => void (d.cache.coldResumeTokens = higher)),
          }),
        }),
      cold.cause === null || !cold.isArmed ? null : note(k, `Why: ${cold.cause}.`, 'cold-cause'),
      price === null ? null : note(k, price, 'cold-price'),
      cold.last === null ? null : note(k, `Last asked ${fmt.clock(cold.last.at)}: ${cold.last.choice}`, 'cold-last'),
    ],
  })
}

/** What the cache holds, in a line, for Overview's lifecycle card: its state is the line above it, said once. */
export function cacheSummary(cache: CacheView): string {
  if (cache.warmth === 'none') return 'Nothing cached yet'
  const parts = [`${fmt.tokens(cache.cachedTokens)} cached`]
  if (cache.hitRatio !== null) parts.push(`${Math.round(cache.hitRatio * 100)}% read from cache`)
  return parts.join(' · ')
}

/** The cache's lifetime in a few words, for a card's aside; null while it is not known. */
export function lifetimeWords(cache: CacheView): string | null {
  return cache.ttl === null ? null : `${LIFETIME[cache.ttl]} cache`
}
