/**
 * The design system's tokens. Colors are Claude Code theme keys, so every
 * drawing follows the person's theme (dark, light, daltonized, ANSI) on the
 * terminal and on Desktop. Glyphs are single-cell BMP characters.
 *
 * Restraint is the rule: text is the default color, secondary text is dim,
 * the accent marks the brand and the selected place, and status colors are
 * reserved for state that needs a look.
 */

import type { HudState, TabId, TimelineKind, Tone, TrackStop } from '../../types'

export type ColorProps = { color?: string; dimColor?: boolean; bold?: boolean }

export function toneProps(tone: Tone): ColorProps {
  switch (tone) {
    case 'normal':
      return {}
    case 'muted':
      return { dimColor: true }
    case 'good':
      return { color: 'success' }
    case 'warn':
      return { color: 'warning' }
    case 'bad':
      return { color: 'error' }
    case 'accent':
      return { color: 'claude' }
    case 'info':
      return { color: 'suggestion' }
  }
}

/**
 * Each section's accent, a theme key: its card titles and its tab indicator,
 * nothing more. One quiet hue per place, so the eye learns where it is.
 */
export const ACCENT: Record<TabId, string> = {
  overview: 'claude',
  context: 'ide',
  behavior: 'autoAccept',
  guardrails: 'planMode',
  activity: 'suggestion',
  setup: 'inactive',
}

/** The colors drawn into SVG (Desktop, mobile), where theme keys do not reach. */
export const SVG_COLOR: Record<Tone, string> = {
  normal: '#8E8E93',
  muted: '#8E8E93',
  good: '#30B158',
  warn: '#F2A33A',
  bad: '#E5534B',
  accent: '#D97757',
  info: '#4C8DF6',
}

export const G = {
  brand: '◆',
  dot: '●',
  ring: '○',
  mid: '·',
  chevron: '›',
  back: '‹',
  down: '▾',
  up: '▴',
  top: '↑',
  arrow: '▸',
  lineFull: '━',
  lineEmpty: '─',
  marker: '┃',
  /**
   * The status bar's context meter: a solid bar, filled in its tone over a dim track of the same
   * block, with the handoff point as a notch. A bar, never a line of stops, so it reads apart from
   * the work track.
   */
  segFull: '▇',
  segEmpty: '▇',
  /** A full-height block: it stands a little proud of the bar's seven-eighths blocks, with no gap beside it. */
  notch: '█',
  /** The status bar's top edge under Kit: a line at the top of its row, right under Kit's feet. */
  edge: '▔',
  /** Work: one square per milestone, filled when done. Never a line, so it reads apart from context. */
  square: '■',
  squareOpen: '□',
  rule: '─',
  ok: '✓',
  fail: '✗',
  stop: '⊘',
  /** Under way: a call running, a milestone in progress. */
  run: '▸',
  /** A milestone done and being verified. */
  verify: '◎',
  /** Waiting for a result that will come by itself (a job, a scheduled run). */
  wait: '◷',
  warn: '▲',
  minus: '−',
  plus: '+',
  none: '—',
  /** The Quest log: a level, an achievement earned and one still to earn. */
  star: '★',
  starOpen: '☆',
  /** A turn's time strip: a cell with a call running, and one where Claude was thinking. */
  busy: '▅',
  idle: '▁',
  spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const,
  /** Work as a track of milestones: done, the one under way, to come, joined by a thin line. */
  stepDone: '●',
  stepNow: '◉',
  stepOpen: '○',
  stepJoin: '─',
  /** The cache's time left, as a clock face emptying: full, three quarters, half, a quarter, none. */
  clock: ['○', '◔', '◑', '◕', '●'] as const,
  /**
   * The plan's five-hour use: a thin bar on the line's foot, used in its tone over the quietest gray.
   * Thin, so it never reads as the context meter's solid bar, the cache's clock or the work track.
   */
  thin: '▂',
} as const

/** A sparkline of 0–100 values: "▁▂▄▆█". */
export function sparkline(values: readonly number[], width: number): string {
  const v = values.slice(-Math.max(1, width))
  return v.map(n => G.spark[Math.min(7, Math.max(0, Math.floor((Math.max(0, Math.min(100, n)) / 100) * 7.999)))]).join('')
}

