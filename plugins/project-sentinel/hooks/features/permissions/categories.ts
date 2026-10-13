/**
 * Permission categories and the classifier that maps a tool call to them.
 *
 * Shell commands are split into simple commands (see shell.ts) and every
 * segment is classified; a call can fall in several categories and the
 * strictest configured state wins. Classification is best-effort pattern
 * matching, documented as such: it narrows what Claude may do, it is not a
 * sandbox, and Claude Code's own permission system still applies beneath it.
 */

import type { PermissionCategory, PermissionState } from '../../core/settings'
import { type Segment, commandName, segmentsOf } from './shell'

export type CategoryInfo = {
  id: PermissionCategory
  label: string
  description: string
  examples: string
}

export const CATEGORY_INFO: Record<PermissionCategory, CategoryInfo> = {
  install: {
    id: 'install',
    label: 'Package installation',
    description: 'npm/pnpm/yarn/pip/uv/cargo/go/gem/brew/apt/winget installs, npx -y, uvx',
    examples: 'npm install zod · pip install requests',
  },
  network: {
    id: 'network',
    label: 'Internet & network access',
    description: 'WebFetch, WebSearch, curl/wget, ssh/scp, git fetch/pull/clone, gh',
    examples: 'curl (a web address) · git pull',
  },
  download: {
    id: 'download',
    label: 'Downloading files',
    description: 'curl -o / wget / Invoke-WebRequest -OutFile, git clone, release downloads',
    examples: 'wget (a model file) · git clone',
  },
  edit: {
    id: 'edit',
    label: 'Project file changes',
    description: 'Edit, Write and NotebookEdit inside the project',
    examples: 'Edit src/app.ts',
  },
  editOutside: {
    id: 'editOutside',
    label: 'Changes outside the project',
    description: 'Edit, Write and NotebookEdit on paths outside the project root',
    examples: 'Write ~/.bashrc',
  },
  delete: {
    id: 'delete',
    label: 'File deletion',
    description: 'rm, del, Remove-Item, rimraf, git rm, find -delete',
    examples: 'rm -rf dist',
  },
  commit: {
    id: 'commit',
    label: 'Git commits',
    description: 'git commit (including --amend)',
    examples: 'git commit -m "…"',
  },
  push: {
    id: 'push',
    label: 'Git push',
    description: 'git push to any remote (non-force)',
    examples: 'git push origin main',
  },
  gitDestructive: {
    id: 'gitDestructive',
    label: 'Force push & destructive Git',
    description: 'push --force/--delete, reset --hard, clean -f, branch -D, checkout/restore that discard work, stash drop, history rewrites',
    examples: 'git push --force · git reset --hard',
  },
  deploy: {
    id: 'deploy',
    label: 'Deploy & publish',
    description: 'npm/cargo publish, docker push, gh release, vercel/netlify/fly/firebase deploy, kubectl/helm/terraform apply, MCP publish/send/deploy tools',
    examples: 'npm publish · terraform apply',
  },
  dangerous: {
    id: 'dangerous',
    label: 'Dangerous system commands',
    description: 'recursive deletes of root/home/project root, disk formatting, dd to devices, shutdown, registry deletes, a download piped into a shell',
    examples: 'rm -rf ~ · mkfs on a disk',
  },
}

export type Finding = { category: PermissionCategory; evidence: string }

const lower = (w: string | undefined): string => (w ?? '').toLowerCase()
/** Exact flag match (git and most POSIX tools are case-sensitive: -D is not -d). */
const has = (args: string[], ...flags: string[]): boolean => args.some(a => flags.includes(a))
/** Case-insensitive match, for PowerShell parameters. */
const hasI = (args: string[], ...flags: string[]): boolean => args.some(a => flags.includes(a.toLowerCase()))
const hasShort = (args: string[], letter: string): boolean =>
  args.some(a => /^-[a-zA-Z]+$/.test(a) && !a.startsWith('--') && a.slice(1).includes(letter))

