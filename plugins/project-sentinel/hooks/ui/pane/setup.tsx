/**
 * Setup: profiles (everything at once), display, and about. The profile in
 * use carries a check; when settings drifted from it, the exact changes are
 * listed, with a way back and a way to keep them as a profile.
 */

import type { RenderElement } from 'claude-code'

import type { PaneModel } from '../../../types'
import { VERSION } from '../../constants'
import { diffSystems, listProfiles } from '../../core/profiles'
import { systemsOf } from '../../core/settings'
import type { Kit } from '../kit'
import * as fmt from '../../core/format'
import { buttons, card, isNative, link, note, picker, row, switchControl } from '../primitives'
import { ACCENT, G } from '../theme'

/**
 * How telling a change from the profile is, by the system it touches: what
 * changes how Claude works or what it may do comes before presentation.
 */
const WEIGHT: readonly string[] = ['autopilot', 'frontier', 'permissions', 'guard', 'qa', 'resources', 'subagents', 'agentModels', 'cache', 'answers', 'progress', 'focus']

const weightOf = (path: string): number => {
  const i = WEIGHT.indexOf(path.split('.')[0] ?? '')
  return i < 0 ? WEIGHT.length : i
}

/** Setup lists this many changes before "View all". */
const CHANGES_SHOWN = 4

