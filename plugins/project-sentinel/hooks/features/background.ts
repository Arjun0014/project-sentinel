/**
 * Background work as a handoff sees it: which of the tasks Claude Code reports in flight hold a
 * written handoff back, and which never should.
 *
 * A background process is not automatically a handoff blocker. Claude Code lists every task in
 * flight at each Stop (`background_tasks`: id, type, status, description, the shell command), and
 * those tasks belong to the session's process, not to the context: seen live on Claude Code 2.1.296,
 * a background shell started before `/clear` is still listed by the fresh context's Stop, and its
 * notification reaches the fresh context when it ends. So:
 *
 *   persistent   infrastructure that never ends by itself (a dev or preview server, a `--watch`,
 *                a tunnel, `tail -f`, a Monitor): never waited for. It keeps running across the
 *                clear, and the fresh context is told it is there.
 *   finite       work whose result may belong in the handoff (tests, builds, renders, a sleep):
 *                waited for, within the Handoff Supervisor's patience.
 *   agent        a background agent or a workflow: finite, its result comes back as a notification.
 *   unknown      a command nothing here recognises (`./run.sh`): waited for at first; the
 *                supervisor may ask a small isolated classifier, once, what it is.
 *
 * Pure: pattern matching over Claude Code's own words for the task, never a guess dressed as a fact.
 */

import { withoutQuoted } from './resources/heavy'
import { validationKindOf } from './validation'

export type TaskClass = 'persistent' | 'finite' | 'agent' | 'unknown'

/** Who decided a task's class: these rules, the isolated classifier, or the person. */
export type ClassBy = 'rule' | 'classifier' | 'person'

/** One task as Claude Code's Stop lists it (BackgroundTaskSummary), in the fields that matter here. */
export type TaskSummary = {
  id: string
  type: string
  description: string
  command?: string
  agentType?: string
  name?: string
}

export type TaskVerdict = { class: TaskClass; why: string; by: ClassBy }

/** Dev, preview and API servers, watchers, tunnels, followers: processes that never end by themselves. */
const PERSISTENT_COMMAND: readonly { re: RegExp; why: string }[] = [
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:.-]*(?:dev|serve|preview|watch|storybook)[\w:.-]*(?=\s|$|;|&|\|)/i, why: 'a dev, preview or watch script' },
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?start(?=\s|$|;|&|\|)/i, why: 'a start script (a server)' },
  { re: /\bvite\b(?!\s+(?:build|optimize)\b)/i, why: 'a Vite dev or preview server' },
  { re: /\b(?:next|nuxt|nuxi|astro|remix|gatsby)\s+(?:dev|start|preview|develop|serve)\b/i, why: 'a framework dev or preview server' },
  { re: /\b(?:ng\s+serve|vue-cli-service\s+serve|react-scripts\s+start|expo\s+start|storybook\s+dev|start-storybook|svelte-kit\s+dev|docusaurus\s+(?:start|serve)|mkdocs\s+serve|hugo\s+server|jekyll\s+serve|wrangler\s+dev|netlify\s+dev|vercel\s+dev)\b/i, why: 'a dev server' },
  { re: /\bwebpack(?:-dev-server|\s+serve)\b|\bparcel\b(?!\s+build\b)/i, why: 'a bundler dev server' },
  { re: /(?:^|[\s;&|(])(?:npx\s+(?:-y\s+|--yes\s+)?)?(?:http-server|live-server|serve)(?=\s|$)/i, why: 'a static file server' },
  { re: /\bpython[\d.]*\s+-m\s+(?:http\.server|SimpleHTTPServer)\b/i, why: 'a Python HTTP server' },
  { re: /\b(?:uvicorn|gunicorn|hypercorn|daphne|waitress-serve|flask\s+run|streamlit\s+run|panel\s+serve|bokeh\s+serve|mlflow\s+ui|tensorboard)\b|\bmanage\.py\s+runserver\b/i, why: 'a Python app server' },
  { re: /\bjupyter(?:-lab|-notebook)?\s+(?:lab|notebook|server)\b/i, why: 'a Jupyter server' },
  { re: /\brails\s+(?:s|server)\b|\b(?:puma|unicorn|thin\s+start)\b|\bphp\s+(?:-S\b|artisan\s+serve\b)|\bmix\s+phx\.server\b/i, why: 'an app server' },
  { re: /\b(?:nodemon|ts-node-dev|tsx\s+watch|cargo\s+watch|dotnet\s+watch|watchexec|entr|chokidar)\b|\b(?:node|bun|deno)\b[^;&|]*\s--watch\b|--watch(?:All)?\b|\btsc\b[^;&|]*\s-w\b/i, why: 'a watcher' },
  { re: /\bdocker(?:-compose|\s+compose)\s+up\b(?![^;&|]*\s(?:-d|--detach)\b)/i, why: 'containers attached to the shell' },
  { re: /\b(?:ngrok|cloudflared|localtunnel)\b|\bkubectl\s+(?:port-forward|proxy)\b|\bminikube\s+tunnel\b|\bssh\b[^;&|]*\s-[a-zA-Z]*N\b/i, why: 'a tunnel or port forward' },
  { re: /\b(?:redis-server|mongod|mysqld|memcached|ollama\s+serve|minio\s+server|pg_ctl\s+start)\b|\bpostgres\s+-D\b/i, why: 'a database or model server' },
  { re: /\btail\s+(?:-[a-zA-Z]*[fF]\b|--follow\b)|\b(?:journalctl|kubectl\s+logs|docker\s+(?:compose\s+)?logs)\b[^;&|]*\s-f\b|\bGet-Content\b[^;&|]*-Wait\b|\bwatch\s+-n\b/i, why: 'a log follower' },
  { re: /\bsleep\s+infinity\b|\bwhile\s+(?:true|:)\s*;?\s*do\b|\bfor\s*\(\s*;\s*;\s*\)/i, why: 'an endless loop' },
]

