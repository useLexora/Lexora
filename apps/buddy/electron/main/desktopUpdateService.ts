import type { DesktopUpdateCheckResult } from '../shared/desktopApi'
import { isLexoraReleaseUrl, RELEASES_API_URL } from '../shared/productLinks'

export interface CheckForDesktopUpdateOptions {
  currentVersion: string
  fetchRelease?: (url: string, init?: RequestInit) => Promise<Response>
}

interface GithubRelease {
  draft: boolean
  html_url: string
  prerelease: boolean
  tag_name: string
}

const RELEASE_TAG_PREFIX = 'v'
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

export class DesktopUpdateCheckError extends Error {
  readonly code = 'UPDATE_CHECK_FAILED'

  constructor(options?: ErrorOptions) {
    super('Lexora Buddy update check failed', options)
    this.name = 'DesktopUpdateCheckError'
  }
}

export async function checkForDesktopUpdate(
  options: CheckForDesktopUpdateOptions,
): Promise<DesktopUpdateCheckResult> {
  try {
    const response = await (options.fetchRelease ?? fetch)(RELEASES_API_URL, {
      headers: {
        'accept': 'application/vnd.github+json',
        'user-agent': 'Lexora-Buddy',
      },
    })
    if (!response.ok)
      throw new Error(`GitHub release request failed with ${response.status}`)

    const release = parseLatestBuddyRelease(await response.json())
    const current = parseVersion(options.currentVersion)
    return {
      currentVersion: options.currentVersion,
      latestVersion: release.version.raw,
      releaseUrl: release.metadata.html_url,
      status: compareVersions(release.version.parts, current.parts) > 0
        ? 'update_available'
        : 'up_to_date',
    }
  }
  catch (error) {
    throw new DesktopUpdateCheckError({ cause: error })
  }
}

function parseLatestBuddyRelease(value: unknown): {
  metadata: GithubRelease
  version: ReturnType<typeof parseVersion>
} {
  if (!Array.isArray(value))
    throw new Error('GitHub release response is invalid')

  const releases = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return []
    const release = candidate as Partial<GithubRelease>
    if (
      release.draft !== false
      || release.prerelease !== false
      || typeof release.tag_name !== 'string'
      || !release.tag_name.startsWith(RELEASE_TAG_PREFIX)
      || typeof release.html_url !== 'string'
      || !isLexoraReleaseUrl(release.html_url)
    ) {
      return []
    }

    try {
      return [{
        metadata: release as GithubRelease,
        version: parseVersion(release.tag_name.slice(RELEASE_TAG_PREFIX.length)),
      }]
    }
    catch {
      return []
    }
  })
  if (releases.length === 0)
    throw new Error('GitHub release response is invalid')

  return releases.reduce((latest, release) => (
    compareVersions(release.version.parts, latest.version.parts) > 0 ? release : latest
  ))
}

function parseVersion(value: string): { parts: readonly number[], raw: string } {
  const match = SEMVER_PATTERN.exec(value)
  if (!match)
    throw new Error('Lexora Buddy version is invalid')
  return {
    parts: match.slice(1).map(Number),
    raw: value,
  }
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0)
      return difference
  }
  return 0
}
