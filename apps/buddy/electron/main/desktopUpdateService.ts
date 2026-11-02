import type { DesktopUpdateCheckResult } from '../shared/desktopApi'
import type { DesktopUpdateChannel } from '../shared/desktopUpdates'
import { readResponseBytes } from '../../platform/network/publicWebTransport'
import { compareDesktopVersions, desktopUpdateResultSchema, desktopVersionSchema, isDesktopBetaVersion, isDesktopVersionAllowed } from '../shared/desktopUpdates'
import { isLexoraReleaseUrl, RELEASES_API_URL, REPOSITORY_URL } from '../shared/productLinks'

export interface CheckForDesktopUpdateOptions {
  currentVersion: string
  channel?: DesktopUpdateChannel
  signal?: AbortSignal
  fetchRelease?: (url: string, init?: RequestInit) => Promise<Response>
  onRelease?: (release: GithubRelease, version: string) => void
}

export interface GithubRelease {
  draft: boolean
  html_url: string
  prerelease: boolean
  tag_name: string
  body?: string
  assets?: unknown
}

const RELEASE_TAG_PREFIX = 'v'

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
    const timeout = AbortSignal.timeout(15_000)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const releases: unknown[] = []
    let remainingBytes = 4 * 1024 * 1024
    for (let page = 1; ; page++) {
      signal.throwIfAborted()
      const url = page === 1 ? RELEASES_API_URL : `${RELEASES_API_URL}&page=${page}`
      const response = await (options.fetchRelease ?? fetch)(url, {
        signal,
        headers: {
          'accept': 'application/vnd.github+json',
          'user-agent': 'Lexora-Buddy',
        },
      })
      if (!response.ok)
        throw new Error(`GitHub release request failed with ${response.status}`)
      const body = await readResponseBytes(response, remainingBytes)
      remainingBytes -= body.byteLength
      const batch: unknown = JSON.parse(new TextDecoder().decode(body))
      if (!Array.isArray(batch))
        throw new Error('GitHub release response is invalid')
      releases.push(...batch)
      const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1]
      if (!next)
        break
      if (page >= 10)
        throw new Error('GitHub release listing is incomplete')
    }
    signal.throwIfAborted()
    const release = parseLatestBuddyRelease(releases, options.channel ?? 'stable')
    const current = desktopVersionSchema.parse(options.currentVersion)
    options.onRelease?.(release.metadata, release.version)
    return desktopUpdateResultSchema.parse({
      currentVersion: current,
      latestVersion: release.version,
      releaseUrl: release.metadata.html_url,
      releaseNotes: typeof release.metadata.body === 'string' ? release.metadata.body.trim() : '',
      status: compareDesktopVersions(release.version, current) > 0
        ? 'update_available'
        : 'up_to_date',
    })
  }
  catch (error) {
    throw new DesktopUpdateCheckError({ cause: error })
  }
}

function parseLatestBuddyRelease(value: unknown, channel: DesktopUpdateChannel): {
  metadata: GithubRelease
  version: string
} {
  if (!Array.isArray(value))
    throw new Error('GitHub release response is invalid')

  const releases = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return []
    const release = candidate as Partial<GithubRelease>
    if (
      release.draft !== false
      || typeof release.prerelease !== 'boolean'
      || typeof release.tag_name !== 'string'
      || !release.tag_name.startsWith(RELEASE_TAG_PREFIX)
      || typeof release.html_url !== 'string'
      || !isLexoraReleaseUrl(release.html_url)
    ) {
      return []
    }

    try {
      const version = desktopVersionSchema.parse(release.tag_name.slice(RELEASE_TAG_PREFIX.length))
      if (!isDesktopVersionAllowed(version, channel) || release.prerelease !== isDesktopBetaVersion(version)
        || release.html_url !== `${REPOSITORY_URL}/releases/tag/v${version}`) {
        return []
      }
      return [{ metadata: release as GithubRelease, version }]
    }
    catch {
      return []
    }
  })
  if (releases.length === 0)
    throw new Error('GitHub release response is invalid')

  return releases.reduce((latest, release) => (
    compareDesktopVersions(release.version, latest.version) > 0 ? release : latest
  ))
}
