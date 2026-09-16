import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { writeError, writeOutput } from '../shared/cli-output.mjs'
import {
  compareLexoraVersions,
  createLexoraVersionSources,
  lexoraVersionStatePaths,
  readLexoraVersionStateFromSources,
  validateLexoraVersionState,
} from './version.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')
const commitPattern = /^[a-f\d]{40}$/

export const lexoraReleaseTransitionPaths = Object.freeze([
  'package.json',
  'apps/buddy/package.json',
  'apps/buddy/buddy.version.json',
  'apps/buddy/native/pet/Cargo.toml',
  'apps/buddy/native/Cargo.lock',
])

export function validateLexoraReleaseTransition({ before, after, changedPaths }) {
  const errors = [
    ...validateLexoraVersionState(before).map(error => `before: ${error}`),
    ...validateLexoraVersionState(after).map(error => `after: ${error}`),
  ]

  try {
    if (compareLexoraVersions(after.productVersion, before.productVersion) <= 0) {
      errors.push(
        `product version must increase: ${before.productVersion} -> ${after.productVersion}`,
      )
    }
  }
  catch {
    errors.push(
      `product version transition is invalid: ${before.productVersion} -> ${after.productVersion}`,
    )
  }

  if (after.sourceDateEpoch <= before.sourceDateEpoch) {
    errors.push(
      `sourceDateEpoch must increase: ${before.sourceDateEpoch} -> ${after.sourceDateEpoch}`,
    )
  }

  const actualPaths = [...new Set(changedPaths.map(normalizePath))].sort()
  const expectedPaths = [...lexoraReleaseTransitionPaths].sort()
  const missingPaths = expectedPaths.filter(path => !actualPaths.includes(path))
  const unexpectedPaths = actualPaths.filter(path => !expectedPaths.includes(path))

  if (actualPaths.length !== changedPaths.length)
    errors.push('release transition contains duplicate changed paths')
  if (missingPaths.length)
    errors.push(`release transition is missing version files: ${missingPaths.join(', ')}`)
  if (unexpectedPaths.length)
    errors.push(`release transition contains non-version files: ${unexpectedPaths.join(', ')}`)

  return errors
}

export function validateLexoraReleaseSources({ beforeSources, afterSources, after }) {
  try {
    const expected = createLexoraVersionSources(
      beforeSources,
      after.productVersion,
      { sourceDateEpoch: after.sourceDateEpoch },
    ).sources
    const mismatches = lexoraVersionStatePaths.filter(
      path => expected[path] !== afterSources[path],
    )
    return mismatches.length
      ? [`release version files contain non-generated changes: ${mismatches.join(', ')}`]
      : []
  }
  catch (error) {
    return [
      `unable to reconstruct release version files: ${error instanceof Error ? error.message : String(error)}`,
    ]
  }
}

export function checkLexoraReleaseTransition(before, after, cwd = repoRoot) {
  const beforeCommit = resolveCommit(before, 'before', cwd)
  const afterCommit = resolveCommit(after, 'after', cwd)
  requireAncestor(beforeCommit, afterCommit, cwd)

  const beforeSnapshot = readVersionSnapshotAtCommit(beforeCommit, cwd)
  const afterSnapshot = readVersionSnapshotAtCommit(afterCommit, cwd)
  const changedPaths = listChangedPaths(beforeCommit, afterCommit, cwd)
  const structuralChanges = listStructuralChanges(beforeCommit, afterCommit, cwd)
  const errors = [
    ...validateLexoraReleaseTransition({
      after: afterSnapshot.state,
      before: beforeSnapshot.state,
      changedPaths,
    }),
    ...validateLexoraReleaseSources({
      after: afterSnapshot.state,
      afterSources: afterSnapshot.sources,
      beforeSources: beforeSnapshot.sources,
    }),
  ]
  if (structuralChanges) {
    errors.push(
      `release transition contains file structure or mode changes: ${structuralChanges}`,
    )
  }

  if (errors.length)
    throw new Error(errors.join('\n'))

  return {
    commit: afterCommit,
    tag: `v${afterSnapshot.state.productVersion}`,
    version: afterSnapshot.state.productVersion,
  }
}

function readVersionSnapshotAtCommit(commit, cwd) {
  const sources = Object.fromEntries(
    lexoraVersionStatePaths.map(path => [
      path,
      runGit(['show', `${commit}:${path}`], cwd, `read ${path} at ${commit}`),
    ]),
  )
  return {
    sources,
    state: readLexoraVersionStateFromSources(sources),
  }
}

function listChangedPaths(before, after, cwd) {
  return runGit([
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=ACMRD',
    before,
    after,
    '--',
  ], cwd, 'list release transition paths').split('\n').filter(Boolean)
}

function listStructuralChanges(before, after, cwd) {
  return runGit([
    'diff',
    '--summary',
    before,
    after,
    '--',
  ], cwd, 'list release transition structure changes').trim().replaceAll('\n', '; ')
}

function resolveCommit(value, label, cwd) {
  if (!commitPattern.test(value))
    throw new Error(`${label} must be a full Git commit SHA: ${value}`)
  return runGit(['rev-parse', '--verify', `${value}^{commit}`], cwd, `resolve ${label} commit`).trim()
}

function requireAncestor(before, after, cwd) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', before, after], {
      cwd,
      stdio: 'ignore',
    })
  }
  catch {
    throw new Error(`release transition must move forward from ${before} to ${after}`)
  }
}

function runGit(args, cwd, action) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  catch {
    throw new Error(`Unable to ${action}`)
  }
}

function normalizePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

function parseOptions(args) {
  if (args[0] !== '--check' || !args[1] || !args[2]) {
    throw new Error(
      'usage: transition.mjs --check <before-sha> <after-sha> [--github-output <path>]',
    )
  }

  const options = {
    after: args[2],
    before: args[1],
  }
  for (let index = 3; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (name !== '--github-output' || !value)
      throw new Error(`Invalid release transition option: ${name ?? ''}`)
    options.githubOutput = value
  }
  return options
}

function main() {
  const options = parseOptions(process.argv.slice(2))
  const result = checkLexoraReleaseTransition(options.before, options.after)
  if (options.githubOutput) {
    appendFileSync(
      options.githubOutput,
      `commit=${result.commit}\ntag=${result.tag}\nversion=${result.version}\n`,
    )
  }
  writeOutput(`Lexora release transition check passed: ${result.tag}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  }
  catch (error) {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
