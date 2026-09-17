import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { CPU_ARCHITECTURE } from '../../../apps/buddy/shared/platform/identifiers.ts'
import { resolveBuddyOutputPaths } from './output-paths.mjs'
import { readBuddyProductMetadata } from './release-metadata.mjs'
import { requirePackageFormat, resolveBuildTarget } from './targets.mjs'

const formats = {
  deb: { directory: 'desktop', key: 'DEB', artifact: 'lexora-buddy-ubuntu', suffix: target => `linux-${target.architecture === CPU_ARCHITECTURE.X64 ? 'amd64' : 'arm64'}.deb` },
  pacman: { directory: 'arch', key: 'ARCH', artifact: 'lexora-buddy-arch', suffix: () => 'arch-x86_64.pkg.tar.zst' },
  nsis: { directory: 'windows', key: 'WINDOWS', artifact: 'lexora-buddy-windows', suffix: target => `windows-${target.architecture}.exe` },
  dmg: { directory: 'macos', key: 'MACOS', artifact: 'lexora-buddy-macos', suffix: target => `macos-${target.architecture}.dmg` },
}

export const releasePackages = [
  { targetId: 'linux-x64', format: 'deb' },
  { targetId: 'linux-arm64', format: 'deb' },
  { targetId: 'linux-x64', format: 'pacman' },
  { targetId: 'win32-x64', format: 'nsis' },
  { targetId: 'win32-arm64', format: 'nsis' },
  { targetId: 'darwin-arm64', format: 'dmg' },
]

export function desktopArtifactName(target, format, version) {
  requirePackageFormat(target, format)
  return `Lexora-Buddy-${version}-${formats[format].suffix(target)}`
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
    key: `${definition.key}${arm ? '_ARM64' : ''}`,
    artifact: `${definition.artifact}${arm}`,
    name,
    path: join(resolveBuddyOutputPaths(cwd).artifacts[definition.directory], name),
  }
}

export function readBuddyReleaseMetadata(cwd) {
  return {
    ...readBuddyProductMetadata(cwd),
    artifacts: releasePackages.map(({ targetId, format }) => desktopArtifact(resolveBuildTarget(targetId), format, { cwd })),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'format': { type: 'string' }, 'github-output': { type: 'string' } } })
  if (!values.format || !values['github-output'])
    throw new Error('Usage: artifacts.mjs --format <format> --github-output <path>')
  const artifact = desktopArtifact(resolveBuildTarget(), values.format)
  appendFileSync(values['github-output'], `name=${artifact.name}\npath=${artifact.path}\nartifact=${artifact.artifact}\n`)
}
