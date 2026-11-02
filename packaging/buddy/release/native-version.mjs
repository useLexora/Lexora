import { OPERATING_SYSTEM } from '../../../apps/buddy/shared/platform/identifiers.ts'
import { parseLexoraVersion } from '../../release/version.mjs'

export function desktopNativeVersions(version) {
  const { baseVersion, beta } = parseLexoraVersion(version)
  return {
    deb: beta === null ? baseVersion : `${baseVersion}~beta.${beta}`,
    rpm: { version: baseVersion, release: beta === null ? '1' : `0.beta.${beta}` },
    pacman: beta === null ? baseVersion : `${baseVersion}beta${beta}`,
    windows: `${baseVersion}.0`,
    macos: { shortVersion: baseVersion, bundleVersion: beta === null ? baseVersion : `${baseVersion}b${beta}` },
  }
}

export function withDesktopNativeVersion(config, version, target) {
  const { major, minor, patch, beta } = parseLexoraVersion(version)
  if (beta === null)
    return config
  const native = desktopNativeVersions(version)
  if (target.platform === OPERATING_SYSTEM.Linux) {
    return {
      ...config,
      rpm: { ...config.rpm, fpm: [...config.rpm?.fpm ?? [], '--version', native.rpm.version, '--iteration', native.rpm.release] },
      pacman: { ...config.pacman, fpm: [...config.pacman?.fpm ?? [], '--version', native.pacman, '--iteration', '1'] },
    }
  }
  if (target.platform === OPERATING_SYSTEM.Windows) {
    if ([major, minor, patch].some(part => BigInt(part) > 65535n))
      throw new Error('Windows native version components must not exceed 65535')
    return { ...config, buildVersion: native.windows, buildNumber: '0' }
  }
  if (target.platform === OPERATING_SYSTEM.MacOS) {
    if (BigInt(beta) > 255n)
      throw new Error('macOS beta build number must be between 1 and 255')
    if (BigInt(major) > 9999n || [minor, patch].some(part => BigInt(part) > 99n))
      throw new Error('macOS native version requires major <= 9999 and minor/patch <= 99')
    return { ...config, mac: { ...config.mac, bundleShortVersion: native.macos.shortVersion, bundleVersion: native.macos.bundleVersion } }
  }
  throw new Error(`Unsupported native version platform: ${target.platform}`)
}
