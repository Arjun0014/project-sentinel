/**
 * The status bar: a mission HUD above the prompt.
 *
 *              ▄▀▄    ▄▀▄                                                       (Kit, when on)
 *   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ the top edge
 *   ▸ Rewriting the cache scheduler · step 3 of 8               ▲ Tests failing   ◆ Control Room
 *     WORK ●━●━●━◉─○─○─○─○ 3/8    CONTEXT ▇▇▇▇▇▇▇▇▇▇▌▇▇▇ 48% · hands off 70%    CACHE ◕ 42m   5H ▂▂▂▂▂▂ 63% · 2h14m
 *
 * The headline says what is happening, in words, with a mark for the state
 * (working, thinking, running a check, waiting for you or for a result,
 * blocked, handing off, done). On its right: only what needs a look, as
 * chips, then the Control Room button, drawn as a filled control.
 *
 * Under it, the instruments, each its own shape so they cannot be confused:
 * WORK is a track of milestones (it carries across handoffs), CONTEXT a
 * filling meter with the handoff point as a notch (it starts over after one),
 * CACHE a clock face (shown only while it can matter: when you are away, or
 * after a costly rebuild), and on the right 5H, the plan's five-hour use as
 * Claude Code reports it (a thin bar, the percentage, the time to its reset;
 * nothing on an account with no five-hour window). The run's cost lives in
 * Overview, Context → Run and the Run Budget. While a watcher parks the run,
 * WATCHER counts down to its wake (on Desktop it takes the Machine cell:
 * nothing runs, so the machine is not the story).
 *
 * Kit, when on, walks a lane of its own: in the terminal it stands on the
 * HUD's top edge; on Desktop it is a short animated image above the headline.
 * A handoff that needs the person takes a line of its own above everything.
 *
 * Width decides the detail: the richest tier whose instruments all fit,
 * from named readings with long graphics down to bare graphics, then the
 * least important reading drops. Desktop draws the marks, the track, the
 * meter and the clock as SVG.
 */

import type { RenderElement } from 'claude-code'

import type { HudChip, HudModel, Tone, TrackStop } from '../../types'
import * as fmt from '../core/format'
import { desktopLanePx, kitStillSvg } from '../kit.client'
import type { Kit } from './kit'
import { clip, isNative } from './primitives'
import { G, STATE_MARK, STOP_LOOK, clockGlyph, meterCells, scaleTrack, svgClock, svgContextMeter, svgLevel, svgStateIcon, svgThinMeter, svgWorkTrack, toneProps } from './theme'

/** The watcher that parks the run, while it sleeps: its countdown is an instrument of its own. */
const sleepingWatcher = (hud: HudModel): NonNullable<NonNullable<HudModel['ops']>['watcher']> | null =>
  hud.ops !== null && hud.ops.isSleeping && hud.ops.watcher !== null && hud.ops.watcher.status === 'armed' ? hud.ops.watcher : null

/**
 * A run of text in one style. `isTrack` draws the empty part of a graphic in the theme's quietest
 * gray (`subtle`): dim text varies from terminal to terminal, and a dim block reads as a slab.
 */
type Span = { text: string; tone?: Tone; isDim?: boolean; isBold?: boolean; isTrack?: boolean }

/** A graphic drawn as SVG on the remote surfaces, in place of its glyphs: `cells` wide. */
type Graphic = { source: string; cells: number; alt: string; height: number }

export type Segment = {
  key: string
  priority: number
  side: 'left' | 'right'
  /** Text before the graphic (or the whole segment). */
  spans: Span[]
  graphic?: Graphic
  /** Text after the graphic. */
  after?: Span[]
}

/** Cells between instruments. */
const GAP = 4

/** The instruments sit under the headline's words, past its mark. */
const INDENT = 2

/** The pixels a cell of a status-bar graphic takes as SVG. */
const CELL_PX = 8

const spanWidth = (spans: readonly Span[] | undefined): number => (spans ?? []).reduce((n, p) => n + p.text.length, 0)

export const widthOf = (s: Segment): number => spanWidth(s.spans) + (s.graphic?.cells ?? 0) + spanWidth(s.after)

/** How much the instruments row shows: names, the meter's cells, the track's stops, the long notes. */
export type Tier = { labels: boolean; meter: number; stops: number; notes: boolean }

const TIERS: readonly Tier[] = [
  { labels: true, meter: 24, stops: 16, notes: true },
  { labels: true, meter: 16, stops: 12, notes: true },
  { labels: true, meter: 12, stops: 10, notes: false },
  { labels: true, meter: 10, stops: 8, notes: false },
  { labels: true, meter: 8, stops: 6, notes: false },
  { labels: false, meter: 8, stops: 6, notes: false },
  { labels: false, meter: 6, stops: 5, notes: false },
]

/**
 * From this wide (terminal columns; Desktop's are wider) the readings carry their names, docked
 * beside the panel included, so the names do not come and go as readings appear.
 */
const NAMED_FROM: Record<'terminal' | 'other', number> = { terminal: 72, other: 64 }

const namedFrom = (surface: Kit['surface']): number => (surface === 'terminal' ? NAMED_FROM.terminal : NAMED_FROM.other)

/** The tiers the instruments may take at a width, richest first: the first whose segments all fit wins. */
export function tiersOf(columns: number, surface: Kit['surface'] = 'terminal'): readonly Tier[] {
  return columns >= namedFrom(surface) ? TIERS : TIERS.filter(t => !t.labels)
}

/** Adjacent spans of one style become one, so a graphic is a few Texts, not one per cell. */
function merged(spans: readonly Span[]): Span[] {
  const out: Span[] = []
  for (const span of spans) {
    const last = out[out.length - 1]
    if (last !== undefined && last.tone === span.tone && last.isDim === span.isDim && last.isBold === span.isBold && last.isTrack === span.isTrack) last.text += span.text
    else out.push({ ...span })
  }
  return out
}

/** The context meter in the terminal: filled segments in its tone, empty ones dim, the handoff point an orange bar. */
function meterSpans(fraction: number, marker: number | null, tone: Tone, width: number): Span[] {
  const c = meterCells(fraction, width, marker)
  return merged(
    Array.from({ length: c.width }, (_, i): Span => (i === c.marker ? { text: G.notch, tone: 'accent' } : i < c.filled ? { text: G.segFull, tone } : { text: G.segEmpty, isTrack: true })),
  )
}

/** The plan's five-hour meter in the terminal: a thin bar, the used part in its tone, the rest the quietest gray. */
export function thinMeterSpans(fraction: number, tone: Tone, width: number): Span[] {
  const w = Math.max(2, Math.floor(width))
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const filled = f > 0 ? Math.max(1, Math.round(f * w)) : 0
  return merged(Array.from({ length: w }, (_, i): Span => (i < filled ? { text: G.thin, tone } : { text: G.thin, isTrack: true })))
}

