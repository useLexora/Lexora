import type { ModelMetadataCatalog } from './ModelsDevCatalog'
import { createHash } from 'node:crypto'
import { serializeModelMetadata } from './modelMetadata'

export const MODEL_RESOLUTION_VERSION = 1

export function modelResolutionFingerprint(value: unknown): string {
  return createHash('sha256').update(serializeModelMetadata(value)).digest('hex')
}

export function modelCatalogFingerprint(catalog: ModelMetadataCatalog): string {
  return modelResolutionFingerprint({
    mediaModels: [...catalog.getMediaModels?.() ?? []].sort(compareModels),
    providers: [...catalog.getProviders()].sort((a, b) => a.id.localeCompare(b.id)),
    models: [...catalog.getModels()].sort(compareModels),
  })
}

function compareModels(a: { provider: string, id: string }, b: { provider: string, id: string }): number {
  return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)
}