/** `git -C dir --no-pager commit` → ['commit', ...rest]. */
function gitArgs(args: string[]): string[] {
  let i = 0
  while (i < args.length) {
    const a = args[i]!
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') i += 2
    else if (a.startsWith('-')) i += 1
    else break
  }
  return args.slice(i)
}

const INSTALL_VERBS = new Set(['i', 'install', 'ci', 'add', 'update', 'up', 'upgrade', 'isntall', 'in'])
const PKG_MANAGERS = new Set(['apt', 'apt-get', 'dnf', 'yum', 'zypper', 'apk', 'port', 'snap', 'flatpak', 'brew', 'choco', 'winget', 'scoop', 'nix-env', 'emerge'])

function classifyInstall(cmd: string, args: string[]): string | null {
  const a0 = lower(args[0])
  if ((cmd === 'npm' || cmd === 'pnpm' || cmd === 'bun' || cmd === 'cnpm') && INSTALL_VERBS.has(a0)) return `${cmd} ${a0}`
  if (cmd === 'yarn' && (args.length === 0 || ['install', 'add', 'upgrade', 'up', 'dlx'].includes(a0))) return `yarn ${a0}`.trim()
  if ((cmd === 'pnpm' || cmd === 'yarn') && a0 === 'dlx') return `${cmd} dlx`
  if (cmd === 'npx' && has(args, '-y', '--yes')) return 'npx --yes'
  if (cmd === 'bunx' || cmd === 'uvx' || cmd === 'pipx' && a0 === 'run') return cmd
  if ((cmd === 'pip' || cmd === 'pip3' || cmd === 'pipx') && ['install', 'download'].includes(a0)) return `${cmd} ${a0}`
  if (/^(python3?|py)$/.test(cmd) && lower(args[0]) === '-m' && lower(args[1]) === 'pip' && lower(args[2]) === 'install') return 'python -m pip install'
  if (cmd === 'uv' && (a0 === 'add' || a0 === 'sync' || (a0 === 'pip' && lower(args[1]) === 'install') || (a0 === 'tool' && lower(args[1]) === 'install'))) return `uv ${a0}`
  if ((cmd === 'poetry' || cmd === 'pdm' || cmd === 'rye') && ['add', 'install', 'update', 'sync'].includes(a0)) return `${cmd} ${a0}`
  if ((cmd === 'conda' || cmd === 'mamba' || cmd === 'micromamba') && ['install', 'create', 'update'].includes(a0)) return `${cmd} ${a0}`
  if (cmd === 'cargo' && ['add', 'install', 'binstall'].includes(a0)) return `cargo ${a0}`
  if (cmd === 'go' && ['get', 'install'].includes(a0)) return `go ${a0}`
  if (cmd === 'gem' && a0 === 'install') return 'gem install'
  if ((cmd === 'bundle' || cmd === 'bundler') && ['install', 'add', 'update'].includes(a0)) return `bundle ${a0}`
  if (cmd === 'composer' && ['require', 'install', 'update'].includes(a0)) return `composer ${a0}`
  if (cmd === 'deno' && ['install', 'add'].includes(a0)) return `deno ${a0}`
  if (cmd === 'dotnet' && ((a0 === 'add' && lower(args[1]) === 'package') || (a0 === 'tool' && lower(args[1]) === 'install'))) return `dotnet ${a0}`
  if (cmd === 'nuget' && a0 === 'install') return 'nuget install'
  if (cmd === 'pacman' && args.some(a => /^-S/.test(a))) return 'pacman -S'
  if (PKG_MANAGERS.has(cmd) && ['install', 'upgrade', 'reinstall', 'add', 'tap'].includes(a0)) return `${cmd} ${a0}`
  if (['install-module', 'install-package', 'install-script', 'update-module', 'install-psresource'].includes(cmd)) return cmd
  return null
}

const NETWORK_CMDS = new Set([
  'curl', 'wget', 'http', 'https', 'httpie', 'xh', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet',
  'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'start-bitstransfer', 'aria2c', 'gh', 'glab', 'hub', 'socat',
])