/**
 * The cells of a line meter: how many are filled, and where the marker sits
 * (or -1). A reading past the marker always shows at least one filled cell
 * beyond it, so a coarse meter never hides "past the threshold" under the
 * tick (60k of a 1M window in ten cells).
 */
export function meterCells(fraction: number, width: number, markerAt?: number | null): { filled: number; marker: number; width: number } {
  const w = Math.max(3, Math.floor(width))
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const hasMarker = markerAt !== undefined && markerAt !== null && Number.isFinite(markerAt)
  const marker = hasMarker ? Math.min(w - 1, Math.max(0, Math.round(markerAt * w) - 1)) : -1
  const filled = Math.round(f * w)
  const isPast = hasMarker && f > markerAt
  return { filled: isPast ? Math.min(w, Math.max(filled, marker + 2)) : filled, marker, width: w }
}

/** The same meter as one plain string ("━━━━──┃──"), for the status line and tests. */
export function meter(fraction: number, width: number, markerAt?: number | null): string {
  const c = meterCells(fraction, width, markerAt)
  return Array.from({ length: c.width }, (_, i) => (i === c.marker ? G.marker : i < c.filled ? G.lineFull : G.lineEmpty)).join('')
}

/** A rounded horizontal bar with an optional threshold tick, as SVG for the remote surfaces. */
export function svgBar(input: { fraction: number; marker?: number | null; tone: Tone; width: number; height?: number }): string {
  const w = Math.max(40, Math.round(input.width))
  const h = input.height ?? 10
  const track = Math.max(4, h - 4)
  const y = Math.round((h - track) / 2)
  const f = Number.isFinite(input.fraction) ? Math.min(1, Math.max(0, input.fraction)) : 0
  const fill = Math.max(f > 0 ? track : 0, Math.round(f * w))
  const tick =
    input.marker === undefined || input.marker === null || !Number.isFinite(input.marker)
      ? ''
      : `<rect x="${Math.max(0, Math.min(w - 2, Math.round(input.marker * w) - 1))}" y="0" width="2" height="${h}" rx="1" fill="${SVG_COLOR.accent}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${SVG_ROOT_STYLE}` +
    `<rect x="0" y="${y}" width="${w}" height="${track}" rx="${track / 2}" fill="#8E8E93" fill-opacity="0.25"/>` +
    (fill > 0 ? `<rect x="0" y="${y}" width="${fill}" height="${track}" rx="${track / 2}" fill="${SVG_COLOR[input.tone]}"/>` : '') +
    tick +
    `</svg>`
  )
}

/**
 * The cells of a milestone strip: one per milestone while they fit in
 * `max`, else scaled (the "4/31" beside it stays exact). `current` is the
 * milestone under way, or -1 when scaled or none.
 */
export function workCells(done: number, total: number, max: number, hasCurrent: boolean): { done: number; current: number; width: number } {
  const t = Math.max(0, Math.floor(total))
  const d = Math.min(t, Math.max(0, Math.floor(done)))
  if (t <= max) return { done: d, current: hasCurrent && d < t ? d : -1, width: t }
  const width = Math.max(1, Math.floor(max))
  const filled = d === t ? width : Math.min(width - 1, Math.round((d / t) * width))
  return { done: filled, current: -1, width }
}

/** Separate rounded segments, one per milestone (scaled past `max`), as SVG for the remote surfaces. */
export function svgSegments(input: { done: number; total: number; hasCurrent: boolean; max: number; width: number; height?: number }): string {
  const h = input.height ?? 10
  const c = workCells(input.done, input.total, input.max, input.hasCurrent)
  const gap = 3
  const w = Math.max(24, Math.round(input.width))
  const seg = Math.max(3, (w - gap * (c.width - 1)) / Math.max(1, c.width))
  const y = Math.max(0, Math.round((h - 6) / 2))
  const rects = Array.from({ length: c.width }, (_, i) => {
    const x = (i * (seg + gap)).toFixed(1)
    const fill = i < c.done ? `fill="${SVG_COLOR.info}"` : i === c.current ? `fill="${SVG_COLOR.info}" fill-opacity="0.45"` : `fill="#8E8E93" fill-opacity="0.3"`
    return `<rect x="${x}" y="${y}" width="${seg.toFixed(1)}" height="6" rx="2" ${fill}/>`
  }).join('')
  return svgDoc(w, h, rects)
}

/** A stop on the milestone track. */
export type Stop = 'done' | 'now' | 'open'