/** The work track in the terminal: ●━●━◉─○, done in the work color, the stretch to come dim. */
export function trackSpans(stops: readonly TrackStop[]): Span[] {
  const out: Span[] = []
  stops.forEach((s, i) => {
    if (i > 0) out.push(stops[i - 1] === 'done' && s !== 'open' ? { text: G.lineFull, tone: 'info' } : { text: G.lineEmpty, isDim: true })
    const look = STOP_LOOK[s]
    out.push({ text: look.glyph, tone: look.tone, isBold: look.isBold, isDim: look.isDim })
  })
  return merged(out)
}

const valueTone = (tone: Tone): Tone | undefined => (tone === 'good' || tone === 'normal' || tone === 'muted' ? undefined : tone)

const label = (tier: Tier, text: string): Span[] => (tier.labels ? [{ text: `${text} `, isDim: true }] : [])

/** The instruments at a tier, in display order, each with its priority for when room runs short. */
export function hudSegments(hud: HudModel, tier: Tier, surface: Kit['surface'] = 'terminal'): Segment[] {
  const isSvg = surface !== 'terminal'
  const segments: Segment[] = []

  // WORK: a track of milestones, as Claude's own task list counts them.
  const work = hud.work
  if (work !== null && work.total > 0) {
    const isDone = work.done === work.total
    const count: Span = { text: ` ${work.done}/${work.total}`, tone: isDone ? 'good' : undefined, isBold: true }
    const stops = scaleTrack(work.track.length === work.total ? work.track : fallbackTrack(work.done, work.total, work.current !== null), tier.stops)
    const alt = `Work: ${work.done} of ${work.total} milestones done`
    if (isSvg) {
      const source = svgWorkTrack({ stops, height: 14, pitch: 16 })
      const px = Math.round(2 * 6.5 + (stops.length - 1) * 16)
      segments.push({ key: 'work', priority: 1, side: 'left', spans: label(tier, 'WORK'), graphic: { source, cells: Math.ceil(px / CELL_PX), alt, height: 14 }, after: [count] })
    } else {
      segments.push({ key: 'work', priority: 1, side: 'left', spans: [...label(tier, 'WORK'), ...trackSpans(stops), count] })
    }
  }

  // CONTEXT: a filling meter with the handoff notch; it starts over in each fresh context.
  const ctx = hud.ctx
  if (ctx.pct === null || ctx.tokens === null || ctx.window === null || ctx.window <= 0) {
    segments.push({ key: 'ctx', priority: 0, side: 'left', spans: [...label(tier, 'CONTEXT'), { text: G.none, isDim: true }] })
  } else {
    const fraction = ctx.tokens / ctx.window
    const marker = ctx.threshold === null ? null : ctx.threshold / ctx.window
    const tone: Tone = ctx.tone === 'muted' || ctx.tone === 'normal' ? 'good' : ctx.tone
    const pct: Span = { text: ` ${ctx.pct}%`, tone: valueTone(ctx.tone), isBold: true }
    const notes: string[] = []
    const event = hud.autopilot.isOn && hud.autopilot.state !== 'armed' && hud.autopilot.state !== 'off' ? hud.autopilot.text : null
    if (event !== null) notes.push(event)
    else if (tier.notes && marker !== null && hud.autopilot.isOn) notes.push(`hands off ${Math.round(marker * 100)}%`)
    if (tier.notes && hud.session.index > 1) notes.push(`session ${hud.session.index}`)
    const after: Span[] = [pct, ...(notes.length === 0 ? [] : [{ text: ` · ${notes.join(' · ')}`, isDim: event === null, tone: event === null ? undefined : 'info' } as Span])]
    if (isSvg) {
      const px = tier.meter * CELL_PX + 24
      segments.push({ key: 'ctx', priority: 0, side: 'left', spans: label(tier, 'CONTEXT'), graphic: { source: svgContextMeter({ fraction, marker, tone, width: px, height: 14 }), cells: Math.ceil(px / CELL_PX), alt: `Context ${ctx.pct}% used`, height: 14 }, after })
    } else {
      segments.push({ key: 'ctx', priority: 0, side: 'left', spans: [...label(tier, 'CONTEXT'), ...meterSpans(fraction, marker, tone, tier.meter), ...after] })
    }
  }

  // CACHE: only while it can matter.
  const cache = hud.cache
  if (cache !== null && cache.isShown) {
    const word = cache.parked !== undefined ? (tier.notes ? cache.parked.text : cache.parked.short) : cache.recentMiss !== null ? cache.text : cache.warmth === 'warm' && cache.leftMs !== null && tier.notes ? `${cache.text} left` : cache.text
    const text: Span = { text: ` ${word}`, tone: cache.tone === 'warn' ? 'warn' : undefined, isDim: cache.tone === 'muted' ? true : undefined }
    const glyphTone: Tone = cache.tone === 'normal' ? 'info' : cache.tone
    const alt = cacheAlt(cache)
    segments.push(
      isSvg
        ? { key: 'cache', priority: 2, side: 'left', spans: label(tier, 'CACHE'), graphic: { source: svgClock({ fraction: cache.fraction, tone: glyphTone, size: 14 }), cells: 2, alt, height: 14 }, after: [text] }
        : { key: 'cache', priority: 2, side: 'left', spans: [...label(tier, 'CACHE'), { text: clockGlyph(cache.fraction), tone: glyphTone }, text] },
    )
  }

  // WATCHER: while a watcher parks the run, the time to its wake (the headline says until when, and why).
  const watcher = sleepingWatcher(hud)
  if (watcher !== null) {
    const left: Span = { text: ` ${watcher.left}`, isBold: true }
    const alt = `Watcher ${watcher.id} wakes the run in ${watcher.left}, at ${watcher.at}`
    segments.push(
      isSvg
        ? { key: 'watcher', priority: 1, side: 'left', spans: label(tier, 'WATCHER'), graphic: { source: svgStateIcon('sleeping', 14), cells: 2, alt, height: 14 }, after: [left] }
        : { key: 'watcher', priority: 1, side: 'left', spans: [...label(tier, 'WATCHER'), { text: G.wait, tone: 'info' }, left] },
    )
  }

  // 5H: the plan's five-hour window, on the right; nothing where the account has none.
  const plan = planSegment(hud.plan.five, tier, isSvg)
  if (plan !== null) segments.push(plan)
  return segments
}

