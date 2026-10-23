import type { FileOpeningLocation, FileOpeningProvider } from '../files/fileOpening'
import type { ExtensionManifest } from './extensionManifest'
import { z } from 'zod'
import { taskFileTargetSchema } from '../files/taskFileApi'
import { idSchema } from '../runtime/apiValidation'
import { spaceFileTargetSchema } from '../spaces/spaceFileApi'

export const extensionFileOpeningSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('space'), target: spaceFileTargetSchema }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: idSchema }).strict(),
  z.object({ kind: z.literal('task'), target: taskFileTargetSchema }).strict(),
])
export type ExtensionFileOpeningSource = z.infer<typeof extensionFileOpeningSourceSchema>

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