/**
 * The milestone track's stops: one per milestone while they fit in `max`,
 * else scaled (the "4/31" beside it stays exact), the one under way marked.
 */
export function trackStops(done: number, total: number, max: number, hasCurrent: boolean): Stop[] {
  const c = workCells(done, total, max, hasCurrent)
  const now = c.current >= 0 ? c.current : hasCurrent && c.done < c.width ? c.done : -1
  return Array.from({ length: c.width }, (_, i) => (i < c.done ? 'done' : i === now ? 'now' : 'open'))
}

/**
 * The milestone track as SVG: stops joined by a line, filled up to the work
 * done. The one under way pulses when `isAnimated` (an interactive Svg runs
 * SMIL; drawn as an image it holds still).
 */
export function svgTrack(input: { stops: readonly Stop[]; width: number; height?: number; isAnimated?: boolean }): string {
  const h = input.height ?? 10
  const n = Math.max(1, input.stops.length)
  const r = Math.max(2, h / 2 - 1)
  const w = Math.max(Math.round(2 * r + 2), Math.round(input.width))
  const gap = n > 1 ? (w - 2 * r - 2) / (n - 1) : 0
  const x = (i: number) => (1 + r + i * gap).toFixed(1)
  const cy = (h / 2).toFixed(1)
  const lastDone = input.stops.lastIndexOf('done')
  const line = n > 1 ? `<line x1="${x(0)}" x2="${x(n - 1)}" y1="${cy}" y2="${cy}" stroke="#8E8E93" stroke-opacity="0.4" stroke-width="1.5"/>` : ''
  const filled = lastDone > 0 ? `<line x1="${x(0)}" x2="${x(lastDone)}" y1="${cy}" y2="${cy}" stroke="${SVG_COLOR.info}" stroke-width="1.5"/>` : ''
  const stops = input.stops
    .map((s, i) => {
      if (s === 'done') return `<circle cx="${x(i)}" cy="${cy}" r="${(r - 0.5).toFixed(1)}" fill="${SVG_COLOR.info}"/>`
      if (s === 'open') return `<circle cx="${x(i)}" cy="${cy}" r="${(r - 1).toFixed(1)}" fill="#FFFFFF" fill-opacity="0" stroke="#8E8E93" stroke-opacity="0.7" stroke-width="1.2"/>`
      const pulse = input.isAnimated === true ? `<animate attributeName="fill-opacity" values="0.35;0.9;0.35" dur="1.8s" repeatCount="indefinite"/>` : ''
      return `<circle cx="${x(i)}" cy="${cy}" r="${(r - 0.5).toFixed(1)}" fill="${SVG_COLOR.info}" fill-opacity="0.45" stroke="${SVG_COLOR.info}" stroke-width="1.2">${pulse}</circle>`
    })
    .join('')
  return svgDoc(w, h, `${line}${filled}${stops}`)
}

// ---------------------------------------------------------------------------
// The status bar's instruments: the work track, the context meter and the
// state marks, as glyphs in the terminal and as SVG on the remote surfaces.

/**
 * The root style every SVG carries. Desktop draws an interactive SVG in a
 * sandboxed frame, and a frame whose document has another color scheme than
 * the page is painted with an opaque canvas (white on a dark page); declaring
 * both schemes lets the frame follow the page, so it stays transparent.
 */
export const SVG_ROOT_STYLE = '<style>:root{color-scheme:light dark}</style>'

