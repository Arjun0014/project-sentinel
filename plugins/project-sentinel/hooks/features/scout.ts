/**
 * Watcher Scout: after a turn, whether Claude evidently waits for a future result, and when to
 * look again, read only from what is explicit:
 *
 *   - a milestone Claude marked waiting (its blocker may say when: "S-002 result, check at 14:00");
 *   - a sentence of Claude's last message that pairs a check with a time ("I'll check the
 *     leaderboard again in two hours", "re-run the eval at 14:00").
 *
 * A sentence addressed to the person ("you can check back in an hour") is advice, not a wait. No
 * model is asked: a wait with no time is suggested without one, and the person picks it. Pure.
 */

import { clean } from '../core/text'
import { type WhenResult, clockAhead, parseWhen, untilWords } from './when'

export type ScoutSuggestion = {
  /** What the watcher would wait for, in words. */
  label: string
  /** When to look again, if a time was said; null when it was not (the person picks). */
  when: WhenResult | null
  whenText: string | null
  /** Why it is suggested, in words. */
  reason: string
  /** A milestone marked waiting, or a sentence with a check and an unambiguous time: what Auto-arm acts on. */
  isExplicit: boolean
  source: 'milestone' | 'message'
}

/** Words that open a time phrase. */
const OPENERS = new Set(['in', 'after', 'at', 'around', 'by'])

/** A check, a look, a wait: what makes a sentence about coming back later. */
const CUE = /\b(check(?:ing)?|re-?check|look(?:ing)? (?:again|back|at)|come back|circle back|revisit|poll|try again|re-?run|see (?:if|whether)|follow up|wait(?:ing)? (?:for|until|on)|resume|pick (?:it|this|that) (?:back )?up|verify)\b/i

/** Addressed to the person: advice, not Claude's own wait. */
const TO_PERSON = /^you\b|\byou(?:'ll| will| can| could| should| may| might| need to)\b/i

/** Claude speaking about its own next step. */
const LEAD = /^(?:(?:ok(?:ay)?|so|then|next|now)[, ]+)?(?:i(?:'ll| will| need to| should| want to| plan to| am going to|'m going to)|let me|we(?:'ll| will| need to| should)|i'd like to)\s+/i

/** The longest time phrase found in the words, and where it is. */
function findTime(text: string, now: number): { phrase: string; result: WhenResult; start: number; end: number } | null {
  const words = text.split(/\s+/)
  let best: { phrase: string; result: WhenResult; start: number; end: number } | null = null
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.toLowerCase().replace(/[^a-z]/g, '')
    if (!OPENERS.has(w) && w !== 'tomorrow') continue
    for (let n = Math.min(6, words.length - i); n >= 2; n--) {
      const phrase = words
        .slice(i, i + n)
        .join(' ')
        .replace(/[.,;:!?)"'”’]+$/, '')
      const result = parseWhen(phrase, now)
      if (result.kind === 'error') continue
      // "at 14:50 local", "at 14:50 local time": the clock's own words, kept with the time and out of the label.
      const bare = (k: number): string => (words[k] ?? '').toLowerCase().replace(/[^a-z]/g, '')
      let end = i + n
      if (bare(end) === 'local') end += bare(end + 1) === 'time' ? 2 : 1
      const said = end === i + n ? phrase : words.slice(i, end).join(' ').replace(/[.,;:!?)"'”’]+$/, '')
      if (best === null || end - i > best.end - best.start) best = { phrase: said, result, start: i, end }
      break
    }
  }
  return best
}

/** The words with the time phrase taken out, Claude's lead-in dropped, cut to a label. */
function labelOf(text: string, time: { start: number; end: number } | null): string {
  const words = text.split(/\s+/)
  const kept = time === null ? words : [...words.slice(0, time.start), ...words.slice(time.end)]
  const out = kept
    .join(' ')
    .replace(LEAD, '')
    .replace(/[\s,;:]+$/, '')
    .replace(/[.!?]+$/, '')
    // "S-002 result, check (at 14:00)": the check is what the watcher does, not what it waits for.
    .replace(/[\s,;:-]+\b(?:check(?: (?:it|again|back))?|re-?check|look again|revisit|poll)$/i, '')
    .trim()
  return clean(out.charAt(0).toUpperCase() + out.slice(1), 60)
}

/** A label's first word when it is an article or a determiner, never a name. */
const ARTICLE = /^(?:the|a|an|this|that|these|those|its|their|our|my|your|his|her|some|any|each|every|all|both)\b/i

/**
 * The suggestion as the person is asked it: "Check the leaderboard again in two hours?", in Claude's
 * own time words when it said them, else the local time or a countdown.
 */
export function suggestionWords(s: { label: string; when: WhenResult | null; whenText: string | null }, now: number): string {
  const at = s.when !== null && s.when.kind === 'at' ? s.when.at : null
  // The label starts with a capital where it stands alone; inside the question an article or a determiner is lowercase
  // (a name keeps its capital).
  const what = s.label.replace(/^(?:check|look at|re-?check|revisit)\s+/i, '').replace(ARTICLE, w => w.toLowerCase())
  const when = at === null ? ' later' : s.whenText !== null ? ` ${s.whenText}` : ` at ${clockAhead(at, now)} (in ${untilWords(at - now)})`
  const again = at === null || /\bagain\b/i.test(what) ? '' : ' again'
  return `Check ${what}${again}${when}?`
}

const sentencesOf = (text: string): string[] =>
  text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.replace(/^[\s>*\-•\d.)]+/, '').trim())
    .filter(s => s.length >= 8 && s.length <= 400)

export function scoutOf(input: { now: number; message: string; waiting: readonly { subject: string; detail: string | null }[] }): ScoutSuggestion | null {
  // A milestone marked waiting is the plainest signal: Claude said so in its run state.
  for (const m of [...input.waiting].reverse()) {
    const text = m.detail ?? m.subject
    const time = findTime(text, input.now)
    const label = labelOf(text, time) || m.subject
    return {
      label,
      when: time?.result ?? null,
      whenText: time?.phrase ?? null,
      reason: `Milestone "${clean(m.subject, 60)}" is waiting${m.detail === null ? '' : ` for ${clean(m.detail, 60)}`}`,
      isExplicit: time !== null && time.result.kind === 'at',
      source: 'milestone',
    }
  }
  // The last message: the last sentence of Claude's own that pairs a check with a time.
  const sentences = sentencesOf(input.message).reverse()
  for (const s of sentences) {
    if (!CUE.test(s) || TO_PERSON.test(s.replace(LEAD, ''))) continue
    const time = findTime(s, input.now)
    if (time === null) continue
    return {
      label: labelOf(s, time) || 'the result',
      when: time.result,
      whenText: time.phrase,
      reason: `Claude said it will ${clean(s.replace(LEAD, '').replace(/[.!?]+$/, ''), 80).replace(/^./, c => c.toLowerCase())}`,
      isExplicit: time.result.kind === 'at',
      source: 'message',
    }
  }
  return null
}
