import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { desktopUpdateArtifactName } from '../../../apps/buddy/electron/shared/desktopDistribution.ts'
import { CPU_ARCHITECTURE } from '../../../apps/buddy/shared/platform/identifiers.ts'
import { resolveBuddyOutputPaths } from './output-paths.mjs'
import { readBuddyProductMetadata } from './release-metadata.mjs'
import { requirePackageFormat, resolveBuildTarget } from './targets.mjs'

const formats = {
  deb: { directory: 'desktop', artifact: 'lexora-buddy-ubuntu' },
  rpm: { directory: 'rpm', artifact: 'lexora-buddy-fedora' },
  pacman: { directory: 'arch', artifact: 'lexora-buddy-arch' },
  nsis: { directory: 'windows', artifact: 'lexora-buddy-windows' },
  zip: { directory: 'macos', artifact: 'lexora-buddy-macos' },
  dmg: { directory: 'macos', artifact: 'lexora-buddy-macos' },
}

export const releasePackages = [
  { targetId: 'linux-x64', format: 'deb' },
  { targetId: 'linux-arm64', format: 'deb' },
  { targetId: 'linux-x64', format: 'rpm' },
  { targetId: 'linux-arm64', format: 'rpm' },
  { targetId: 'linux-x64', format: 'pacman' },
  { targetId: 'linux-arm64', format: 'pacman' },
  { targetId: 'win32-x64', format: 'nsis' },
  { targetId: 'win32-arm64', format: 'nsis' },
  { targetId: 'darwin-arm64', format: 'dmg' },
  { targetId: 'darwin-arm64', format: 'zip' },
]

export function desktopArtifactName(target, format, version) {
  requirePackageFormat(target, format)
  return desktopUpdateArtifactName(format, target.architecture, version)
}

export function desktopArtifact(target, format, { cwd } = {}) {
  const { version } = readBuddyProductMetadata(cwd)
  const definition = formats[format]
  const name = desktopArtifactName(target, format, version)
  const arm = target.architecture === CPU_ARCHITECTURE.ARM64 ? '-arm64' : ''
  return {
    targetId: target.id,
    target: format,
    platform: target.platform,
    directory: definition.directory,
    artifact: `${definition.artifact}${arm}`,
    name,
    path: join(resolveBuddyOutputPaths(cwd).artifacts[definition.directory], name),
  }
}

export function readBuddyReleaseMetadata(cwd) {
  const artifacts = releasePackages.map(({ targetId, format }) => desktopArtifact(resolveBuildTarget(targetId), format, { cwd }))
  return {
    ...readBuddyProductMetadata(cwd),
    artifacts,
    checksums: artifacts.map(({ name, path }) => ({ name: `${name}.sha256`, path: `${path}.sha256` })),
    checksum: { name: 'SHA256SUMS.txt', path: join(resolveBuddyOutputPaths(cwd).outputRoot, 'artifacts/SHA256SUMS.txt') },
  }
}

export function releaseAssets(metadata) {
  return [...metadata.artifacts, ...metadata.checksums, metadata.checksum]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'format': { type: 'string' }, 'github-output': { type: 'string' } } })
  if (!values.format || !values['github-output'])
    throw new Error('Usage: artifacts.mjs --format <format> --github-output <path>')
  const artifact = desktopArtifact(resolveBuildTarget(), values.format)
  appendFileSync(values['github-output'], `name=${artifact.name}\npath=${artifact.path}\nartifact=${artifact.artifact}\n`)
}
