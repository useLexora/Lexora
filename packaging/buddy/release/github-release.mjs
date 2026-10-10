import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { createReleaseNotesDraft, validateReleaseNotes } from '../../release/notes.mjs'
import { writeError, writeOutput } from '../../shared/cli-output.mjs'
import { readBuddyReleaseMetadata } from './artifacts.mjs'
import { verifyBuddyReleaseArtifacts, verifyPublicAssets } from './verify-release-artifacts.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')

function requireReleaseIdentity(release, metadata) {
  if (!Number.isSafeInteger(release?.id) || release.id <= 0
    || release.tag_name !== metadata.releaseTag
    || typeof release.draft !== 'boolean' || release.prerelease !== false) {
    throw new Error('Release must match the selected stable version')
  }
}

function verifyReleaseAssets(release, artifacts, { allowMissing = false } = {}) {
  if (!Array.isArray(release.assets))
    throw new Error('Release assets are missing')
  const expected = new Map(artifacts.map(artifact => [artifact.name, artifact]))
  const seen = new Set()
  for (const asset of release.assets) {
    if (!expected.has(asset.name) || seen.has(asset.name))
      throw new Error(`Unexpected or duplicate release asset: ${asset.name}`)
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.state !== 'uploaded'
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1_000_000_000
      || !/^sha256:[a-f\d]{64}$/.test(asset.digest ?? '')) {
      throw new Error(`Release asset is incomplete: ${asset.name}`)
    }
    const artifact = expected.get(asset.name)
    if (artifact.hash && asset.digest !== `sha256:${artifact.hash}`)
      throw new Error(`Release asset differs from the verified package: ${asset.name}`)
    seen.add(asset.name)
  }
  if (!allowMissing && seen.size !== expected.size)
    throw new Error(`Missing release assets: ${[...expected.keys()].filter(name => !seen.has(name)).join(', ')}`)
}

function requireUnchangedRelease(before, after) {
  const snapshot = release => ({
    id: release.id,
    tag: release.tag_name,
    title: release.name,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
    assets: release.assets.map(({ id, name, size, digest, state, updated_at }) => (
      { id, name, size, digest, state, updated_at }
    )).sort((a, b) => a.name.localeCompare(b.name)),
  })
  if (!isDeepStrictEqual(snapshot(before), snapshot(after)))
    throw new Error('Release changed during verification; review the current draft and run Publish Release again')
}

