import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../..')
const ciPrefixes = [
  '.github/actions/',
  '.github/scripts/',
  '.github/workflows/',
]
const rustInputs = new Set([
  'rust-toolchain',
  'rust-toolchain.toml',
  '.github/scripts/buddy-test-runtime.mjs',
  '.github/workflows/buddy-build.yml',
  'apps/buddy/resources/icons/app-icon.png',
  'packaging/buddy/release/native-host.mjs',
  'packaging/buddy/release/targets.mjs',
  'apps/buddy/platform/targets.json',
  'packaging/buddy/release/preflight.mjs',
  'packaging/buddy/release/verify-windows-sandbox.ps1',
])
const rustPrefixes = [
  '.cargo/',
  'apps/buddy/native/',
  'apps/buddy/platform/native/',
  'apps/buddy/shared/platform/',
  'packages/assets/buddy/pets/default/',
]
const workspaceInputs = new Set([
  '.node-version',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
])
const websiteInputs = new Set([
  '.github/workflows/website-pages.yml',
])
const ignoredInputs = new Set([
  '.github/PULL_REQUEST_TEMPLATE.md',
  'CONTRIBUTING.md',
  'README.en.md',
  'README.md',
  'apps/buddy/README.md',
  'packaging/buddy/README.md',
])
const ignoredPrefixes = [
  '.github/ISSUE_TEMPLATE/',
]
const websitePrefixes = [
  'apps/website/',
]
const integrationPrefixes = [
  '.playwright/scripts/',
  'apps/buddy/service/',
  'apps/buddy/electron/',
  'apps/buddy/platform/',
  'packaging/buddy/',
]
const inactivePrefixes = [
  'legacy/',
  '.playwright/scripts/community/',
  'apps/agent/',
  'apps/api/',
  'apps/web/',
  'evals/',
  'packages/contracts/',
  'packages/shared/',
]
const repositoryPrefixes = [
  '.github/',
  'infrastructure/',
]

export function classifyCiScope(files) {
  if (files.length === 0)
    return fullScope()

  let workspace = false
  let integration = false
  let native = false
  let website = false
  let repository = false

  for (const input of files) {
    const path = normalizePath(input)

    if (ignoredInputs.has(path) || ignoredPrefixes.some(prefix => path.startsWith(prefix)) || inactivePrefixes.some(prefix => path.startsWith(prefix)))
      continue

    if (rustInputs.has(path) || rustPrefixes.some(prefix => path.startsWith(prefix))) {
      workspace = true
      integration = true
      native = true
      if (path.startsWith('.github/') || path.startsWith('packages/assets/'))
        repository = true
      continue
    }

    if (websiteInputs.has(path) || websitePrefixes.some(prefix => path.startsWith(prefix))) {
      website = true
      continue
    }

    if (workspaceInputs.has(path) || ciPrefixes.some(prefix => path.startsWith(prefix)) || path.startsWith('.playwright/scripts/fixtures/'))
      return fullScope()

    if (path.startsWith('apps/buddy/src/')) {
      workspace = true
      continue
    }

    if (path.startsWith('packages/assets/')) {
      workspace = true
      integration = true
      website = true
      repository = true
      continue
    }

    if (integrationPrefixes.some(prefix => path.startsWith(prefix))) {
      workspace = true
      integration = true
      continue
    }

    if (repositoryPrefixes.some(prefix => path.startsWith(prefix))) {
      repository = true
      continue
    }

    return fullScope()
  }

  return { workspace, integration, native, website, repository }
}

export function listChangedFiles(base, head, cwd = repoRoot) {
  const output = execFileSync('git', [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    `${base}...${head}`,
  ], {
    cwd,
    encoding: 'utf8',
  })

  return output.split('\0').filter(Boolean)
}

export function resolveCiScope(base, head, cwd = repoRoot) {
  return classifyCiScope(listChangedFiles(base, head, cwd))
}

function fullScope() {
  return {
    workspace: true,
    integration: true,
    native: true,
    website: true,
    repository: true,
  }
}

function normalizePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

function parseOptions(args) {
  if (args[0] === '--files')
    return { files: args.slice(1) }

  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined)
      throw new Error(`Invalid CI scope option: ${name ?? ''}`)
    options[name.slice(2)] = value
  }

  for (const name of ['base', 'head']) {
    if (!options[name])
      throw new Error(`Missing required CI scope option: --${name}`)
  }

  return options
}

function writeScope(scope, githubOutput) {
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      `${Object.entries(scope).map(([name, value]) => `${name}=${value}`).join('\n')}\n`,
    )
  }

  process.stdout.write(`${JSON.stringify(scope)}\n`)
}

function run() {
  const options = parseOptions(process.argv.slice(2))
  const scope = options.files
    ? classifyCiScope(options.files)
    : resolveCiScope(options.base, options.head)
  writeScope(scope, options['github-output'])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  run()
