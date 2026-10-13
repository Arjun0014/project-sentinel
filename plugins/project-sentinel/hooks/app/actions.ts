/**
 * The Control Centre's actions: what every Button, Select and Input calls.
 * Each goes through the Runtime, which validates, persists, reconfigures
 * the live systems and republishes the views.
 */

import { deleteCustomProfile, saveCustomProfile } from '../core/profiles'
import { defaultSettings } from '../core/settings'
import { parseDuration } from '../features/when'
import type { Actions } from '../ui/kit'
import type { Runtime } from './runtime'

export function actionsOf(rt: Runtime): Actions {
  return {
    openPane: () => void rt.openPane(true),
    closePane: () => void rt.closePane(),
    togglePane: () => void rt.togglePane(),
    setTab: tab => rt.setTab(tab),
    togglePicker: key => rt.togglePicker(key),
    setActivitySub: sub => {
      rt.ui.activitySub = sub
      rt.publisher.mark('pane')
    },
    toggleChanges: () => {
      rt.ui.showAllChanges = !rt.ui.showAllChanges
      rt.publisher.mark('pane')
    },
    toggleGenerated: () => {
      rt.ui.showGenerated = !rt.ui.showGenerated
      rt.publisher.mark('activity')
    },
    scrollToTop: () => void rt.host?.scrollPaneToTop().catch(() => undefined),
    update: change => rt.update(draft => void change(draft)),
    applyProfile: id => void rt.applyProfileById(id),
    saveProfile: name => {
      const clean = name.trim()
      if (clean === '') return
      rt.update(s => saveCustomProfile(s, clean, Date.now()))
      rt.host?.toast(`Profile “${clean}” saved`, 3000)
    },
    deleteProfile: id => rt.update(s => deleteCustomProfile(s, id)),
    handoff: () => void rt.requestHandoff().then(text => rt.sayToPerson(text)),
    fresh: () => void rt.startFreshContext().then(text => rt.sayToPerson(text)),
    snooze: () => rt.snoozeAutopilot(),
    handoffNow: () => void rt.handoffNow().then(text => rt.sayToPerson(text)),
    stopAndHandoff: taskId => void rt.stopAndHandOff(taskId).then(text => rt.sayToPerson(text)),
    keepWaiting: () => void rt.keepWaiting().then(text => rt.sayToPerson(text)),
    cancelHandoff: () => rt.sayToPerson(rt.cancelHandoff()),
    stopTask: taskId => void rt.stopBackgroundTask(taskId),
    selectFile: path => rt.selectChangedFile(path),
    clearChanges: () => {
      rt.activity.clearChanges()
      rt.ui.selectedPath = null
      rt.publisher.mark('activity', 'pane')
    },
    toggleRow: id => rt.toggleRow(id),
    toggleFocus: () =>
      rt.update(s => {
        s.focus.enabled = !s.focus.enabled
      }),
    resetSettings: () => {
      rt.update(s => ({ ...defaultSettings(), customProfiles: s.customProfiles }))
      rt.host?.toast('Settings reset to Normal (Autopilot at 70%, Frontier Max at Extra High)', 3000)
    },
    copy: (text, surface) => void rt.host?.copy(text, surface),
    dismissOnboarding: () => rt.dismissOnboarding(),

    openOps: section => void rt.openOps(undefined, section),
    openAgents: () => void rt.openActivity('agents'),
    acceptEvidence: key => void rt.acceptEvidence(key).then(text => rt.sayToPerson(text)),
    toggleOpsRow: id => {
      const open = rt.ui.ops.expanded
      rt.ui.ops.expanded = open.includes(id) ? open.filter(x => x !== id) : [...open, id].slice(-12)
      rt.publisher.mark('ops')
    },
    queueAdd: text => {
      const done = rt.ops.queueAdd(text, rt.ui.ops.queueTarget)
      rt.ui.ops.error = done.ok ? null : done.error
      if (done.ok && rt.settings.ui.toasts) rt.host?.toast(`Queued ${done.id} · ${done.when}`, 3000)
      rt.publisher.mark('ops')
    },
    setQueueTarget: target => {
      rt.ui.ops.queueTarget = target
      rt.ui.openPicker = null
      rt.publisher.mark('ops', 'pane')
    },
    editQueue: id => {
      rt.ui.ops.editing = id
      rt.publisher.mark('ops')
    },
    queueEdit: (id, text) => {
      rt.ops.queueEdit(id, { text })
      rt.ui.ops.editing = null
      rt.publisher.mark('ops')
    },
    queueRetarget: (id, target) => {
      rt.ops.queueEdit(id, { target })
      rt.ui.openPicker = null
      rt.publisher.mark('ops', 'pane')
    },
    queueMove: (id, delta) => rt.ops.queueMove(id, delta),
    queueNow: id => rt.ops.queueNow(id),
    queueCancel: id => rt.ops.queueCancel(id),

    answer: (id, text) => {
      const done = rt.ops.answer(id, text)
      rt.ui.ops.error = done.ok ? null : done.error
      rt.publisher.mark('ops')
    },
    answerNow: id => rt.ops.answerNow(id),
    withdraw: id => rt.ops.withdraw(id),

    watchLabel: label => {
      // A draft: kept as typed, never redrawn per key.
      rt.ui.ops.watchLabel = label
    },
    setWatchStrategy: strategy => {
      rt.ui.ops.watchStrategy = strategy
      rt.ui.openPicker = null
      rt.publisher.mark('ops', 'pane')
    },
    watchAdd: when => {
      const done = rt.ops.armFrom(rt.ui.ops.watchLabel, when, rt.ui.ops.watchStrategy)
      rt.ui.ops.choices = done.ok ? null : (done.options ?? null)
      rt.ui.ops.error = done.ok ? null : done.error
      if (done.ok) {
        rt.ui.ops.watchLabel = ''
        if (rt.settings.ui.toasts) rt.host?.toast(`Watcher ${done.words}`, 5000)
      }
      rt.publisher.mark('ops')
    },
    watchPick: at => {
      const done = rt.ops.armAt(rt.ui.ops.watchLabel, { kind: 'at', at, words: '' }, rt.ui.ops.watchStrategy)
      rt.ui.ops.choices = null
      rt.ui.ops.error = done.ok ? null : done.error
      if (done.ok) {
        rt.ui.ops.watchLabel = ''
        if (rt.settings.ui.toasts) rt.host?.toast(`Watcher ${done.words}`, 5000)
      }
      rt.publisher.mark('ops')
    },
    watchWake: id => void rt.ops.wakeNow(id),
    watchCheck: id => void rt.ops.checkNow(id),
    watchFresh: id => void rt.ops.wakeFreshNow(id),
    watchSnooze: (id, minutes) => void rt.ops.rescheduleAt(id, rt.clock() + minutes * 60_000),
    watchReschedule: (id, when) => {
      const done = rt.ops.reschedule(id, when)
      rt.ui.ops.error = done.ok ? null : done.error
      if (done.ok) rt.ui.ops.rescheduling = null
      rt.publisher.mark('ops')
    },
    editWatch: id => {
      rt.ui.ops.rescheduling = id
      rt.publisher.mark('ops')
    },
    watchPause: id => rt.ops.pause(id),
    watchResume: id => rt.ops.resume(id),
    watchDismiss: id => rt.ops.dismiss(id),
    watchStrategy: (id, strategy) => {
      rt.ops.setStrategy(id, strategy)
      rt.ui.openPicker = null
      rt.publisher.mark('ops', 'pane')
    },
    watchNotes: id => void rt.ops.prepareNotes(id),
    suggestTake: () => {
      const done = rt.ops.takeSuggestion()
      if (done.ok && rt.settings.ui.toasts) rt.host?.toast(`Watcher ${done.words}`, 5000)
      if (!done.ok) void rt.openOps()
    },
    suggestAt: when => {
      const done = rt.ops.takeSuggestion(when)
      rt.ui.ops.error = done.ok ? null : done.error
      rt.ui.ops.choices = done.ok ? null : (done.options ?? null)
      if (done.ok && rt.settings.ui.toasts) rt.host?.toast(`Watcher ${done.words}`, 5000)
      rt.publisher.mark('ops')
    },
    suggestIgnore: () => rt.ops.ignoreSuggestion(),

    heldPutBack: () => rt.ops.heldPutBack(),
    heldSend: () => rt.ops.heldSend(),
    heldDiscard: () => rt.ops.heldDiscard(),

    budgetOpen: isOpen => {
      rt.ui.ops.budgetOpen = isOpen
      rt.publisher.mark('ops')
    },
    budgetCost: text => {
      const t = text.trim()
      const n = Number(t.replace(/[$,\s]/g, ''))
      if (t === '' || t === '0') rt.ops.setBudget({ costUsd: null })
      else if (Number.isFinite(n) && n > 0) rt.ops.setBudget({ costUsd: Math.round(n * 100) / 100 })
      else rt.ui.ops.error = `"${t}" is not an amount: try 30 or 12.50.`
      rt.publisher.mark('ops')
    },
    budgetTime: text => {
      const t = text.trim()
      const ms = t === '' || t === '0' ? null : parseDuration(t)
      if (ms === null && t !== '' && t !== '0') rt.ui.ops.error = `"${t}" is not a duration: try 6h or 90m.`
      else rt.ops.setBudget({ durationMs: ms })
      rt.publisher.mark('ops')
    },
    budgetHandoffs: delta => {
      const now = rt.ops.current().budget?.handoffs ?? 0
      const next = Math.max(0, Math.min(50, now + delta))
      rt.ops.setBudget({ handoffs: next === 0 ? null : next })
    },
    budgetAtLimit: atLimit => {
      rt.ops.setBudget({ atLimit })
      rt.ui.openPicker = null
      rt.publisher.mark('ops', 'pane')
    },
    budgetClear: () => {
      rt.ops.setBudget(null)
      rt.ui.ops.budgetOpen = false
      rt.publisher.mark('ops')
    },
    budgetApprove: () => rt.ops.approveBudget(),

    foreignBring: () => void rt.ops.bringForeign(),
    foreignDismiss: () => rt.ops.dismissForeign(),
    agentStop: id => void rt.ops.stopAgent(id),
    editMessage: id => {
      rt.ui.ops.messaging = id
      rt.publisher.mark('ops')
    },
    agentMessage: (id, text) => {
      void rt.ops.messageAgent(id, text)
      rt.ui.ops.messaging = null
      rt.publisher.mark('ops')
    },
  }
}
