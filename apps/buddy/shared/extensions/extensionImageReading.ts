import { z } from 'zod'
import { imageReadingLimits } from '../images/ocrService'
import { inferenceHashSchema, inferenceIdSchema, inferenceImageReaderSchema, inferenceProviderNameSchema } from './extensionInference'

export const extensionImageReaderSchema = inferenceImageReaderSchema.extend({
  extensionId: z.string().min(1).max(160),
  extensionName: z.string(),
  providerName: inferenceProviderNameSchema.optional(),
  revision: inferenceHashSchema,
  generation: z.uuid(),
  bindingRevision: inferenceHashSchema,
  managementPage: z.boolean(),
}).strict()
export type ExtensionImageReader = z.infer<typeof extensionImageReaderSchema>
export { imageReadingLimits } from '../images/ocrService'
const imageReadingRequestSchema = z.object({
  requestId: z.uuid(),
  model: inferenceIdSchema,
  question: z.string().max(8192),
  image: z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string() }).strict(),
}).strict()
export const extensionImageReadingRequestSchema = z.discriminatedUnion('operation', [
  imageReadingRequestSchema.extend({ operation: z.enum(['understand', 'document']), currentUserRequest: z.string().max(imageReadingLimits.inputBytes).optional() }),
  imageReadingRequestSchema.extend({ operation: z.literal('extract') }),
])
export const extensionImageReadingInvocationSchema = z.object({
  id: z.uuid(),
  target: extensionImageReaderSchema,
  request: extensionImageReadingRequestSchema,
  parentInvocationId: z.uuid().optional(),
}).strict()
export const extensionImageReadingEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), sequence: z.number().int().nonnegative(), text: z.string().max(16384) }).strict(),
  z.object({ type: z.literal('done') }).strict(),
  z.object({ type: z.literal('failed'), code: z.enum(['UNAVAILABLE', 'BUSY', 'UNSUPPORTED', 'FAILED']), retryable: z.boolean() }).strict(),
])
export const extensionImageReadingResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), text: z.string().max(imageReadingLimits.textBytes) }).strict(),
  z.object({ status: z.literal('failed'), retryable: z.boolean() }).strict(),
])
export const extensionImageReadingRpc = { list: 'extensions.imageReading.list', invoke: 'extensions.imageReading.invoke' } as const
