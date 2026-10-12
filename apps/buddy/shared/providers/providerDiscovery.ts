import { z } from 'zod'

export const discoveredModelMetadataSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  input: z.array(z.enum(['text', 'image', 'pdf', 'audio', 'video'])).min(1).optional(),
  reasoningOptions: z.array(z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/u)).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
}).strict().refine(value => value.contextWindow === undefined || value.maxTokens === undefined || value.maxTokens <= value.contextWindow)

export type DiscoveredModelMetadata = z.infer<typeof discoveredModelMetadataSchema>

export const serviceModelMetadataSchema = z.object({
  api: z.string().min(1),
  baseUrl: z.url(),
  metadata: discoveredModelMetadataSchema,
}).strict()
export type ServiceModelMetadata = z.infer<typeof serviceModelMetadataSchema>

export function modelDiscoveryBaseUrl(value: string): string {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/u, '')
  return url.href
}
