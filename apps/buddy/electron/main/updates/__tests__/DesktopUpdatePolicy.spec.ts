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
    const unsigned = policy('dmg', 'ad-hoc').resolve(release(['dmg', 'zip']), version)
    expect(unsigned).toMatchObject({ mode: 'open-package', reason: 'signature-required', update: { name: 'Lexora-Buddy-1.2.3-macos-arm64.dmg' } })
    const signed = policy('dmg', 'developer-id')
    expect(signed.resolve(release(['dmg', 'zip']), version)).toMatchObject({ mode: 'restart', reason: null, update: { name: 'Lexora-Buddy-1.2.3-macos-arm64.zip' }, fallback: { name: 'Lexora-Buddy-1.2.3-macos-arm64.dmg' } })
    expect(signed.resolve(release(['dmg']), version)).toMatchObject({ mode: 'open-package', reason: 'asset-unavailable' })
    expect(signed.resolve(release(['zip']), version)).toMatchObject({ mode: 'release', update: null })
    expect(signed.resolve(release([]), version)).toMatchObject({ mode: 'release', update: null })
  })

  it.each(['deb', 'rpm', 'pacman'] as const)('keeps %s installation under the system package manager', (format) => {
    const delivery = policy(format).resolve(release([format, 'nsis']), version)
    expect(delivery.mode).toBe('open-package')
    expect(delivery.reason).toBe('system-package')
    expect(delivery.update?.name).toBe(desktopUpdateArtifactName(format, 'arm64', version))
    expect(policy(format).capabilities).toEqual({ download: true, install: false })
  })

  it('degrades Windows without a qualified asset and unknown distributions to the release page', () => {
    expect(policy('nsis').resolve(release(['nsis']), version).mode).toBe('restart')
    expect(policy('nsis').resolve(release(['nsis'], 'x64'), version).mode).toBe('release')
    expect(new DesktopUpdatePolicy(null).resolve(release(['dmg']), version).mode).toBe('release')
  })

  it('rejects metadata from another host or architecture rather than guessing the installer format', () => {
    const metadata = { schemaVersion: 1, format: 'dmg', signing: 'developer-id', architecture: 'arm64' }
    expect(readDesktopDistribution(metadata, 'darwin', 'arm64')).toEqual(metadata)
    expect(readDesktopDistribution(metadata, 'win32', 'arm64')).toBeNull()
    expect(readDesktopDistribution(metadata, 'darwin', 'x64')).toBeNull()
    expect(readDesktopDistribution({ ...metadata, schemaVersion: 2 }, 'darwin', 'arm64')).toBeNull()
  })
})