/**
 * Every plan window in a line, for /cr status and Context → Run: "5-hour 63%, resets 14:20 (in 2h 14m)
 * · 7-day 18%, resets Oct 14 23:00". As Claude Code reports them; nothing is estimated.
 */
export function planDetail(plan: HudModel['plan'], now: number): string {
  const five = plan.five
  if (five.kind === 'absent') return 'No five-hour window on this account (an API key, or a plan without one)'
  if (five.kind === 'pending') return 'No reading yet: it comes with the first response'
  const resets = (at: number | null, leftMs: number | null) => (at === null ? '' : `, resets ${fmt.when(at, now)}${leftMs === null ? '' : ` (in ${fmt.countdown(leftMs)})`}`)
  const parts = plan.windows.map(w => (w.isReset ? `${w.name} reset at ${fmt.when(w.resetsAt, now)}, no reading of the new window yet` : `${w.name} ${fmt.percent(w.percent)}${resets(w.resetsAt, w.leftMs)}`))
  if (five.kind === 'limited') {
    const which = five.window === 'seven_day' ? '7-day limit reached' : five.window === null ? 'A request was refused on the rate limit' : '5-hour limit reached'
    return [`${which}${resets(five.resetsAt, five.leftMs)}`, ...parts.filter(p => !(five.window === 'five_hour' && p.startsWith('5-hour')))].join(' · ')
  }
  return parts.join(' · ')
}

/**
 * The five-hour window in a few words, as the status line and the terminal's status bar say it:
 * "5H 63% · 2h14m", "5H reset · new window", "5H limit · 2h14m", "5H —" before a reading; nothing
 * where the account has no five-hour window. `isShort` drops the reset's second half.
 */
export function planWords(five: HudModel['plan']['five'], isShort: boolean): string | null {
  switch (five.kind) {
    case 'absent':
      return null
    case 'pending':
      return '5H —'
    case 'reset':
      return isShort ? '5H reset' : '5H reset · new window'
    case 'reading':
      return `5H ${fmt.percent(five.percent)}${five.leftMs === null ? '' : ` · ${fmt.countdown(five.leftMs, true)}`}`
    case 'limited': {
      const left = five.leftMs === null ? '' : ` · ${fmt.countdown(five.leftMs, true)}`
      return five.window === 'seven_day' ? `7D limit${left}` : five.window === null ? `Rate limited${left}` : `5H limit${left}`
    }
  }
}

/** The cells of the five-hour meter: a short bar where the readings carry their names, none in the leanest rows. */
const PLAN_METER = 6

/** What the five-hour reading says to a screen reader (Desktop's image, the plain text). */
export function planAlt(five: HudModel['plan']['five']): string {
  switch (five.kind) {
    case 'pending':
      return 'Five-hour plan usage: no reading yet'
    case 'absent':
      return 'No five-hour plan limit on this account'
    case 'reset':
      return 'Five-hour plan window reset; no reading of the new window yet'
    case 'reading':
      return `Five-hour plan usage ${fmt.percent(five.percent)}${five.leftMs === null ? '' : `, resets in ${fmt.countdown(five.leftMs)}`}`
    case 'limited':
      return `${five.window === 'seven_day' ? 'Seven-day plan limit' : five.window === null ? 'Rate limit' : 'Five-hour plan limit'} reached${five.leftMs === null ? '' : `, resets in ${fmt.countdown(five.leftMs)}`}`
  }
}

/**
 * The status bar's 5H reading: "5H ▂▂▂▂▂▂ 63% · 2h14m" (the bar only where the readings carry their
 * names), "5H reset · new window" once the window has reset and no response has read the new one,
 * "5H limit · 2h14m" in red at the limit (the one reading that never drops for room), "5H —" before
 * the first response. Null on an account with no five-hour window.
 */
function planSegment(five: HudModel['plan']['five'], tier: Tier, isSvg: boolean): Segment | null {
  const name: Span = { text: '5H ', isDim: true }
  const left = (ms: number | null, tone?: Tone): Span[] => (ms === null ? [] : [{ text: ` · ${fmt.countdown(ms, true)}`, isDim: tone === undefined, tone }])
  switch (five.kind) {
    case 'absent':
      return null
    case 'pending':
      return { key: 'plan', priority: 1, side: 'right', spans: [name, { text: G.none, isDim: true }] }
    case 'reset':
      return { key: 'plan', priority: 1, side: 'right', spans: [name, { text: tier.notes ? 'reset · new window' : 'reset', isDim: true }] }
    case 'limited': {
      const word: Span = { text: five.window === 'seven_day' ? '7D limit' : five.window === null ? 'Rate limited' : 'limit', tone: 'bad', isBold: true }
      return { key: 'plan', priority: 0, side: 'right', spans: [...(five.window === 'five_hour' ? [name] : []), word, ...left(five.leftMs, 'bad')] }
    }
    case 'reading': {
      const tone: Tone = five.isHigh ? 'warn' : 'info'
      const value: Span = { text: ` ${fmt.percent(five.percent)}`, tone: five.isHigh ? 'warn' : undefined, isBold: true }
      if (!tier.labels) return { key: 'plan', priority: 1, side: 'right', spans: [{ text: '5H', isDim: true }, value, ...left(five.leftMs)] }
      const fraction = five.percent / 100
      if (isSvg) {
        const px = PLAN_METER * CELL_PX
        return { key: 'plan', priority: 1, side: 'right', spans: [name], graphic: { source: svgThinMeter({ fraction, tone, width: px, height: 14 }), cells: PLAN_METER, alt: planAlt(five), height: 14 }, after: [value, ...left(five.leftMs)] }
      }
      return { key: 'plan', priority: 1, side: 'right', spans: [name, ...thinMeterSpans(fraction, tone, PLAN_METER), value, ...left(five.leftMs)] }
    }
  }
}

/** A track from counts alone (a stored plan without statuses): done, the one under way, the rest. */
function fallbackTrack(done: number, total: number, hasCurrent: boolean): TrackStop[] {
  return Array.from({ length: total }, (_, i) => (i < done ? 'done' : i === done && hasCurrent ? 'now' : 'open'))
}

/** Keeps the highest-priority segments that fit `width` (gaps included), in display order. */
export function fitSegments(segments: readonly Segment[], width: number, gap = GAP): Segment[] {
  const kept = [...segments]
  const total = (list: readonly Segment[]) => list.reduce((sum, s) => sum + widthOf(s), 0) + Math.max(0, list.length - 1) * gap
  while (kept.length > 1 && total(kept) > width) {
    let worst = 0
    for (let i = 1; i < kept.length; i++) if (kept[i]!.priority >= kept[worst]!.priority) worst = i
    kept.splice(worst, 1)
  }
  return kept
}

