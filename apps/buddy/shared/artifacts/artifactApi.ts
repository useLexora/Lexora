import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema, isAbsolutePath, timestampSchema } from '../runtime/apiValidation'

export const artifactSchema = z.object({
  artifactId: idSchema,
  conversationId: idSchema,
  createdAt: timestampSchema,
  kind: z.enum(['file', 'directory']),
  mimeType: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1).max(32_768),
  previewUrl: z.string().nullable(),
  runId: idSchema,
  sizeBytes: z.number().int().nonnegative(),
  sourceArtifactId: idSchema.nullable(),
  sourceToolCallId: idSchema,
  updatedAt: timestampSchema,
}).strict()

export const artifactTextSchema = z.object({
  artifactId: idSchema,
  language: z.string().max(64).nullable(),
  text: z.string().max(2 * 1024 * 1024),
}).strict()

export type LocalArtifact = DeepReadonly<z.infer<typeof artifactSchema>>

export type LocalArtifactText = DeepReadonly<z.infer<typeof artifactTextSchema>>

export const artifactsRequestSchemas = {
  artifactPreview: z.object({ artifactId: idSchema }).strict(),
  artifactText: z.object({ artifactId: idSchema }).strict(),
} as const

export const artifactsResponseSchemas = {
  artifactPreview: z.object({
    mimeType: z.string().regex(/^image\//),
    path: z.string().refine(isAbsolutePath),
  }).strict(),
  artifactText: artifactTextSchema,
} as const

export const artifactsRpc = {
  readText: { method: 'artifacts.readText', input: artifactsRequestSchemas.artifactText, response: artifactsResponseSchemas.artifactText },
} as const satisfies Record<string, RuntimeRequestContract>

export const artifactChangeNoticeSchema = z.object({
  sourceId: z.uuid(),
  revision: z.number().int().positive(),
  conversationId: idSchema,
}).strict()

export type ArtifactChangeNotice = z.infer<typeof artifactChangeNoticeSchema>
export const artifactsChanged = { method: 'artifacts.changed', params: artifactChangeNoticeSchema } as const

export function isTextArtifactMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || [
    'application/json',
    'application/toml',
    'application/xml',
    'application/yaml',
  ].includes(mimeType)
}
