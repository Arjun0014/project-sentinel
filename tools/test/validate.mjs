// Validates the plugin as it ships, then the marketplace.
//
// The plugin is validated from a copy of its folder without the type declarations Claude Code lays beside it for
// development (`.claude-plugin/types/` and `tsconfig.json`: git-ignored, so never in what the marketplace serves).
// With them in place, the validator's own type-check of the hooks module takes in the engine's full declarations
// and, from Claude Code 2.1.325 (18k lines of them), runs past its 2048 MiB limit, which `--strict` reports as a
// failure that says nothing about the plugin (seen on this repository at 1.8 development; the same commit passes
// without the declarations). The plugin's own type-check against those declarations is `npm run typecheck`.
//
//   node tools/test/validate.mjs

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function pluginFolder() {
  const marketplace = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'))
  const source = marketplace.plugins?.[0]?.source
  if (typeof source !== 'string') throw new Error('marketplace.json names no plugin folder')
  return resolve(REPO, source)
}

/** An argument as cmd.exe reads it: quoted when it holds a space or a character cmd.exe acts on. */
const forCmd = arg => (/[\s"&|<>^%]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)

function claude(args) {
  // npm installs `claude` on Windows as a `.cmd` shim, which only a shell can start.
  const result =
    process.platform === 'win32'
      ? spawnSync(['claude', ...args].map(forCmd).join(' '), { stdio: 'inherit', cwd: REPO, shell: true })
      : spawnSync('claude', args, { stdio: 'inherit', cwd: REPO })
  if (result.error !== undefined) {
    console.error(`claude: ${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

const plugin = pluginFolder()
const copy = join(REPO, '.build', 'validate', basename(plugin))
rmSync(dirname(copy), { recursive: true, force: true })
mkdirSync(dirname(copy), { recursive: true })
const laid = [join(plugin, '.claude-plugin', 'types'), join(plugin, 'tsconfig.json')]
cpSync(plugin, copy, { recursive: true, filter: source => !laid.some(p => source === p || source.startsWith(p + sep)) })
console.log(`Validating the plugin as it ships (${relative(REPO, copy)}: the folder without the declarations laid for development)`)
const pluginStatus = claude(['plugin', 'validate', copy, '--strict'])
const marketplaceStatus = claude(['plugin', 'validate', '.'])
process.exit(pluginStatus !== 0 ? pluginStatus : marketplaceStatus)
