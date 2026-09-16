import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { writeError, writeOutput } from '../../shared/cli-output.mjs'
import { resolveBuddyOutputPaths } from './output-paths.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')

export const desktopPackageTargets = {
  deb: { platform: 'linux', directory: 'desktop', suffix: 'linux-amd64.deb', key: 'DEB', artifact: 'lexora-buddy-ubuntu' },
  pacman: { platform: 'linux', directory: 'arch', suffix: 'arch-x86_64.pkg.tar.zst', key: 'ARCH', artifact: 'lexora-buddy-arch' },
  nsis: { platform: 'win32', directory: 'windows', suffix: 'windows-x64.exe', key: 'WINDOWS', artifact: 'lexora-buddy-windows' },
}

export function readBuddyReleaseMetadata(cwd = repoRoot) {
  const paths = resolveBuddyOutputPaths(cwd)
  const { version } = JSON.parse(readFileSync(join(paths.buddyRoot, 'buddy.version.json'), 'utf8'))
  const { repository } = JSON.parse(readFileSync(join(paths.buddyRoot, 'package.json'), 'utf8'))
  const repositoryUrl = repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Buddy release requires a stable version')
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repositoryUrl))
    throw new Error('Buddy repository URL must identify its GitHub repository')
  return {
    version,
    releaseTag: `v${version}`,
    releaseRepo: new URL(repositoryUrl).pathname.slice(1),
    artifacts: Object.entries(desktopPackageTargets).map(([target, definition]) => {
      const name = `Lexora-Buddy-${version}-${definition.suffix}`
      return { ...definition, target, name, path: join(paths.artifacts[definition.directory], name) }
    }),
  }
}

export function verifyBuddyReleaseArtifacts({ cwd = repoRoot, checksumPath } = {}) {
  const metadata = readBuddyReleaseMetadata(cwd)
  const artifacts = metadata.artifacts.map(artifact => ({
    ...artifact,
    hash: sha256(readFileSync(artifact.path)),
  }))
  const content = `${artifacts.map(artifact => `${artifact.hash}  ${artifact.name}`).join('\n')}\n`
  const path = checksumPath ?? join(resolveBuddyOutputPaths(cwd).outputRoot, 'artifacts/SHA256SUMS.txt')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return { ...metadata, artifacts, checksum: { name: 'SHA256SUMS.txt', path, hash: sha256(content) } }
}

export function writeBuddyReleaseGithubEnv(path, metadata) {
  const entries = {
    LEXORA_BUDDY_VERSION: metadata.version,
    LEXORA_BUDDY_RELEASE_TAG: metadata.releaseTag,
    LEXORA_BUDDY_RELEASE_REPO: metadata.releaseRepo,
  }
  for (const artifact of [...metadata.artifacts, { ...metadata.checksum, key: 'CHECKSUM' }]) {
    entries[`LEXORA_BUDDY_${artifact.key}_ASSET_NAME`] = artifact.name
    entries[`LEXORA_BUDDY_${artifact.key}_PATH`] = artifact.path
    entries[`LEXORA_BUDDY_${artifact.key}_SHA256`] = artifact.hash
  }
  for (const [key, value] of Object.entries(entries)) {
    if (/[\r\n]/.test(value))
      throw new Error(`Invalid newline in GitHub environment value: ${key}`)
    appendFileSync(path, `${key}=${value}\n`)
  }
}

export async function verifyPublicAssets(metadata, fetchAsset = fetch) {
  for (const artifact of [...metadata.artifacts, metadata.checksum]) {
    const url = `https://github.com/${metadata.releaseRepo}/releases/download/${metadata.releaseTag}/${artifact.name}`
    const response = await fetchAsset(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok || !response.body)
      throw new Error(`Public asset download failed: ${artifact.name} (HTTP ${response.status})`)
    const hash = createHash('sha256')
    let bytes = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done)
          break
        bytes += value.byteLength
        if (bytes > 1_000_000_000)
          throw new Error(`Public asset exceeds size limit: ${artifact.name}`)
        hash.update(value)
      }
    }
    finally {
      await reader.cancel()
    }
    if (hash.digest('hex') !== artifact.hash)
      throw new Error(`Public asset checksum mismatch: ${artifact.name}`)
    writeOutput(`Public asset verified: ${artifact.name}`)
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function main() {
  const args = process.argv.slice(2)
  const publicCheck = args.length === 1 && args[0] === '--verify-public'
  if (!publicCheck && args.length && (args.length !== 2 || args[0] !== '--github-env' || !args[1]))
    throw new Error('Usage: verify-release-artifacts.mjs [--github-env <path> | --verify-public]')
  const metadata = verifyBuddyReleaseArtifacts()
  if (publicCheck)
    await verifyPublicAssets(metadata)
  else if (args.length)
    writeBuddyReleaseGithubEnv(args[1], metadata)
  writeOutput(`Release assets verified: ${metadata.artifacts.map(artifact => artifact.name).join(', ')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
