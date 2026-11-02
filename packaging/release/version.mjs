import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { writeError, writeOutput } from '../shared/cli-output.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/
const applicationPackagePaths = {
  buddy: 'apps/buddy/package.json',
}
const versionlessPackagePaths = [
  'apps/website/package.json',
]
const buddyMetadataPath = 'apps/buddy/buddy.version.json'
const cargoManifestPath = 'apps/buddy/native/pet/Cargo.toml'
const cargoLockPath = 'apps/buddy/native/Cargo.lock'

export const lexoraVersionStatePaths = Object.freeze([
  'package.json',
  ...Object.values(applicationPackagePaths),
  ...versionlessPackagePaths,
  buddyMetadataPath,
  cargoManifestPath,
  cargoLockPath,
])

export function readLexoraVersionState(cwd = repoRoot) {
  return readLexoraVersionStateFromSources(readManagedSources(cwd))
}

export function readLexoraVersionStateFromSources(sources) {
  const rootPackage = parseJson(sources['package.json'], 'package.json')
  const applicationPackages = Object.fromEntries(
    Object.entries(applicationPackagePaths).map(([name, path]) => [name, parseJson(sources[path], path)]),
  )
  const versionlessPackages = Object.fromEntries(
    versionlessPackagePaths.map(path => [path, parseJson(sources[path], path)]),
  )
  const buddyMetadata = parseJson(sources[buddyMetadataPath], buddyMetadataPath)
  const cargoManifest = sources[cargoManifestPath]
  const cargoLock = sources[cargoLockPath]

  return {
    applicationVersions: Object.fromEntries(
      Object.entries(applicationPackages).map(([name, value]) => [name, readJsonVersion(value)]),
    ),
    buddyMetadataVersion: readJsonVersion(buddyMetadata),
    cargoLockVersion: readCargoLockVersion(cargoLock),
    cargoVersion: readCargoVersion(cargoManifest),
    packagePrivacy: {
      'package.json': rootPackage.private,
      ...Object.fromEntries(
        Object.entries(applicationPackagePaths).map(([name, path]) => [path, applicationPackages[name].private]),
      ),
      ...Object.fromEntries(
        versionlessPackagePaths.map(path => [path, versionlessPackages[path].private]),
      ),
    },
    productVersion: readJsonVersion(rootPackage),
    sourceDateEpoch: Number(buddyMetadata.sourceDateEpoch),
    versionlessPackageVersions: Object.fromEntries(
      versionlessPackagePaths.map(path => [
        path,
        Object.hasOwn(versionlessPackages[path], 'version')
          ? String(versionlessPackages[path].version)
          : undefined,
      ]),
    ),
  }
}

export function validateLexoraVersionState(state) {
  const errors = []
  if (!isLexoraVersion(state.productVersion))
    errors.push(`package.json has invalid product version: ${state.productVersion}`)

  for (const [name, version] of Object.entries(state.applicationVersions)) {
    if (version !== state.productVersion)
      errors.push(`${applicationPackagePaths[name]} version ${version} does not match ${state.productVersion}`)
  }

  if (state.buddyMetadataVersion !== state.productVersion)
    errors.push(`${buddyMetadataPath} version ${state.buddyMetadataVersion} does not match ${state.productVersion}`)
  if (!Number.isSafeInteger(state.sourceDateEpoch) || state.sourceDateEpoch <= 0)
    errors.push(`${buddyMetadataPath} has invalid sourceDateEpoch: ${state.sourceDateEpoch}`)
  if (state.cargoVersion !== state.productVersion)
    errors.push(`${cargoManifestPath} version ${state.cargoVersion} does not match ${state.productVersion}`)
  if (state.cargoLockVersion !== state.productVersion)
    errors.push(`${cargoLockPath} version ${state.cargoLockVersion} does not match ${state.productVersion}`)

  for (const [path, version] of Object.entries(state.versionlessPackageVersions)) {
    if (version !== undefined)
      errors.push(`${path} must not declare a version`)
  }

  for (const [path, value] of Object.entries(state.packagePrivacy)) {
    if (value !== true)
      errors.push(`${path} private must be the boolean true`)
  }

  return errors
}