function spanEl(kit: Kit, key: string, span: Span): RenderElement {
  const { Text } = kit.ui
  const props = span.isTrack === true ? { color: 'subtle' as const } : span.tone === undefined ? {} : toneProps(span.tone)
  return (
    <Text key={key} {...props} dimColor={span.isDim === true ? true : undefined} bold={span.isBold === true ? true : undefined}>
      {span.text}
    </Text>
  )
}

function segmentEl(kit: Kit, s: Segment): RenderElement {
  const { Box, Text, Svg } = kit.ui
  const text = (spans: readonly Span[] | undefined, part: string) =>
    spans === undefined || spans.length === 0 ? null : <Text key={`seg-${s.key}-${part}`}>{spans.map((p, i) => spanEl(kit, `seg-${s.key}-${part}-${i}`, p))}</Text>
  if (s.graphic === undefined || Svg === undefined) {
    return (
      <Text key={`seg-${s.key}`} wrap="truncate-end">
        {s.spans.map((p, i) => spanEl(kit, `seg-${s.key}-${i}`, p))}
      </Text>
    )
  }
  return (
    <Box key={`seg-${s.key}`} flexDirection="row" alignItems="center" flexShrink={0} columnGap={1}>
      {text(s.spans, 'before')}
      <Svg key={`seg-${s.key}-svg`} source={s.graphic.source} alt={s.graphic.alt} height={s.graphic.height} />
      {text(s.after?.map((p, i) => (i === 0 ? { ...p, text: p.text.replace(/^ /, '') } : p)), 'after')}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The headline row

/** The Control Room button's words: its name with the brand mark, or a short verb in a narrow bar. */
const buttonLabel = (hud: HudModel, columns: number): string => (columns >= 64 ? `${G.brand} Control Room` : `${G.brand} ${hud.isPaneOpen ? 'Close' : 'Open'}`)

/**
 * The Control Room button. Desktop draws its native primary button, the panel
 * open or closed: it is the bar's one control, and the secondary button, gray
 * on the bar's own gray, read as a tag. The terminal draws a filled chip,
 * brighter under the pointer and in the brand color while the panel is open,
 * so it reads as a control and not as more text.
 */
function controlButton(kit: Kit, hud: HudModel): RenderElement {
  const { Box, Button } = kit.ui
  const text = buttonLabel(hud, kit.columns)
  if (isNative(kit)) return <Button key="open" label={text} variant="primary" onPress={kit.actions.togglePane} />
  return (
    <Box key="open-chip" flexShrink={0} paddingX={1} backgroundColor={hud.isPaneOpen ? 'claude' : 'subtle'} hover={{ backgroundColor: hud.isPaneOpen ? 'claude' : 'inactive' }}>
      <Button key="open" label={text} plain onPress={kit.actions.togglePane} />
    </Box>
  )
}

/** The chips that fit beside the headline: the most pressing first. */
function chipsThatFit(chips: readonly HudChip[], room: number): HudChip[] {
  const out: HudChip[] = []
  let used = 0
  for (const c of chips) {
    const w = c.text.length + 2 + (out.length > 0 ? 2 : 0)
    if (used + w > room) break
    out.push(c)
    used += w
  }
  return out
}

/** The Operations card a chip opens at: pressed, Review 2 shows the decisions, not the top of Operations. */
const CHIP_SECTION: Record<string, string> = { review: 'ops-review', queued: 'ops-queue', watcher: 'ops-watchers', budget: 'ops-budget' }

/**
 * A chip: its mark in its tone, then its words. One that `opens` is a control: pressed, it opens
 * Activity → Operations (Review, a watcher's countdown, queued work, agents, the budget). Its words
 * are the Button's label and its mark sits beside it: Claude Code 2.1.289 takes a Button's label
 * only, and refuses one with Text children by skipping the whole status bar.
 */
function chipEl(kit: Kit, chip: HudChip): RenderElement {
  const { Box, Text, Button } = kit.ui
  const mark = chip.key === 'failing' ? G.fail : chip.tone === 'bad' || chip.tone === 'warn' ? G.warn : chip.key === 'quest' ? G.star : chip.key === 'watcher' ? G.wait : G.dot
  const markEl = <Text key={`chip-${chip.key}-mark`} {...toneProps(chip.tone)}>{`${mark} `}</Text>
  if (chip.opens !== undefined) {
    const onPress = chip.opens === 'agents' ? () => kit.actions.openAgents() : () => kit.actions.openOps(CHIP_SECTION[chip.key])
    return (
      <Box key={`chip-${chip.key}-box`} flexDirection="row" flexShrink={0}>
        {markEl}
        <Button key={`chip-${chip.key}`} label={chip.text} plain onPress={onPress} />
      </Box>
    )
  }
  return (
    <Text key={`chip-${chip.key}`} wrap="truncate-end">
      {markEl}
      <Text key={`chip-${chip.key}-text`} {...toneProps(chip.tone === 'info' || chip.tone === 'accent' ? 'normal' : chip.tone)} bold={chip.tone === 'bad' ? true : undefined}>
        {chip.text}
      </Text>
    </Text>
  )
}

/** The headline: the state's mark, what is happening, its detail; then the chips and the button on the right. */
function headlineRow(kit: Kit, hud: HudModel): RenderElement {
  const { Box, Text, Svg } = kit.ui
  // Not `h`: that name is the JSX factory's in this module.
  const line = hud.headline
  const mark = STATE_MARK[line.state]
  const isStrong = line.state === 'working' || line.state === 'validating' || line.state === 'handoff' || line.state === 'waitingUser' || line.state === 'waitingExternal' || line.state === 'blocked'
  const isQuiet = line.state === 'ready' || line.state === 'thinking'
  const buttonWidth = buttonLabel(hud, kit.columns).length + (isNative(kit) ? 6 : 4)
  // On Desktop the Machine cell carries CPU and memory, in their tones; the headline does not repeat them.
  const shown = isNative(kit) ? hud.chips.filter(c => c.key !== 'cpu' && c.key !== 'ram') : hud.chips
  const chips = chipsThatFit(shown, Math.max(0, Math.floor((kit.columns - buttonWidth) * 0.45)))
  return (
    <Box key="hud-head" flexDirection="row" alignItems="center" columnGap={3}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} alignItems="center" columnGap={Svg !== undefined ? 1 : 0} {...clip(kit)}>
        {/* The terminal's mark takes the indent the instruments line up under; an icon takes its own size. */}
        <Box width={Svg !== undefined ? undefined : INDENT} flexShrink={0}>
          {Svg !== undefined ? <Svg key="mark" source={svgStateIcon(line.state)} alt={line.state} width={16} height={16} /> : <Text {...toneProps(mark.tone)}>{mark.glyph}</Text>}
        </Box>
        <Box flexShrink={1} {...clip(kit)}>
          <Text wrap="truncate-end">
            <Text bold={isStrong ? true : undefined} dimColor={isQuiet ? true : undefined}>
              {line.text}
            </Text>
            {line.detail === null || line.detail === '' ? null : <Text dimColor>{` · ${line.detail}`}</Text>}
          </Text>
        </Box>
      </Box>
      {chips.length === 0 ? null : (
        <Box key="hud-chips" flexDirection="row" columnGap={2} flexShrink={0} alignItems="center">
          {chips.map(c => chipEl(kit, c))}
        </Box>
      )}
      <Box flexShrink={0}>{controlButton(kit, hud)}</Box>
    </Box>
  )
}

/** The instruments: Work, Context and Cache on the left, the plan's five-hour use on the right. */
function instrumentsRow(kit: Kit, hud: HudModel): RenderElement {
  const { Box } = kit.ui
  const room = Math.max(10, kit.columns - INDENT)
  // The richest tier that shows every reading; failing that, the leanest one, the least important readings dropped.
  let kept: Segment[] = []
  for (const tier of tiersOf(kit.columns, kit.surface)) {
    const all = hudSegments(hud, tier, kit.surface)
    kept = fitSegments(all, room)
    if (kept.length === all.length) break
  }
  const left = kept.filter(s => s.side === 'left')
  const right = kept.filter(s => s.side === 'right')
  return (
    <Box flexDirection="row" key="hud-line" alignItems="center" marginLeft={INDENT}>
      <Box flexDirection="row" columnGap={GAP} flexShrink={0} alignItems="center">
        {left.map(s => segmentEl(kit, s))}
      </Box>
      <Box key="hud-gap" flexGrow={1} flexShrink={1} />
      {right.length === 0 ? null : (
        <Box flexDirection="row" columnGap={GAP} flexShrink={0} marginLeft={GAP} alignItems="center">
          {right.map(s => segmentEl(kit, s))}
        </Box>
      )}
    </Box>
  )
}

type AlertAction = { key: string; label: string; onPress: () => void; isPrimary?: boolean }

/** What the alert line offers: the handoff's, a watcher that waits for the person, a held message, the budget, a suggestion. */
export function alertActions(kit: Kit, alert: NonNullable<HudModel['alert']>): AlertAction[] {
  const a = kit.actions
  const ref = alert.ref ?? ''
  switch (alert.kind) {
    case 'pending':
      return [
        { key: 'handoff-now', label: 'Hand off now', onPress: a.handoff, isPrimary: true },
        { key: 'snooze', label: 'Later', onPress: a.snooze },
      ]
    case 'awaiting':
      return [
        { key: 'fresh', label: 'Start fresh', onPress: a.fresh, isPrimary: true },
        { key: 'snooze', label: 'Later', onPress: a.snooze },
      ]
    // A written handoff waiting for background work: the ways out, never only words.
    case 'waiting':
      return [
        { key: 'handoff-go', label: 'Hand off now', onPress: a.handoffNow, isPrimary: true },
        ...(alert.canStop === true ? [{ key: 'handoff-stop', label: 'Stop & hand off', onPress: () => a.stopAndHandoff() }] : []),
        ...(alert.canKeep === true ? [{ key: 'handoff-wait', label: 'Keep waiting', onPress: a.keepWaiting }] : []),
        { key: 'handoff-cancel', label: 'Call off', onPress: a.cancelHandoff },
      ]
    case 'stuck': {
      const offers = alert.offers ?? []
      const out: AlertAction[] = []
      if (offers.includes('start-fresh')) out.push({ key: 'stuck-fresh', label: 'Start fresh', onPress: a.fresh, isPrimary: true })
      if (offers.includes('handoff-now')) out.push({ key: 'stuck-now', label: 'Hand off now', onPress: a.handoffNow, isPrimary: out.length === 0 })
      if (offers.includes('hand-off')) out.push({ key: 'stuck-again', label: 'Hand off again', onPress: a.handoff, isPrimary: out.length === 0 })
      if (offers.includes('cancel')) out.push({ key: 'stuck-cancel', label: 'Call off', onPress: a.cancelHandoff })
      return out
    }
    case 'watcher':
      return [
        { key: 'watch-check', label: 'Check now', onPress: () => a.watchCheck(ref), isPrimary: true },
        ...(alert.canFresh === true ? [{ key: 'watch-fresh', label: 'Start fresh', onPress: () => a.watchFresh(ref) }] : []),
        { key: 'watch-snooze', label: 'In 30m', onPress: () => a.watchSnooze(ref, 30) },
        { key: 'watch-dismiss', label: 'Dismiss', onPress: () => a.watchDismiss(ref) },
      ]
    case 'held':
      return [
        { key: 'held-back', label: 'Put back', onPress: a.heldPutBack, isPrimary: true },
        { key: 'held-send', label: 'Send now', onPress: a.heldSend },
        { key: 'held-discard', label: 'Discard', onPress: a.heldDiscard },
      ]
    case 'budget':
      return [
        { key: 'budget-go', label: 'Continue anyway', onPress: a.budgetApprove, isPrimary: true },
        { key: 'budget-open', label: `Budget ${G.chevron}`, onPress: () => a.openOps('ops-budget') },
      ]
    case 'suggest':
      return [
        alert.hasTime === true
          ? { key: 'suggest-take', label: 'Create watcher', onPress: a.suggestTake, isPrimary: true }
          : { key: 'suggest-1h', label: 'In 1h', onPress: () => a.suggestAt('in 60m'), isPrimary: true },
        { key: 'suggest-change', label: 'Change time', onPress: () => a.openOps('ops-watchers') },
        { key: 'suggest-ignore', label: 'Ignore', onPress: a.suggestIgnore },
      ]
    case 'load':
      return []
  }
}

const ALERT_MARK: Record<NonNullable<HudModel['alert']>['kind'], string> = { pending: G.warn, awaiting: G.dot, waiting: G.wait, stuck: G.warn, load: G.warn, watcher: G.wait, held: G.warn, budget: G.warn, suggest: G.wait }

/** What needs the person now, on a line of its own above, with its actions. */
function alertLine(kit: Kit, alert: NonNullable<HudModel['alert']>): RenderElement {
  const { Box, Text, Button } = kit.ui
  const actions = alertActions(kit, alert)
  return (
    <Box flexDirection="row" key="hud-alert" alignItems="center" columnGap={2}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} {...clip(kit)}>
        <Box width={INDENT} flexShrink={0}>
          <Text {...toneProps(alert.tone)}>{ALERT_MARK[alert.kind]}</Text>
        </Box>
        <Box flexShrink={1} {...clip(kit)}>
          <Text wrap="truncate-end" bold>
            {alert.text}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" columnGap={1} flexShrink={0}>
        {actions.map(a => (
          <Button key={a.key} label={a.label} variant={a.isPrimary === true ? 'primary' : 'secondary'} onPress={a.onPress} />
        ))}
      </Box>
    </Box>
  )
}

