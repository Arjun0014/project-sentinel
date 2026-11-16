/**
 * The Control Centre's frame: the name and the active profile, the section
 * bar, the page, and (in the terminal) one quiet line on how to move.
 *
 * Six sections, each answering one question:
 *   Overview    How is this session doing, and what is on?
 *   Context     When does Claude hand off, and what happened across the run?
 *   Behavior    How does Claude work (effort, finishing the job, models)?
 *   Guardrails  What may Claude do, and how hard may it push the machine?
 *   Activity    What did Claude just do, and what did it change?
 *   Setup       Profiles, display, about.
 */

import type { RenderElement } from 'claude-code'

import type { ActivityView, ChainView, HudModel, OpsView, PaneModel, PermissionsView, ResourcesView, TabId } from '../../../types'
import type { Kit } from '../kit'
import { clip, navBar } from '../primitives'
import { ACCENT, G } from '../theme'
import { activityPage } from './activity'
import { behaviorPage } from './behavior'
import { contextPage } from './context'
import { guardrailsPage } from './guardrails'
import { overviewPage } from './overview'
import { setupPage } from './setup'

export const TABS: readonly { id: TabId; label: string; accent: string }[] = [
  { id: 'overview', label: 'Overview', accent: ACCENT.overview },
  { id: 'context', label: 'Context', accent: ACCENT.context },
  { id: 'behavior', label: 'Behavior', accent: ACCENT.behavior },
  { id: 'guardrails', label: 'Guardrails', accent: ACCENT.guardrails },
  { id: 'activity', label: 'Activity', accent: ACCENT.activity },
  { id: 'setup', label: 'Setup', accent: ACCENT.setup },
]

/** Which extra atoms a page draws from (the render hook reads only these). */
export const TAB_NEEDS: Record<TabId, readonly ('resources' | 'chain' | 'activity' | 'permissions' | 'ops')[]> = {
  overview: ['resources', 'ops'],
  context: ['chain', 'ops'],
  behavior: [],
  guardrails: ['permissions', 'resources'],
  activity: ['activity', 'ops'],
  setup: [],
}

export type PaneData = {
  pane: PaneModel
  hud: HudModel
  resources?: ResourcesView
  chain?: ChainView
  activity?: ActivityView
  permissions?: PermissionsView
  /** The orchestration layer (Activity → Operations; Overview's card; Context's Cold Resume Guard and Ready to resume). */
  ops?: OpsView
}

function header(kit: Kit, data: PaneData): RenderElement {
  const { Box, Text, Button } = kit.ui
  const p = data.hud.profile
  const chip = `${p.name}${p.isModified ? ' · edited' : ''}`
  return (
    <Box key="header" flexDirection="row" justifyContent="space-between" alignItems="center">
      <Text>
        <Text color="claude" bold>
          {G.brand}
        </Text>
        <Text bold>{' Control Room'}</Text>
      </Text>
      <Button key="header-profile" label={chip} plain dimColor={p.id === 'normal'} onPress={() => kit.actions.setTab('setup')} />
    </Box>
  )
}

function page(kit: Kit, data: PaneData): RenderElement {
  switch (data.pane.tab) {
    case 'overview':
      return overviewPage(kit, data)
    case 'context':
      return contextPage(kit, data.pane, data.hud, data.chain, data.ops)
    case 'behavior':
      return behaviorPage(kit, data.pane)
    case 'guardrails':
      return guardrailsPage(kit, data.pane, data.permissions, data.resources)
    case 'activity':
      return activityPage(kit, data.pane, data.activity, data.ops)
    case 'setup':
      return setupPage(kit, data.pane)
  }
}

/**
 * The widest a page draws. Beyond it a row's label and its control drift too
 * far apart to read as one line (an inline frame in a wide terminal spans
 * the screen, as does a Desktop pane at full size), so a wider frame centres
 * the page at this width.
 */
export const MAX_COLUMNS = 80

