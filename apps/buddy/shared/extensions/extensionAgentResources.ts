import { z } from 'zod'
import { extensionLocalFileSchema } from './extensionResources.ts'

export const EXTENSION_ARTIFACT_BYTES_LIMIT = 64 * 1024 * 1024
export const EXTENSION_IMAGE_BYTES_LIMIT = 8 * 1024 * 1024
export const extensionAgentResourceRequestSchema = z.object({
  invocationId: z.string().uuid(),
  extensionId: z.string(),
  resourceId: z.string().uuid(),
  offset: z.number().int().min(0).max(EXTENSION_ARTIFACT_BYTES_LIMIT),
  length: z.number().int().min(1).max(64 * 1024),
}).strict()
export type ExtensionAgentResourceRequest = z.infer<typeof extensionAgentResourceRequestSchema>
export const extensionAgentResourceResponseSchema = z.object({
  resource: extensionLocalFileSchema,
  base64: z.string().max(90_000),
  size: z.number().int().min(0).max(EXTENSION_ARTIFACT_BYTES_LIMIT),
  eof: z.boolean(),
}).strict()
export type ExtensionAgentResourceResponse = z.infer<typeof extensionAgentResourceResponseSchema>
export const extensionAgentPublishedArtifactSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(255), mimeType: z.string().max(80), size: z.number().int().min(0).max(EXTENSION_ARTIFACT_BYTES_LIMIT) }).strict()
export const extensionAgentPrivateResourceSchema = z.object({ id: z.string().uuid() }).strict()
export const extensionArtifactNameSchema = z.string().trim().min(1).max(255).refine(value => [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) && !/[<>:"/\\|?*]/.test(value) && !/^\.+$/.test(value) && !/[. ]$/.test(value))
