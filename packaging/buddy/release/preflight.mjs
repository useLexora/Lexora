import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { writeOutput } from '../../shared/cli-output.mjs'
import { resolveBuddyOutputPaths } from './output-paths.mjs'
import { resolvePackagingPlatform } from './platform-definition.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const qualitySteps = [
  ['Lint workspace', 'pnpm', ['--filter', '@uselexora/lexora-buddy', 'lint']],
  ['Type-check workspace', 'pnpm', ['--filter', '@uselexora/lexora-buddy', 'type-check']],
  ['Native components format', 'cargo', ['fmt', '--manifest-path', 'apps/buddy/native/Cargo.toml', '--all', '--', '--check']],
  ['Native components clippy', 'cargo', ['clippy', '--locked', '--manifest-path', 'apps/buddy/native/Cargo.toml', '--target-dir', 'apps/buddy/.output/build/native', '--workspace', '--all-targets', '--', '-D', 'warnings']],
  ['Native components tests', 'cargo', ['test', '--locked', '--manifest-path', 'apps/buddy/native/Cargo.toml', '--target-dir', 'apps/buddy/.output/build/native', '--workspace']],
]
const packageSteps = {
  deb: ['Ubuntu deb package', 'pnpm', ['--filter', '@uselexora/lexora-buddy', 'package:deb']],
  pacman: ['Arch Linux package', 'pnpm', ['--filter', '@uselexora/lexora-buddy', 'package:arch']],
  nsis: ['Windows NSIS package', 'pnpm', ['--filter', '@uselexora/lexora-buddy', 'package:windows']],
}

export function createBuddyReleasePreflightSteps(stage = 'all', platformId = process.platform) {
  const platform = resolvePackagingPlatform(platformId)
  const platformQualitySteps = qualitySteps.map(([label, command, args]) => {
    if (command !== 'cargo' || !args.includes('--workspace') || platform.features.includes('nativePet'))
      return [label, command, args]
    const separator = args.indexOf('--')
    const position = separator < 0 ? args.length : separator
    return [label, command, [...args.slice(0, position), '--exclude', 'lexora-buddy-pet', ...args.slice(position)]]
  })
  const target = stage === 'all' ? platform.packageTargets[0] : stage === 'windows' ? 'nsis' : stage
  const steps = stage === 'all'
    ? [...platformQualitySteps, packageSteps[target], ['Test workspace', 'pnpm', ['--filter', '@uselexora/lexora-buddy', 'test']]]
    : platform.packageTargets.includes(target)
      ? [packageSteps[target]]
      : undefined

  if (!steps)
    throw new Error(`Unknown Buddy preflight stage: ${stage}`)

  return steps.map(([label, command, args]) => ({ label, command, args }))
}

export function createBuddyReleaseEnvironment(
  env,
  defaultSourceDateEpoch,
  cargoTargetDirectory = resolveBuddyOutputPaths(repoRoot).build.native,
) {
  const sourceDateEpoch = String(defaultSourceDateEpoch)
  if (!/^\d+$/.test(sourceDateEpoch))
    throw new Error('Buddy release SOURCE_DATE_EPOCH must be a Unix timestamp')
  if (env.SOURCE_DATE_EPOCH !== undefined && String(env.SOURCE_DATE_EPOCH) !== sourceDateEpoch)
    throw new Error('Buddy release SOURCE_DATE_EPOCH must match Buddy metadata')

  return {
    ...env,
    CARGO_TARGET_DIR: cargoTargetDirectory,
    RUSTFLAGS: env.RUSTFLAGS ?? '-D warnings',
    RUST_MIN_STACK: env.RUST_MIN_STACK ?? '16777216',
    SOURCE_DATE_EPOCH: sourceDateEpoch,
  }
}

const buildCommands = {
  linux: { node: { command: process.execPath } },
  win32: { node: { command: process.execPath }, pnpm: { command: 'pnpm.cmd', shell: true } },
}

export function runBuddyReleasePreflight(options = {}) {
  const cwd = options.cwd ?? repoRoot
  const env = options.env ?? process.env
  const stage = options.stage ?? 'all'
  const productMetadata = JSON.parse(readFileSync(
    join(cwd, 'apps/buddy/buddy.version.json'),
    'utf8',
  ))
  const releaseEnvironment = createBuddyReleaseEnvironment(
    env,
    String(productMetadata.sourceDateEpoch ?? ''),
    resolveBuddyOutputPaths(cwd).build.native,
  )

  for (const step of createBuddyReleasePreflightSteps(stage)) {
    writeOutput(`\n[Buddy] ${step.label}`)
    const invocation = buildCommands[process.platform][step.command] ?? { command: step.command }
    execFileSync(invocation.command, step.args, {
      cwd,
      env: releaseEnvironment,
      stdio: 'inherit',
      shell: invocation.shell ?? false,
    })
  }

  writeOutput(`\nLexora Buddy ${stage} gate passed`)
}

function readStage(args) {
  if (args.length === 0)
    return 'all'
  if (args.length === 2 && args[0] === '--stage')
    return args[1]
  throw new Error('Usage: preflight.mjs [--stage deb|pacman|windows]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runBuddyReleasePreflight({ stage: readStage(process.argv.slice(2)) })