/** An SVG document of `w` × `h` CSS pixels, transparent on every theme. */
export const svgDoc = (w: number, h: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${SVG_ROOT_STYLE}${body}</svg>`

/**
 * The work track at most `max` stops wide: one stop per milestone while they
 * fit, else each stop stands for a stretch of them, showing the most telling
 * state in it (under way, then being verified, then held, then done only when
 * all of it is done). The count beside the track stays exact.
 */
export function scaleTrack(track: readonly TrackStop[], max: number): TrackStop[] {
  const n = track.length
  const m = Math.max(1, Math.floor(max))
  if (n <= m) return [...track]
  const rank: TrackStop[] = ['now', 'verify', 'held']
  return Array.from({ length: m }, (_, i) => {
    const part = track.slice(Math.floor((i * n) / m), Math.floor(((i + 1) * n) / m))
    return rank.find(r => part.includes(r)) ?? (part.every(s => s === 'done') ? 'done' : 'open')
  })
}

/** A stop's glyph and look in the terminal. */
export const STOP_LOOK: Record<TrackStop, { glyph: string; tone?: Tone; isBold?: boolean; isDim?: boolean }> = {
  done: { glyph: '●', tone: 'info' },
  now: { glyph: '◉', tone: 'info', isBold: true },
  verify: { glyph: '◎', tone: 'info' },
  held: { glyph: '◌', tone: 'warn' },
  open: { glyph: '○', isDim: true },
}

/**
 * The work track as SVG: stops joined by a line, the stretch done drawn in
 * the work color, the one under way ringed, one being verified half filled,
 * one held in amber, the rest hollow.
 */
export function svgWorkTrack(input: { stops: readonly TrackStop[]; height?: number; pitch?: number }): string {
  const h = input.height ?? 14
  const pitch = input.pitch ?? 16
  const n = Math.max(1, input.stops.length)
  const r = Math.max(3, h / 2 - 2)
  const w = Math.round(2 * (r + 1.5) + (n - 1) * pitch)
  const cx = (i: number) => (r + 1.5 + i * pitch).toFixed(1)
  const cy = (h / 2).toFixed(1)
  const blue = SVG_COLOR.info
  const lastDone = input.stops.lastIndexOf('done')
  const line = n > 1 ? `<line x1="${cx(0)}" x2="${cx(n - 1)}" y1="${cy}" y2="${cy}" stroke="#8E8E93" stroke-opacity="0.45" stroke-width="2"/>` : ''
  const filled = lastDone > 0 ? `<line x1="${cx(0)}" x2="${cx(lastDone)}" y1="${cy}" y2="${cy}" stroke="${blue}" stroke-width="2"/>` : ''
  const stops = input.stops
    .map((s, i) => {
      switch (s) {
        case 'done':
          return `<circle cx="${cx(i)}" cy="${cy}" r="${r.toFixed(1)}" fill="${blue}"/>`
        case 'now':
          return `<circle cx="${cx(i)}" cy="${cy}" r="${r.toFixed(1)}" fill="${blue}" fill-opacity="0.22" stroke="${blue}" stroke-width="2"/><circle cx="${cx(i)}" cy="${cy}" r="${(r / 2.4).toFixed(1)}" fill="${blue}"/>`
        case 'verify':
          return `<circle cx="${cx(i)}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="${blue}" stroke-width="2"/><path d="M${cx(i)} ${(h / 2 - r).toFixed(1)} A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${cx(i)} ${(h / 2 + r).toFixed(1)} Z" fill="${blue}"/>`
        case 'held':
          return `<circle cx="${cx(i)}" cy="${cy}" r="${(r - 0.5).toFixed(1)}" fill="none" stroke="${SVG_COLOR.warn}" stroke-width="2" stroke-dasharray="2.2 1.6"/>`
        case 'open':
          return `<circle cx="${cx(i)}" cy="${cy}" r="${(r - 0.5).toFixed(1)}" fill="none" stroke="#8E8E93" stroke-opacity="0.75" stroke-width="1.5"/>`
      }
    })
    .join('')
  return svgDoc(w, h, `${line}${filled}${stops}`)
}

/**
 * A machine reading's level as SVG: a slim upright bar filling from the bottom, in its tone (blue
 * while calm, amber near a ceiling, red at it), so two readings sit side by side in a narrow cell.
 */
export function svgLevel(input: { fraction: number; tone: Tone; height?: number }): string {
  const h = input.height ?? 14
  const w = 6
  const f = Number.isFinite(input.fraction) ? Math.min(1, Math.max(0, input.fraction)) : 0
  const fill = f > 0 ? Math.max(2, Math.round(f * h)) : 0
  return svgDoc(
    w,
    h,
    `<rect x="0" y="0" width="${w}" height="${h}" rx="2" fill="#8E8E93" fill-opacity="0.22"/>` +
      (fill > 0 ? `<rect x="0" y="${h - fill}" width="${w}" height="${fill}" rx="2" fill="${SVG_COLOR[input.tone === 'good' || input.tone === 'normal' ? 'info' : input.tone]}"/>` : ''),
  )
}

