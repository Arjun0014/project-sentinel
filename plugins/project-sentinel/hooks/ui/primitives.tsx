/**
 * Control Room's design system: the few components every page is made of,
 * each drawn natively per surface.
 *
 * Layout: a page is a stack of cards. A card is a quiet small-caps title, a
 * rounded box of rows, and at most a short footnote. Color is meaning, never
 * decoration: green verified, amber waiting for you or worth a look, red a
 * failure or a blocker, blue (and the section's accent on its own tab) what is
 * current or under way, gray the default, the inactive and the past. Card
 * titles are structure, so they stay gray; the brand's orange is kept for its
 * mark, the Control Room button and the handoff point.
 *
 * Navigation has two levels that never look alike: the section bar (six
 * sections, an accent underline under the current one) and, inside a section
 * with more than one view, `subNav` (a breadcrumb, `Activity › Summary`, over a
 * captioned row of views, the current one bracketed: `View  [ Summary ]
 * Operations  Agents (2)  Tool calls`; on Desktop a bordered group of buttons).
 * A view switch is never drawn as a setting's choice.
 * A row reads like a settings list: the label (and a one-line description
 * under it) on the left, the control on the right edge, at every width.
 * Controls too wide for the right edge (a segmented choice) sit under the
 * label instead.
 *
 * Terminal: quiet glyph controls that work with the keyboard (Tab, Enter)
 * and the pointer alike: `● On`, `● Standard  ○ Strict`, `Ask ▾` opening its
 * options in place, `−  70%  +`. No popups: the terminal's own Select cannot
 * be picked or closed with the pointer.
 * Desktop / VS Code: native buttons and popups, SVG meters, rows spaced so
 * native buttons never touch.
 * Mobile: native buttons, choices in place, SVG meters.
 */

import type { RenderElement } from 'claude-code'

import type { HudState, Tone } from '../../types'
import type { Kit } from './kit'
import {
  CHECK_DOT,
  G,
  STATE_MARK,
  TIMELINE,
  type TimelineSpan,
  clockGlyph,
  diffCells,
  meterCells,
  sparkline,
  svgBar,
  svgColumns,
  svgDiff,
  svgRing,
  svgSpark,
  svgStateIcon,
  svgSwatch,
  svgTimeline,
  svgTrack,
  timelineCells,
  toneProps,
  trackStops,
} from './theme'

/** Desktop and VS Code draw native controls; the terminal and mobile get the in-place forms. */
export const isNative = (kit: Kit): boolean => kit.surface === 'desktop' || kit.surface === 'vscode'

export type Choice = { value: string; label: string; hint?: string }

/** A control and the cells it takes; `below` is drawn under its row (an open picker). */
/**
 * A row's control and how wide it draws. `stack` puts it under the label at any width: a text field
 * for free text, which the terminal draws as wide as its text, so beside the label it would squeeze
 * the label into a column.
 */
export type Control = { element: RenderElement; width: number; below?: RenderElement | null; stack?: true }

type Child = RenderElement | null | false | undefined

const present = (list: readonly Child[]): RenderElement[] => list.filter((c): c is RenderElement => c !== null && c !== false && c !== undefined)

/**
 * Props that let a flex child narrow below its text on the remote surfaces.
 * A browser keeps a flex item at least as wide as its content, so a line
 * that should cut with an ellipsis pushes past its card instead; the
 * terminal's layout already narrows it.
 */
export const clip = (kit: Kit): { minWidth?: number; overflow?: 'hidden' } => (kit.surface === 'terminal' ? {} : { minWidth: 0, overflow: 'hidden' })

// ---------------------------------------------------------------------------
// Structure

/**
 * A titled group of rows in a rounded box. `rows` receives the kit for the
 * box's inside (its width less the border and padding). The title is quiet
 * structure (bold, gray), whatever the section: `accent` is accepted for the
 * places that name one and is no longer drawn; `link` puts a quiet "Open ›"
 * at its right.
 */
/** The key a card is drawn under, the one `$.ui.scroll` finds it by: `card-ops-agents` for `ops-agents`. */
export const cardKey = (key: string): string => `card-${key}`

/** The lines `emptyState` drew: a card holding nothing else is a quiet line, not a box around it. */
const EMPTY_LINES = new WeakSet<object>()