export function validateLexoraReleaseTag(tag, productVersion) {
  const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : ''
  if (!isLexoraVersion(version))
    throw new Error(`Lexora release tag must use vX.Y.Z or vX.Y.Z-beta.N format: ${tag}`)
  if (version !== productVersion)
    throw new Error(`Lexora release tag ${tag} does not match product version ${productVersion}`)
  return { tag, version }
}

export function setLexoraVersion(cwd, version, options = {}) {
  const sources = readManagedSources(cwd)
  const result = createLexoraVersionSources(sources, version, options)

  for (const path of result.changedPaths)
    writeFileSync(join(cwd, path), result.sources[path])

  return {
    changedPaths: result.changedPaths,
    sourceDateEpoch: result.sourceDateEpoch,
    version: result.version,
  }
}

export function createLexoraVersionSources(sources, version, options = {}) {
  parseLexoraVersion(version)

  const parsed = {
    rootPackage: parseJson(sources['package.json'], 'package.json'),
    applicationPackages: Object.fromEntries(
      Object.entries(applicationPackagePaths).map(([name, path]) => [name, parseJson(sources[path], path)]),
    ),
    versionlessPackages: Object.fromEntries(
      versionlessPackagePaths.map(path => [path, parseJson(sources[path], path)]),
    ),
    buddyMetadata: parseJson(sources[buddyMetadataPath], buddyMetadataPath),
  }
  const currentVersion = readJsonVersion(parsed.rootPackage)
  if (!isLexoraVersion(currentVersion))
    throw new Error(`package.json has invalid product version: ${currentVersion}`)

  const comparison = compareLexoraVersions(version, currentVersion)
  if (comparison < 0)
    throw new Error(`version ${version} is lower than current product version ${currentVersion}`)

  validateWritableStructure(parsed, sources)

  const currentSourceDateEpoch = Number(parsed.buddyMetadata.sourceDateEpoch)
  const sourceDateEpoch = comparison > 0
    ? options.sourceDateEpoch ?? Math.max(
      Math.floor((options.now?.() ?? Date.now()) / 1000),
      currentSourceDateEpoch + 1,
    )
    : currentSourceDateEpoch
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0)
    throw new Error(`invalid sourceDateEpoch: ${sourceDateEpoch}`)
  if (comparison > 0 && sourceDateEpoch <= currentSourceDateEpoch) {
    throw new Error(
      `sourceDateEpoch ${sourceDateEpoch} must be greater than ${currentSourceDateEpoch}`,
    )
  }

  const nextSources = { ...sources }
  nextSources['package.json'] = updateJson(sources['package.json'], parsed.rootPackage, (value) => {
    value.version = version
  })
  for (const [name, path] of Object.entries(applicationPackagePaths)) {
    nextSources[path] = updateJson(sources[path], parsed.applicationPackages[name], (value) => {
      value.version = version
    })
  }
  for (const path of versionlessPackagePaths) {
    nextSources[path] = updateJson(sources[path], parsed.versionlessPackages[path], (value) => {
      delete value.version
    })
  }
  nextSources[buddyMetadataPath] = updateJson(sources[buddyMetadataPath], parsed.buddyMetadata, (value) => {
    value.version = version
    value.sourceDateEpoch = sourceDateEpoch
  })
  nextSources[cargoManifestPath] = replaceCargoVersion(sources[cargoManifestPath], version)
  nextSources[cargoLockPath] = replaceCargoLockVersion(sources[cargoLockPath], version)

  const changedPaths = []
  for (const [path, source] of Object.entries(nextSources)) {
    if (source === sources[path])
      continue
    changedPaths.push(path)
  }

  return {
    changedPaths,
    sourceDateEpoch,
    sources: nextSources,
    version,
  }
}

function validateWritableStructure(parsed, sources) {
  for (const [path, value] of Object.entries({
    'package.json': parsed.rootPackage,
    ...Object.fromEntries(
      Object.entries(applicationPackagePaths).map(([name, path]) => [path, parsed.applicationPackages[name]]),
    ),
    ...parsed.versionlessPackages,
  })) {
    if (value.private !== true)
      throw new Error(`${path} private must be the boolean true`)
  }

  const sourceDateEpoch = Number(parsed.buddyMetadata.sourceDateEpoch)
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0)
    throw new Error(`${buddyMetadataPath} has invalid sourceDateEpoch: ${sourceDateEpoch}`)
  if (!readCargoVersion(sources[cargoManifestPath]))
    throw new Error(`${cargoManifestPath} does not contain a package version`)
  if (!readCargoLockVersion(sources[cargoLockPath]))
    throw new Error(`${cargoLockPath} does not contain lexora-buddy-pet`)
}

