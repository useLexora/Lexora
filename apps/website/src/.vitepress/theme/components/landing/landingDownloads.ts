export type DownloadSystem = 'windows' | 'macos' | 'linux' | 'unknown'
export type DownloadArchitecture = 'x64' | 'arm64'
export type DownloadFormat = 'deb' | 'rpm' | 'pacman' | 'nsis' | 'windows-zip' | 'macos-zip' | 'dmg'

export interface DownloadAsset {
  system: DownloadSystem
  architecture: DownloadArchitecture
  format: DownloadFormat
  name: string
  url: string
  size: number
}

export interface DownloadSelection {
  title: string
  name: string
  url: string
  releaseUrl: string
}

export interface DownloadRelease {
  tag: string
  version: string
  publishedAt: string
  url: string
  assets: DownloadAsset[]
}

export interface BrowserEnvironment {
  userAgent?: string
  platform?: string
  maxTouchPoints?: number
  userAgentData?: {
    platform?: string
    mobile?: boolean
  }
}

const tagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

const recognizedSuffixes: Record<string, { system: DownloadSystem, architecture: DownloadArchitecture, format: DownloadFormat }> = {
  'windows-x64.exe': { system: 'windows', architecture: 'x64', format: 'nsis' },
  'windows-arm64.exe': { system: 'windows', architecture: 'arm64', format: 'nsis' },
  'windows-x64-portable.zip': { system: 'windows', architecture: 'x64', format: 'windows-zip' },
  'windows-arm64-portable.zip': { system: 'windows', architecture: 'arm64', format: 'windows-zip' },
  'macos-arm64.dmg': { system: 'macos', architecture: 'arm64', format: 'dmg' },
  'macos-arm64.zip': { system: 'macos', architecture: 'arm64', format: 'macos-zip' },
  'linux-amd64.deb': { system: 'linux', architecture: 'x64', format: 'deb' },
  'linux-arm64.deb': { system: 'linux', architecture: 'arm64', format: 'deb' },
  'linux-x86_64.rpm': { system: 'linux', architecture: 'x64', format: 'rpm' },
  'linux-aarch64.rpm': { system: 'linux', architecture: 'arm64', format: 'rpm' },
  'arch-x86_64.pkg.tar.zst': { system: 'linux', architecture: 'x64', format: 'pacman' },
  'arch-aarch64.pkg.tar.zst': { system: 'linux', architecture: 'arm64', format: 'pacman' },
}

export function detectDownloadSystem(browser?: BrowserEnvironment): DownloadSystem {
  if (!browser || typeof browser !== 'object')
    return 'unknown'

  if (browser.userAgentData?.mobile === true)
    return 'unknown'

  const ua = browser.userAgent ?? ''
  const platform = browser.platform ?? ''

  if (/Android|iPhone|iPad|iPod|CrOS/i.test(ua))
    return 'unknown'

  if ((browser.maxTouchPoints ?? 0) > 0 && (platform === 'MacIntel' || /Macintosh/i.test(ua)))
    return 'unknown'

  const clientPlatform = browser.userAgentData?.platform
  if (clientPlatform) {
    if (/^Windows$/i.test(clientPlatform))
      return 'windows'
    if (/^macOS$/i.test(clientPlatform))
      return 'macos'
    if (/^Linux$/i.test(clientPlatform))
      return 'linux'
  }

  if (/Win32|Win64|Windows/i.test(platform) || /Windows NT/i.test(ua))
    return 'windows'

  if (/MacIntel|Macintosh|Mac OS X/i.test(platform) || /Macintosh.*Mac OS X/i.test(ua))
    return 'macos'

  if (/Linux/i.test(platform) || /Linux/i.test(ua))
    return 'linux'

  return 'unknown'
}

export function parseDownloadRelease(release: unknown): DownloadRelease | null {
  if (!release || typeof release !== 'object' || Array.isArray(release))
    return null

  const candidate = release as Record<string, unknown>
  if (candidate.draft !== false || candidate.prerelease !== false)
    return null

  const tag = candidate.tag_name
  if (typeof tag !== 'string' || !tagPattern.test(tag))
    return null

  const htmlUrl = candidate.html_url
  if (typeof htmlUrl !== 'string' || htmlUrl !== `https://github.com/useLexora/Lexora/releases/tag/${tag}`)
    return null

  const publishedAt = candidate.published_at
  if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt)))
    return null

  const rawAssets = candidate.assets
  if (!Array.isArray(rawAssets))
    return null

  const version = tag.slice(1)
  const prefix = `Lexora-Buddy-${version}-`
  const expectedDownloadBase = `https://github.com/useLexora/Lexora/releases/download/${tag}/`
  const assets: DownloadAsset[] = []
  const seenUrls = new Set<string>()

  for (const raw of rawAssets) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      continue
    const asset = raw as Record<string, unknown>
    if (asset.state !== 'uploaded')
      continue
    if (typeof asset.size !== 'number' || !Number.isFinite(asset.size) || asset.size <= 0)
      continue
    if (typeof asset.name !== 'string' || !asset.name.startsWith(prefix))
      continue

    const suffix = asset.name.slice(prefix.length)
    const matched = recognizedSuffixes[suffix]
    if (!matched)
      continue

    if (typeof asset.browser_download_url !== 'string')
      continue

    try {
      const parsedUrl = new URL(asset.browser_download_url)
      if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com')
        continue
      if (parsedUrl.username || parsedUrl.password || parsedUrl.port)
        continue
      if (parsedUrl.search || parsedUrl.hash)
        continue
      if (parsedUrl.href !== `${expectedDownloadBase}${asset.name}`)
        continue
      if (seenUrls.has(parsedUrl.href))
        continue

      seenUrls.add(parsedUrl.href)
      assets.push({
        system: matched.system,
        architecture: matched.architecture,
        format: matched.format,
        name: asset.name,
        url: parsedUrl.href,
        size: asset.size,
      })
    }
    catch {
      continue
    }
  }

  return {
    tag,
    version,
    publishedAt,
    url: htmlUrl,
    assets,
  }
}

export function matchDownloadAsset(
  release: DownloadRelease | null,
  system: DownloadSystem,
  architecture: DownloadArchitecture | '',
  format: DownloadFormat | '',
): DownloadAsset | undefined {
  if (!release || !system || system === 'unknown' || !architecture || !format)
    return undefined

  const found = release.assets.find(item => item.system === system && item.architecture === architecture && item.format === format)
  if (!found)
    return undefined

  return {
    system,
    architecture,
    format,
    name: found.name,
    url: found.url,
    size: found.size,
  }
}
