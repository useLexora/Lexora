import type { ExtensionBuildResult } from '../../shared/extensions/extensionAuthoring'
import type { ExtensionCompiler } from './compileExtensionSource'
import { Buffer } from 'node:buffer'
import { zipSync } from 'fflate/browser'
import { extensionError } from '../../shared/extensions/extensionApi'
import { extensionBuildRequestSchema } from '../../shared/extensions/extensionAuthoring'
import { extensionManifestSchema } from '../../shared/extensions/extensionManifest'
import { EXTENSION_PACKAGE_INLINE_BYTES, validateExtensionArchiveSize } from '../../shared/extensions/extensionPackageBudget'
import { validateFileIconThemeFiles } from '../icons/fileIconThemeAssets'
import { validateThemeFiles } from '../themes/themeAssets'
import { unpackExtension, validateExtensionFiles } from './extensionFiles'
import { extensionIconUrl } from './extensionIcon'

export type ExtensionArchiveBuildResult = Omit<Extract<ExtensionBuildResult, { ok: true }>, 'archive'> & { archive: Uint8Array } | Extract<ExtensionBuildResult, { ok: false }>

export async function buildExtensionPackage(input: unknown, compile: ExtensionCompiler, signal: AbortSignal): Promise<ExtensionBuildResult> {
  try {
    const { archive } = extensionBuildRequestSchema.parse(input)
    const result = await buildExtensionArchive(Buffer.from(archive, 'base64'), compile, signal)
    if (!result.ok)
      return result
    if (result.archive.byteLength > EXTENSION_PACKAGE_INLINE_BYTES)
      return { ok: false, code: 'EXTENSION_ARCHIVE_REQUIRES_TRANSFER', diagnostics: result.diagnostics }
    return { ...result, archive: Buffer.from(result.archive).toString('base64') }
  }
  catch (error) {
    signal.throwIfAborted()
    return { ok: false, code: extensionError(error), diagnostics: [] }
  }
}

export async function buildExtensionArchive(archive: Uint8Array, compile: ExtensionCompiler, signal: AbortSignal): Promise<ExtensionArchiveBuildResult> {
  const diagnostics: string[] = []
  const report = (message: string) => {
    if (diagnostics.length < 30)
      diagnostics.push(message.slice(0, 600))
  }
  try {
    signal.throwIfAborted()
    const files = unpackExtension(archive)
    const result = extensionManifestSchema.safeParse(JSON.parse(new TextDecoder().decode(files.get('extension.json'))))
    if (!result.success) {
      for (const issue of result.error.issues) report(`${issue.path.join('.')}: ${issue.message}`)
      throw new Error('EXTENSION_MANIFEST_INVALID')
    }
    const manifest = result.data
    for (const entry of [manifest.entry, manifest.icon, ...manifest.contributes.views.map(view => view.entry)].filter((entry): entry is string => !!entry)) {
      if (!files.has(entry)) {
        report(`Missing file: ${entry}`)
        throw new Error('EXTENSION_ENTRY_MISSING')
      }
    }
    validateThemeFiles(files, manifest.contributes.themes)
    validateFileIconThemeFiles(files, manifest.contributes.iconThemes)
    extensionIconUrl(manifest.icon, manifest.icon ? files.get(manifest.icon) : undefined)
    const compiled = manifest.format === 'source' ? await compile(files, manifest, signal, report) : files
    signal.throwIfAborted()
    validateExtensionFiles(compiled)
    validateThemeFiles(compiled, manifest.contributes.themes)
    validateFileIconThemeFiles(compiled, manifest.contributes.iconThemes)
    const bytes = zipSync(Object.fromEntries(compiled), { level: 6 })
    validateExtensionArchiveSize(bytes.byteLength)
    return { ok: true, id: manifest.id, name: manifest.name, author: manifest.author ?? '', version: manifest.version, archive: bytes, diagnostics }
  }
  catch (error) {
    signal.throwIfAborted()
    return { ok: false, code: extensionError(error), diagnostics }
  }
}