/**
 * The agent band, above everything else and only while subagents run: one line per agent (what it is
 * doing, for how long, its plan's count when it keeps one), or past three one line counting them by what
 * they do. Each line is a control: pressed, it opens Activity → Agents. Gone when no agent runs.
 */
function agentBand(kit: Kit, hud: HudModel): RenderElement | null {
  const band = hud.agentBand
  if (band === null) return null
  const { Box, Text, Button } = kit.ui
  const lineOf = (key: string, label: string, isStarting: boolean) => (
    <Box key={`band-${key}`} flexDirection="row" alignItems="center" {...clip(kit)}>
      <Box width={INDENT} flexShrink={0}>
        <Text {...toneProps('info')}>{isStarting ? G.ring : G.run}</Text>
      </Box>
      <Box flexShrink={1} {...clip(kit)}>
        <Button key={`band-${key}-open`} label={label} plain onPress={kit.actions.openAgents} />
      </Box>
    </Box>
  )
  const rows =
    band.summary !== null
      ? [lineOf('all', `${band.summary} ${G.chevron}`, false)]
      : band.lines.map(l => lineOf(l.id, [l.name, l.doing, l.plan === null ? null : `plan ${l.plan}`, l.elapsedMs === null ? null : fmt.duration(l.elapsedMs)].filter((p): p is string => p !== null && p !== '').join(' · '), l.status === 'starting' || l.status === 'pending'))
  return (
    <Box key="hud-agents" flexDirection="column">
      {rows}
    </Box>
  )
}