/** The plan's five-hour use as SVG: a thin rounded bar (4 px) on a quiet track, filled in its tone. */
export function svgThinMeter(input: { fraction: number; tone: Tone; width: number; height?: number }): string {
  const w = Math.max(16, Math.round(input.width))
  const h = input.height ?? 14
  const bar = 4
  const y = (h - bar) / 2
  const f = Number.isFinite(input.fraction) ? Math.min(1, Math.max(0, input.fraction)) : 0
  const fill = f > 0 ? Math.max(bar, Math.round(f * w)) : 0
  return svgDoc(
    w,
    h,
    `<rect x="0" y="${y}" width="${w}" height="${bar}" rx="2" fill="#8E8E93" fill-opacity="0.22"/>` +
      (fill > 0 ? `<rect x="0" y="${y}" width="${fill}" height="${bar}" rx="2" fill="${SVG_COLOR[input.tone]}"/>` : ''),
  )
}

/**
 * The context meter as SVG: a rounded bar, filled in its tone, with the
 * handoff point as an orange notch that stands proud of the bar above and
 * below, so it reads as a line the fill must not cross.
 */
export function svgContextMeter(input: { fraction: number; marker: number | null; tone: Tone; width: number; height?: number }): string {
  const w = Math.max(48, Math.round(input.width))
  const h = input.height ?? 14
  const bar = Math.max(6, h - 6)
  const y = (h - bar) / 2
  const f = Number.isFinite(input.fraction) ? Math.min(1, Math.max(0, input.fraction)) : 0
  const fill = f > 0 ? Math.max(bar, Math.round(f * w)) : 0
  const mx = input.marker === null || !Number.isFinite(input.marker) ? null : Math.max(1.5, Math.min(w - 1.5, input.marker * w))
  return svgDoc(
    w,
    h,
    `<rect x="0" y="${y}" width="${w}" height="${bar}" rx="${bar / 2}" fill="#8E8E93" fill-opacity="0.22"/>` +
      (fill > 0 ? `<rect x="0" y="${y}" width="${fill}" height="${bar}" rx="${bar / 2}" fill="${SVG_COLOR[input.tone]}"/>` : '') +
      (mx === null ? '' : `<rect x="${(mx - 1.5).toFixed(1)}" y="0" width="3" height="${h}" rx="1.5" fill="${SVG_COLOR.accent}"/>`),
  )
}

/** The headline's state marks: a glyph and tone in the terminal, a small drawn icon on the remote surfaces. */
export const STATE_MARK: Record<HudState, { glyph: string; tone: Tone }> = {
  ready: { glyph: '○', tone: 'muted' },
  idle: { glyph: '○', tone: 'muted' },
  thinking: { glyph: '◌', tone: 'muted' },
  working: { glyph: '▸', tone: 'info' },
  validating: { glyph: '◎', tone: 'info' },
  waitingUser: { glyph: '◆', tone: 'warn' },
  waitingExternal: { glyph: '◷', tone: 'info' },
  blocked: { glyph: '⊘', tone: 'bad' },
  handoff: { glyph: '↻', tone: 'info' },
  done: { glyph: '✓', tone: 'good' },
  complete: { glyph: '✓', tone: 'good' },
  failing: { glyph: '✗', tone: 'bad' },
  sleeping: { glyph: '◷', tone: 'info' },
}

