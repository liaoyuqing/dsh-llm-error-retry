/**
 * CI sanity gate — no dependencies, runs with plain node.
 * Validates the package manifest shape that `dsh plugin add` + the awesome-list
 * CI require, plus syntax of both halves.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

const check = (ok, message) => { if (!ok) problems.push(message) }

check(typeof pkg.name === 'string' && pkg.name.length > 0, 'package.json: name missing')
check(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version), 'package.json: version must be semver')
check(pkg.license === 'MIT', 'package.json: license must be MIT')
check(pkg.type === 'module', 'package.json: type must be module')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json: dsh.bundle.patch must be ./cordis.patch.yml')
check(pkg.dsh?.client?.platform === 'web', 'package.json: dsh.client.platform must be web')
check(pkg.exports?.['.'] === './host.v7.mjs', 'package.json: exports["."] must point at the host half')
check(pkg.exports?.['./client'] === './client.js', 'package.json: exports["./client"] must point at the browser half')
check(pkg.exports?.['./package.json'] === './package.json', 'package.json: exports["./package.json"] required by resolvers')
check(pkg.repository?.url?.includes('liaoyuqing/dsh-llm-error-retry'), 'package.json: repository must point at the public repo')
check(!pkg.dependencies && !pkg.devDependencies, 'package.json: keep zero runtime deps (git installs need no build)')
check(existsSync(join(root, 'host.v7.mjs')), 'host.v7.mjs missing')
check(existsSync(join(root, 'client.js')), 'client.js missing')
check(existsSync(join(root, 'cordis.patch.yml')), 'bundle cordis.patch.yml missing')
check(existsSync(join(root, 'LICENSE')), 'LICENSE missing')

const bundlePatch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
check(/- insert:/.test(bundlePatch), 'bundle patch: must start with an insert list')
check(/id: llm-error-retry/.test(bundlePatch), 'bundle patch: must insert id llm-error-retry')
check(/name: \.\/host\.v7\.mjs/.test(bundlePatch), 'bundle patch: row name must be ./host.v7.mjs')

const client = readFileSync(join(root, 'client.js'), 'utf8')
check(client.startsWith('//') || client.startsWith('window.'), 'client.js: must not carry a BOM (breaks combo concatenation)')
check(client.charCodeAt(0) !== 0xFEFF, 'client.js: BOM stripped required')
check(client.includes(`id: "${pkg.name}"`), 'client.js: bundle registration id must equal the package name')

const host = readFileSync(join(root, 'host.v7.mjs'), 'utf8')
check(host.includes("export const name = 'llm-error-retry'"), 'host: plugin name export mismatch')
check(host.includes('prepend: true'), 'host: listener must stay prepended (priority over builtin llm-retry)')
check(host.includes('const MAX_RETRIES_LIMIT = 1000'), 'host: max retries limit must be 1000')
// Headers must go through setHeader/end only — a pinned content-length (setHeader or
// writeHead literal) fights the gzip middleware. Comments mentioning it are fine.
check(!/setHeader\(\s*['"]content-length/i.test(host), 'host: never setHeader content-length (gzip conflict)')
check(!/writeHead\([^)]*content-length/i.test(host), 'host: never writeHead content-length (gzip conflict)')

for (const file of ['host.v7.mjs', 'client.js']) {
  execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' })
}

if (problems.length > 0) {
  console.error('validate: FAIL')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('validate: OK (' + pkg.name + ' ' + pkg.version + ')')
