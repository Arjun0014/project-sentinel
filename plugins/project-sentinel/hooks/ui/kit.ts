/**
 * What every view function receives: the surface's element constructors
 * (from `$.ui.resolve(e)`), the actions its controls call, and the room it
 * has. Views never touch `$`; actions mutate the Runtime, which republishes.
 */

import type {
  BoxProps,
  ButtonProps,
  CodeProps,
  ElementConstructor,
  InputProps,
  MarkdownProps,
  RenderSurface,
  SelectProps,
  SvgProps,
  TextProps,
} from 'claude-code'

import type { ActivitySub, ControlRoomSettings, QueueTarget, TabId, WatchStrategy } from '../../types'

export type Ui = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Code: ElementConstructor<CodeProps>
  Markdown: ElementConstructor<MarkdownProps>
  /** Desktop and VS Code only: their native popup works with pointer and keys alike. */
  Select?: ElementConstructor<SelectProps>
  Input?: ElementConstructor<InputProps>
  /** Remote surfaces only (Desktop, VS Code, mobile). */
  Svg?: ElementConstructor<SvgProps>
}

export type Actions = {
  openPane: () => void
  closePane: () => void
  togglePane: () => void
  setTab: (tab: TabId) => void
  /** Opens one in-place picker, or closes it when it is the open one; null closes any. */
  togglePicker: (key: string | null) => void
  setActivitySub: (sub: ActivitySub) => void
  toggleGenerated: () => void
  /** Setup: every change from the profile, or the most telling few. */
  toggleChanges: () => void
  /** Brings the section bar back into view. */
  scrollToTop: () => void
  update: (change: (draft: ControlRoomSettings) => void) => void
  applyProfile: (id: string) => void
  saveProfile: (name: string) => void
  deleteProfile: (id: string) => void
  handoff: () => void
  fresh: () => void
  snooze: () => void
  /** A handoff's ways out of a wait: hand off now and leave background work running, stop it first, wait longer, call it off. */
  handoffNow: () => void
  stopAndHandoff: (taskId?: string) => void
  keepWaiting: () => void
  cancelHandoff: () => void
  stopTask: (taskId: string) => void
  selectFile: (path: string | null) => void
  clearChanges: () => void
  toggleRow: (id: string) => void
  toggleFocus: () => void
  resetSettings: () => void
  /** The first-run card's "Got it". */
  dismissOnboarding: () => void
  copy: (text: string, surface: RenderSurface) => void
  /** Activity → Operations: opens the panel there (from the status bar's chips and alerts). */
  /** Opens Activity → Operations, at one of its cards when given (`ops-review`, `ops-budget`, ...). */
  openOps: (section?: string) => void
  /** Opens Activity → Agents (the agent band, the agents chip, Operations' line). */
  openAgents: () => void
  /** Milestone evidence: accept stale milestones' files as they are now (one by key, or all). */
  acceptEvidence: (key: string | null) => void
  /** Opens or closes a row's details (a watcher, a queued item, an agent, a decision). */
  toggleOpsRow: (id: string) => void
  // Mission Queue
  queueAdd: (text: string) => void
  setQueueTarget: (target: QueueTarget) => void
  editQueue: (id: string | null) => void
  queueEdit: (id: string, text: string) => void
  queueRetarget: (id: string, target: QueueTarget) => void
  queueMove: (id: string, delta: -1 | 1) => void
  queueNow: (id: string) => void
  queueCancel: (id: string) => void
  // Decision Inbox
  answer: (id: string, text: string) => void
  answerNow: (id: string) => void
  withdraw: (id: string) => void
  // Watchers
  watchLabel: (label: string) => void
  setWatchStrategy: (strategy: WatchStrategy) => void
  /** Arms a watcher from the form: its label draft, this time ("in 2h", "at 14:00"), its strategy. */
  watchAdd: (when: string) => void
  watchPick: (at: number) => void
  watchWake: (id: string) => void
  watchCheck: (id: string) => void
  watchFresh: (id: string) => void
  watchSnooze: (id: string, minutes: number) => void
  watchReschedule: (id: string, when: string) => void
  editWatch: (id: string | null) => void
  watchPause: (id: string) => void
  watchResume: (id: string) => void
  watchDismiss: (id: string) => void
  watchStrategy: (id: string, strategy: WatchStrategy) => void
  watchNotes: (id: string) => void
  suggestTake: () => void
  suggestAt: (when: string) => void
  suggestIgnore: () => void
  // The Cold Resume Guard's held message
  heldPutBack: () => void
  heldSend: () => void
  heldDiscard: () => void
  // Run Budget
  budgetOpen: (isOpen: boolean) => void
  budgetCost: (text: string) => void
  budgetTime: (text: string) => void
  budgetHandoffs: (delta: number) => void
  budgetAtLimit: (atLimit: 'notify' | 'ask' | 'finish') => void
  budgetClear: () => void
  budgetApprove: () => void
  // An ended run's operations, and agents
  foreignBring: () => void
  foreignDismiss: () => void
  agentStop: (id: string) => void
  editMessage: (id: string | null) => void
  agentMessage: (id: string, text: string) => void
}

export type Kit = {
  ui: Ui
  actions: Actions
  /** Cells across the body the tree draws into. */
  columns: number
  surface: RenderSurface
  now: number
  /** The in-place picker drawn open, by key. */
  openPicker: string | null
  /** Where a pane sits: docked beside the transcript, or a short frame above the prompt. */
  placement?: 'dock' | 'inline'
}

/**
 * Picks the surface's element table into a Ui. The engine completes every
 * table (an element a surface lacks draws as an empty fragment), so what a
 * surface can really draw is decided by the surface, not by presence.
 *
 * The terminal's Select is left out on purpose: its option list cannot be
 * picked or closed with the pointer, so the terminal draws choices in place.
 */
export function uiOf(table: Partial<Ui> & Pick<Ui, 'Box' | 'Text' | 'Button' | 'Code' | 'Markdown'>, surface: RenderSurface): Ui {
  const isNative = surface === 'desktop' || surface === 'vscode'
  return {
    Box: table.Box,
    Text: table.Text,
    Button: table.Button,
    Code: table.Code,
    Markdown: table.Markdown,
    Select: isNative ? table.Select : undefined,
    Input: surface === 'mobile' ? undefined : table.Input,
    Svg: surface === 'terminal' ? undefined : table.Svg,
  }
}
