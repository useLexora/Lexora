import { Buffer } from 'node:buffer'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
import { BUILTIN_FILE_ICON_THEME } from '../../../shared/icons/fileIconTheme'
import { validateExtensionFileCounts } from '../../extensions/extensionLimits'
import { ExtensionPackageStore } from '../../extensions/ExtensionPackageStore'
import { fileIconAssetPaths, readFileIconTheme, validateFileIconThemeFiles } from '../fileIconThemeAssets'
import { FileIconThemeService } from '../FileIconThemeService'

const contribution = { id: 'test.icons.palette', label: 'Palette', path: 'theme/icons.json' }
const document = { iconDefinitions: { file: { iconPath: '../assets/file.svg' } }, file: 'file', folder: 'file' }
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#cba6f7" d="M2 2h12v12H2z"/></svg>'
function files(version = '1.0.0') {
  return new Map([
    ['extension.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'test.icons', name: 'Test icons', version, apiVersion: 3, engines: { lexora: '*' }, contributes: { iconThemes: [contribution] } }))],
    [contribution.path, Buffer.from(JSON.stringify(document))],
    ['assets/file.svg', Buffer.from(svg)],
  ])
}
async function fixture() {
  const home = await createTemporaryDirectory('file-icon-theme-')
  const store = new ExtensionPackageStore(home, '0.11.0')
  await store.install((await store.reviewFiles(files())).token)
  let preference = { id: BUILTIN_FILE_ICON_THEME }
  const service = new FileIconThemeService(async (next, guard) => {
    guard()
    preference = { ...next }
  })
  const packages = () => [{ package: store.installed['test.icons']!.current, root: store.packageRoot(store.installed['test.icons']!.current) }]
  await service.refresh(packages())
  const select = () => service.request({ action: 'preference', preference: { id: contribution.id } }, () => {})
  return { service, store, select, packages, preference: () => preference }
}

describe('file icon theme packages and lifecycle', () => {
  it('loads a declarative package on selection and revokes URLs when disabled or replaced', async () => {
    const { service, select, packages, preference } = await fixture()
    expect(service.snapshot.active).toBeNull()
    await select()
    const url = service.snapshot.active!.urls.file!
    expect(new TextDecoder().decode((await service.asset(url))!.bytes)).toBe(svg)
    expect(await service.asset(url.replace('/file', '/unknown'))).toBeNull()
    await service.refresh([])
    expect(await service.asset(url)).toBeNull()
    expect(service.snapshot.unavailable).toBe(contribution.id)
    expect(preference().id).toBe(contribution.id)
    await service.refresh(packages())
    expect(service.snapshot.active!.urls.file).not.toBe(url)
    expect(await service.asset(url)).toBeNull()
    expect(service.snapshot.unavailable).toBeNull()
    service.dispose()
  })

  it('rejects altered package bytes on demand and retains the selected preference', async () => {
    const { service, select, packages, preference } = await fixture()
    await select()
    const url = service.snapshot.active!.urls.file!
    await writeFile(join(packages()[0]!.root, 'assets/file.svg'), '<svg/>')
    expect(await service.asset(url)).toBeNull()
    expect(service.snapshot.active).toBeNull()
    expect(service.snapshot.unavailable).toBe(contribution.id)
    expect(preference().id).toBe(contribution.id)
    service.dispose()
  })

  it('keeps pending updates inactive and revokes cached assets when a new version becomes current', async () => {
    const { service, store, select, packages } = await fixture()
    await select()
    const oldUrl = service.snapshot.active!.urls.file!
    await service.asset(oldUrl)
    const updated = files('1.1.0')
    const nextSvg = svg.replace('#cba6f7', '#8839ef')
    updated.set('assets/file.svg', Buffer.from(nextSvg))
    await store.install((await store.reviewFiles(updated)).token)
    await service.refresh(packages())
    expect(service.snapshot.active!.urls.file).toBe(oldUrl)
    await store.promote('test.icons')
    await service.refresh(packages())
    const nextUrl = service.snapshot.active!.urls.file!
    expect(nextUrl).not.toBe(oldUrl)
    expect(await service.asset(oldUrl)).toBeNull()
    expect(new TextDecoder().decode((await service.asset(nextUrl))!.bytes)).toBe(nextSvg)
    const pending = service.asset(nextUrl)
    service.dispose()
    expect(await pending).toBeNull()
  })

  it('does not publish a late theme load after it has been deselected', async () => {
    const { service, packages } = await fixture()
    service.applyPreference({ id: contribution.id })
    service.applyPreference({ id: BUILTIN_FILE_ICON_THEME })
    await service.refresh(packages())
    expect(service.snapshot.preference.id).toBe(BUILTIN_FILE_ICON_THEME)
    expect(service.snapshot.active).toBeNull()
    service.dispose()
  })

  it('accepts relative package images and rejects traversal, missing images and unsupported definitions', () => {
    validateFileIconThemeFiles(files(), [contribution])
    for (const path of ['../../../outside.svg', '/outside.svg', 'https://example.com/a.svg', 'file:///a.svg', '..\\outside.svg', '../script.js']) {
      expect(() => fileIconAssetPaths(contribution.path, { ...document, iconDefinitions: { file: { iconPath: path } } })).toThrow()
    }
    expect(() => validateFileIconThemeFiles(new Map([[contribution.path, Buffer.from(JSON.stringify(document))]]), [contribution])).toThrow('EXTENSION_ICON_THEME_ASSET_INVALID')
    expect(() => readFileIconTheme(Buffer.from(JSON.stringify({ iconDefinitions: { file: { fontCharacter: 'x' } }, file: 'file' })))).toThrow('EXTENSION_ICON_THEME_DOCUMENT_INVALID')
  })

  it('allows bounded image collections while preserving the non-image file limit', () => {
    expect(() => validateExtensionFileCounts([...Array.from({ length: 700 }, (_, i) => `${i}.svg`), 'extension.json'])).not.toThrow()
    expect(() => validateExtensionFileCounts(Array.from({ length: 513 }, (_, i) => `${i}.js`))).toThrow('EXTENSION_PACKAGE_LIMIT')
    expect(() => validateExtensionFileCounts(Array.from({ length: 4097 }, (_, i) => `${i}.svg`))).toThrow('EXTENSION_PACKAGE_LIMIT')
  })
})
