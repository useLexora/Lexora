import { z } from 'zod'
import { inferenceDiagnosticSchema } from '../diagnostics/inferenceDiagnostic.ts'
import { imageReadingSupportSchema, imageSupportSchema } from '../images/imagePreferences.ts'
import { modelCatalogReferenceSchema } from '../providers/providerCatalog.ts'
import { extensionPathSchema } from './extensionPath.ts'

export const inferencePlatformSchema = z.enum(['linux-x64', 'windows-x64', 'macos-arm64'])
export type InferencePlatform = z.infer<typeof inferencePlatformSchema>
export interface InferenceEnvironment {
  platform: InferencePlatform | null
  executionMode: 'isolated' | 'supervised' | 'unsupported'
  hardware?: InferenceHardware
}

const memoryBytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const inferenceHardwareSchema = z.object({
  sampledAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  logicalCores: z.number().int().positive().max(65536),
  totalMemoryBytes: memoryBytes,
  availableMemoryBytes: memoryBytes.optional(),
  gpus: z.array(z.object({
    name: z.string().trim().min(1).max(256),
    vendor: z.enum(['nvidia', 'amd', 'intel', 'apple', 'unknown']),
    totalMemoryBytes: memoryBytes.optional(),
    availableMemoryBytes: memoryBytes.optional(),
  }).strip()).max(16),
}).strip()
export type InferenceHardware = z.infer<typeof inferenceHardwareSchema>
export const inferenceObservationSchema = inferenceDiagnosticSchema.pick({
  engine: true,
  backend: true,
  device: true,
  architecture: true,
  context: true,
  offload: true,
  degraded: true,
  loadMs: true,
  timings: true,
  prompt: true,
  decode: true,
  error: true,
}).extend({ observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
export type InferenceObservation = z.infer<typeof inferenceObservationSchema>

export const inferenceIdSchema = z.string().min(1).max(80).regex(/^[a-z][a-z0-9.-]*$/)
export const inferenceProviderNameSchema = z.string().trim().min(1).max(100)
export const inferenceRuntimeReferenceSchema = z.object({ runtime: inferenceIdSchema }).strict()
export const inferenceHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const inferenceResourcePathSchema = z.string().min(1).max(1024).refine(value => value.split('/').every(part => part && part !== '.' && part !== '..' && !/[<>:"\\|?*]/.test(part) && [...part].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && new TextEncoder().encode(part).byteLength <= 255), 'Invalid resource path')
export const inferenceCapabilitySchema = z.object({
  id: inferenceIdSchema,
  title: z.string().min(1).max(100),
  kind: z.enum(['speech.transcribe', 'speech.synthesize', 'chat.completion', 'image.generate', 'image.read']),
  runtime: inferenceIdSchema,
  streamingInput: z.boolean().default(false),
  streamingOutput: z.boolean().default(false),
}).strict()
export const inferenceRuntimeSchema = z.object({
  id: inferenceIdSchema,
  entry: extensionPathSchema.refine(value => /^native\/.+\.mjs$/.test(value), 'Expected a compiled native/*.mjs entry'),
  platforms: z.array(inferencePlatformSchema).min(1).max(3).refine(value => new Set(value).size === value.length, 'Duplicate inference platform'),
  gpu: z.boolean().default(false),
  capacity: z.number().int().min(1).max(4).default(1),
  idleTimeoutMs: z.number().int().min(0).max(3600000).optional(),
}).strict()
export const inferenceContributionSchema = z.object({
  providerName: inferenceProviderNameSchema.optional(),
  preparation: inferenceRuntimeSchema.pick({ entry: true, platforms: true }).optional(),
  runtimes: z.array(inferenceRuntimeSchema).min(1).max(8),
  capabilities: z.array(inferenceCapabilitySchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  const runtimes = new Set(value.runtimes.map(runtime => runtime.id))
  if (runtimes.size !== value.runtimes.length || new Set(value.capabilities.map(item => item.id)).size !== value.capabilities.length)
    context.addIssue({ code: 'custom', message: 'Duplicate inference contribution' })
  if (value.capabilities.some(item => !runtimes.has(item.runtime)))
    context.addIssue({ code: 'custom', message: 'Unknown inference runtime' })
})
export const inferenceResourceFileSchema = z.object({
  path: inferenceResourcePathSchema,
  sha256: inferenceHashSchema,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  executable: z.boolean().optional(),
  source: z.union([
    z.object({ url: z.url().max(4096) }).strict(),
    z.object({ resourceId: z.uuid(), reference: z.boolean().default(false) }).strict(),
    z.object({ directoryId: z.uuid(), path: inferenceResourcePathSchema, reference: z.literal(true) }).strict(),
  ]),
}).strict()
export const inferencePreparationSchema = z.object({
  inputs: z.array(z.object({
    id: inferenceIdSchema,
    sha256: inferenceHashSchema,
    size: z.number().int().positive().max(16 * 1024 ** 3),
    source: z.union([z.object({ url: z.url().max(4096) }).strict(), z.object({ resourceId: z.uuid() }).strict()]),
  }).strict()).min(1).max(16),
  options: z.json().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 1024 * 1024, 'Preparation options too large'),
  maxBytes: z.number().int().positive().max(64 * 1024 ** 3),
  maxFiles: z.number().int().positive().max(4096),
}).strict().refine(value => new Set(value.inputs.map(input => input.id)).size === value.inputs.length, 'Duplicate preparation input')
export const inferencePrepareSchema = z.object({
  id: inferenceIdSchema,
  kind: z.enum(['engine', 'model']),
  files: z.array(inferenceResourceFileSchema).max(4096),
  preparation: inferencePreparationSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.preparation ? value.files.length : !value.files.length)
    context.addIssue({ code: 'custom', message: 'Use direct files or plugin preparation' })
  const paths = new Set(value.files.map(file => file.path.toLowerCase()))
  if (paths.size !== value.files.length || value.files.some(file => file.path.split('/').slice(0, -1).some((_, index, parts) => paths.has(parts.slice(0, index + 1).join('/').toLowerCase()))))
    context.addIssue({ code: 'custom', message: 'Conflicting resource paths' })
})
export const inferencePreparedFileEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: inferenceResourcePathSchema, size: z.number().int().min(0).max(64 * 1024 ** 3), executable: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('chunk') }).strict(),
  z.object({ type: z.literal('alias'), path: inferenceResourcePathSchema, target: inferenceResourcePathSchema }).strict(),
  z.object({ type: z.literal('end'), sha256: inferenceHashSchema }).strict(),
])
export interface InferenceResourceProgress {
  readonly resource: string
  readonly path: string
  readonly phase: 'connect' | 'download' | 'verify' | 'extract' | 'ready'
  readonly completedFiles: number
  readonly totalFiles: number
  readonly bytes: number
  readonly totalBytes: number | null
  readonly resumedBytes?: number
}
export interface InferenceResourceEvents {
  'inference:resources:progress': { readonly id: string, readonly progress: InferenceResourceProgress }
}
export const inferenceResourceSetSchema = z.object({
  id: inferenceIdSchema,
  revision: inferenceHashSchema,
  kind: z.enum(['engine', 'model']),
  files: z.number().int().positive(),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict()
export const inferenceEndpointUrlSchema = z.url().max(2048).refine((value) => {
  const url = new URL(value)
  return !url.username && !url.password && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
}, 'Expected HTTPS or an explicit loopback HTTP endpoint')
export const inferenceOriginSchema = inferenceEndpointUrlSchema.refine(value => new URL(value).origin === value, 'Expected an origin')
export const inferenceCredentialReferenceSchema = z.object({ id: inferenceIdSchema, origin: inferenceOriginSchema }).strict()
export const inferenceCredentialSchema = inferenceCredentialReferenceSchema.extend({ token: z.string().min(1).max(8192).regex(/^[\x21-\x7E]+$/) }).strict()
export const inferenceNetworkOptionsSchema = z.object({ contentType: z.string().regex(/^multipart\/form-data; boundary=[a-z0-9-]{1,70}$/i).optional() }).strict()
export const inferenceEndpointSchema = z.object({
  id: inferenceIdSchema,
  url: inferenceEndpointUrlSchema,
  contentType: z.enum(['application/json', 'application/octet-stream', 'audio/wav', 'multipart/form-data']),
  credential: inferenceIdSchema.optional(),
}).strict()
export const inferenceModelSchema = z.object({
  id: inferenceIdSchema,
  title: z.string().min(1).max(100),
  capability: inferenceIdSchema,
  contextWindow: z.number().int().min(256).max(2_000_000),
  maxTokens: z.number().int().positive(),
  tools: z.union([z.boolean(), z.literal('auto')]),
  reasoning: z.union([z.boolean(), z.literal('auto')]).optional(),
  catalogModels: z.array(modelCatalogReferenceSchema).max(8).refine(value => new Set(value.map(model => JSON.stringify([model.providerId, model.modelId]))).size === value.length, 'Duplicate catalog model').optional(),
  input: z.array(z.enum(['text', 'image'])).min(1).max(2).refine(value => value.includes('text') && new Set(value).size === value.length, 'Expected unique inputs including text').optional(),
}).strict().refine(value => value.maxTokens <= value.contextWindow, 'Output exceeds context window')
export const inferenceImageModelSchema = z.object({ id: inferenceIdSchema, title: z.string().min(1).max(100), capability: inferenceIdSchema, support: imageSupportSchema }).strict()
export const inferenceImageReaderSchema = z.object({ id: inferenceIdSchema, title: z.string().min(1).max(100), capability: inferenceIdSchema, support: imageReadingSupportSchema }).strict()
export const inferenceBindingSchema = z.object({
  runtime: inferenceIdSchema,
  resources: z.array(z.object({ mount: inferenceIdSchema, id: inferenceIdSchema, revision: inferenceHashSchema }).strict()).max(16),
  libraryPaths: z.array(z.object({ mount: inferenceIdSchema, path: inferenceResourcePathSchema }).strict()).max(8).default([]),
  endpoints: z.array(inferenceEndpointSchema).max(8).default([]),
  configuration: z.record(z.string().max(80), z.json()).default({}),
  imageReaders: z.array(inferenceImageReaderSchema).max(64).default([]),
  imageModels: z.array(inferenceImageModelSchema).max(64).default([]),
  models: z.array(inferenceModelSchema).max(64).default([]),
}).strict().refine(value => new Set(value.resources.map(item => item.mount)).size === value.resources.length, 'Duplicate resource mount').refine(value => value.libraryPaths.every(item => value.resources.some(resource => resource.mount === item.mount)), 'Unknown library mount').refine(value => new Set(value.endpoints.map(item => item.id)).size === value.endpoints.length, 'Duplicate endpoint')
export const inferenceLimits = { controlBytes: 64 * 1024, chunkBytes: 256 * 1024, queuedBytes: 4 * 1024 * 1024, networkRequestBytes: 32 * 1024 * 1024, networkResponseBytes: 48 * 1024 * 1024, networkTimeoutMs: 600000, startTimeoutMs: 120000, stopTimeoutMs: 10000 } as const
export type InferenceCredentialReference = z.infer<typeof inferenceCredentialReferenceSchema>
export type InferenceCredential = z.infer<typeof inferenceCredentialSchema>
export type InferenceNetworkOptions = z.infer<typeof inferenceNetworkOptionsSchema>
export type InferenceCapability = z.infer<typeof inferenceCapabilitySchema>
export type InferenceRuntime = z.infer<typeof inferenceRuntimeSchema>
export type InferencePrepare = z.infer<typeof inferencePrepareSchema>
export type InferenceResourceSet = z.infer<typeof inferenceResourceSetSchema>
export type InferenceBinding = z.infer<typeof inferenceBindingSchema>
export type InferenceRuntimeReference = z.infer<typeof inferenceRuntimeReferenceSchema>
