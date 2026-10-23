import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { zipSync } from 'fflate/browser'
import { extensionManifestSchema, extensionPackageManifest } from '../../shared/extensions/extensionManifest.ts'
import { validateExtensionArchiveSize, validateExtensionFiles } from '../../shared/extensions/extensionPackageBudget.ts'
import { validateFileIconThemeFiles } from '../icons/fileIconThemeAssets.ts'
import { validateThemeFiles } from '../themes/themeAssets.ts'
import { compileExtensionSource } from './compileExtensionSource.ts'
import { extensionIconUrl } from './extensionIcon.ts'
import { readExtensionDirectory } from './extensionPackageFiles.ts'

export async function readExtensionPackage(source: string) {
  const files = await readExtensionDirectory(source)
  const manifest = extensionManifestSchema.parse(JSON.parse(new TextDecoder().decode(files.get('extension.json'))))
  for (const entry of [manifest.entry, ...manifest.contributes.views.map(view => view.entry)].filter((entry): entry is string => !!entry))
    assert(files.has(entry), `Missing entry: ${entry}`)
  validateThemeFiles(files, manifest.contributes.themes)
  validateFileIconThemeFiles(files, manifest.contributes.iconThemes)
  const iconUrl = extensionIconUrl(manifest.icon, manifest.icon ? files.get(manifest.icon) : undefined)
  return { manifest, files, iconUrl }
}

export async function buildExtensionDirectory(source: string, destination: string, report: (message: string) => void = () => {}) {
  source = path.resolve(source)
  destination = path.resolve(destination)
  assert(source !== destination && !source.startsWith(`${destination}${path.sep}`), 'Output must not contain source')
  const { files, manifest } = await readExtensionPackage(source)
  const result = manifest.format === 'source' ? await compileExtensionSource(files, manifest, report) : files
  if (manifest.format !== 'source')
    result.set('extension.json', new TextEncoder().encode(JSON.stringify(extensionPackageManifest(manifest))))
  validateExtensionFiles(result)
  const old = await fs.readdir(destination).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
  if (old.length)
    assert(JSON.parse(await fs.readFile(path.join(destination, 'extension.json'), 'utf8')).id === manifest.id, 'Output belongs to another plugin')
  await fs.rm(destination, { recursive: true, force: true })
  for (const [name, bytes] of result) {
    await fs.mkdir(path.dirname(path.join(destination, name)), { recursive: true })
    await fs.writeFile(path.join(destination, name), bytes)
  }
  return extensionManifestSchema.parse(JSON.parse(new TextDecoder().decode(result.get('extension.json'))))
}

export async function packExtensionDirectory(source: string, destination: string, { license }: { license?: Uint8Array } = {}) {
  const { files, manifest, iconUrl } = await readExtensionPackage(source)
  if (license && !files.has('LICENSE'))
    files.set('LICENSE', license)
  const packageManifest = extensionPackageManifest(manifest)
  files.set('extension.json', new TextEncoder().encode(JSON.stringify(packageManifest)))
  validateExtensionFiles(files)
  const bytes = zipSync(Object.fromEntries(files), { level: 6, mtime: new Date('2020-01-01T00:00:00Z') })
  validateExtensionArchiveSize(bytes.byteLength)
  await fs.mkdir(path.dirname(path.resolve(destination)), { recursive: true })
  await fs.writeFile(destination, bytes)
  return { manifest: packageManifest, iconUrl, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}