function readManagedSources(cwd) {
  return Object.fromEntries(
    lexoraVersionStatePaths.map(path => [path, readSource(cwd, path)]),
  )
}

function readSource(cwd, path) {
  return readFileSync(join(cwd, path), 'utf8')
}

function parseJson(source, path) {
  const value = JSON.parse(source)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path} must contain a JSON object`)
  return value
}

function readJsonVersion(value) {
  return String(value.version ?? '')
}

function updateJson(source, value, update) {
  const next = structuredClone(value)
  update(next)
  if (isDeepStrictEqual(next, value))
    return source
  const serialized = `${JSON.stringify(next, null, 2)}\n`
  return serialized
}

function readCargoVersion(source) {
  return source.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? ''
}

function replaceCargoVersion(source, version) {
  return replaceExactlyOnce(
    source,
    /^(version\s*=\s*)"[^"]+"/m,
    `$1"${version}"`,
    cargoManifestPath,
  )
}

function readCargoLockVersion(source) {
  return source.match(/\[\[package\]\]\r?\nname = "lexora-buddy-pet"\r?\nversion = "([^"]+)"/)?.[1] ?? ''
}

function replaceCargoLockVersion(source, version) {
  return replaceExactlyOnce(
    source,
    /(\[\[package\]\]\r?\nname = "lexora-buddy-pet"\r?\nversion = )"[^"]+"/,
    `$1"${version}"`,
    cargoLockPath,
  )
}

function replaceExactlyOnce(source, pattern, replacement, path) {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) ?? []
  if (matches.length !== 1)
    throw new Error(`${path} must contain exactly one managed version`)
  return source.replace(pattern, replacement)
}

function isLexoraVersion(version) {
  return typeof version === 'string' && versionPattern.exec(version)?.[0] === version
}

export function parseLexoraVersion(version) {
  const match = typeof version === 'string' ? versionPattern.exec(version) : null
  if (!match || match[0] !== version)
    throw new Error(`version must use x.y.z or x.y.z-beta.N without leading zeroes (N > 0): ${version}`)
  const [, major, minor, patch, beta = null] = match
  return { major, minor, patch, beta, baseVersion: `${major}.${minor}.${patch}` }
}

export function compareLexoraVersions(left, right) {
  const a = parseLexoraVersion(left)
  const b = parseLexoraVersion(right)
  for (const part of ['major', 'minor', 'patch']) {
    if (BigInt(a[part]) > BigInt(b[part]))
      return 1
    if (BigInt(a[part]) < BigInt(b[part]))
      return -1
  }
  if (a.beta === b.beta)
    return 0
  if (a.beta === null)
    return 1
  if (b.beta === null)
    return -1
  return BigInt(a.beta) > BigInt(b.beta) ? 1 : -1
}

function checkVersionState(cwd = repoRoot) {
  const state = readLexoraVersionState(cwd)
  const errors = validateLexoraVersionState(state)
  if (errors.length)
    throw new Error(errors.join('\n'))
  return state
}

function main() {
  const [command, value] = process.argv.slice(2)
  if (command === '--set') {
    const result = setLexoraVersion(repoRoot, value ?? '')
    checkVersionState()
    writeOutput(`Lexora version synchronized: ${result.version}`)
    return
  }
  if (command === '--check') {
    const state = checkVersionState()
    writeOutput(`Lexora version check passed: ${state.productVersion}`)
    return
  }
  if (command === '--check-next') {
    const state = checkVersionState()
    const version = value ?? ''
    parseLexoraVersion(version)
    if (compareLexoraVersions(version, state.productVersion) <= 0) {
      throw new Error(
        `version ${version} must be greater than current product version ${state.productVersion}`,
      )
    }
    writeOutput(`Lexora next version check passed: ${version}`)
    return
  }
  if (command === '--check-tag') {
    const state = checkVersionState()
    const release = validateLexoraReleaseTag(value ?? '', state.productVersion)
    writeOutput(`Lexora release tag check passed: ${release.tag}`)
    return
  }
  throw new Error(
    'usage: version.mjs --set <version> | --check | --check-next <version> | --check-tag <vVersion> (x.y.z or x.y.z-beta.N)',
  )
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
