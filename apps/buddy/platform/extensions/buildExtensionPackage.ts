import type { ExtensionBuildResult } from '../../shared/extensions/extensionAuthoring'
import type { ExtensionCompiler } from './compileExtensionSource'
import { Buffer } from 'node:buffer'
import { zipSync } from 'fflate/browser'
import { extensionError } from '../../shared/extensions/extensionApi'
import { extensionBuildRequestSchema } from '../../shared/extensions/extensionAuthoring'
import { extensionManifestSchema } from '../../shared/extensions/extensionManifest'
import { unpackExtension, validateExtensionFiles } from './extensionFiles'
import { extensionIconUrl } from './extensionIcon'

export async function buildExtensionPackage(input: unknown, compile: ExtensionCompiler, signal: AbortSignal): Promise<ExtensionBuildResult> {
  const diagnostics: string[] = []
  const report = (message: string) => {
    if (diagnostics.length < 30)
      diagnostics.push(message.slice(0, 600))
  }
  try {
    signal.throwIfAborted()
    const { archive } = extensionBuildRequestSchema.parse(input)
    const files = unpackExtension(Buffer.from(archive, 'base64'))
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
    extensionIconUrl(manifest.icon, manifest.icon ? files.get(manifest.icon) : undefined)
    const compiled = manifest.format === 'source' ? await compile(files, manifest, signal, report) : files
    signal.throwIfAborted()
    validateExtensionFiles(compiled)
    const bytes = zipSync(Object.fromEntries(compiled), { level: 6 })
    return { ok: true, id: manifest.id, name: manifest.name, author: manifest.author ?? '', version: manifest.version, archive: Buffer.from(bytes).toString('base64'), diagnostics }
  }
  catch (error) {
    signal.throwIfAborted()
    return { ok: false, code: extensionError(error), diagnostics }
  }
}
