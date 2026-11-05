import { z } from 'zod'
import { imageOutputOptionsSchema } from '../images/imagePreferences'
import { inferenceHashSchema, inferenceIdSchema, inferenceImageModelSchema, inferenceProviderNameSchema } from './extensionInference'

export const extensionImageModelSchema = inferenceImageModelSchema.extend({
  extensionId: z.string().min(1).max(160),
  extensionName: z.string(),
  providerName: inferenceProviderNameSchema.optional(),
  revision: inferenceHashSchema,
  generation: z.uuid(),
  bindingRevision: inferenceHashSchema,
  managementPage: z.boolean(),
}).strict()
export type ExtensionImageModel = z.infer<typeof extensionImageModelSchema>
export const extensionImageRequestSchema = z.object({
  requestId: z.uuid(),
  model: inferenceIdSchema,
  operation: z.enum(['generate', 'edit']),
  prompt: z.string().trim().min(1).max(32768),
  images: z.array(z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string() }).strict()).max(16),
  output: imageOutputOptionsSchema,
}).strict().refine(value => (value.operation === 'edit') === (value.images.length > 0))
export type ExtensionImageRequest = z.infer<typeof extensionImageRequestSchema>
export const extensionImageEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('submitted'), requestId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('image'), index: z.number().int().min(0).max(3), sequence: z.number().int().nonnegative(), final: z.boolean(), mimeType: z.literal('image/png') }).strict(),
  z.object({ type: z.literal('done'), responseId: z.string().min(1).max(256).nullable() }).strict(),
  z.object({ type: z.literal('failed'), code: z.enum(['UNAVAILABLE', 'BUSY', 'RESOURCE_EXHAUSTED', 'UNSUPPORTED', 'FAILED']), retryable: z.boolean() }).strict(),
])
export type ExtensionImageEvent = z.infer<typeof extensionImageEventSchema>
export const extensionImageInvocationSchema = z.object({ id: z.uuid(), target: extensionImageModelSchema, request: extensionImageRequestSchema, parentInvocationId: z.uuid().optional() }).strict()
export const extensionImageRpc = { list: 'extensions.images.list', invoke: 'extensions.images.invoke', event: 'extensions.images.event' } as const
export const extensionImageLimits = { inputBytes: 32 * 1024 * 1024, outputBytes: 32 * 1024 * 1024 } as const