/** The same marks drawn as 16-pixel icons. */
export function svgStateIcon(state: HudState, lineHeight = 16): string {
  const s = 16
  const c = SVG_COLOR[STATE_MARK[state].tone]
  const ring = (fill: string, extra = '') => `<circle cx="8" cy="8" r="6.2" fill="${fill}" stroke="${c}" stroke-width="1.6"${extra}/>`
  let body: string
  switch (state) {
    case 'working':
      body = `${ring(c, ' fill-opacity="0.16"')}<path d="M6.4 5.2 L11 8 L6.4 10.8 Z" fill="${c}"/>`
      break
    case 'thinking':
      body = `<circle cx="4" cy="8" r="1.5" fill="${c}"/><circle cx="8" cy="8" r="1.5" fill="${c}"/><circle cx="12" cy="8" r="1.5" fill="${c}"/>`
      break
    case 'validating':
      body = `${ring('none')}<circle cx="8" cy="8" r="2.6" fill="${c}"/>`
      break
    case 'waitingUser':
      body = `<path d="M8 1.8 L14.2 8 L8 14.2 L1.8 8 Z" fill="${c}" fill-opacity="0.2" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>`
      break
    case 'waitingExternal':
      body = `${ring('none')}<path d="M8 4.6 V8 L10.6 9.6" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`
      break
    case 'blocked':
      body = `${ring('none')}<path d="M4.2 11.8 L11.8 4.2" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`
      break
    case 'handoff':
      body = `<path d="M12.6 6.4 A5 5 0 1 0 13 9.4" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/><path d="M13.6 2.8 L13 6.6 L9.4 5.8" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
      break
    case 'done':
    case 'complete':
      body = `${ring(c, ' fill-opacity="0.16"')}<path d="M5 8.2 L7.2 10.4 L11.2 6" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
      break
    case 'failing':
      body = `${ring(c, ' fill-opacity="0.16"')}<path d="M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`
      break
    case 'ready':
    case 'idle':
      body = ring('none')
      break
    case 'sleeping':
      // A crescent: the run sleeps until its watcher wakes it.
      body = `<path d="M10.6 2.6 A5.8 5.8 0 1 0 13.6 10.4 A4.6 4.6 0 0 1 10.6 2.6 Z" fill="${c}" fill-opacity="0.2" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/>`
      break
  }
  // Centred in a canvas one text line tall, so lined up with the top of a block it sits on that line.
  const h = Math.max(s, lineHeight)
  return svgDoc(s, h, h === s ? body : `<g transform="translate(0 ${(h - s) / 2})">${body}</g>`)
}

/** The cache's time left as a clock-face glyph: ● full, ◕ ◑ ◔ emptying, ○ none. */
export function clockGlyph(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction) || fraction <= 0) return G.clock[0]
  return G.clock[Math.min(4, Math.max(1, Math.ceil(Math.min(1, fraction) * 4)))] ?? G.clock[0]
}

/** The same clock face as SVG: a ring, and a wedge from twelve o'clock for the time left. */
export function svgClock(input: { fraction: number | null; tone: Tone; size?: number }): string {
  const s = input.size ?? 12
  const c = s / 2
  const r = s / 2 - 1
  const f = input.fraction === null || !Number.isFinite(input.fraction) ? 0 : Math.min(1, Math.max(0, input.fraction))
  const color = SVG_COLOR[input.tone]
  const ring = `<circle cx="${c}" cy="${c}" r="${r.toFixed(1)}" fill="none" stroke="${f > 0 ? color : '#8E8E93'}" stroke-opacity="${f > 0 ? 0.6 : 0.5}" stroke-width="1.2"/>`
  let wedge = ''
  if (f >= 0.999) wedge = `<circle cx="${c}" cy="${c}" r="${(r - 1.2).toFixed(1)}" fill="${color}"/>`
  else if (f > 0) {
    const inner = r - 1.2
    const a = f * 2 * Math.PI
    const ex = (c + inner * Math.sin(a)).toFixed(2)
    const ey = (c - inner * Math.cos(a)).toFixed(2)
    wedge = `<path d="M${c} ${c} L${c} ${(c - inner).toFixed(2)} A${inner.toFixed(2)} ${inner.toFixed(2)} 0 ${f > 0.5 ? 1 : 0} 1 ${ex} ${ey} Z" fill="${color}"/>`
  }
  return svgDoc(s, s, `${ring}${wedge}`)
}

