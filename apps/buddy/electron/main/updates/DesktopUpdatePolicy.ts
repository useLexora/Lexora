import type { DesktopDistribution } from '../../shared/desktopDistribution'
import type { DesktopUpdateDeliveryMode, DesktopUpdateDeliveryReason } from '../../shared/desktopUpdates'
import type { GithubRelease } from '../desktopUpdateService'
import type { DesktopUpdatePackage } from './DesktopUpdatePackage'
import { z } from 'zod'
import { DESKTOP_PACKAGE_FORMATS } from '../../shared/desktopDistribution'
import { selectDesktopUpdatePackage } from './DesktopUpdatePackage'

const distributionSchema = z.object({
  schemaVersion: z.literal(1),
  format: z.enum(Object.keys(DESKTOP_PACKAGE_FORMATS) as [keyof typeof DESKTOP_PACKAGE_FORMATS, ...(keyof typeof DESKTOP_PACKAGE_FORMATS)[]]),
  architecture: z.enum(['x64', 'arm64']),
  signing: z.enum(['developer-id', 'ad-hoc', 'none']),
}).strict()

export function readDesktopDistribution(input: unknown, platform: string, architecture: string): DesktopDistribution | null {
  const parsed = distributionSchema.safeParse(input)
  return parsed.success && DESKTOP_PACKAGE_FORMATS[parsed.data.format].platform === platform && parsed.data.architecture === architecture ? parsed.data : null
}

export interface DesktopUpdatePlan {
  mode: DesktopUpdateDeliveryMode
  reason: DesktopUpdateDeliveryReason
  update: DesktopUpdatePackage | null
  fallback: DesktopUpdatePackage | null
}

export class DesktopUpdatePolicy {
  readonly distribution: DesktopDistribution | null
  linuxInstallation = { available: false, failedVersion: null as string | null }

  constructor(distribution: DesktopDistribution | null) {
    this.distribution = distribution
  }

  get capabilities() {
    return { download: this.distribution !== null, install: this.linuxInstallation.available || this.distribution?.format === 'nsis' || (this.distribution?.signing === 'developer-id' && this.distribution.format === 'dmg') }
  }

  resolveCached(packages: DesktopUpdatePackage[]): DesktopUpdatePlan | null {
    const version = packages[0]?.version
    if (!version || packages.some(item => item.version !== version))
      return null
    const plan = this.resolve({
      tag_name: `v${version}`,
      html_url: `https://github.com/useLexora/Lexora/releases/tag/v${version}`,
      draft: false,
      prerelease: false,
      assets: packages.map(item => ({ name: item.name, browser_download_url: item.url, digest: `sha256:${item.sha256}`, size: item.size, state: 'uploaded' })),
    }, version)
    return plan.update ? plan : null
  }

  resolve(release: GithubRelease, version: string): DesktopUpdatePlan {
    const distribution = this.distribution
    if (!distribution)
      return { mode: 'release', reason: 'distribution-unavailable', update: null, fallback: null }
    const { format, architecture, signing } = distribution
    const fallback = selectDesktopUpdatePackage(release, version, architecture, format)
    if (format === 'dmg' && signing === 'developer-id') {
      const zip = selectDesktopUpdatePackage(release, version, architecture, 'macos-zip')
      if (zip && fallback)
        return { mode: 'restart', reason: null, update: zip, fallback }
    }
    if (!fallback)
      return { mode: 'release', reason: 'asset-unavailable', update: null, fallback: null }
    if (format === 'windows-zip')
      return { mode: 'open-package', reason: 'portable-package', update: fallback, fallback: null }
    if (['deb', 'rpm', 'pacman'].includes(format)) {
      const failed = this.linuxInstallation.failedVersion === version
      return { mode: this.linuxInstallation.available && !failed ? 'restart' : 'manual', reason: failed ? 'installer-unavailable' : 'system-package', update: fallback, fallback: null }
    }
    return {
      mode: format === 'nsis' ? 'restart' : 'open-package',
      reason: format === 'dmg' ? signing === 'developer-id' ? 'asset-unavailable' : 'signature-required' : format === 'nsis' ? null : 'system-package',
      update: fallback,
      fallback: null,
    }
  }
}
