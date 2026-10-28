import type { ExtensionManifest } from '../../shared/extensions/extensionManifest'
import type { ExtensionPackage } from './extensionState'
import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ExtensionCompatibilityError, extensionCompatibilityIssue } from '../../shared/extensions/extensionCompatibility'
import { extensionManifestSchema, extensionMetadataSchema } from '../../shared/extensions/extensionManifest'
import { EXTENSION_UNO_STYLESHEET } from '../../shared/extensions/extensionStyles'
import { validateFileIconThemeFiles } from '../icons/fileIconThemeAssets'
import { validateThemeFiles } from '../themes/themeAssets'
import { completeExtensionCompilation, prepareExtensionCompilation } from './extensionCompilation'
import { EXTENSION_ARCHIVE_LIMIT, readExtensionDirectory, readExtensionFile, sha256, unpackExtension, validateExtensionFiles } from './extensionFiles'
import { extensionIconUrl } from './extensionIcon'
import { validateExtensionSkillFiles } from './extensionSkillAssets'

export interface ReviewedExtensionPackage {
  files: Map<string, Uint8Array>
  manifest: ExtensionManifest
  hashes: Record<string, string>
  revision: string
  iconUrl: string | undefined
}

export interface ExtensionPackageRequests {
  read: { kind: 'read', path: string, development: boolean, appVersion: string }
  unpack: { kind: 'unpack', bytes: Uint8Array, appVersion: string }
  inspect: { kind: 'inspect', files: Map<string, Uint8Array>, appVersion: string }
  verify: { kind: 'verify', files: Map<string, Uint8Array>, hashes: Record<string, string> }
  stage: { kind: 'stage', files: Map<string, Uint8Array>, hashes: Record<string, string>, directory: string }
  existing: { kind: 'existing', directory: string, package: ExtensionPackage }
  compile: { kind: 'compile', files: Map<string, Uint8Array>, manifest: ExtensionManifest }
  hash: { kind: 'hash', bytes: Uint8Array }
}

export interface ExtensionPackageResults {
  read: ReviewedExtensionPackage
  unpack: ReviewedExtensionPackage
  inspect: ReviewedExtensionPackage
  verify: void
  stage: void
  existing: void
  compile: Map<string, Uint8Array>
  hash: string
}

export type ExtensionPackageTask = keyof ExtensionPackageRequests
export type ExtensionPackageProcessor = <R extends ExtensionPackageRequests[ExtensionPackageTask]>(request: R, signal?: AbortSignal, report?: (message: string) => void) => Promise<ExtensionPackageResults[R['kind']]>

function hashesFor(files: Map<string, Uint8Array>): Record<string, string> {
  validateExtensionFiles(files)
  return Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, sha256(bytes)]))
}

function verify(files: Map<string, Uint8Array>, expected: Record<string, string>): void {
  if (!isDeepStrictEqual(hashesFor(files), expected))
    throw new Error('EXTENSION_PACKAGE_CHANGED')
}

function inspect(files: Map<string, Uint8Array>, appVersion: string): ReviewedExtensionPackage {
  validateExtensionFiles(files)
  let manifest: ExtensionManifest
  try {
    const raw = JSON.parse(Buffer.from(files.get('extension.json') ?? []).toString('utf8'))
    const metadata = extensionMetadataSchema.parse(raw)
    const issue = extensionCompatibilityIssue(metadata, appVersion)
    if (issue)
      throw new ExtensionCompatibilityError(metadata, issue)
    manifest = extensionManifestSchema.parse(raw)
  }
  catch (error) {
    if (error instanceof ExtensionCompatibilityError)
      throw error
    throw new Error('EXTENSION_MANIFEST_INVALID')
  }
  for (const entry of [manifest.entry, ...manifest.contributes.views.map(view => view.entry)]) {
    if (entry && (!files.has(entry) || !(manifest.format === 'source' ? /\.m?[jt]s$/.test(entry) : /\.m?js$/.test(entry))))
      throw new Error('EXTENSION_ENTRY_MISSING')
  }
  if (manifest.format === 'compiled' && manifest.styles?.uno && !files.has(EXTENSION_UNO_STYLESHEET))
    throw new Error('EXTENSION_STYLES_MISSING')
  validateThemeFiles(files, manifest.contributes.themes)
  validateFileIconThemeFiles(files, manifest.contributes.iconThemes)
  validateExtensionSkillFiles(files, manifest.contributes.skills)
  const hashes = hashesFor(files)
  return { files, manifest, hashes, revision: sha256(JSON.stringify(hashes)), iconUrl: extensionIconUrl(manifest.icon, manifest.icon ? files.get(manifest.icon) : undefined) }
}

async function processPackage(request: ExtensionPackageRequests[ExtensionPackageTask], signal?: AbortSignal, report: (message: string) => void = () => {}): Promise<ExtensionPackageResults[ExtensionPackageTask]> {
  signal?.throwIfAborted()
  switch (request.kind) {
    case 'read': {
      const files = request.development ? await readExtensionDirectory(request.path) : unpackExtension(await readExtensionFile(request.path, EXTENSION_ARCHIVE_LIMIT))
      signal?.throwIfAborted()
      return inspect(files, request.appVersion)
    }
    case 'unpack': return inspect(unpackExtension(request.bytes), request.appVersion)
    case 'inspect': return inspect(request.files, request.appVersion)
    case 'verify': return verify(request.files, request.hashes)
    case 'hash': return sha256(request.bytes)
    case 'existing': {
      const files = await readExtensionDirectory(request.directory)
      const hashes = hashesFor(files)
      if (!isDeepStrictEqual(hashes, request.package.hashes) || sha256(JSON.stringify(hashes)) !== request.package.revision)
        throw new Error('EXTENSION_PACKAGE_CHANGED')
      return
    }
    case 'stage': {
      verify(request.files, request.hashes)
      for (const [name, content] of request.files) {
        signal?.throwIfAborted()
        const bytes = Buffer.from(content)
        if (sha256(bytes) !== request.hashes[name])
          throw new Error('EXTENSION_PACKAGE_CHANGED')
        const path = join(request.directory, name)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600, flush: true })
      }
      return
    }
    case 'compile': {
      const prepared = prepareExtensionCompilation(request.files, request.manifest)
      const { compileExtensionSource } = await import('./compileExtensionSource')
      const compiled = await compileExtensionSource(prepared.input, request.manifest, report)
      signal?.throwIfAborted()
      return completeExtensionCompilation(prepared, compiled, request.manifest)
    }
  }
}

export const processExtensionPackage = processPackage as ExtensionPackageProcessor