/** What Claude Code's description of a task says it is, when its command alone does not tell. */
const PERSISTENT_WORDS = /\b(?:dev|preview|local|api|web|http|static|file|app|mock|proxy)\s+server\b|\bserver\s+(?:on|at)\s+(?:port\s+)?:?\d{2,5}\b|\b(?:serve|serving|watch(?:er|ing)?|tunnel|port[- ]forward(?:ing)?|follow(?:ing)?\s+(?:the\s+)?logs?)\b/i

/** Work that ends by itself, recognised by its runner. */
const FINITE_COMMAND: readonly { re: RegExp; why: string }[] = [
  { re: /\bsleep\s+\d+(?:\.\d+)?[smhd]?\b/i, why: 'a timed wait' },
  { re: /\b(?:ffmpeg|remotion\s+render|blender\b[^;&|]*\s-b\b|magick|convert\s+\S+\.\w+)\b/i, why: 'a render' },
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add)\b|\b(?:pip3?|uv|poetry|cargo|go)\s+(?:install|sync|fetch|get)\b/i, why: 'an install' },
  { re: /\b(?:curl|wget|scp|rsync)\b|\bgit\s+(?:clone|fetch|pull|push|gc)\b/i, why: 'a transfer' },
  { re: /\b(?:docker|podman)\s+(?:build|pull|push)\b/i, why: 'an image build or transfer' },
]

/** A check's runner names it finite (tests, builds, type-checks, linters, simulations). */
const finiteCheck = (command: string): string | null => {
  const kind = validationKindOf(command)
  return kind === null ? null : `a ${kind === 'typecheck' ? 'type-check' : kind === 'sim' ? 'simulation' : kind === 'check' ? 'project check' : kind === 'tests' ? 'test run' : kind}`
}

/**
 * A task's class from what Claude Code says of it. A watcher outranks the check it runs (`vitest
 * --watch`, `tsc -w` never end); a persistent command outranks a finite word in its description.
 */
export function classifyTask(t: TaskSummary): TaskVerdict {
  const type = t.type.toLowerCase()
  if (type === 'subagent' || type === 'agent' || type === 'teammate') return { class: 'agent', why: `a background agent${t.agentType === undefined ? '' : ` (${t.agentType})`}`, by: 'rule' }
  if (type === 'workflow') return { class: 'agent', why: `a workflow${t.name === undefined ? '' : ` (${t.name})`}`, by: 'rule' }
  // A Monitor watches a stream and reports events as they come: a watcher, not a result to wait for.
  if (type === 'monitor') return { class: 'persistent', why: 'a monitor (it reports events; it holds no result)', by: 'rule' }
  const command = withoutQuoted(t.command ?? '')
  const text = command.trim() === '' ? withoutQuoted(t.description) : command
  // A shell handed the real command as a quoted string (`bash -c "npm run dev"`) is read inside the quotes.
  const quoted = /^\s*(?:bash|sh|zsh|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?)\s+(?:-c|\/c|-Command)\s+(["'])([\s\S]*)\1\s*$/i.exec(t.command ?? '')
  const inner = quoted?.[2] ?? text
  for (const p of PERSISTENT_COMMAND) if (p.re.test(text) || p.re.test(inner)) return { class: 'persistent', why: p.why, by: 'rule' }
  const check = finiteCheck(text)
  if (check !== null) return { class: 'finite', why: check, by: 'rule' }
  for (const f of FINITE_COMMAND) if (f.re.test(text)) return { class: 'finite', why: f.why, by: 'rule' }
  // Claude Code's description is Claude's own words for the command ("Start the Vite preview server").
  if (t.description !== '' && t.description !== t.command && PERSISTENT_WORDS.test(t.description)) return { class: 'persistent', why: 'described as a server or watcher', by: 'rule' }
  return { class: 'unknown', why: type === 'shell' || type === '' ? 'a command these rules do not recognise' : `a ${t.type} task`, by: 'rule' }
}

/** Whether a task of this class holds a written handoff back: everything but infrastructure. */
export const isBlocking = (c: TaskClass): boolean => c !== 'persistent'

/** The words for a class, as the panel and the status bar say them. */
export const CLASS_WORDS: Record<TaskClass, string> = {
  persistent: 'Keeps running · not waited for',
  finite: 'Waited for · its result goes in the notes',
  agent: 'Waited for · an agent reports back',
  unknown: 'Waited for · not recognised',
}

/** The labels the isolated classifier picks from, and what each means as a class. */
export const CLASSIFIER_LABELS = ['persistent_service', 'finite_job', 'unclear'] as const

export function classifierText(t: TaskSummary): string {
  return [
    'Classify one background process an AI coding agent left running.',
    'persistent_service = it never exits by itself: a dev, preview or API server, a file watcher, a tunnel, a log follower, a REPL, a daemon.',
    'finite_job = it ends by itself with a result: a test run, a build, a render, a download, a script that finishes.',
    'unclear = the command does not say.',
    '',
    `COMMAND: ${(t.command ?? '').slice(0, 600)}`,
    `DESCRIPTION: ${t.description.slice(0, 300)}`,
  ].join('\n')
}

/** The classifier's label as a verdict; null when it could not tell. */
export function verdictOfLabel(label: string | undefined): TaskVerdict | null {
  if (label === 'persistent_service') return { class: 'persistent', why: 'a long-running service, by a small isolated classification', by: 'classifier' }
  if (label === 'finite_job') return { class: 'finite', why: 'a job that ends by itself, by a small isolated classification', by: 'classifier' }
  return null
}