/**
 * Desktop's minimized pane (`widget`): a glance, never the panel. Clicks may not reach it, so it holds
 * no controls: what needs the person, then the context and the handoff, then agents at work.
 */
export function widgetView(kit: Kit, data: PaneData): RenderElement {
  const { Box, Text } = kit.ui
  const hud = data.hud
  const ctx = hud.ctx
  const pct = ctx.pct === null ? (ctx.tokens === null ? 'new context' : `${ctx.isProvisional ? '~' : ''}${Math.round(ctx.tokens / 1000)}k`) : `${ctx.isProvisional ? '~' : ''}${ctx.pct}%`
  const lines: { key: string; text: string; color?: string; dim?: boolean }[] = []
  if (hud.alert !== null) lines.push({ key: 'w-alert', text: `${G.warn} ${hud.alert.text}`, color: hud.alert.tone === 'bad' ? 'error' : 'warning' })
  lines.push({ key: 'w-ctx', text: `Context ${pct}${hud.autopilot.isOn ? ` · ${hud.autopilot.text}` : ''}` })
  if (hud.work !== null) lines.push({ key: 'w-work', text: `Work ${hud.work.done}/${hud.work.total}${hud.work.current === null ? '' : ` · ${hud.work.current}`}`, dim: true })
  if (hud.agents.running > 0) lines.push({ key: 'w-agents', text: `${hud.agents.running} agent${hud.agents.running === 1 ? '' : 's'} running`, dim: true })
  return (
    <Box key="widget" flexDirection="column" paddingX={1}>
      <Text key="w-title" bold>
        <Text color="claude">{G.brand}</Text>
        {' Sentinel'}
      </Text>
      {lines.map(l => (
        <Text key={l.key} wrap="truncate-end" {...(l.color === undefined ? {} : { color: l.color })} {...(l.dim === true ? { dimColor: true } : {})}>
          {l.text}
        </Text>
      ))}
    </Box>
  )
}

export function paneView(base: Kit, data: PaneData): RenderElement {
  if (base.placement === 'widget') return widgetView(base, data)
  const inner = Math.max(24, base.columns - 2)
  const columns = Math.min(MAX_COLUMNS, inner)
  const kit: Kit = { ...base, openPicker: data.pane.openPicker, columns }
  const { Box, Text, Button } = kit.ui
  const notes = data.pane.notes
  // A short frame above the prompt: the tabs sit right under the title, so the page starts sooner.
  const isShort = kit.placement === 'inline' && kit.surface === 'terminal'
  const body = (
    <Box key="page-body" flexDirection="column" paddingX={1} width={columns === inner ? undefined : columns + 2}>
      {header(kit, data)}
      <Box key="nav-wrap" marginTop={isShort ? 0 : 1} flexDirection="column">
        {navBar(kit, { tabs: TABS, current: data.pane.tab, onSelect: id => kit.actions.setTab(id) })}
      </Box>
      {notes.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1} key="notes">
          {notes.map((n, i) => (
            <Text key={`note-${i}`} color="warning" wrap="wrap">{`${G.warn} ${n}`}</Text>
          ))}
        </Box>
      )}
      {page(kit, data)}
      <Box marginTop={1} key="footer" flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexShrink={1} {...clip(kit)}>
          {kit.surface === 'terminal' ? (
            <Text dimColor wrap="truncate-end">
              {'Tab to move · Enter to choose · Esc to return'}
            </Text>
          ) : null}
        </Box>
        {/* The section bar does not scroll with the page; this brings it back from the end of any page. */}
        <Box flexShrink={0}>
          <Button key="to-top" label={`${G.top} Sections`} plain dimColor onPress={kit.actions.scrollToTop} />
        </Box>
      </Box>
    </Box>
  )
  // Capped in a wider frame: centred, so the margins match.
  if (columns === inner) return body
  return (
    <Box flexDirection="column" alignItems="center">
      {body}
    </Box>
  )
}
