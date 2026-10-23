import type { FileOpeningLocation, FileOpeningProvider } from '../files/fileOpening'
import type { ExtensionManifest } from './extensionManifest'

type FileHandler = ExtensionManifest['contributes']['fileHandlers'][number]

export function extensionFileHandlerBindings(handler: FileHandler) {
  const targets = [['inline', handler.preview], ['standalone', handler.open]] as const
  return targets.flatMap(([location, target]): { location: FileOpeningLocation, view: string, requestDefault: boolean }[] => target ? [{ location, ...target }] : [])
}

export function extensionFileOpeningProviders(manifest: ExtensionManifest, available: boolean): FileOpeningProvider[] {
  return manifest.contributes.fileHandlers.map(handler => ({
    id: handler.id,
    title: handler.title,
    extensions: handler.extensions,
    locations: extensionFileHandlerBindings(handler).map(target => target.location),
    builtin: false,
    available,
    renderer: 'extension',
    extensionId: manifest.id,
    extensionName: manifest.name,
    viewTypes: Object.fromEntries(extensionFileHandlerBindings(handler).map(target => [target.location, target.view])),
  }))
}
