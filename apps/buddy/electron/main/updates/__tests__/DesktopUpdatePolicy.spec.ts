import type { DesktopDistribution } from '../../../shared/desktopDistribution'
import { describe, expect, it } from 'vitest'
import { desktopUpdateArtifactName } from '../../../shared/desktopDistribution'
import { DesktopUpdatePolicy, readDesktopDistribution } from '../DesktopUpdatePolicy'

const version = '1.2.3'
function release(formats: DesktopDistribution['format'][], architecture: DesktopDistribution['architecture'] = 'arm64') {
  return {
    draft: false,
    prerelease: false,
    tag_name: `v${version}`,
    html_url: `https://github.com/useLexora/Lexora/releases/tag/v${version}`,
    assets: formats.map((format) => {
      const name = desktopUpdateArtifactName(format, architecture, version)
      return { name, browser_download_url: `https://github.com/useLexora/Lexora/releases/download/v${version}/${name}`, state: 'uploaded', size: 100, digest: `sha256:${'a'.repeat(64)}` }
    }),
  }
}
function policy(format: DesktopDistribution['format'], signing: DesktopDistribution['signing'] = 'none') {
  return new DesktopUpdatePolicy({ schemaVersion: 1, format, signing, architecture: 'arm64' })
}

describe('desktop update capability policy', () => {
  it('promotes signed macOS packages only when the update ZIP is present', () => {
    const unsigned = policy('dmg', 'ad-hoc').resolve(release(['dmg', 'macos-zip']), version)
    expect(unsigned).toMatchObject({ mode: 'open-package', reason: 'signature-required', update: { name: 'Lexora-Buddy-1.2.3-macos-arm64.dmg' } })
    const signed = policy('dmg', 'developer-id')
    expect(signed.resolve(release(['dmg', 'macos-zip']), version)).toMatchObject({ mode: 'restart', reason: null, update: { name: 'Lexora-Buddy-1.2.3-macos-arm64.zip' }, fallback: { name: 'Lexora-Buddy-1.2.3-macos-arm64.dmg' } })
    expect(signed.resolve(release(['dmg']), version)).toMatchObject({ mode: 'open-package', reason: 'asset-unavailable' })
    expect(signed.resolve(release(['macos-zip']), version)).toMatchObject({ mode: 'release', update: null })
  })

  it('keeps system package installation dependent on native availability and failures scoped to their version', () => {
    const linux = policy('deb')
    expect(linux.resolve(release(['deb', 'nsis']), version)).toMatchObject({ mode: 'manual', reason: 'system-package' })
    linux.linuxInstallation = { available: true, failedVersion: null }
    expect(linux.resolve(release(['deb']), version).mode).toBe('restart')
    linux.linuxInstallation.failedVersion = version
    expect(linux.resolve(release(['deb']), version)).toMatchObject({ mode: 'manual', reason: 'installer-unavailable' })
    linux.linuxInstallation.failedVersion = '1.2.2'
    expect(linux.resolve(release(['deb']), version).mode).toBe('restart')
  })

  it('keeps Windows ZIP updates manual and separate from installers', () => {
    const metadata: DesktopDistribution = { schemaVersion: 1, format: 'windows-zip', signing: 'none', architecture: 'arm64' }
    const portable = new DesktopUpdatePolicy(readDesktopDistribution(metadata, 'win32', 'arm64'))
    expect(portable.capabilities).toEqual({ download: true, install: false })
    const plan = portable.resolve(release(['nsis', 'windows-zip', 'macos-zip']), version)
    expect(plan).toMatchObject({
      mode: 'open-package',
      reason: 'portable-package',
      update: { name: 'Lexora-Buddy-1.2.3-windows-arm64-portable.zip' },
      fallback: null,
    })
    expect(portable.resolve(release(['nsis', 'macos-zip']), version)).toMatchObject({ mode: 'release', update: null })
    expect(portable.resolve(release(['windows-zip'], 'x64'), version)).toMatchObject({ mode: 'release', update: null })
    const installed = new DesktopUpdatePolicy({ ...metadata, format: 'nsis' })
    const installer = installed.resolve(release(['nsis', 'windows-zip']), version)
    expect(installer).toMatchObject({ mode: 'restart', update: { name: 'Lexora-Buddy-1.2.3-windows-arm64.exe' } })
    expect(installed.resolve(release(['nsis'], 'x64'), version).mode).toBe('release')
    expect(portable.resolveCached([installer.update!])).toBeNull()
    expect(installed.resolveCached([plan.update!])).toBeNull()
  })

  it('rejects metadata from another host or architecture rather than guessing the installer format', () => {
    const metadata = { schemaVersion: 1, format: 'dmg', signing: 'developer-id', architecture: 'arm64' }
    expect(readDesktopDistribution(metadata, 'darwin', 'arm64')).toEqual(metadata)
    expect(readDesktopDistribution(metadata, 'win32', 'arm64')).toBeNull()
    expect(readDesktopDistribution(metadata, 'darwin', 'x64')).toBeNull()
    expect(readDesktopDistribution({ ...metadata, schemaVersion: 2 }, 'darwin', 'arm64')).toBeNull()
    expect(new DesktopUpdatePolicy(null).resolve(release(['dmg']), version).mode).toBe('release')
  })
})