export function card(
  kit: Kit,
  input: {
    key: string
    title?: string
    accent?: string
    aside?: string
    link?: { label: string; onPress: () => void }
    footer?: string
    rows: (inner: Kit) => readonly Child[]
  },
): RenderElement {
  const { Box, Text, Button } = kit.ui
  const inner: Kit = { ...kit, columns: Math.max(16, kit.columns - 4) }
  const rows = present(input.rows(inner))
  const hasHead = input.title !== undefined || input.aside !== undefined || input.link !== undefined
  return (
    <Box key={cardKey(input.key)} flexDirection="column" marginTop={1}>
      {hasHead ? (
        <Box key={`card-${input.key}-head`} flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold dimColor>
            {(input.title ?? '').toUpperCase()}
          </Text>
          {input.link !== undefined && input.aside !== undefined && input.aside !== '' ? (
            <Box flexDirection="row" columnGap={2} flexShrink={1} alignItems="center" {...clip(kit)}>
              <Box flexShrink={1} {...clip(kit)}>
                <Text dimColor wrap="truncate-start">
                  {input.aside}
                </Text>
              </Box>
              <Button key={`${input.key}-link`} label={`${input.link.label} ${G.chevron}`} plain dimColor onPress={input.link.onPress} />
            </Box>
          ) : input.link !== undefined ? (
            <Button key={`${input.key}-link`} label={`${input.link.label} ${G.chevron}`} plain dimColor onPress={input.link.onPress} />
          ) : input.aside === undefined || input.aside === '' ? null : (
            <Box flexShrink={1} {...clip(kit)}>
              <Text dimColor wrap="truncate-start">
                {input.aside}
              </Text>
            </Box>
          )}
        </Box>
      ) : null}
      {rows.length === 0 ? null : rows.every(r => EMPTY_LINES.has(r as object)) ? (
        // Nothing in it yet ("Claude has not changed any files yet."): the line alone, aligned with a box's inside.
        <Box key={`card-${input.key}-box`} flexDirection="column" paddingX={1}>
          {rows}
        </Box>
      ) : (
        <Box key={`card-${input.key}-box`} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} rowGap={isNative(kit) ? 1 : 0}>
          {rows}
        </Box>
      )}
      {input.footer === undefined || input.footer === '' ? null : (
        <Box key={`card-${input.key}-foot`} paddingX={1}>
          <Text dimColor wrap="wrap">
            {input.footer}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** Controls at most this wide (switches, steppers, pickers) always stay on the right. */
const NARROW_CONTROL = 20

/**
 * A settings row: label (and a dim description under it) on the left, the
 * control or value on the right. A wide control (a segmented choice) moves
 * under the label when it would take over half the row, or when the label
 * or description would no longer fit beside it, so text never wraps into a
 * narrow column. An open picker's options appear under the row.
 */
export function row(
  kit: Kit,
  input: { key: string; label: string; subtitle?: string; subtitleTone?: Tone; control?: Control; value?: string; valueTone?: Tone; isDim?: boolean },
): RenderElement {
  const { Box, Text } = kit.ui
  const control = input.control
  const subtitle = input.subtitle === undefined || input.subtitle === '' ? null : input.subtitle
  const textWidth = Math.max(input.label.length, subtitle?.length ?? 0)
  const isStacked =
    control !== undefined &&
    (control.stack === true ||
      (control.width > 12 && (control.width > Math.floor(kit.columns * 0.55) || (control.width > NARROW_CONTROL && kit.columns - control.width - 2 < textWidth))))
  const subtitleTone = input.subtitleTone ?? 'muted'
  const subtitleEl = subtitle === null ? null : (
    <Text key={`${input.key}-sub`} {...toneProps(subtitleTone)} dimColor={subtitleTone === 'muted' ? true : undefined} wrap="wrap">
      {subtitle}
    </Text>
  )
  const right =
    control !== undefined ? (
      control.element
    ) : input.value === undefined ? null : (
      <Text key={`${input.key}-value`} {...toneProps(input.valueTone ?? 'normal')} wrap="truncate-end">
        {input.value}
      </Text>
    )
  // A plain value may cut short where the surface lays out like a browser; a control keeps its size.
  const isValueShrinking = control === undefined && kit.surface !== 'terminal'
  return (
    <Box key={`row-${input.key}`} flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} {...clip(kit)}>
          <Text dimColor={input.isDim === true ? true : undefined} wrap="wrap">
            {input.label}
          </Text>
          {isStacked ? null : subtitleEl}
        </Box>
        {isStacked || right === null ? null : (
          <Box flexShrink={isValueShrinking ? 1 : 0} key={`${input.key}-right`} {...(isValueShrinking ? clip(kit) : {})}>
            {right}
          </Box>
        )}
      </Box>
      {isStacked ? subtitleEl : null}
      {isStacked ? (
        <Box key={`${input.key}-stacked`} marginTop={isNative(kit) ? 1 : 0}>
          {right}
        </Box>
      ) : null}
      {control?.below === undefined || control.below === null ? null : (
        <Box key={`${input.key}-below`} marginLeft={2}>
          {control.below}
        </Box>
      )}
    </Box>
  )
}

/**
 * What closes a run of cards that belong together (Guardrails' permission
 * groups): their shared actions, then a short dim note, aligned with a card's
 * own footnote. A group's name is a card's title, never a line among its
 * rows: on Desktop a heading inside a box reads as one more row.
 */
export function footnote(kit: Kit, input: { key: string; text: string; actions?: Parameters<typeof buttons>[1] }): RenderElement {
  const { Box, Text } = kit.ui
  const actions = input.actions === undefined ? null : buttons(kit, input.actions, `${input.key}-actions`, true)
  return (
    <Box key={`foot-${input.key}`} flexDirection="column" paddingX={1} marginTop={actions !== null && isNative(kit) ? 1 : 0} rowGap={isNative(kit) ? 1 : 0}>
      {actions}
      <Text dimColor wrap="wrap">
        {input.text}
      </Text>
    </Box>
  )
}

/**
 * A row set apart from the readings above it: a blank line before it in the
 * terminal (native surfaces space rows themselves), so a switch never sits
 * flush under a meter's figures.
 */
export function apart(kit: Kit, key: string, element: RenderElement): RenderElement {
  const { Box } = kit.ui
  return (
    <Box key={`apart-${key}`} flexDirection="column" marginTop={kit.surface === 'terminal' ? 1 : 0}>
      {element}
    </Box>
  )
}

/** The width of a field's label column, in cells. */
export const FIELD_LABEL = 10

/**
 * A readout line: a dim label in a fixed column, then its content
 * ("Cost      $4.18 this session"). Fields stacked together line up, so a
 * block of them reads as one calm table. `under` is a dim line aligned
 * with the content.
 */
export function field(kit: Kit, input: { key: string; label: string; content: RenderElement; under?: string }): RenderElement {
  const { Box, Text } = kit.ui
  return (
    <Box key={`field-${input.key}`} flexDirection="column">
      <Box flexDirection="row">
        <Box width={FIELD_LABEL} flexShrink={0}>
          <Text dimColor>{input.label}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} {...clip(kit)}>
          {input.content}
        </Box>
      </Box>
      {input.under === undefined || input.under === '' ? null : (
        <Box key={`field-${input.key}-under`} marginLeft={FIELD_LABEL}>
          <Text dimColor wrap="truncate-end">
            {input.under}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export type Run = { text: string; tone?: Tone; isBold?: boolean }

/** One line of differently styled runs ("$4.18" bold, " this session" dim). */
export function textRuns(kit: Kit, key: string, runs: readonly Run[]): RenderElement {
  const { Text } = kit.ui
  return (
    <Text key={key} wrap="truncate-end">
      {runs.map((r, i) => (
        <Text key={`${key}-${i}`} {...toneProps(r.tone ?? 'normal')} bold={r.isBold === true ? true : undefined}>
          {r.text}
        </Text>
      ))}
    </Text>
  )
}

/** A dim line with text at both ends ("694k of 1M ........ hands off at 700k"). */
export function pair(kit: Kit, input: { key: string; left: string; right?: string; rightTone?: Tone }): RenderElement {
  const { Box, Text } = kit.ui
  return (
    <Box key={`pair-${input.key}`} flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Box flexShrink={1} {...clip(kit)}>
        <Text dimColor wrap="truncate-end">
          {input.left}
        </Text>
      </Box>
      {input.right === undefined ? null : (
        <Box flexShrink={0}>
          <Text {...toneProps(input.rightTone ?? 'muted')} dimColor={input.rightTone === undefined || input.rightTone === 'muted' ? true : undefined}>
            {input.right}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** Something that needs the person: a bordered card in the status color, a line, actions. */
export function callout(
  kit: Kit,
  input: { key: string; tone: Tone; title: string; text?: string; actions?: readonly { key: string; label: string; onPress: () => void; isPrimary?: boolean }[] },
): RenderElement {
  const { Box, Text } = kit.ui
  const color = toneProps(input.tone).color ?? 'text'
  return (
    <Box key={`callout-${input.key}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginTop={1} rowGap={isNative(kit) ? 1 : 0}>
      <Text bold color={color}>
        {input.title}
      </Text>
      {input.text === undefined ? null : <Text wrap="wrap">{input.text}</Text>}
      {input.actions === undefined || input.actions.length === 0 ? null : buttons(kit, input.actions, `callout-${input.key}`)}
    </Box>
  )
}

/**
 * Explicit actions: `[ Hand off now ]` in the terminal, native buttons
 * elsewhere. In the terminal an action row keeps a blank line above it, so
 * it never sits flush under text (native surfaces space rows themselves);
 * `isInline` drops that for a button used as a row's control.
 */
export function buttons(
  kit: Kit,
  list: readonly { key: string; label: string; onPress: () => void; isPrimary?: boolean; isHidden?: boolean }[],
  key = 'actions',
  isInline = false,
): RenderElement | null {
  const { Box, Button } = kit.ui
  const shown = list.filter(b => b.isHidden !== true)
  if (shown.length === 0) return null
  return (
    <Box key={key} flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={isNative(kit) ? 1 : 0} marginTop={isInline || isNative(kit) ? 0 : 1}>
      {shown.map(b => (
        <Button key={b.key} label={b.label} variant={b.isPrimary === true ? 'primary' : 'secondary'} onPress={b.onPress} />
      ))}
    </Box>
  )
}

export function note(kit: Kit, text: string, key = 'note', tone: Tone = 'muted'): RenderElement {
  const { Box, Text } = kit.ui
  return (
    <Box key={key}>
      <Text {...toneProps(tone)} dimColor={tone === 'muted' ? true : undefined} wrap="wrap">
        {text}
      </Text>
    </Box>
  )
}

export function emptyState(kit: Kit, text: string, key = 'empty'): RenderElement {
  const { Box, Text } = kit.ui
  const line = (
    <Box key={key}>
      <Text dimColor italic>
        {text}
      </Text>
    </Box>
  )
  if (typeof line === 'object' && line !== null) EMPTY_LINES.add(line as object)
  return line
}

/**
 * A list line: status glyph, text, a right-aligned note; `detail` is a dim
 * second line under the text (why a call failed, which command ran).
 */
export function listItem(
  kit: Kit,
  input: { key: string; glyph: string; tone: Tone; text: string; right?: string; rightTone?: Tone; detail?: string | null; isDim?: boolean; isBold?: boolean },
): RenderElement {
  const { Box, Text } = kit.ui
  const rightTone = input.rightTone ?? 'muted'
  return (
    <Box key={input.key} flexDirection="row" columnGap={1}>
      <Box width={2} flexShrink={0}>
        <Text {...toneProps(input.tone)}>{input.glyph}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column" {...clip(kit)}>
        <Text dimColor={input.isDim === true ? true : undefined} bold={input.isBold === true ? true : undefined} wrap="truncate-end">
          {input.text}
        </Text>
        {input.detail === undefined || input.detail === null || input.detail === '' ? null : (
          <Text key={`${input.key}-detail`} dimColor wrap="truncate-end">
            {input.detail}
          </Text>
        )}
      </Box>
      {input.right === undefined ? null : (
        <Box flexShrink={0}>
          <Text {...toneProps(rightTone)} dimColor={rightTone === 'muted' ? true : undefined}>
            {input.right}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** A text line's height on the remote surfaces, in CSS pixels: an icon beside a block lines up with its first line. */
const LINE_PX = 24

/**
 * What the run is doing, with its state's mark: the glyph in the terminal, the
 * status bar's 16-pixel icon elsewhere, set on the first line when the words
 * wrap or carry a detail line under them.
 */
export function stateLine(kit: Kit, input: { key: string; state: HudState; text: string; detail?: string | null; isBold?: boolean; isDim?: boolean }): RenderElement {
  const { Box, Text, Svg } = kit.ui
  const mark = STATE_MARK[input.state]
  const words = (
    <Box flexGrow={1} flexShrink={1} flexDirection="column" {...clip(kit)}>
      <Text bold={input.isBold === true ? true : undefined} dimColor={input.isDim === true ? true : undefined} wrap="wrap">
        {input.text}
      </Text>
      {input.detail === undefined || input.detail === null || input.detail === '' ? null : (
        <Text key={`${input.key}-detail`} dimColor wrap="wrap">
          {input.detail}
        </Text>
      )}
    </Box>
  )
  if (Svg === undefined) {
    return (
      <Box key={input.key} flexDirection="row" columnGap={1}>
        <Box width={2} flexShrink={0}>
          <Text {...toneProps(mark.tone)}>{mark.glyph}</Text>
        </Box>
        {words}
      </Box>
    )
  }
  return (
    <Box key={input.key} flexDirection="row" columnGap={1} alignItems="flex-start">
      <Box flexShrink={0}>
        <Svg key={`${input.key}-mark`} source={svgStateIcon(input.state, LINE_PX)} alt={input.state} width={16} height={LINE_PX} />
      </Box>
      {words}
    </Box>
  )
}

/**
 * Milestone progress as a track: one stop per milestone (● done, ◉ the one
 * under way, ○ to come) joined by a thin line in the terminal, SVG circles
 * on a line elsewhere (the current one pulses while motion is allowed), and
 * "4 of 7" beside it. A track of stops, never a filling bar, so it never
 * reads as the context meter.
 */
export function workTrack(kit: Kit, input: { key: string; done: number; total: number; hasCurrent: boolean; max: number; caption?: string; isAnimated?: boolean }): RenderElement {
  const { Box, Text, Svg } = kit.ui
  const caption = input.caption ?? `${input.done} of ${input.total}`
  const stops = trackStops(input.done, input.total, input.max, input.hasCurrent)
  if (Svg !== undefined) {
    const isAnimated = input.isAnimated === true && stops.includes('now')
    return (
      <Box key={input.key} flexDirection="row" alignItems="center" columnGap={1}>
        <Svg key={`${input.key}-svg`} source={svgTrack({ stops, width: stops.length * 14 + 2, height: 12, isAnimated })} alt={`${input.done} of ${input.total} milestones done`} width={stops.length * 14 + 2} height={12} />
        <Text>{caption}</Text>
      </Box>
    )
  }
  const parts: { text: string; style: { color?: string; bold?: boolean; dimColor?: boolean } }[] = []
  stops.forEach((s, i) => {
    if (i > 0) parts.push({ text: G.stepJoin, style: { dimColor: true } })
    parts.push(s === 'done' ? { text: G.stepDone, style: { color: 'suggestion' } } : s === 'now' ? { text: G.stepNow, style: { bold: true } } : { text: G.stepOpen, style: { dimColor: true } })
  })
  const runs: typeof parts = []
  for (const p of parts) {
    const last = runs[runs.length - 1]
    if (last !== undefined && JSON.stringify(last.style) === JSON.stringify(p.style)) last.text += p.text
    else runs.push({ ...p })
  }
  return (
    <Text key={input.key} wrap="truncate-end">
      {runs.map((r, i) => (
        <Text key={`${input.key}-${i}`} {...r.style}>
          {r.text}
        </Text>
      ))}
      <Text key={`${input.key}-caption`}>{`  ${caption}`}</Text>
    </Text>
  )
}

/**
 * The prompt cache's state as a status line: a small dot emptying as its time runs out (`●` `◕` `◑`
 * `◔` `○`, a glyph on every surface, as Context's own status reads), and its words beside it.
 * A drawn clock face at this size read as a selected radio button on Desktop.
 */
export function cacheClock(kit: Kit, input: { key: string; fraction: number | null; tone: Tone; text: string; isBold?: boolean }): RenderElement {
  const { Text } = kit.ui
  const textTone: Tone = input.tone === 'warn' ? 'warn' : input.tone === 'muted' ? 'muted' : 'normal'
  return (
    <Text key={input.key} wrap="truncate-end">
      <Text {...toneProps(input.tone === 'normal' ? 'info' : input.tone)}>{`${clockGlyph(input.fraction)} `}</Text>
      <Text {...toneProps(textTone)} bold={input.isBold === true ? true : undefined}>
        {input.text}
      </Text>
    </Text>
  )
}

/** Numbered steps, for explaining what happens ("1  Claude finishes the step it is on"). */
export function steps(kit: Kit, key: string, list: readonly string[], accent?: string): RenderElement {
  const { Box, Text } = kit.ui
  return (
    <Box key={key} flexDirection="column">
      {list.map((text, i) => (
        <Box key={`${key}-${i}`} flexDirection="row">
          <Box width={3} flexShrink={0}>
            <Text color={accent} bold>
              {String(i + 1)}
            </Text>
          </Box>
          <Box flexShrink={1} {...clip(kit)}>
            <Text wrap="wrap">{text}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Controls

/** On / off. */
export function switchControl(kit: Kit, input: { key: string; isOn: boolean; onPress: () => void }): Control {
  const { Button } = kit.ui
  if (isNative(kit)) {
    const label = input.isOn ? 'On' : 'Off'
    return { element: <Button key={input.key} label={label} variant={input.isOn ? 'primary' : 'secondary'} onPress={input.onPress} />, width: 6 }
  }
  const label = input.isOn ? `${G.dot} On ` : `${G.ring} Off`
  return { element: <Button key={input.key} label={label} plain dimColor={!input.isOn} onPress={input.onPress} />, width: label.length }
}

/** A few short options side by side, the chosen one marked. */
export function segmented(kit: Kit, input: { key: string; value: string; options: readonly Choice[]; onSelect: (value: string) => void }): Control {
  const { Box, Button } = kit.ui
  if (isNative(kit)) {
    return {
      element: (
        <Box key={input.key} flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          {input.options.map(o => (
            <Button key={`${input.key}:${o.value}`} label={o.label} variant={o.value === input.value ? 'primary' : 'secondary'} onPress={() => input.onSelect(o.value)} />
          ))}
        </Box>
      ),
      width: input.options.reduce((n, o) => n + o.label.length + 5, -1),
    }
  }
  return {
    element: (
      <Box key={input.key} flexDirection="row" flexWrap="wrap" columnGap={2}>
        {input.options.map(o => (
          <Button
            key={`${input.key}:${o.value}`}
            label={`${o.value === input.value ? G.dot : G.ring} ${o.label}`}
            plain
            dimColor={o.value !== input.value}
            onPress={() => input.onSelect(o.value)}
          />
        ))}
      </Box>
    ),
    width: input.options.reduce((n, o) => n + o.label.length + 4, -2),
  }
}

/**
 * One of many: the current value with a chevron. Desktop and VS Code open
 * their native popup; the terminal and mobile open the options in place,
 * under the row, each with its one-line hint, and close on a pick.
 */
export function picker(kit: Kit, input: { key: string; value: string; options: readonly Choice[]; onSelect: (value: string) => void }): Control {
  const { Box, Button, Select, Text } = kit.ui
  const current = input.options.find(o => o.value === input.value) ?? input.options[0]
  const shown = current?.label ?? input.value
  if (isNative(kit) && Select !== undefined) {
    return {
      element: <Select key={input.key} options={input.options.map(o => ({ value: o.value, label: o.label }))} value={input.value} onSelect={value => input.onSelect(value)} />,
      width: Math.min(18, shown.length + 4),
    }
  }
  const isOpen = kit.openPicker === input.key
  const label = `${shown} ${isOpen ? G.up : G.down}`
  const optionWidth = Math.max(...input.options.map(o => o.label.length)) + 4
  const below = isOpen ? (
    <Box key={`${input.key}-options`} flexDirection="column">
      {input.options.map(o => (
        <Box key={`${input.key}-option-${o.value}`} flexDirection="row">
          <Box width={optionWidth} flexShrink={0}>
            <Button
              key={`${input.key}:${o.value}`}
              label={`${o.value === input.value ? G.dot : G.ring} ${o.label}`}
              plain
              dimColor={o.value !== input.value}
              onPress={() => {
                kit.actions.togglePicker(null)
                if (o.value !== input.value) input.onSelect(o.value)
              }}
            />
          </Box>
          {o.hint === undefined ? null : (
            <Box flexShrink={1} {...clip(kit)}>
              <Text dimColor wrap="truncate-end">
                {o.hint}
              </Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  ) : null
  return {
    element: <Button key={input.key} label={label} plain onPress={() => kit.actions.togglePicker(input.key)} />,
    width: label.length,
    below,
  }
}

/** A number with − and +. */
export function stepper(kit: Kit, input: { key: string; display: string; onDecrease?: () => void; onIncrease?: () => void }): Control {
  const { Box, Button, Text } = kit.ui
  const noop = () => undefined
  if (isNative(kit)) {
    return {
      element: (
        <Box key={input.key} flexDirection="row" columnGap={1} alignItems="center">
          <Button key={`${input.key}-dec`} label={G.minus} onPress={input.onDecrease ?? noop} />
          <Box minWidth={input.display.length + 2} justifyContent="center">
            <Text bold>{input.display}</Text>
          </Box>
          <Button key={`${input.key}-inc`} label={G.plus} onPress={input.onIncrease ?? noop} />
        </Box>
      ),
      width: input.display.length + 12,
    }
  }
  return {
    element: (
      <Box key={input.key} flexDirection="row">
        <Button key={`${input.key}-dec`} label={G.minus} plain dimColor={input.onDecrease === undefined} onPress={input.onDecrease ?? noop} />
        <Text bold>{`  ${input.display}  `}</Text>
        <Button key={`${input.key}-inc`} label={G.plus} plain dimColor={input.onIncrease === undefined} onPress={input.onIncrease ?? noop} />
      </Box>
    ),
    width: input.display.length + 6,
  }
}

/** A value that navigates to where it is set (`No limit ›`). */
export function link(kit: Kit, input: { key: string; label: string; onPress: () => void }): Control {
  const { Button } = kit.ui
  const label = `${input.label} ${G.chevron}`
  return { element: <Button key={input.key} label={label} plain dimColor onPress={input.onPress} />, width: label.length + (isNative(kit) ? 4 : 0) }
}

// ---------------------------------------------------------------------------
// Meters

/** A thin line meter with a threshold tick; an SVG bar where the surface draws SVG. */
export function meterBar(kit: Kit, input: { key: string; fraction: number; marker?: number | null; tone: Tone; width: number; alt: string }): RenderElement {
  const { Text, Svg } = kit.ui
  if (Svg !== undefined) {
    return <Svg key={input.key} source={svgBar({ fraction: input.fraction, marker: input.marker, tone: input.tone, width: Math.max(8, input.width) * 8, height: 10 })} alt={input.alt} height={10} />
  }
  const c = meterCells(input.fraction, input.width, input.marker)
  return (
    <Text key={input.key} wrap="truncate-end">
      {runs(kit, input.key, c, input.tone)}
    </Text>
  )
}

/** The meter's cells grouped into runs of one style (filled, empty, marker), as nested Texts. */
function runs(kit: Kit, key: string, c: { filled: number; marker: number; width: number }, tone: Tone): RenderElement[] {
  const { Text } = kit.ui
  const kindOf = (i: number) => (i === c.marker ? 'marker' : i < c.filled ? 'filled' : 'empty')
  const out: RenderElement[] = []
  let start = 0
  for (let i = 1; i <= c.width; i++) {
    if (i === c.width || kindOf(i) !== kindOf(start)) {
      const kind = kindOf(start)
      const glyph = kind === 'marker' ? G.marker : kind === 'filled' ? G.lineFull : G.lineEmpty
      const style = kind === 'marker' ? { color: 'claude' } : kind === 'filled' ? toneProps(tone) : { dimColor: true }
      out.push(
        <Text key={`${key}-run-${start}`} {...style}>
          {glyph.repeat(i - start)}
        </Text>,
      )
      start = i
    }
  }
  return out
}

/** A sparkline of 0–100 readings; SVG where the surface draws SVG. */
export function spark(kit: Kit, input: { key: string; values: readonly number[]; tone: Tone; width: number; ceiling?: number | null; alt: string }): RenderElement {
  const { Text, Svg } = kit.ui
  if (Svg !== undefined) {
    return <Svg key={input.key} source={svgSpark(input.values, { tone: input.tone, width: Math.max(8, input.width) * 8, height: 22, ceiling: input.ceiling })} alt={input.alt} height={22} />
  }
  return (
    <Text key={input.key} {...toneProps(input.tone)}>
      {sparkline(input.values, input.width)}
    </Text>
  )
}

/**
 * A live reading: label and value on one line, the meter (and in the
 * terminal, a sparkline of recent readings) under it.
 */
export function gauge(
  kit: Kit,
  input: { key: string; label: string; value: number | null; ceiling?: number | null; series?: readonly number[]; tone: Tone; detail?: string },
): RenderElement {
  const { Box, Text } = kit.ui
  const series = input.series ?? []
  const sparkWidth = kit.surface === 'terminal' && series.length > 1 ? Math.min(12, Math.max(6, Math.floor(kit.columns * 0.2))) : 0
  const meterWidth = Math.max(8, kit.columns - (sparkWidth > 0 ? sparkWidth + 2 : 0))
  const valueTone: Tone = input.tone === 'good' ? 'normal' : input.tone
  return (
    <Box key={`gauge-${input.key}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text>{input.label}</Text>
        <Text>
          {input.detail === undefined ? null : <Text dimColor>{`${input.detail}   `}</Text>}
          <Text bold {...toneProps(valueTone)}>
            {input.value === null ? G.none : `${Math.round(input.value)}%`}
          </Text>
        </Text>
      </Box>
      <Box flexDirection="row" columnGap={2}>
        <Box width={meterWidth} flexShrink={1}>
          {meterBar(kit, { key: `gauge-${input.key}-meter`, fraction: (input.value ?? 0) / 100, marker: input.ceiling === undefined || input.ceiling === null ? null : input.ceiling / 100, tone: input.tone, width: meterWidth, alt: `${input.label} ${input.value === null ? 'unknown' : `${Math.round(input.value)}%`}` })}
        </Box>
        {sparkWidth === 0 ? null : (
          <Text dimColor key={`gauge-${input.key}-spark`}>
            {sparkline(series, sparkWidth).padStart(sparkWidth)}
          </Text>
        )}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Charts: where time, context and changes went

/**
 * Parts of one line set apart: three spaces in the terminal, " · " where the
 * surface lays text out like a browser. Desktop draws a text with spaced-out
 * runs of blanks in a monospace face (it reads them as a table), so padding
 * never separates words there.
 */
export const spaced = (kit: Kit, parts: readonly (string | null | undefined | false)[]): string =>
  parts.filter((p): p is string => typeof p === 'string' && p !== '').join(kit.surface === 'terminal' ? '   ' : ' · ')

/**
 * Where a turn's time went: a strip across the turn, each call a stretch in
 * its kind's color (read, edit, run, check, web, agent), a failed one red,
 * and the gaps where Claude was thinking. SVG on the remote surfaces.
 */
export function timelineStrip(kit: Kit, input: { key: string; spans: readonly TimelineSpan[]; from: number; to: number; width: number }): RenderElement {
  const { Text, Svg } = kit.ui
  const width = Math.max(8, input.width)
  if (Svg !== undefined) {
    return <Svg key={input.key} source={svgTimeline({ spans: input.spans, from: input.from, to: input.to, width: width * 8, height: 12 })} alt={`${input.spans.length} tool calls over the turn`} height={12} />
  }
  const cells = timelineCells(input.spans, input.from, input.to, width)
  const runs: { text: string; color?: string; isDim: boolean }[] = []
  for (const c of cells) {
    const color = c === null ? undefined : c.isFailed ? 'error' : TIMELINE[c.kind].key
    const glyph = c === null ? G.idle : G.busy
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color && last.isDim === (c === null)) last.text += glyph
    else runs.push({ text: glyph, color, isDim: c === null })
  }
  return (
    <Text key={input.key} wrap="truncate-end">
      {runs.map((r, i) => (
        <Text key={`${input.key}-${i}`} color={r.color} dimColor={r.isDim ? true : undefined}>
          {r.text}
        </Text>
      ))}
    </Text>
  )
}

/** A legend of colored marks and words, set apart by gaps rather than padding. */
/**
 * The kinds of work in a strip, each a colored square and a dim word. `color` is a theme key (the
 * terminal's glyph); `svg`, when given, is the exact color the strip draws with on the remote
 * surfaces, where the square is drawn too, so the legend and the strip never disagree (a theme
 * key and an SVG fill are two palettes there).
 */
export function legend(kit: Kit, key: string, items: readonly { label: string; color: string; svg?: string }[]): RenderElement {
  const { Box, Text, Svg } = kit.ui
  return (
    <Box key={key} flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={isNative(kit) ? 1 : 0}>
      {items.map(item =>
        Svg !== undefined && item.svg !== undefined ? (
          <Box key={`${key}-${item.label}`} flexDirection="row" alignItems="center" columnGap={1}>
            <Svg key={`${key}-${item.label}-swatch`} source={svgSwatch(item.svg)} alt={item.label} width={10} height={10} />
            <Text dimColor>{item.label}</Text>
          </Box>
        ) : (
          <Text key={`${key}-${item.label}`}>
            <Text color={item.color}>{G.square}</Text>
            <Text dimColor>{` ${item.label}`}</Text>
          </Text>
        ),
      )}
    </Box>
  )
}

/**
 * Columns of 0–1 values side by side (a run's sessions, each its peak
 * context), the current one bright; SVG with a dashed line at `marker` on
 * the remote surfaces, block glyphs two cells wide in the terminal.
 */
export function columns(kit: Kit, input: { key: string; values: readonly number[]; marker?: number | null; current?: number; alt: string }): RenderElement {
  const { Text, Svg } = kit.ui
  if (Svg !== undefined) {
    const width = Math.min(kit.columns * 8, input.values.length * 32 + 8)
    return <Svg key={input.key} source={svgColumns({ values: input.values, marker: input.marker, current: input.current, width, height: 36 })} alt={input.alt} height={36} />
  }
  return (
    <Text key={input.key} wrap="truncate-end">
      {input.values.map((v, i) => {
        const glyph = G.spark[Math.min(7, Math.max(0, Math.round(Math.max(0, Math.min(1, v)) * 7)))]
        const isOver = input.marker !== undefined && input.marker !== null && v >= input.marker
        return (
          <Text key={`${input.key}-${i}`} color={isOver ? 'warning' : 'ide'} dimColor={i === input.current ? undefined : true}>
            {`${i > 0 ? ' ' : ''}${glyph}${glyph}`}
          </Text>
        )
      })}
    </Text>
  )
}

/** A change's size and balance as five squares, green for added and red for removed. */
export function diffSquares(kit: Kit, input: { key: string; added: number; removed: number }): RenderElement {
  const { Text, Svg } = kit.ui
  if (Svg !== undefined) {
    return <Svg key={input.key} source={svgDiff({ added: input.added, removed: input.removed })} alt={`${input.added} lines added, ${input.removed} removed`} height={8} />
  }
  const c = diffCells(input.added, input.removed)
  return (
    <Text key={input.key}>
      {c.added > 0 ? <Text color="success">{G.square.repeat(c.added)}</Text> : null}
      {c.removed > 0 ? <Text color="error">{G.square.repeat(c.removed)}</Text> : null}
      {c.empty > 0 ? <Text dimColor>{G.square.repeat(c.empty)}</Text> : null}
    </Text>
  )
}

/** A check's runs as colored dots, oldest first. */
export function dots(kit: Kit, input: { key: string; statuses: readonly string[] }): RenderElement {
  const { Text } = kit.ui
  return (
    <Text key={input.key}>
      {input.statuses.map((s, i) => (
        <Text key={`${input.key}-${i}`} {...toneProps(CHECK_DOT[s] ?? 'muted')}>
          {G.dot}
        </Text>
      ))}
    </Text>
  )
}

/** A level's progress: a ring on the remote surfaces, a star in the terminal. */
export function levelBadge(kit: Kit, input: { key: string; level: number; fraction: number }): RenderElement {
  const { Box, Text, Svg } = kit.ui
  if (Svg !== undefined) {
    return (
      <Box key={input.key} flexDirection="row" alignItems="center" columnGap={1}>
        <Svg key={`${input.key}-ring`} source={svgRing({ fraction: input.fraction, size: 28 })} alt={`Level ${input.level}, ${Math.round(input.fraction * 100)}% of the way to the next`} height={28} />
        <Text bold>{`Level ${input.level}`}</Text>
      </Box>
    )
  }
  return (
    <Text key={input.key}>
      <Text color="claude">{`${G.star} `}</Text>
      <Text bold>{`Level ${input.level}`}</Text>
    </Text>
  )
}

// ---------------------------------------------------------------------------
// Navigation

/**
 * The second level of navigation, inside a section with several views. Never drawn like a setting's
 * choice (`● A  ○ B`), so it cannot be read as one:
 *
 *   Activity › Summary
 *   View   [ Summary ]   Operations   Agents (2)   Tool calls
 *
 * The breadcrumb names where you are in words (the section in its accent, the view bold); the views sit
 * under a dim "View" caption, the current one bracketed in the section's accent and bright, the others
 * dim until focused. Desktop draws the breadcrumb over a bordered group of its own buttons (the current
 * one primary), so the group reads apart from the section bar's free-standing buttons. Each view keeps
 * the key `<key>:<value>`.
 */
export function subNav<T extends string>(
  kit: Kit,
  input: { key: string; section: string; accent: string; current: T; options: readonly { value: T; label: string }[]; onSelect: (value: T) => void },
): RenderElement {
  const { Box, Text, Button } = kit.ui
  const here = input.options.find(o => o.value === input.current)?.label ?? ''
  const crumb = (
    <Text key={`${input.key}-crumb`} wrap="truncate-end">
      <Text color={input.accent}>{input.section}</Text>
      <Text dimColor>{` ${G.chevron} `}</Text>
      <Text bold>{here.replace(/ \(\d+\)$/, '')}</Text>
    </Text>
  )
  if (isNative(kit)) {
    return (
      <Box key={`${input.key}-nav`} flexDirection="column" marginTop={1} rowGap={1}>
        {crumb}
        <Box key={`${input.key}-group`} flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
          <Text dimColor>View</Text>
          {input.options.map(o => (
            <Button key={`${input.key}:${o.value}`} label={o.label} variant={o.value === input.current ? 'primary' : 'secondary'} onPress={() => input.onSelect(o.value)} />
          ))}
        </Box>
      </Box>
    )
  }
  return (
    <Box key={`${input.key}-nav`} flexDirection="column" marginTop={1}>
      {crumb}
      <Box key={`${input.key}-views`} flexDirection="row" flexWrap="wrap" columnGap={3}>
        <Text dimColor>View</Text>
        {input.options.map(o =>
          o.value === input.current ? (
            <Box key={`${input.key}-at-${o.value}`} flexDirection="row" flexShrink={0}>
              <Text color={input.accent}>[ </Text>
              <Button key={`${input.key}:${o.value}`} label={o.label} plain onPress={() => input.onSelect(o.value)} />
              <Text color={input.accent}> ]</Text>
            </Box>
          ) : (
            <Button key={`${input.key}:${o.value}`} label={o.label} plain dimColor onPress={() => input.onSelect(o.value)} />
          ),
        )}
      </Box>
    </Box>
  )
}

/** Native section buttons per row when they do not fit on one. */
const NAV_PER_ROW = 3

/**
 * The columns a native section bar needs to keep every tab on one row: each
 * label with a native button's padding, and a cell between buttons.
 */
export const navRowColumns = (tabs: readonly { label: string }[]): number => tabs.reduce((n, t) => n + t.label.length + 3, 0) + tabs.length - 1

/**
 * The section bar. Terminal: labels with the chosen one bright and its
 * section's accent underline beneath it (which doubles as the header's
 * rule); two rows when one will not fit. Native surfaces: one row of
 * buttons with an even gap when every label fits; otherwise three equal
 * cells per row spanning the page, each button centred in its cell. The
 * chosen one is primary.
 */
export function navBar<T extends string>(
  kit: Kit,
  input: { tabs: readonly { id: T; label: string; accent: string }[]; current: T; onSelect: (id: T) => void },
): RenderElement {
  const { Box, Button, Text } = kit.ui
  if (kit.surface !== 'terminal') {
    const tab = (t: { id: T; label: string }) => (
      <Button key={`tab-${t.id}`} label={t.label} variant={t.id === input.current ? 'primary' : 'secondary'} onPress={() => input.onSelect(t.id)} />
    )
    // Room for all: one row at the labels' own widths with an even gap, as the page's other choices sit.
    if (kit.columns >= navRowColumns(input.tabs)) {
      return (
        <Box key="nav" flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          {input.tabs.map(tab)}
        </Box>
      )
    }
    // Narrow: three equal cells per row across the page, each button centred in its cell, so the columns line up.
    const rows: (typeof input.tabs)[number][][] = []
    for (let i = 0; i < input.tabs.length; i += NAV_PER_ROW) rows.push(input.tabs.slice(i, i + NAV_PER_ROW))
    const cell = `${Math.floor(100 / NAV_PER_ROW)}%`
    return (
      <Box key="nav" flexDirection="column" rowGap={1}>
        {rows.map((r, i) => (
          <Box key={`nav-row-${i}`} flexDirection="row" justifyContent="space-between">
            {r.map(t => (
              <Box key={`nav-cell-${t.id}`} width={cell} flexDirection="row" justifyContent="center">
                {tab(t)}
              </Box>
            ))}
            {/* A short last row keeps its cells under the ones above. */}
            {Array.from({ length: NAV_PER_ROW - r.length }, (_, j) => (
              <Box key={`nav-pad-${i}-${j}`} width={cell} />
            ))}
          </Box>
        ))}
      </Box>
    )
  }
  const widthAt = (gap: number) => input.tabs.reduce((n, t) => n + t.label.length, 0) + gap * (input.tabs.length - 1)
  const gap = widthAt(3) <= kit.columns ? 3 : widthAt(2) <= kit.columns ? 2 : 0
  const tab = (t: { id: T; label: string }) => <Button key={`tab-${t.id}`} label={t.label} plain dimColor={t.id !== input.current} onPress={() => input.onSelect(t.id)} />
  const currentAccent = input.tabs.find(t => t.id === input.current)?.accent ?? 'claude'
  if (gap === 0) {
    const half = Math.ceil(input.tabs.length / 2)
    return (
      <Box key="nav" flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          {input.tabs.slice(0, half).map(tab)}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          {input.tabs.slice(half).map(tab)}
        </Box>
        <Text color={currentAccent}>{G.lineEmpty.repeat(Math.max(4, kit.columns))}</Text>
      </Box>
    )
  }
  const underline: RenderElement[] = []
  let used = 0
  input.tabs.forEach((t, i) => {
    if (i > 0) {
      underline.push(
        <Text key={`nav-gap-${i}`} dimColor>
          {G.lineEmpty.repeat(gap)}
        </Text>,
      )
      used += gap
    }
    const isCurrent = t.id === input.current
    underline.push(
      <Text key={`nav-line-${t.id}`} {...(isCurrent ? { color: t.accent } : { dimColor: true })}>
        {(isCurrent ? G.lineFull : G.lineEmpty).repeat(t.label.length)}
      </Text>,
    )
    used += t.label.length
  })
  if (kit.columns > used) {
    underline.push(
      <Text key="nav-rest" dimColor>
        {G.lineEmpty.repeat(kit.columns - used)}
      </Text>,
    )
  }
  return (
    <Box key="nav" flexDirection="column">
      <Box flexDirection="row" columnGap={gap}>
        {input.tabs.map(tab)}
      </Box>
      <Text wrap="truncate-end">{underline}</Text>
    </Box>
  )
}
