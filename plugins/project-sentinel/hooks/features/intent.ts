/**
 * Handoff-control intent: whether a short message the person typed while a handoff is under way is an
 * instruction about the handoff itself ("handoff now", "don't wait for the background process", "start
 * the fresh session now") rather than work for Claude. Read before the Cold Resume Guard, so such a
 * message never goes into the old context (a cold one least of all).
 *
 * Only short messages count: a sentence of work that happens to say "handoff" is a request, and goes
 * through the person's choice instead (app/runtime.ts handoffGuard). Pure pattern matching.
 */

export type HandoffIntent =
  /** Hand off now; background work keeps running for the fresh context. */
  | 'handoff-now'
  /** Do not wait for the background work (the same, said of the wait). */
  | 'skip-wait'
  /** Start the fresh context now (the notes checked first). */
  | 'fresh-now'
  /** Keep waiting for the background work. */
  | 'keep-waiting'
  /** Stop the background work, then hand off (asked to confirm first). */
  | 'stop-and-handoff'
  /** Call the handoff off: carry on in this context. */
  | 'cancel'

/** Longer than this, a message is work for Claude, not a control. */
const MAX_WORDS = 14

const LEAD = /^(?:(?:ok(?:ay)?|yes|yeah|sure|right|alright|fine|so|then|please|pls|just|now|hey|claude|sentinel|go ahead and|can you|could you|would you|i want you to|let'?s|lets)\s+)+/
const TAIL = /(?:\s+(?:please|pls|thanks|thank you|now|already|right away|immediately|asap|then|instead))+$/

const HANDOFF = String.raw`hand\s?-?off|handover|hand\s+over`
const WORK = String.raw`(?:the\s+|that\s+|this\s+|those\s+|these\s+|any\s+|all\s+)?(?:background\s+)?(?:process(?:es)?|servers?|tasks?|jobs?|work|build|render|tests?|test\s+run|script|it|them|vite|dev\s+server|preview(?:\s+server)?|watchers?)`

/** The message as compared: lower case, no punctuation or quotes, single spaces, politeness trimmed. */
export function normalizeIntent(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEAD, '')
    .replace(TAIL, '')
    .trim()
}

const RULES: readonly { intent: HandoffIntent; re: RegExp }[] = [
  // "stop the server and hand off", "kill the render then handoff"
  { intent: 'stop-and-handoff', re: new RegExp(String.raw`^(?:stop|kill|end|cancel|terminate)\s+${WORK}\s+(?:and|then|and then)\s+(?:${HANDOFF}|start\s+(?:the\s+)?fresh(?:\s+\w+)?)$`) },
  // "cancel the handoff", "don't hand off", "no handoff", "call off the handoff", "abort handoff"
  { intent: 'cancel', re: new RegExp(String.raw`^(?:(?:cancel|abort|stop|skip|forget|undo)\s+(?:the\s+|this\s+)?(?:${HANDOFF})|call\s+(?:the\s+)?(?:${HANDOFF})\s+off|call\s+off\s+(?:the\s+)?(?:${HANDOFF})|(?:don'?t|do\s+not|no)\s+(?:${HANDOFF})(?:\s+(?:yet|at\s+all))?|no\s+(?:${HANDOFF})(?:\s+yet)?|stay\s+(?:here|in\s+this\s+(?:context|session))|keep\s+(?:working\s+)?(?:here|in\s+this\s+(?:context|session)))$`) },
  // "keep waiting", "wait for it", "let it finish", "wait until the build finishes"
  { intent: 'keep-waiting', re: new RegExp(String.raw`^(?:(?:keep|continue|carry\s+on|go\s+on)\s+waiting(?:\s+for\s+${WORK})?|wait\s+for\s+${WORK}(?:\s+to\s+(?:finish|end|complete))?|wait\s+(?:until|till)\s+${WORK}\s+(?:finishes|ends|completes|is\s+done)|let\s+${WORK}\s+finish|wait\s+longer)$`) },
  // "don't wait for the background process", "skip the wait", "stop waiting", "ignore the server", "leave it running"
  { intent: 'skip-wait', re: new RegExp(String.raw`^(?:(?:don'?t|do\s+not|no\s+need\s+to|stop|quit)\s+wait(?:ing)?(?:\s+(?:for|on)\s+${WORK})?(?:\s+(?:and|just)\s+(?:${HANDOFF}|continue|go\s+on|proceed))?|skip\s+(?:the\s+)?wait(?:ing)?|(?:ignore|forget(?:\s+about)?)\s+${WORK}|leave\s+${WORK}\s+running(?:\s+and\s+(?:${HANDOFF}|continue|go\s+on|proceed))?|no\s+more\s+waiting)$`) },
  // "start the fresh session now", "fresh context", "clear the context", "new session"
  { intent: 'fresh-now', re: /^(?:(?:start|begin|open|go\s+to|switch\s+to|move\s+to|continue\s+in|use)\s+(?:a\s+|the\s+)?(?:fresh|new|clean)(?:\s+(?:session|context|chat|conversation|window))?|(?:fresh|new|clean)\s+(?:session|context|start)|start\s+fresh|clear\s+(?:the\s+)?(?:context|session|conversation)|(?:go|move)\s+fresh)$/ },
  // "handoff now", "hand off", "do the handoff", "proceed with the handoff", "finish the handoff"
  { intent: 'handoff-now', re: new RegExp(String.raw`^(?:(?:do|finish|complete|run|start|go\s+ahead\s+with|proceed\s+with|continue\s+with|go\s+on\s+with|force)\s+(?:the\s+|a\s+|your\s+)?(?:${HANDOFF})|(?:${HANDOFF})(?:\s+(?:to\s+(?:the\s+)?(?:fresh|new)\s+(?:session|context)))?)$`) },
]

/**
 * The handoff-control intent of a message, or null when it is not one (or too long to be one). A bare
 * "go ahead" or "continue" is never one: it answers whatever Claude asked last.
 */
export function handoffIntentOf(text: string): HandoffIntent | null {
  if (text.length > 200 || text.includes('\n')) return null
  const t = normalizeIntent(text)
  if (t === '' || t.split(' ').length > MAX_WORDS) return null
  for (const r of RULES) if (r.re.test(t)) return r.intent
  return null
}

/** The intent in words, for the trace and the drop reason. */
export const INTENT_WORDS: Record<HandoffIntent, string> = {
  'handoff-now': 'hand off now',
  'skip-wait': 'do not wait for the background work',
  'fresh-now': 'start the fresh context now',
  'keep-waiting': 'keep waiting',
  'stop-and-handoff': 'stop the background work, then hand off',
  cancel: 'call the handoff off',
}
