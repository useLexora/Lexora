import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { writeError, writeOutput } from '../../shared/cli-output.mjs'
import { readBuddyReleaseMetadata, releaseAssets } from './artifacts.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')

export function verifyBuddyReleaseArtifacts({ cwd = repoRoot, directory, verifyChecksum = false } = {}) {
  const metadata = readBuddyReleaseMetadata(cwd)
  const artifacts = metadata.artifacts.map((artifact) => {
    const path = directory ? join(directory, artifact.name) : artifact.path
    return { ...artifact, path, hash: sha256(readFileSync(path)) }
  })
  const entries = artifacts.map(artifact => `${artifact.hash}  ${artifact.name}\n`)
  function checksumFile(checksum, content) {
    const path = directory ? join(directory, checksum.name) : checksum.path
    if (verifyChecksum) {
      if (readFileSync(path, 'utf8') !== content)
        throw new Error(`Release checksum file does not match the downloaded packages: ${checksum.name}`)
    }
    else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    return { ...checksum, path, hash: sha256(content) }
  }
  const checksums = metadata.checksums.map((checksum, index) => checksumFile(checksum, entries[index]))
  const checksum = checksumFile(metadata.checksum, entries.join(''))
  return { ...metadata, artifacts, checksums, checksum }
}

export function writeBuddyReleaseGithubEnv(path, metadata) {
  const entries = {
    LEXORA_BUDDY_VERSION: metadata.version,
    LEXORA_BUDDY_RELEASE_TAG: metadata.releaseTag,
  }
  for (const [key, value] of Object.entries(entries)) {
    if (/[\r\n]/.test(value))
      throw new Error(`Invalid newline in GitHub environment value: ${key}`)
    appendFileSync(path, `${key}=${value}\n`)
  }
}

export async function verifyPublicAssets(metadata, fetchAsset = fetch) {
  for (const artifact of releaseAssets(metadata)) {
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

function main() {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--github-env' || !args[1]))
    throw new Error('Usage: verify-release-artifacts.mjs [--github-env <path>]')
  const metadata = verifyBuddyReleaseArtifacts()
  if (args.length)
    writeBuddyReleaseGithubEnv(args[1], metadata)
  writeOutput(`Release assets verified: ${metadata.artifacts.map(artifact => artifact.name).join(', ')}`)
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
