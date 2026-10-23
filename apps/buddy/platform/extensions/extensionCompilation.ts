import type { ExtensionManifest } from '../../shared/extensions/extensionManifest'
import { isDeepStrictEqual } from 'node:util'
import { extensionManifestSchema } from '../../shared/extensions/extensionManifest'
import { EXTENSION_UNO_STYLESHEET } from '../../shared/extensions/extensionStyles'
import { sha256, validateExtensionFiles } from './extensionFiles'

export function prepareExtensionCompilation(files: ReadonlyMap<string, Uint8Array>, manifest: ExtensionManifest) {
  validateExtensionFiles(files)
  const input = new Map<string, Uint8Array>()
  const retained = new Map<string, { bytes: Uint8Array, hash: string }>()
  const outputs = new Set<string>(['extension.json'])
  if (manifest.styles?.uno)
    outputs.add(EXTENSION_UNO_STYLESHEET)
  for (const [name, bytes] of files) {
    const declaration = /\.d\.[cm]?ts$/.test(name)
    const text = !declaration && (/\.(?:js|mjs|ts|mts)$/.test(name) || (manifest.styles?.uno && /\.(?:[cm]?[jt]s|html)$/.test(name)))
    input.set(name, text ? bytes : new Uint8Array())
    if (!declaration && name !== 'extension.json') {
      outputs.add(name.replace(/\.(?:ts|mts)$/, '.js'))
      if (!text)
        retained.set(name, { bytes, hash: sha256(bytes) })
    }
  }
  return { input, retained, outputs }
}

export function completeExtensionCompilation(prepared: ReturnType<typeof prepareExtensionCompilation>, compiled: Map<string, Uint8Array>, original: ExtensionManifest): Map<string, Uint8Array> {
  validateExtensionFiles(compiled)
  if (compiled.size !== prepared.outputs.size || [...compiled.keys()].some(name => !prepared.outputs.has(name)))
    throw new Error('EXTENSION_COMPILE_OUTPUT_INVALID')
  const manifest = extensionManifestSchema.parse(JSON.parse(new TextDecoder().decode(compiled.get('extension.json'))))
  const expected = { ...original, format: 'compiled', ...(original.entry ? { entry: original.entry.replace(/\.(?:ts|mts)$/, '.js') } : {}), contributes: { ...original.contributes, views: original.contributes.views.map(view => ({ ...view, entry: view.entry.replace(/\.(?:ts|mts)$/, '.js') })) } }
  if (!isDeepStrictEqual(manifest, expected))
    throw new Error('EXTENSION_COMPILE_OUTPUT_INVALID')
  for (const [name, retained] of prepared.retained) {
    if (compiled.get(name)?.byteLength !== 0 || sha256(retained.bytes) !== retained.hash)
      throw new Error('EXTENSION_COMPILE_OUTPUT_INVALID')
    compiled.set(name, retained.bytes)
  }
  validateExtensionFiles(compiled)
  return compiled
}
