export const DESKTOP_PACKAGE_FORMATS = {
  'nsis': { platform: 'win32', extension: 'exe' },
  'windows-zip': { platform: 'win32', extension: 'zip' },
  'dmg': { platform: 'darwin', extension: 'dmg' },
  'macos-zip': { platform: 'darwin', extension: 'zip' },
  'deb': { platform: 'linux', extension: 'deb' },
  'rpm': { platform: 'linux', extension: 'rpm' },
  'pacman': { platform: 'linux', extension: 'pkg.tar.zst' },
} as const

export type DesktopPackageFormat = keyof typeof DESKTOP_PACKAGE_FORMATS
export interface DesktopDistribution {
  schemaVersion: 1
  format: DesktopPackageFormat
  architecture: 'x64' | 'arm64'
  signing: 'developer-id' | 'ad-hoc' | 'none'
}

export function desktopUpdateArtifactName(format: DesktopPackageFormat, architecture: DesktopDistribution['architecture'], version: string): string {
  const definition = DESKTOP_PACKAGE_FORMATS[format]
  const platform = definition.platform === 'win32' ? 'windows' : definition.platform === 'darwin' ? 'macos' : format === 'pacman' ? 'arch' : 'linux'
  const packageArchitecture = format === 'deb' ? (architecture === 'x64' ? 'amd64' : 'arm64') : ['rpm', 'pacman'].includes(format) ? (architecture === 'x64' ? 'x86_64' : 'aarch64') : architecture
  const suffix = format === 'windows-zip' ? '-portable' : ''
  return `Lexora-Buddy-${version}-${platform}-${packageArchitecture}${suffix}.${definition.extension}`
}