function classifyNetwork(cmd: string, args: string[]): string | null {
  if (NETWORK_CMDS.has(cmd)) {
    if (cmd === 'rsync' && !args.some(a => /^[^/\\]*:/.test(a) && !/^[A-Za-z]:[\\/]/.test(a))) return null
    if (cmd === 'gh' && ['help', '--help', '--version', 'version'].includes(lower(args[0]))) return null
    return cmd
  }
  if (cmd === 'git') {
    const g = gitArgs(args)
    const verb = lower(g[0])
    if (['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(verb)) return `git ${verb}`
    if (verb === 'remote' && lower(g[1]) === 'update') return 'git remote update'
    if (verb === 'submodule' && ['update', 'sync'].includes(lower(g[1]))) return 'git submodule update'
  }
  return null
}

/** Where output is thrown away or shown, not kept as a file: the null device (POSIX, cmd, PowerShell) or stdout. */
const DISCARD = /^(?:\/dev\/null|nul|\$null|-)$/i

/**
 * The value of an output option at `args[i]`: `-o FILE`, `-sSLo FILE`, `-oFILE`, `-qO-`, `--output FILE`,
 * `--output=FILE`. Null when `args[i]` is no such option; undefined when the option has no value.
 */
function outputTarget(args: string[], i: number, short: string, long: string): string | undefined | null {
  const a = args[i]!
  if (a === long) return args[i + 1]
  if (a.startsWith(`${long}=`)) return a.slice(long.length + 1)
  if (a.startsWith('--')) return null
  // A short option takes the rest of its word, or else the next word.
  const m = new RegExp(`^-[A-Za-z]*?${short}(.*)$`).exec(a)
  if (m === null) return null
  return m[1] === '' ? args[i + 1] : m[1]
}

/** Whether a fetcher keeps what it fetches in a file: an output option or a redirect naming anything but the void. */
function writesFile(args: string[], text: string, short: string, long: string): boolean {
  for (let i = 0; i < args.length; i++) {
    const target = outputTarget(args, i, short, long)
    if (target !== null && (target === undefined || !DISCARD.test(target))) return true
  }
  // A redirect into a file; `2>&1` and a redirect into the null device keep nothing.
  return [...text.matchAll(/(?:^|\s)\d?>{1,2}\s*(\S+)/g)].some(m => !DISCARD.test(m[1] ?? '') && !/^&\d$/.test(m[1] ?? ''))
}

function classifyDownload(cmd: string, args: string[], text: string): string | null {
  // `-O` names the file after the URL; `-o /dev/null` (a status check: `curl -s -o /dev/null -w "%{http_code}" URL`) keeps nothing.
  if (cmd === 'curl' && (has(args, '-O', '--remote-name', '--remote-name-all', '-OJ', '-LO') || hasShort(args, 'O') || writesFile(args, text, 'o', '--output'))) return 'curl download'
  if (cmd === 'wget') {
    // wget keeps a file named after the URL unless told otherwise: `--spider`, or `-O` into the void or stdout.
    if (has(args, '--spider')) return null
    const hasOutput = args.some((_, i) => outputTarget(args, i, 'O', '--output-document') !== null)
    return hasOutput && !writesFile(args, text, 'O', '--output-document') ? null : 'wget'
  }
  if ((cmd === 'invoke-webrequest' || cmd === 'iwr') && hasI(args, '-outfile', '-o')) return 'Invoke-WebRequest -OutFile'
  if (cmd === 'start-bitstransfer' || cmd === 'aria2c') return cmd
  if (cmd === 'git' && lower(gitArgs(args)[0]) === 'clone') return 'git clone'
  if (cmd === 'gh' && ((lower(args[0]) === 'release' && lower(args[1]) === 'download') || (lower(args[0]) === 'repo' && lower(args[1]) === 'clone'))) return `gh ${args[0]} ${args[1]}`
  if (cmd === 'huggingface-cli' && lower(args[0]) === 'download') return 'huggingface-cli download'
  if (cmd === 'scp' && args.length >= 2 && /:/.test(args[args.length - 2] ?? '')) return 'scp (remote → local)'
  return null
}

const DELETE_CMDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'del', 'erase', 'rd', 'remove-item', 'ri', 'rimraf', 'trash', 'trash-put', 'srm'])