/**
 * Kit's lane, only while the companion is on: its surface module (made by the hooks module,
 * which alone may name it) in the terminal and on Desktop, where Kit lives on the surface's own
 * clock; where a surface draws no surface module (VS Code), Kit held still in its mood's pose.
 */
function laneRow(kit: Kit, hud: HudModel, stage: RenderElement | null): RenderElement | null {
  const { Box, Svg } = kit.ui
  const companion = hud.companion
  if (companion === null) return null
  if (stage !== null) {
    return (
      <Box key="hud-lane" flexDirection="row" height={kit.surface === 'terminal' ? 5 : undefined}>
        {stage}
      </Box>
    )
  }
  if (kit.surface === 'terminal' || Svg === undefined) return null
  // An image of a fixed size: never boxed in a frame the surface sizes and paints on its own.
  const width = desktopLanePx(kit.columns)
  const still = kitStillSvg(companion, width)
  return (
    <Box key="hud-lane" flexDirection="row">
      <Svg key="companion" source={still.source} alt={companion.caption} width={still.width} height={still.height} />
    </Box>
  )
}

/** The HUD's top edge in the terminal: a line right under Kit's feet when it is on, a quiet rule otherwise. */
function edgeRow(kit: Kit, hud: HudModel, hasLane: boolean): RenderElement | null {
  const { Text } = kit.ui
  if (kit.surface !== 'terminal') return null
  return (
    <Text key="hud-edge" color="subtle" wrap="truncate-end">
      {(hasLane ? G.edge : G.lineEmpty).repeat(Math.max(4, kit.columns))}
    </Text>
  )
}

// ---------------------------------------------------------------------------
// Desktop and mobile: the same readings laid out by the surface, not by counted cells.
//
//   (▸) Running tests · step 8 of 10                                         ▲ 1 issue   [◆ Control Room]
//   Work                     Context · hands off at 80%     Cache              Machine              5-hour usage
//   ●━●━◉─○─○  2 of 10       ▬▬▬▬▬▬▬▬┃▬▬▬  24%              ◔ warm · 345k      CPU ▮ 34%  RAM ▮ 85%   ▂▂▂ 63% · 2h14m
//
// Each reading is a column weighted by what it holds (Work and Context wider, Cache and Machine
// narrower; the plan's five-hour use takes what it needs at the right edge), on a zero basis, so the columns
// never drift as values change and no cell is left with a hole. Every reading keeps its column, a
// quiet `—` standing in for one with nothing yet. Width decides the detail: three tiers, each sized
// so every cell fits (from about 500 pixels to a full window). Every graphic is an image of a fixed
// size (never a sandboxed frame, which Desktop sizes on its own and may paint opaque).

/** One part of a cell's value line: an optional dim label, an optional graphic, and its value. */
export type CellPart = { key: string; label?: Span[]; graphic?: { source: string; alt: string; width: number; height: number }; value: Span[] }

/** One instrument on the remote surfaces: its caption over its parts, its column's weight. */
export type Cell = { key: string; caption: Span[]; parts: CellPart[]; weight: number; isEnd?: boolean }

/** How much a cell row shows at a width: compact below 80 columns, wide from 110. */
export type CellTier = 'compact' | 'medium' | 'wide'

export const cellTierOf = (columns: number): CellTier => (columns < 80 ? 'compact' : columns < 110 ? 'medium' : 'wide')

/** The columns' weights: Work and Context hold graphics and words, Cache and Machine a mark and a value. */
const WEIGHT = { work: 3, ctx: 3, cache: 2, machine: 2 } as const

/** The work track's stop pitch in pixels at each tier. */
const PITCH: Record<CellTier, number> = { compact: 12, medium: 14, wide: 16 }

/** CSS pixels per column, on the low side (Desktop's text is about 8): graphics sized by it always fit their column. */
const PX_PER_COLUMN = 7.5

/**
 * Columns the row spends outside the weighted cells: four gaps of three, and the five-hour reading at
 * the right edge (its thin bar and "63% · 2h14m"; "63%" alone in the compact tier).
 */
const ROW_OVERHEAD: Record<CellTier, number> = { compact: 21, medium: 30, wide: 30 }

/** The five-hour bar's width in pixels at each tier. */
const PLAN_PX: Record<CellTier, number> = { compact: 24, medium: 32, wide: 40 }

/**
 * The graphics' sizes for a width: each fills its column (its weight's share of the row) less the
 * room its value needs, so a wide window has no hole inside a cell and a narrow one never overflows.
 * They depend on the width alone, never on the values, so nothing drifts as readings change.
 */
