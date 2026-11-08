import { Buffer } from 'node:buffer'
import process from 'node:process'
import { writeOutput } from '../../shared/cli-output.mjs'

const transientStatuses = new Set([408, 429, 500, 502, 503, 504])

class DownloadError extends Error {
  constructor(url, status) {
    super(`Unable to download ${url}: HTTP ${status}`)
    this.status = status
  }
}

async function request(url, accept) {
  const token = url.startsWith('https://api.github.com/') ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN : undefined
  const response = await fetch(url, {
    headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new DownloadError(url, response.status)
  }
  return response
}

export async function downloadGithubReleaseAsset(release, archive) {
  const source = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)$/.exec(release)
  if (!source)
    throw new Error(`Unsupported GitHub release URL: ${release}`)
  try {
    const response = await request(`${release}/${encodeURIComponent(archive)}`, 'application/octet-stream')
    return Buffer.from(await response.arrayBuffer())
  }
  catch (error) {
    if (!(error instanceof TypeError || error.name === 'TimeoutError'
      || (error instanceof DownloadError && transientStatuses.has(error.status)))) {
      throw error
    }
    writeOutput(`Downloading ${archive} through the GitHub asset API after: ${error.message}`)
  }
  const repository = `https://api.github.com/repos/${source[1]}`
  const response = await request(`${repository}/releases/tags/${source[2]}`, 'application/vnd.github+json')
  const releaseMetadata = await response.json()
  const asset = releaseMetadata.assets.find(asset => asset.name === archive)
  if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0)
    throw new Error(`GitHub release asset not found: ${archive}`)
  const download = await request(`${repository}/releases/assets/${asset.id}`, 'application/octet-stream')
  return Buffer.from(await download.arrayBuffer())
}
