import type { On, SessionUsage } from 'claude-code'
import { mock } from 'claude-code/testing'

import { SYSTEMINFO_10000_MB } from './fake-host'

/**
 * A session the plugin runs in, answered from memory beneath it: every
 * engine call Control Room makes has an answer here, and what the plugin
 * asked for is kept for the test to read.
 */
export type World = ReturnType<typeof world>

export function world(
  on: On,
  options: {
    settings?: unknown
    window?: number
    tokens?: number
    isHandoffWritten?: boolean
    samplerLines?: string[]
    /** Paths that exist (`fs.exists`); none by default. */
    exists?: string[]
    /** Files `fs.stat` answers for (size and time), before its defaults; undefined: not one of them. */
    stat?: (path: string) => { size: number; mtimeMs: number } | undefined
    /** Programs `process.run` answers for (a Git command), before its defaults; undefined: not one of them. */
    run?: (argv: readonly string[]) => { exitCode: number; stdout: string } | undefined
  } = {},
) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const store: Record<string, unknown> = options.settings === undefined ? {} : { 'settings.v1': options.settings }
  const kept = {
    submitted: [] as string[],
    /** The context each submitted prompt carried (what Claude reads after it), by the same index. */
    contexts: [] as string[][],
    appended: [] as string[],
    commandsRun: [] as { command: string; args: string }[],
    registered: [] as string[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    opened: [] as string[],
    /** Each `$.ui.open`, and whether it asked for the keyboard (`focus`). */
    opens: [] as { id: string; isFocus: boolean }[],
    asked: [] as string[],
    spawned: [] as string[][],
    /** `$.process.run` calls, by their argument vectors. */
    ran: [] as string[][],
    invalidated: [] as string[],
    /** The debug log's lines (`$.ui.log(text, { to: 'debug' })`: the trace, `ops: …`). */
    logs: [] as string[],
  }
  const live = {
    sessionId: 'session-1',
    usage: {
      startedAt: 0,
      context: { tokens: options.tokens, window: options.window ?? 1_000_000, percent: undefined },
      rateLimits: [],
      cost: { usd: 1.25 },
    } as SessionUsage,
    /** How the person answers Claude Code's question dialog: the words, or a function of the question and its options. */
    askAnswer: 'Deny' as string | ((question: string, options: readonly string[]) => string),
    /** What Claude Code's agent list reports. */
    agents: [] as import('claude-code').AgentInfo[],
    isHandoffWritten: options.isHandoffWritten ?? true,
    /** When the handoff notes were last written; null: a moment after each look (always just written). */
    notesAt: null as number | null,
  }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('session.id', () => ({ value: live.sessionId }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: live.usage }))
  on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292' } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.messages', () => ({ value: [] }))
  // From Claude Code 2.1.293 the test kit stores the row beneath this hook, and a hook must relay
  // what `next(e)` stored. Before it, this world is the bottom and answers from memory.
  on('session.append', async ($, e, next) => {
    const text = e.message.content.map(b => (typeof b.text === 'string' ? b.text : '')).join('')
    kept.appended.push(text)
    // Before 2.1.293 nothing is beneath, and `next` throws at once (no rejected promise to catch).
    let stored: Awaited<ReturnType<typeof next>> | undefined
    try {
      stored = await next(e)
    } catch {
      stored = undefined
    }
    return stored ?? { message: e.message, uuid: `row-${kept.appended.length}` }
  })
  on('session.compact', () => ({ messages: [], tokensBefore: 900_000, tokensAfter: 40_000 }))

  on('command.register', ($, e) => {
    kept.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('command.list', () => ({ value: [] }))
  on('command.run', ($, e) => {
    kept.commandsRun.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  on('prompt.submit', ($, e) => {
    kept.submitted.push(e.text)
    kept.contexts.push([...(e.context ?? [])])
    return { text: e.text, origin: e.origin }
  })

  // The context blocks of a conversation's first message, as the engine computed them.
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))

  on('agent.list', () => ({ value: live.agents }))
  on('model.classify', () => ({ value: 'premature' }))
  on('settings.read', () => ({ value: {} }))

  // Compared as POSIX paths: on Windows the engine resolves `/System/...` onto the current drive.
  const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.exists', ($, e) => ({ value: options.exists?.includes(posix(e.path)) ?? false }))
  on('fs.read', () => ({ deny: 'no files in this world' }))
  on('fs.stat', ($, e) => {
    const own = options.stat?.(posix(e.path))
    if (own !== undefined) return { value: { kind: 'file' as const, size: own.size, mtimeMs: own.mtimeMs, isLink: false } }
    if (e.path.endsWith('NEXT_SESSION_PROMPT.md')) {
      return live.isHandoffWritten
        ? { value: { kind: 'file' as const, size: 120, mtimeMs: live.notesAt ?? clock.now() + 1, isLink: false } }
        : { deny: 'ENOENT' }
    }
    return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
  })

  on('process.spawn', async function* ($, e) {
    kept.spawned.push([...e.argv])
    // A machine sampler's lines; then it keeps running, as a real one does, until the test ends.
    if (options.samplerLines !== undefined) {
      for (const line of options.samplerLines) yield { stream: 'stdout' as const, text: `${line}\n` }
      await new Promise<never>(() => undefined)
    }
    return { value: { code: 0, signal: null } }
  })
  // The samplers' one-shot programs: a 10,000 MB Windows machine, a Mac whose kernel counts 63% free.
  on('process.run', ($, e, next) => {
    kept.ran.push([...e.argv])
    const answered = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const own = options.run?.(e.argv)
    if (own !== undefined) return { value: { exitCode: own.exitCode, stdout: own.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'systeminfo.exe') return answered(SYSTEMINFO_10000_MB)
    if (e.argv[0] === 'sysctl') return answered('63\n')
    return next(e)
  })

  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))

  on('ui.toast', ($, e) => {
    kept.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    kept.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    kept.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', ($, e) => {
    kept.invalidated.push(e.event)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    kept.opened.push(e.id)
    kept.opens.push({ id: e.id, isFocus: e.focus === true })
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: kept.opened.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    kept.asked.push(question)
    const answer = typeof live.askAnswer === 'function' ? live.askAnswer(question, (e.questions[0]?.options ?? []).map(o => o.label)) : live.askAnswer
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  on('tool.call', ($, e) => ({ result: { ok: true, tool: e.tool } }))

  return { clock, store, kept, live }
}

export const SESSION = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