export function graphicsFor(columns: number, tier: CellTier): { stops: number; pitch: number; meter: number } {
  const share = Math.max(0, columns - ROW_OVERHEAD[tier]) / (WEIGHT.work + WEIGHT.ctx + WEIGHT.cache + WEIGHT.machine)
  const pitch = PITCH[tier]
  // Work: the track, a gap and "12 of 16" (or "2/10"); Context: the meter, a gap and "100%".
  const workPx = WEIGHT.work * share * PX_PER_COLUMN - (tier === 'wide' ? 10 : 6) * PX_PER_COLUMN
  const ctxPx = WEIGHT.ctx * share * PX_PER_COLUMN - 5 * PX_PER_COLUMN
  const stops = Math.max(5, Math.min(16, Math.floor((workPx - 13) / pitch) + 1))
  return { stops, pitch, meter: Math.round(Math.max(56, Math.min(280, ctxPx))) }
}

/** What the cache's clock says to a screen reader. */
function cacheAlt(cache: NonNullable<HudModel['cache']>): string {
  if (cache.parked !== undefined) return `Prompt cache ${cache.parked.text} while the watcher parks the run`
  return cache.warmth === 'warm' ? `Prompt cache warm${cache.leftMs === null ? '' : `, about ${cache.text} left`}` : `Prompt cache ${cache.text}`
}

/** The prompt cache's words in its cell: what it holds while warm, its time left near the expiry or while you are away, what became of it. */
function cacheWord(cache: NonNullable<HudModel['cache']>, tier: CellTier): string {
  if (cache.parked !== undefined) {
    if (tier === 'compact') return cache.parked.short
    return tier === 'wide' && cache.cachedTokens > 0 ? `${cache.parked.text} · ${fmt.tokens(cache.cachedTokens)}` : cache.parked.text
  }
  if (cache.recentMiss !== null || cache.warmth !== 'warm') return cache.text
  // A turn's requests keep the cache warm; its time left matters only near the expiry (a long call).
  const left = cache.leftMs === null || (cache.isInUse && cache.tone !== 'warn') ? null : cache.text
  if (tier === 'compact') return left ?? 'warm'
  const state = left === null ? 'warm' : `${left} left`
  return tier === 'wide' && cache.cachedTokens > 0 ? `${state} · ${fmt.tokens(cache.cachedTokens)}` : state
}

const none = (text: string = G.none): Span[] => [{ text, isDim: true }]

/** The instruments as cells for a width (its tier decides the words, the width the graphics' sizes). */
export function hudCells(hud: HudModel, columns: number): Cell[] {
  const tier = cellTierOf(columns)
  const size = graphicsFor(columns, tier)
  const cells: Cell[] = []
  const caption = (text: string): Span[] => [{ text, isDim: true }]

  const work = hud.work
  if (work === null || work.total === 0) {
    cells.push({ key: 'work', caption: caption('Work'), parts: [{ key: 'v', value: none(tier === 'compact' ? 'None' : 'No milestones yet') }], weight: WEIGHT.work })
  } else {
    const isDone = work.done === work.total
    const stops = scaleTrack(work.track.length === work.total ? work.track : fallbackTrack(work.done, work.total, work.current !== null), size.stops)
    const height = 14
    const source = svgWorkTrack({ stops, height, pitch: size.pitch })
    const width = Math.round(2 * (Math.max(3, height / 2 - 2) + 1.5) + (stops.length - 1) * size.pitch)
    cells.push({
      key: 'work',
      caption: caption('Work'),
      parts: [{ key: 'v', graphic: { source, alt: `Work: ${work.done} of ${work.total} milestones done`, width, height }, value: [{ text: tier === 'wide' ? `${work.done} of ${work.total}` : `${work.done}/${work.total}`, tone: isDone ? 'good' : undefined, isBold: true }] }],
      weight: WEIGHT.work,
    })
  }

  const ctx = hud.ctx
  const event = hud.autopilot.isOn && hud.autopilot.state !== 'armed' && hud.autopilot.state !== 'off' ? hud.autopilot.text : null
  if (ctx.pct === null || ctx.tokens === null || ctx.window === null || ctx.window <= 0) {
    cells.push({ key: 'ctx', caption: caption('Context'), parts: [{ key: 'v', value: none() }], weight: WEIGHT.ctx })
  } else {
    const fraction = ctx.tokens / ctx.window
    const marker = ctx.threshold === null ? null : ctx.threshold / ctx.window
    const tone: Tone = ctx.tone === 'muted' || ctx.tone === 'normal' ? 'good' : ctx.tone
    // The handoff point is the meter's notch; the wide tier also says it in words.
    const note: Span[] =
      event !== null
        ? [{ text: ` · ${event}`, tone: 'info' }]
        : marker !== null && hud.autopilot.isOn && tier === 'wide'
          ? [{ text: ` · hands off at ${Math.round(marker * 100)}%`, isDim: true }]
          : []
    const width = size.meter
    cells.push({
      key: 'ctx',
      caption: [...caption('Context'), ...note],
      parts: [{ key: 'v', graphic: { source: svgContextMeter({ fraction, marker, tone, width, height: 14 }), alt: `Context ${ctx.pct}% used`, width, height: 14 }, value: [{ text: `${ctx.pct}%`, tone: valueTone(ctx.tone), isBold: true }] }],
      weight: WEIGHT.ctx,
    })
  }

  const cache = hud.cache
  if (cache === null || cache.warmth === 'none') {
    cells.push({ key: 'cache', caption: caption('Cache'), parts: [{ key: 'v', value: none() }], weight: WEIGHT.cache })
  } else {
    const glyphTone: Tone = cache.tone === 'normal' ? 'info' : cache.tone
    const alt = cacheAlt(cache)
    cells.push({
      key: 'cache',
      caption: caption('Cache'),
      parts: [{ key: 'v', graphic: { source: svgClock({ fraction: cache.fraction, tone: glyphTone, size: 14 }), alt, width: 14, height: 14 }, value: [{ text: cacheWord(cache, tier), tone: cache.tone === 'warn' ? 'warn' : undefined, isDim: cache.tone === 'muted' ? true : undefined }] }],
      weight: WEIGHT.cache,
    })
  }

  // Machine: CPU and memory, each a slim level bar and its percentage, from the sampler's live readings.
  // While a watcher parks the run nothing runs, so the cell counts down to its wake instead.
  const load = hud.load
  const watcher = sleepingWatcher(hud)
  if (watcher !== null) {
    cells.push({
      key: 'machine',
      caption: caption(tier === 'compact' ? 'Wakes' : 'Watcher'),
      parts: [
        {
          key: 'v',
          graphic: { source: svgStateIcon('sleeping', 14), alt: `Watcher ${watcher.id} wakes the run at ${watcher.at}`, width: 16, height: 14 },
          value: [{ text: watcher.left, isBold: true }, ...(tier === 'compact' ? [] : [{ text: ` · ${watcher.at}`, isDim: true }])],
        },
      ],
      weight: WEIGHT.machine,
    })
  } else if (load === null || (load.cpu === null && load.ram === null)) {
    cells.push({ key: 'machine', caption: caption('Machine'), parts: [{ key: 'v', value: none() }], weight: WEIGHT.machine })
  } else {
    const isWide = tier === 'wide'
    const reading = (key: 'cpu' | 'ram', label: string, value: number | null, tone: Tone): CellPart => ({
      key,
      label: isWide ? [{ text: label, isDim: true }] : undefined,
      graphic: tier === 'compact' || value === null ? undefined : { source: svgLevel({ fraction: value / 100, tone, height: 14 }), alt: `${label} ${Math.round(value)}%`, width: 6, height: 14 },
      value: value === null ? none() : [{ text: `${Math.round(value)}%`, tone: valueTone(tone), isBold: tone === 'bad' ? true : undefined }],
    })
    cells.push({
      key: 'machine',
      // Narrower tiers name the two readings once, in their order, over their values.
      caption: caption(isWide ? 'Machine' : 'CPU · RAM'),
      parts: [reading('cpu', 'CPU', load.cpu, load.cpuTone), reading('ram', 'RAM', load.ram, load.ramTone)],
      weight: WEIGHT.machine,
    })
  }

  cells.push({ ...planCell(hud.plan.five, tier), weight: 0, isEnd: true })
  return cells
}

