import { z } from 'zod'
import { discoveredModelMetadataSchema } from '../providers/providerDiscovery.ts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const contextCount = z.number().int().positive().max(2147483647)
const duration = z.number().finite().nonnegative()
const backend = z.enum(['cpu', 'vulkan', 'cuda', 'metal'])
const timing = z.object({ tokens: count, ms: duration, tokensPerSecond: duration.optional() }).strip()
export const inferenceDiagnosticCodeSchema = z.string().regex(/^EXTENSION_INFERENCE_[A-Z_]{1,80}$/)

export const inferenceDiagnosticSchema = z.object({
  modelId: z.string().min(1).max(80).regex(/^[a-z][a-z0-9.-]*$/).optional(),
  modelMetadata: discoveredModelMetadataSchema.optional(),
  engine: z.object({ name: z.literal('llama.cpp'), version: z.string().regex(/^b\d{1,12}$/).optional() }).strip().optional(),
  backend: z.object({ requested: z.enum(['cpu', 'vulkan', 'cuda', 'metal', 'unknown']), observed: z.array(backend).max(4) }).strip().optional(),
  device: z.array(z.object({ backend, index: count }).strip()).max(16).optional(),
  architecture: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).optional(),
  offload: z.object({ layers: count, total: count }).strip().optional(),
  context: z.object({ requested: contextCount.optional(), actual: contextCount.optional(), train: contextCount.optional() }).strip().optional(),
  degraded: z.boolean().optional(),
  timings: z.object({ prompt: timing.optional(), decode: timing.optional() }).strip().optional(),
  prompt: timing.optional(),
  decode: timing.optional(),
  loadMs: duration.optional(),
  ms: duration.optional(),
  kind: z.enum(['thinking', 'text', 'tool']).optional(),
  reason: z.enum(['stop', 'length', 'toolUse']).optional(),
  usage: z.object({ input: count, output: count, cacheRead: count.optional() }).strip().optional(),
  cancelled: z.boolean().optional(),
  error: inferenceDiagnosticCodeSchema.optional(),
}).strip()

export const inferenceStderrDiagnosticSchema = inferenceDiagnosticSchema.extend({
  event: z.enum(['chat.gpu.start', 'chat.gpu.ready', 'chat.gpu.exit', 'chat.gpu.invoke', 'chat.gpu.first', 'chat.gpu.timings', 'chat.gpu.done', 'chat.gpu.error', 'chat.gpu.drain']),
  id: z.uuid().optional(),
  code: z.union([inferenceDiagnosticCodeSchema, z.number().int(), z.null()]).optional(),
})