export function setupPage(kit: Kit, pane: PaneModel): RenderElement {
  const { Box, Button, Input } = kit.ui
  const s = pane.settings
  const u = kit.actions.update
  const accent = ACCENT.setup
  const profiles = listProfiles(s)
  const active = profiles.find(p => p.id === s.profile)
  const changes = (active === undefined ? [] : diffSystems(active.systems, systemsOf(s))).map((c, i) => ({ c, i })).sort((a, b) => weightOf(a.c.path) - weightOf(b.c.path) || a.i - b.i).map(x => x.c)
  const shown = pane.showAllChanges || changes.length <= CHANGES_SHOWN + 1 ? changes : changes.slice(0, CHANGES_SHOWN)

  return (
    <Box flexDirection="column">
      {card(kit, {
        key: 'profiles',
        title: 'Profile',
        accent,
        footer: 'A profile sets everything at once. Change anything afterwards and the profile shows as edited.',
        rows: k =>
          profiles.map(p => {
            const isActive = p.id === s.profile
            const label = isActive ? `${G.ok} In use` : 'Use'
            return row(k, {
              key: `profile-${p.id}`,
              label: p.name,
              subtitle: isActive && changes.length > 0 ? 'Edited' : p.tagline,
              isDim: !isActive,
              control: {
                element: (
                  <Box key={`profile-${p.id}-actions`} flexDirection="row" columnGap={2}>
                    {p.isBuiltin ? null : <Button key={`delete-${p.id}`} label="Delete" plain dimColor onPress={() => kit.actions.deleteProfile(p.id)} />}
                    <Button key={`apply-${p.id}`} label={label} plain={isNative(k) ? undefined : true} dimColor={!isActive} variant={isActive ? 'primary' : 'secondary'} onPress={() => kit.actions.applyProfile(p.id)} />
                  </Box>
                ),
                width: label.length + (p.isBuiltin ? 0 : 8) + (isNative(k) ? 4 : 0),
              },
            })
          }),
      })}

      {changes.length === 0 || active === undefined
        ? null
        : card(kit, {
            key: 'changes',
            title: `Changed from ${active.name}`,
            accent,
            aside: fmt.plural(changes.length, 'change'),
            rows: k => [
              ...shown.map(c => row(k, { key: `change-${c.path}`, label: c.label, value: `${c.from} ${G.chevron} ${c.to}` })),
              shown.length < changes.length || pane.showAllChanges
                ? row(k, {
                    key: 'changes-all',
                    label: pane.showAllChanges ? 'Every change is listed' : `${changes.length - shown.length} more`,
                    isDim: true,
                    control: link(k, { key: 'changes-all', label: pane.showAllChanges ? 'Show fewer' : `View all ${changes.length}`, onPress: kit.actions.toggleChanges }),
                  })
                : null,
              Input === undefined
                ? null
                : row(k, {
                    key: 'profile-save',
                    label: 'Keep as a profile',
                    // A native text field is far wider than its placeholder, so it moves under the label sooner.
                    control: { element: <Input key="profile-save" value="" placeholder="Type a name" submitLabel={isNative(k) ? 'Save' : 'save'} onSubmit={name => kit.actions.saveProfile(name)} />, width: isNative(k) ? 36 : 18 },
                  }),
              buttons(k, [{ key: 'profile-revert', label: `Back to ${active.name}`, onPress: () => kit.actions.applyProfile(active.id) }], 'profile-actions'),
            ],
          })}

      {card(kit, {
        key: 'display',
        title: 'Display',
        accent,
        rows: k => [
          row(k, {
            key: 'ui-hud',
            label: 'Status bar',
            subtitle: s.ui.hud === 'off' ? '/cr still opens Control Room' : 'Live readings while you work',
            control: picker(k, {
              key: 'ui-hud',
              value: s.ui.hud,
              options: [
                { value: 'band', label: 'Above prompt' },
                { value: 'status', label: 'Status line' },
                { value: 'both', label: 'Both' },
                { value: 'off', label: 'Hidden' },
              ],
              onSelect: v => u(d => void (d.ui.hud = (['band', 'status', 'both', 'off'].includes(v) ? v : 'band') as typeof d.ui.hud)),
            }),
          }),
          row(k, {
            key: 'ui-load',
            label: 'Live CPU and memory',
            subtitle: `Machine-wide totals every ${s.resources.intervalSec} s`,
            control: switchControl(k, { key: 'ui-load', isOn: s.ui.liveLoad, onPress: () => u(d => void (d.ui.liveLoad = !d.ui.liveLoad)) }),
          }),
          row(k, {
            key: 'ui-toasts',
            label: 'Notifications',
            subtitle: 'Brief notes when something changes',
            control: switchControl(k, { key: 'ui-toasts', isOn: s.ui.toasts, onPress: () => u(d => void (d.ui.toasts = !d.ui.toasts)) }),
          }),
          row(k, {
            key: 'ui-companion',
            label: 'Companion',
            subtitle: s.ui.companion ? 'Kit shows what Claude is doing, and answers a click' : 'A small pixel creature on the status bar that shows what Claude is doing',
            control: switchControl(k, { key: 'ui-companion', isOn: s.ui.companion, onPress: () => u(d => void (d.ui.companion = !d.ui.companion)) }),
          }),
          row(k, {
            key: 'ui-motion',
            label: 'Reduce motion',
            subtitle: 'Still drawings instead of animation',
            control: switchControl(k, { key: 'ui-motion', isOn: s.ui.reducedMotion, onPress: () => u(d => void (d.ui.reducedMotion = !d.ui.reducedMotion)) }),
          }),
          row(k, {
            key: 'ui-open',
            label: 'Open at start',
            subtitle: kit.surface === 'terminal' ? 'In terminals 144 columns or wider' : 'Open Control Room with each session',
            control: switchControl(k, { key: 'ui-open', isOn: s.ui.openOnStart, onPress: () => u(d => void (d.ui.openOnStart = !d.ui.openOnStart)) }),
          }),
        ],
      })}

      {card(kit, {
        key: 'about',
        title: 'About',
        accent,
        rows: k => [
          row(k, { key: 'about-version', label: 'Control Room', value: VERSION, valueTone: 'muted' }),
          row(k, { key: 'about-engine', label: 'Claude Code', value: pane.engine.version ?? 'unknown', valueTone: pane.engine.isSupported ? 'muted' : 'warn' }),
          note(k, 'Runs on your machine only. No network requests, no telemetry. It keeps its settings and run history in Claude Code’s plugin store.', 'about-privacy'),
          buttons(k, [{ key: 'reset', label: 'Reset all settings', onPress: kit.actions.resetSettings }], 'about-actions'),
        ],
      })}
    </Box>
  )
}