/**
 * The plan's five-hour use at the right edge: its thin bar, the percentage and the time to its reset
 * (the percentage alone when compact); the reset and the limit in words; "—" before a reading, under
 * "Plan usage" on an account with no five-hour window.
 */
function planCell(five: HudModel['plan']['five'], tier: CellTier): Omit<Cell, 'weight' | 'isEnd'> {
  const caption: Span[] = [{ text: tier === 'compact' ? '5h' : '5-hour usage', isDim: true }]
  const left = (ms: number | null, tone?: Tone): Span[] => (ms === null || tier === 'compact' ? [] : [{ text: ` · ${fmt.countdown(ms, true)}`, isDim: tone === undefined, tone }])
  switch (five.kind) {
    case 'absent':
      return { key: 'plan', caption: [{ text: 'Plan usage', isDim: true }], parts: [{ key: 'v', value: none() }] }
    case 'pending':
      return { key: 'plan', caption, parts: [{ key: 'v', value: none() }] }
    case 'reset':
      return { key: 'plan', caption, parts: [{ key: 'v', value: none(tier === 'compact' ? 'reset' : 'reset · new window') }] }
    case 'limited': {
      const word = five.window === 'seven_day' ? '7-day limit' : five.window === null ? 'rate limited' : 'limit reached'
      return { key: 'plan', caption, parts: [{ key: 'v', value: [{ text: tier === 'compact' && five.window === 'five_hour' ? 'limit' : word, tone: 'bad', isBold: true }, ...left(five.leftMs, 'bad')] }] }
    }
    case 'reading': {
      const width = PLAN_PX[tier]
      return {
        key: 'plan',
        caption,
        parts: [
          {
            key: 'v',
            graphic: { source: svgThinMeter({ fraction: five.percent / 100, tone: five.isHigh ? 'warn' : 'info', width, height: 14 }), alt: planAlt(five), width, height: 14 },
            value: [{ text: fmt.percent(five.percent), tone: five.isHigh ? 'warn' : undefined, isBold: true }, ...left(five.leftMs)],
          },
        ],
      }
    }
  }
}

function cellsRow(kit: Kit, hud: HudModel): RenderElement {
  const { Box, Text, Svg } = kit.ui
  const cells = hudCells(hud, kit.columns)
  const line = (key: string, spans: readonly Span[]) => <Text key={key} wrap="truncate-end">{spans.map((p, i) => spanEl(kit, `${key}-${i}`, p))}</Text>
  return (
    <Box key="hud-cells" flexDirection="row" columnGap={3} alignItems="flex-start">
      {cells.map(c => (
        <Box
          key={`cell-${c.key}`}
          flexDirection="column"
          // Weighted columns on a zero basis: fixed shares that never drift; the five-hour reading takes what it needs at the
          // right edge. Every caption starts where its reading starts, the last cell's too (flush right, the caption sat
          // apart from its wider reading).
          flexGrow={c.isEnd === true ? 0 : c.weight}
          flexShrink={c.isEnd === true ? 0 : 1}
          width={c.isEnd === true ? undefined : 0}
          alignItems="flex-start"
          {...clip(kit)}
        >
          {line(`cell-${c.key}-caption`, c.caption)}
          <Box flexDirection="row" alignItems="center" columnGap={1.5} {...clip(kit)}>
            {c.parts.map(part => (
              <Box key={`cell-${c.key}-${part.key}`} flexDirection="row" alignItems="center" columnGap={part.label === undefined ? 1 : 0.5} flexShrink={0}>
                {part.label === undefined ? null : line(`cell-${c.key}-${part.key}-label`, part.label)}
                {part.graphic === undefined || Svg === undefined ? null : (
                  <Box flexShrink={0}>
                    <Svg key={`cell-${c.key}-${part.key}-svg`} source={part.graphic.source} alt={part.graphic.alt} width={part.graphic.width} height={part.graphic.height} />
                  </Box>
                )}
                {line(`cell-${c.key}-${part.key}-value`, part.value)}
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function nativeHud(kit: Kit, hud: HudModel, stage: RenderElement | null): RenderElement {
  const { Box } = kit.ui
  return (
    <Box flexDirection="column" rowGap={1}>
      {agentBand(kit, hud)}
      {hud.alert === null ? null : alertLine(kit, hud.alert)}
      {laneRow(kit, hud, stage)}
      {headlineRow(kit, hud)}
      {cellsRow(kit, hud)}
    </Box>
  )
}

export function hudView(kit: Kit, hud: HudModel, stage: RenderElement | null = null): RenderElement {
  const { Box } = kit.ui
  if (kit.surface !== 'terminal') return nativeHud(kit, hud, stage)
  const lane = laneRow(kit, hud, stage)
  return (
    <Box flexDirection="column">
      {agentBand(kit, hud)}
      {hud.alert === null ? null : alertLine(kit, hud.alert)}
      {lane}
      {edgeRow(kit, hud, lane !== null)}
      {headlineRow(kit, hud)}
      {instrumentsRow(kit, hud)}
    </Box>
  )
}
