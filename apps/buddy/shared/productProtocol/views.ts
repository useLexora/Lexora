import { z } from 'zod'
import { approvalReviewSchema } from '../permissions/conditionalApproval'
import { modelSchema, modelSnapshotSchema, providerSchema } from '../providers/providerApi'
import { productContentSchema } from './content'
import { productErrorCodeSchema } from './errors'
import { productIdSchema as id, productRevisionSchema as revision } from './scalars'

export const productResourceSchema = z.object({
  resourceId: id,
  bindingId: id.optional(),
  kind: z.enum(['attachment', 'artifact', 'message', 'review', 'reference']),
  name: z.string().max(512),
  mimeType: z.string().max(256),
  sizeBytes: revision,
  revision: z.string().min(1).max(256),
  availability: z.enum(['ready', 'unavailable', 'export_required']),
}).strict()
export const productMessageSchema = z.object({
  id,
  conversationId: id,
  branchId: id,
  runId: id.nullable(),
  role: z.enum(['user', 'assistant', 'tool']),
  createdAt: z.iso.datetime(),
  body: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('user'), content: productContentSchema }).strict(),
    z.object({ kind: z.literal('text'), text: z.string().max(131_072), interrupted: z.boolean(), truncated: z.boolean() }).strict(),
    z.object({ kind: z.literal('resource'), resourceId: id, previewText: z.string().max(4096), readOnly: z.literal(true), interrupted: z.boolean().optional(), truncated: z.boolean().optional() }).strict(),
  ]),
  resources: z.array(productResourceSchema).max(16),
  tool: z.object({ name: z.string().min(1).max(256), isError: z.boolean() }).strict().optional(),
  author: z.object({ id, name: z.string().trim().min(1).max(80) }).strict().optional(),
}).strict()
export const productApprovalSchema = z.object({
  id,
  runId: id,
  conversationId: id.optional(),
  branchId: id.optional(),
  kind: z.string().min(1).max(80),
  summary: z.string().max(4096),
  status: z.enum(['pending', 'approved', 'denied', 'cancelled']),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  resolution: z.string().max(80).nullable(),
  review: z.object({
    ...approvalReviewSchema.omit({ body: true, lifetimeId: true }).shape,
    document: z.object({ format: z.literal('json'), text: z.string().max(131_072) }).strict().nullable(),
    resourceId: id.nullable(),
    localManagementRequired: z.boolean(),
  }).strict().nullable(),
}).strict()
export const productApprovalDecisionSchema = z.object({
  approvalId: id,
  runId: id,
  reviewVersion: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  status: z.enum(['approved', 'denied', 'cancelled']),
  resolution: z.string().max(80).nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  actor: z.object({ id, kind: z.enum(['desktop', 'device']), current: z.boolean() }).strict().nullable(),
  cancellationReason: z.enum(['cancelled', 'expired', 'recovery', 'shutdown']).nullable(),
}).strict()
export const productQueueItemSchema = z.object({
  id,
  conversationId: id,
  branchId: id,
  revision,
  state: z.enum(['waiting', 'paused', 'sent', 'cancelled']),
  createdAt: z.iso.datetime(),
  sourceRunId: id.nullable(),
  content: productContentSchema,
  steerTarget: z.object({ runId: id, generation: revision }).strict().nullable(),
}).strict()
export const productRunEventSchema = z.object({
  runId: id,
  sequence: revision,
  createdAt: z.iso.datetime(),
  type: z.string().min(1).max(128),
  detail: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text_delta'), messageId: id, delta: z.string().max(65_536), phase: z.enum(['commentary', 'final_answer']).nullable() }).strict(),
    z.object({ kind: z.literal('status'), messageId: id.optional(), approvalId: id.optional(), toolCallId: id.optional(), toolName: z.string().max(256).optional(), errorCode: productErrorCodeSchema.optional() }).strict(),
    z.object({ kind: z.literal('resource'), resourceId: id }).strict(),
  ]),
}).strict()
export const productProviderSchema = providerSchema.pick({ id: true, displayName: true, enabled: true, status: true, modelCount: true, enabledModelCount: true }).strict()
export const productModelSchema = z.object({
  modelId: modelSchema.shape.modelId,
  providerId: modelSchema.shape.providerId,
  displayName: modelSchema.shape.displayName,
  type: modelSchema.shape.type,
  available: modelSchema.shape.available,
  enabled: modelSchema.shape.enabled,
  capabilities: modelSchema.shape.capabilities,
  contextWindow: modelSchema.shape.contextWindow,
  maxTokens: modelSchema.shape.maxTokens,
  fileInputMimeTypes: modelSchema.shape.fileInputMimeTypes,
  reasoningOptions: modelSchema.shape.reasoningOptions,
  serviceTiers: modelSchema.shape.serviceTiers,
}).strict()
export { modelSnapshotSchema as productModelSnapshotSchema }