function gh(args, input) {
  return execFileSync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function api(endpoint, { method, body, allowMissing = false } = {}) {
  try {
    return JSON.parse(gh([
      'api',
      endpoint,
      ...(method ? ['--method', method] : []),
      ...(body ? ['--input', '-'] : []),
    ], body ? JSON.stringify(body) : undefined))
  }
  catch (error) {
    if (allowMissing && error.status && /\(HTTP 404\)/.test(String(error.stderr)))
      return null
    throw error
  }
}

function findRelease(metadata) {
  const [owner, name] = metadata.releaseRepo.split('/')
  const result = api('graphql', {
    method: 'POST',
    body: {
      query: `query($owner: String!, $name: String!, $tag: String!) {
        repository(owner: $owner, name: $name) {
          release(tagName: $tag) { databaseId }
        }
      }`,
      variables: { owner, name, tag: metadata.releaseTag },
    },
  })
  const release = result.data.repository.release
  return release ? api(`repos/${metadata.releaseRepo}/releases/${release.databaseId}`) : null
}

function requireReleaseTag(metadata, commit) {
  const ref = api(`repos/${metadata.releaseRepo}/git/ref/tags/${metadata.releaseTag}`)
  if (ref.object?.type !== 'commit' || ref.object.sha !== commit)
    throw new Error('Release tag no longer points to the verified source commit')
}

function writeSummary(message) {
  writeOutput(message)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`)
}

function stageRelease(commit) {
  const metadata = verifyBuddyReleaseArtifacts()
  const endpoint = `repos/${metadata.releaseRepo}`
  const tag = api(`${endpoint}/git/ref/tags/${metadata.releaseTag}`, { allowMissing: true })
  if (!tag) {
    api(`${endpoint}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/tags/${metadata.releaseTag}`, sha: commit },
    })
  }
  requireReleaseTag(metadata, commit)

  let release = findRelease(metadata)
  if (!release) {
    const previous = api(`${endpoint}/releases/latest`, { allowMissing: true })
    const generated = api(`${endpoint}/releases/generate-notes`, {
      method: 'POST',
      body: {
        tag_name: metadata.releaseTag,
        target_commitish: commit,
        ...(previous ? { previous_tag_name: previous.tag_name } : {}),
      },
    })
    release = api(`${endpoint}/releases`, {
      method: 'POST',
      body: {
        tag_name: metadata.releaseTag,
        target_commitish: commit,
        name: `Lexora ${metadata.version}`,
        body: createReleaseNotesDraft(generated.body),
        draft: true,
        prerelease: false,
      },
    })
  }
  requireReleaseIdentity(release, metadata)
  if (!release.draft)
    throw new Error('Cannot stage assets into an already published release')
  const artifacts = [...metadata.artifacts, metadata.checksum]
  verifyReleaseAssets(release, artifacts, { allowMissing: true })
  for (const artifact of artifacts) {
    if (!release.assets.some(asset => asset.name === artifact.name))
      gh(['release', 'upload', metadata.releaseTag, artifact.path, '--repo', metadata.releaseRepo])
  }
  const uploaded = api(`${endpoint}/releases/${release.id}`)
  requireReleaseIdentity(uploaded, metadata)
  if (!uploaded.draft)
    throw new Error('Release was published before staging finished')
  verifyReleaseAssets(uploaded, artifacts)
  requireReleaseTag(metadata, commit)
  writeSummary(`Draft ${metadata.releaseTag} is ready. Edit and save the Chinese and English notes at https://github.com/${metadata.releaseRepo}/releases, then run Publish Lexora Release with version ${metadata.version}.`)
}

async function publishRelease(commit) {
  const metadata = readBuddyReleaseMetadata()
  const endpoint = `repos/${metadata.releaseRepo}`
  requireReleaseTag(metadata, commit)
  const release = findRelease(metadata)
  requireReleaseIdentity(release, metadata)
  const noteErrors = validateReleaseNotes(release.body)
  if (noteErrors.length)
    throw new Error(noteErrors.join('\n'))
  const artifacts = [...metadata.artifacts, { name: 'SHA256SUMS.txt' }]
  verifyReleaseAssets(release, artifacts)

  const directory = mkdtempSync(join(tmpdir(), 'lexora-release-'))
  try {
    gh([
      'release',
      'download',
      metadata.releaseTag,
      '--repo',
      metadata.releaseRepo,
      '--dir',
      directory,
      ...artifacts.flatMap(artifact => ['--pattern', artifact.name]),
    ])
    const verified = verifyBuddyReleaseArtifacts({ directory, verifyChecksum: true })
    verifyReleaseAssets(release, [...verified.artifacts, verified.checksum])
    for (const artifact of [...verified.artifacts, verified.checksum]) {
      gh([
        'attestation',
        'verify',
        artifact.path,
        '--repo',
        metadata.releaseRepo,
        '--signer-workflow',
        `${metadata.releaseRepo}/.github/workflows/release.yml`,
        '--source-ref',
        'refs/heads/master',
        '--source-digest',
        commit,
        '--signer-digest',
        commit,
        '--deny-self-hosted-runners',
      ])
      writeOutput(`Attestation verified: ${artifact.name}`)
    }

    requireReleaseTag(metadata, commit)
    requireUnchangedRelease(release, api(`${endpoint}/releases/${release.id}`))
    if (release.draft) {
      api(`${endpoint}/releases/${release.id}`, {
        method: 'PATCH',
        body: { draft: false, make_latest: 'legacy' },
      })
    }
    else {
      writeOutput(`${metadata.releaseTag} is already published; verifying without changing it`)
    }
    await verifyPublicAssets(verified)
    writeSummary(`Published assets verified: https://github.com/${metadata.releaseRepo}/releases/tag/${metadata.releaseTag}`)
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function main() {
  const [action, ...extra] = process.argv.slice(2)
  if (!['--stage', '--publish'].includes(action) || extra.length)
    throw new Error('Usage: github-release.mjs --stage | --publish')
  const metadata = readBuddyReleaseMetadata()
  if (process.env.GITHUB_REPOSITORY !== metadata.releaseRepo)
    throw new Error('Release repository does not match the workflow repository')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  if (action === '--stage')
    stageRelease(commit)
  else
    await publishRelease(commit)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