/** A filled sparkline as SVG (Desktop, mobile): 0–100 values. */
export function svgSpark(values: readonly number[], input: { tone: Tone; width: number; height: number; ceiling?: number | null }): string {
  const w = Math.max(40, Math.round(input.width))
  const h = Math.max(12, Math.round(input.height))
  const v = values.length === 0 ? [0] : values
  const step = v.length > 1 ? w / (v.length - 1) : w
  const yOf = (n: number) => (h - 1 - (Math.max(0, Math.min(100, n)) / 100) * (h - 2)).toFixed(1)
  const points = v.map((n, i) => `${(i * step).toFixed(1)},${yOf(n)}`).join(' ')
  const color = SVG_COLOR[input.tone]
  const ceiling = input.ceiling === undefined || input.ceiling === null ? '' : `<line x1="0" x2="${w}" y1="${yOf(input.ceiling)}" y2="${yOf(input.ceiling)}" stroke="${SVG_COLOR.accent}" stroke-width="1" stroke-dasharray="3 3"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${SVG_ROOT_STYLE}` +
    `<polygon points="0,${h} ${points} ${w},${h}" fill="${color}" fill-opacity="0.18"/>` +
    `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    ceiling +
    `</svg>`
  )
}

// ---------------------------------------------------------------------------
// Charts: where time, context and changes went. Each draws as SVG on the
// remote surfaces and as glyphs in the terminal, from the same pure cells.


/** The kinds of work in a turn: a theme key for the terminal, a color for SVG, a word for the legend. */
export const TIMELINE: Record<TimelineKind, { key: string; svg: string; label: string }> = {
  read: { key: 'ide', svg: '#5A9BF6', label: 'read' },
  edit: { key: 'autoAccept', svg: '#A27CF2', label: 'edit' },
  run: { key: 'planMode', svg: '#3BB7A8', label: 'run' },
  check: { key: 'success', svg: '#30B158', label: 'check' },
  web: { key: 'suggestion', svg: '#7C95F5', label: 'web' },
  agent: { key: 'claude', svg: '#D97757', label: 'agent' },
  other: { key: 'inactive', svg: '#8E8E93', label: 'other' },
}

export type TimelineSpan = { kind: TimelineKind; start: number; end: number; isFailed: boolean }

/**
 * A turn's time in `width` cells: each cell takes the kind of work that
 * filled most of it, failed if any failed call ran in it, or null where
 * Claude was thinking between calls.
 */
export function timelineCells(spans: readonly TimelineSpan[], from: number, to: number, width: number): ({ kind: TimelineKind; isFailed: boolean } | null)[] {
  const w = Math.max(1, Math.floor(width))
  const span = Math.max(1, to - from)
  const cells: ({ kind: TimelineKind; isFailed: boolean } | null)[] = []
  for (let c = 0; c < w; c++) {
    const a = from + (span * c) / w
    const b = from + (span * (c + 1)) / w
    const share = new Map<TimelineKind, number>()
    let isFailed = false
    for (const s of spans) {
      const overlap = Math.min(b, s.end) - Math.max(a, s.start)
      if (overlap <= 0) continue
      share.set(s.kind, (share.get(s.kind) ?? 0) + overlap)
      if (s.isFailed) isFailed = true
    }
    let best: TimelineKind | null = null
    for (const [kind, ms] of share) if (best === null || ms > (share.get(best) ?? 0)) best = kind
    // A call shorter than a cell still shows: anything at all in the cell marks it.
    cells.push(best === null ? null : { kind: best, isFailed })
  }
  return cells
}

/** The same turn as SVG: one rounded bar per call on a quiet track, a failed one in red. */
export function svgTimeline(input: { spans: readonly TimelineSpan[]; from: number; to: number; width: number; height?: number }): string {
  const w = Math.max(40, Math.round(input.width))
  const h = input.height ?? 12
  const span = Math.max(1, input.to - input.from)
  const xOf = (t: number) => ((Math.min(input.to, Math.max(input.from, t)) - input.from) / span) * w
  const bars = input.spans
    .map(s => {
      const x = xOf(s.start)
      const width = Math.max(2, xOf(s.end) - x)
      const fill = s.isFailed ? SVG_COLOR.bad : TIMELINE[s.kind].svg
      return `<rect x="${x.toFixed(1)}" y="1" width="${width.toFixed(1)}" height="${h - 2}" rx="2" fill="${fill}"/>`
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${SVG_ROOT_STYLE}` +
    `<rect x="0" y="${Math.round(h / 2) - 1}" width="${w}" height="2" rx="1" fill="#8E8E93" fill-opacity="0.3"/>` +
    bars +
    `</svg>`
  )
}

/** A legend's square in the exact color a strip draws with: rounded as the strip's bars are. */
export const svgSwatch = (fill: string): string => svgDoc(10, 10, `<rect x="0" y="0" width="10" height="10" rx="2" fill="${fill}"/>`)

