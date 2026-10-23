import type { SpaceFileTarget } from '../spaces/spaceFileApi'
import type { TaskFileTarget } from './taskFileApi'
import { z } from 'zod'
import { isAbsolutePath } from '../runtime/apiValidation'
import { isImageMimeType, mediaKindForMimeType } from './fileMimeTypes'

export const mediaPreviewLocationSchema = z.object({
  path: z.string().refine(isAbsolutePath),
  root: z.string().refine(isAbsolutePath),
  mimeType: z.string().refine(value => isImageMimeType(value) || mediaKindForMimeType(value) !== null),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  identity: z.string().min(1).max(512),
}).strict()

export type MediaPreviewLocation = z.infer<typeof mediaPreviewLocationSchema>

export function mediaFileIdentity(metadata: { dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint }): string {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':')
}

export function taskFileMediaUrl(target: TaskFileTarget): string {
  return `lexora-file://task-media/?${new URLSearchParams(target)}`
}

export function spaceFileMediaUrl(target: SpaceFileTarget): string {
  const query = new URLSearchParams({
    spaceId: target.spaceId,
    directoryId: target.directoryId,
    revision: String(target.revision),
    path: target.path,
  })
  return `lexora-file://media/?${query}`
}