function classifyDelete(cmd: string, args: string[]): string | null {
  if (DELETE_CMDS.has(cmd)) return cmd
  if (cmd === 'git' && lower(gitArgs(args)[0]) === 'rm') return 'git rm'
  if (cmd === 'find' && has(args, '-delete')) return 'find -delete'
  if (cmd === 'find' && args.some((a, i) => a === '-exec' && ['rm', 'del', 'unlink'].includes(commandName(args[i + 1] ?? '')))) return 'find -exec rm'
  if (cmd === 'npx' && lower(args[0]) === 'rimraf') return 'rimraf'
  if (cmd === 'cmd' && args.some(a => /^(del|rd|rmdir|erase)$/i.test(a))) return 'cmd del'
  return null
}

function classifyGit(cmd: string, args: string[]): { category: PermissionCategory; evidence: string } | null {
  if (cmd !== 'git') return null
  const g = gitArgs(args)
  const verb = lower(g[0])
  const rest = g.slice(1)
  if (verb === 'push') {
    const isForce =
      has(rest, '--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '-d', '--prune') ||
      hasShort(rest, 'f') ||
      rest.some(a => a.startsWith('+') || a.startsWith('--force-with-lease=') || /^:[^/]/.test(a))
    return isForce ? { category: 'gitDestructive', evidence: 'git push --force/--delete' } : { category: 'push', evidence: 'git push' }
  }
  if (verb === 'commit') return { category: 'commit', evidence: has(rest, '--amend') ? 'git commit --amend' : 'git commit' }
  if (verb === 'reset' && has(rest, '--hard', '--merge', '--keep')) return { category: 'gitDestructive', evidence: 'git reset --hard' }
  if (verb === 'clean' && (has(rest, '--force') || hasShort(rest, 'f'))) return { category: 'gitDestructive', evidence: 'git clean -f' }
  if (verb === 'branch' && (has(rest, '-D') || (has(rest, '--delete', '-d') && has(rest, '--force', '-f')))) return { category: 'gitDestructive', evidence: 'git branch -D' }
  if (verb === 'checkout' && (has(rest, '-f', '--force') || (rest.includes('--') && rest.length > rest.indexOf('--') + 1) || rest.includes('.'))) {
    return { category: 'gitDestructive', evidence: 'git checkout (discarding changes)' }
  }
  if (verb === 'restore' && !has(rest, '--staged', '-S') && rest.length > 0) return { category: 'gitDestructive', evidence: 'git restore (discarding changes)' }
  if (verb === 'stash' && ['drop', 'clear'].includes(lower(rest[0]))) return { category: 'gitDestructive', evidence: `git stash ${lower(rest[0])}` }
  if (['filter-branch', 'filter-repo', 'replace'].includes(verb)) return { category: 'gitDestructive', evidence: `git ${verb}` }
  if (verb === 'reflog' && lower(rest[0]) === 'expire') return { category: 'gitDestructive', evidence: 'git reflog expire' }
  if (verb === 'gc' && rest.some(a => a.startsWith('--prune'))) return { category: 'gitDestructive', evidence: 'git gc --prune' }
  if (verb === 'update-ref' && has(rest, '-d')) return { category: 'gitDestructive', evidence: 'git update-ref -d' }
  if (verb === 'tag' && has(rest, '-d', '--delete')) return { category: 'gitDestructive', evidence: 'git tag -d' }
  if (verb === 'worktree' && lower(rest[0]) === 'remove' && has(rest, '--force', '-f')) return { category: 'gitDestructive', evidence: 'git worktree remove --force' }
  return null
}

function classifyDeploy(cmd: string, args: string[], text: string): string | null {
  const a0 = lower(args[0])
  const a1 = lower(args[1])
  if ((cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') && (a0 === 'publish' || (a0 === 'run' && /^(deploy|release|publish)(:|$)/.test(a1)))) return `${cmd} ${a0}`
  if ((cmd === 'cargo' || cmd === 'poetry' || cmd === 'flit' || cmd === 'hatch' || cmd === 'gem') && (a0 === 'publish' || a0 === 'push')) return `${cmd} ${a0}`
  if (cmd === 'twine' && a0 === 'upload') return 'twine upload'
  if (cmd === 'dotnet' && a0 === 'nuget' && a1 === 'push') return 'dotnet nuget push'
  if ((cmd === 'mvn' || cmd === 'mvnw') && args.includes('deploy')) return 'mvn deploy'
  if ((cmd === 'gradle' || cmd === 'gradlew') && args.some(a => /^publish/i.test(a))) return 'gradle publish'
  if ((cmd === 'docker' || cmd === 'podman') && (a0 === 'push' || (a0 === 'buildx' && has(args, '--push')))) return `${cmd} push`
  if (cmd === 'gh' && ((a0 === 'release' && ['create', 'upload', 'edit'].includes(a1)) || (a0 === 'workflow' && a1 === 'run'))) return `gh ${a0} ${a1}`
  if (cmd === 'vercel' && (a0 === 'deploy' || has(args, '--prod') || args.length === 0 || a0 === 'promote')) return 'vercel'
  if (cmd === 'netlify' && a0 === 'deploy') return 'netlify deploy'
  if (cmd === 'firebase' && a0 === 'deploy') return 'firebase deploy'
  if ((cmd === 'fly' || cmd === 'flyctl') && ['deploy', 'launch'].includes(a0)) return 'fly deploy'
  if (cmd === 'railway' && ['up', 'deploy', 'redeploy'].includes(a0)) return 'railway up'
  if (cmd === 'heroku' && ['container:release', 'releases:rollback', 'deploy'].includes(a0)) return `heroku ${a0}`
  if (cmd === 'kubectl' && ['apply', 'create', 'delete', 'replace', 'patch', 'rollout', 'scale', 'set', 'drain'].includes(a0)) return `kubectl ${a0}`
  if (cmd === 'helm' && ['install', 'upgrade', 'uninstall', 'rollback', 'delete'].includes(a0)) return `helm ${a0}`
  if ((cmd === 'terraform' || cmd === 'tofu' || cmd === 'terragrunt') && ['apply', 'destroy', 'import'].includes(a0)) return `${cmd} ${a0}`
  if (cmd === 'pulumi' && ['up', 'destroy', 'update'].includes(a0)) return `pulumi ${a0}`
  if (cmd === 'cdk' && ['deploy', 'destroy'].includes(a0)) return `cdk ${a0}`
  if ((cmd === 'serverless' || cmd === 'sls') && ['deploy', 'remove'].includes(a0)) return `${cmd} ${a0}`
  if (cmd === 'wrangler' && ['deploy', 'publish', 'pages'].includes(a0)) return `wrangler ${a0}`
  if (cmd === 'supabase' && ((a0 === 'db' && a1 === 'push') || (a0 === 'functions' && a1 === 'deploy'))) return `supabase ${a0} ${a1}`
  if (cmd === 'aws' && /\b(deploy|update-function-code|put-object|s3 (cp|sync|mv|rm)|create-stack|update-stack|delete-stack)\b/i.test(text)) return 'aws deploy/upload'
  if (cmd === 'gcloud' && /\b(deploy|app deploy|run deploy|functions deploy|builds submit)\b/i.test(text)) return 'gcloud deploy'
  if (cmd === 'az' && /\b(webapp|functionapp|deployment|containerapp)\b.*\b(deploy|create|up|update)\b/i.test(text)) return 'az deploy'
  if (cmd === 'ansible-playbook') return 'ansible-playbook'
  if ((cmd === 'eas' && ['submit', 'update'].includes(a0)) || (cmd === 'expo' && a0 === 'publish')) return `${cmd} ${a0}`
  if (cmd === 'fastlane') return 'fastlane'
  return null
}

const ROOTISH = /^(\/|\/\*|~|~\/|~\/\*|\$home|\$\{home\}|\$home\/\*|\.|\.\/|\*|\.\/\*|[a-z]:\\?|[a-z]:\/?|[a-z]:\\\*|%userprofile%|\$env:userprofile|\$env:homedrive\\?|\/home|\/users|\/etc|\/usr|\/var|\/system|\/library|c:\\windows|c:\\users)$/i

function classifyDangerous(seg: Segment, prev: Segment | undefined): string | null {
  const [first, ...args] = seg.words
  const cmd = commandName(first ?? '')
  const lowered = args.map(a => a.toLowerCase())
  const isRecursive = lowered.some(a => /^-[a-z]*r[a-z]*$/i.test(a) || a === '--recursive' || a === '-recurse' || a === '/s')
  const targets = args.filter(a => !a.startsWith('-') && !(a.startsWith('/') && a.length <= 3 && /^\/[a-z]$/i.test(a)))
  if ((cmd === 'rm' || cmd === 'remove-item' || cmd === 'ri' || cmd === 'rd' || cmd === 'rmdir' || cmd === 'del' || cmd === 'erase') && isRecursive) {
    const hit = targets.find(t => ROOTISH.test(t.replace(/["']/g, '').replace(/[\\/]+$/, (m: string) => (m.length > 0 ? m[0]! : ''))))
    if (hit !== undefined) return `recursive delete of ${hit}`
  }
  if (cmd === 'rm' && lowered.includes('--no-preserve-root')) return 'rm --no-preserve-root'
  if (/^mkfs(\.|$)/.test(cmd) || ['fdisk', 'parted', 'diskpart', 'wipefs', 'format-volume', 'clear-disk', 'initialize-disk', 'sgdisk'].includes(cmd)) return cmd
  if (cmd === 'format' && args.some(a => /^[a-z]:$/i.test(a))) return 'format drive'
  if (cmd === 'dd' && args.some(a => /^of=\/dev\//i.test(a))) return 'dd to a device'
  if (['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'].includes(cmd)) return cmd
  if (cmd === 'systemctl' && ['poweroff', 'reboot', 'halt', 'kexec'].includes(lowered[0] ?? '')) return `systemctl ${lowered[0]}`
  if (cmd === 'init' && ['0', '6'].includes(lowered[0] ?? '')) return `init ${lowered[0]}`
  if ((cmd === 'chmod' || cmd === 'chown') && isRecursive && targets.some(t => ROOTISH.test(t) && t !== '.' && t !== './')) return `${cmd} -R on a system path`
  if (cmd === 'reg' && lowered[0] === 'delete') return 'reg delete'
  if (['remove-itemproperty'].includes(cmd) && args.some(a => /^hk(lm|cu|cr|u|cc):?/i.test(a))) return 'registry delete'
  if (cmd === 'bcdedit' || (cmd === 'vssadmin' && lowered[0] === 'delete') || (cmd === 'cipher' && lowered.some(a => a.startsWith('/w')))) return cmd
  if (cmd === 'takeown' && lowered.includes('/r')) return 'takeown /r'
  if (seg.text.includes(':(){') || /:\(\)\s*\{\s*:\|:&\s*\};:/.test(seg.text)) return 'fork bomb'
  // Remote code piped straight into an interpreter.
  if (seg.op === '|' && prev !== undefined) {
    const from = commandName(prev.words[0] ?? '')
    const isFetch = ['curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod'].includes(from)
    const isRunner = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'py', 'perl', 'ruby', 'node', 'iex', 'invoke-expression', 'pwsh', 'powershell'].includes(cmd)
    if (isFetch && isRunner) return `${from} | ${cmd} (remote code execution)`
  }
  if ((cmd === 'iex' || cmd === 'invoke-expression') && /\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)\b/i.test(seg.text)) {
    return 'Invoke-Expression of downloaded code'
  }
  return null
}

/** Every permission category a shell command touches, with evidence. */
export function classifyShell(command: string): Finding[] {
  const findings: Finding[] = []
  const add = (category: PermissionCategory, evidence: string | null) => {
    if (evidence === null) return
    if (!findings.some(f => f.category === category && f.evidence === evidence)) findings.push({ category, evidence })
  }
  if (/-encodedcommand|\s-enc\s|\s-ec\s/i.test(command)) add('dangerous', 'PowerShell -EncodedCommand (unreadable script)')
  const segments = segmentsOf(command)
  segments.forEach((seg, i) => {
    const [first, ...args] = seg.words
    if (first === undefined) return
    const cmd = commandName(first)
    add('dangerous', classifyDangerous(seg, segments[i - 1]))
    add('install', classifyInstall(cmd, args))
    add('download', classifyDownload(cmd, args, seg.text))
    add('network', classifyNetwork(cmd, args))
    add('delete', classifyDelete(cmd, args))
    const git = classifyGit(cmd, args)
    if (git !== null) add(git.category, git.evidence)
    add('deploy', classifyDeploy(cmd, args, seg.text))
  })
  return findings
}

const MCP_DEPLOY = /(^|_)(deploy|publish|release|send|post|create_message|send_message|tweet|email|share|upload|apply|merge|transfer|pay|purchase)(_|$)/i
const MCP_DELETE = /(^|_)(delete|remove|trash|destroy|drop|purge|wipe|archive)(_|$)/i

/** Findings for an MCP tool from its name alone (`mcp__server__tool`). */
export function classifyMcp(tool: string): Finding[] {
  const name = tool.split('__').slice(2).join('__')
  const out: Finding[] = []
  if (MCP_DELETE.test(name)) out.push({ category: 'delete', evidence: `MCP ${name}` })
  if (MCP_DEPLOY.test(name)) out.push({ category: 'deploy', evidence: `MCP ${name}` })
  return out
}

/**
 * The last-resort check a failed hook falls back on: only the unmistakable
 * catastrophes, matched on the raw text, so a crash in the full classifier
 * never lets one through. A download piped into a shell is found by parts
 * (a fetcher before a pipe, a shell after it), as the full classifier does.
 */
const OBVIOUS =
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]*\s+)*(\/|\/\*|~|~\/|\$HOME)(\s|$)|\bmkfs(\.\w+)?\b|\bdd\b[^|;&]*\bof=\/dev\/|\bformat\s+[a-z]:|\bRemove-Item\b[^|;&]*-Recurse[^|;&]*\s([A-Za-z]:\\?|~|\$env:USERPROFILE)(\s|$)/i

const FETCHERS = ['curl', 'wget']
const SHELLS = ['sh', 'bash', 'zsh', 'dash']

/** A download piped straight into a shell, found by its parts: a fetcher left of a pipe, a shell right after it. */
function isPipedIntoShell(command: string): boolean {
  const parts = command.split('|')
  for (let i = 1; i < parts.length; i++) {
    const left = (parts[i - 1] ?? '').toLowerCase()
    const right = (parts[i] ?? '').trim().toLowerCase().split(/\s+/)
    const runner = (right[0] === 'sudo' ? right[1] : right[0])?.replace(/^.*[\\/]/, '')
    const words = left.split(/[^a-z0-9_.-]+/)
    if (FETCHERS.some(f => words.includes(f)) && runner !== undefined && SHELLS.includes(runner)) return true
  }
  return false
}

export const isObviouslyDangerous = (command: string): boolean => OBVIOUS.test(command) || isPipedIntoShell(command)

/** Strictness order: deny > ask > default. */
const RANK: Record<PermissionState, number> = { deny: 2, ask: 1, default: 0 }

export type Decision = {
  state: PermissionState
  category: PermissionCategory | null
  evidence: string | null
}

/** The strictest configured state among the findings. */
export function strictest(findings: readonly Finding[], states: Record<PermissionCategory, PermissionState>): Decision {
  let best: Decision = { state: 'default', category: null, evidence: null }
  for (const f of findings) {
    const state = states[f.category]
    if (RANK[state] > RANK[best.state]) best = { state, category: f.category, evidence: f.evidence }
  }
  return best
}