/** Columns of 0–1 values (a run's sessions, each its peak context) with a dashed line at `marker`. */
export function svgColumns(input: { values: readonly number[]; marker?: number | null; current?: number; width: number; height?: number }): string {
  const h = input.height ?? 36
  const n = Math.max(1, input.values.length)
  const gap = 4
  const w = Math.max(40, Math.round(input.width))
  const col = Math.max(4, Math.min(28, (w - gap * (n - 1)) / n))
  const yOf = (f: number) => (h - 1 - Math.max(0, Math.min(1, f)) * (h - 2)).toFixed(1)
  const cols = input.values
    .map((v, i) => {
      const x = (i * (col + gap)).toFixed(1)
      const top = yOf(v)
      const isCurrent = i === input.current
      const over = input.marker !== undefined && input.marker !== null && v >= input.marker
      const fill = over ? SVG_COLOR.warn : SVG_COLOR.info
      return `<rect x="${x}" y="${top}" width="${col.toFixed(1)}" height="${(h - Number(top)).toFixed(1)}" rx="2" fill="${fill}" fill-opacity="${isCurrent ? 1 : 0.55}"/>`
    })
    .join('')
  const used = Math.min(w, n * col + gap * (n - 1))
  const line =
    input.marker === undefined || input.marker === null
      ? ''
      : `<line x1="0" x2="${used.toFixed(1)}" y1="${yOf(input.marker)}" y2="${yOf(input.marker)}" stroke="${SVG_COLOR.accent}" stroke-width="1" stroke-dasharray="3 3"/>`
  return svgDoc(w, h, `${cols}${line}`)
}

/**
 * A diffstat as `cells` squares, as GitHub draws one: as many filled as the
 * change is large (one per doubling of the lines changed), shared between
 * added and removed by their ratio, the rest empty.
 */
export function diffCells(added: number, removed: number, cells = 5): { added: number; removed: number; empty: number } {
  const total = Math.max(0, added) + Math.max(0, removed)
  if (total === 0) return { added: 0, removed: 0, empty: cells }
  const filled = Math.min(cells, Math.max(1, Math.ceil(Math.log2(total + 1))))
  let plus = Math.round((filled * Math.max(0, added)) / total)
  if (added > 0 && plus === 0) plus = 1
  if (removed > 0 && plus === filled) plus = filled - 1
  return { added: plus, removed: filled - plus, empty: cells - filled }
}

export function svgDiff(input: { added: number; removed: number; cells?: number; size?: number }): string {
  const cells = input.cells ?? 5
  const size = input.size ?? 8
  const gap = 2
  const c = diffCells(input.added, input.removed, cells)
  const w = cells * size + (cells - 1) * gap
  const rects = Array.from({ length: cells }, (_, i) => {
    const fill = i < c.added ? `fill="${SVG_COLOR.good}"` : i < c.added + c.removed ? `fill="${SVG_COLOR.bad}"` : `fill="#8E8E93" fill-opacity="0.3"`
    return `<rect x="${i * (size + gap)}" y="0" width="${size}" height="${size}" rx="2" ${fill}/>`
  }).join('')
  return svgDoc(w, size, rects)
}

/** A progress ring (the Quest log's level), as SVG. */
export function svgRing(input: { fraction: number; size?: number; tone?: Tone }): string {
  const s = input.size ?? 28
  const r = s / 2 - 3
  const c = 2 * Math.PI * r
  const f = Number.isFinite(input.fraction) ? Math.min(1, Math.max(0, input.fraction)) : 0
  const color = SVG_COLOR[input.tone ?? 'accent']
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${SVG_ROOT_STYLE}` +
    `<circle cx="${s / 2}" cy="${s / 2}" r="${r.toFixed(1)}" fill="none" stroke="#8E8E93" stroke-opacity="0.3" stroke-width="4"/>` +
    `<circle cx="${s / 2}" cy="${s / 2}" r="${r.toFixed(1)}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${s / 2} ${s / 2})"/>` +
    `</svg>`
  )
}

/** A check's runs as dots: how the fixes went (✗ ✗ ✓ reads as "passed after two failures"). */
export const CHECK_DOT: Record<string, Tone> = { passed: 'good', failed: 'bad', running: 'info', blocked: 'warn', background: 'muted', stopped: 'muted' }

/**
 * How a live reading reads: against the governor's ceilings when it is on
 * (amber within 10 points, red at or past), else against fixed marks.
 */
export function readingTone(value: number | null, ceiling: number | null, marks: { warn: number; bad: number }): Tone {
  if (value === null) return 'muted'
  const bad = ceiling ?? marks.bad
  const warn = ceiling === null ? marks.warn : ceiling - 10
  return value >= bad ? 'bad' : value >= warn ? 'warn' : 'good'
}

export const toneOfLevel = (level: string): Tone =>
  level === 'ok' ? 'good' : level === 'elevated' ? 'warn' : level === 'high' || level === 'critical' ? 'bad' : 'muted'
