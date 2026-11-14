import { z } from 'zod'
import { conversationArchivePolicySchema } from '../conversation/conversationArchiveApi'
import { desktopOpenResultSchema } from '../service/localServiceProtocol'
import { productErrorCodeSchema } from './errors'
import { productIdSchema as id, productRevisionSchema as revision } from './scalars'

export const productReceiptTargetSchema = z.object({
  uploadId: id.optional(),
  actorId: id.optional(),
  markId: id.optional(),
  conversationId: id.optional(),
  branchId: id.optional(),
  runId: id.optional(),
  messageId: id.optional(),
  queueId: id.optional(),
  draftId: id.optional(),
  sourceDraftId: id.optional(),
  approvalId: id.optional(),
  questionId: id.optional(),
}).strict()
export const productReceiptResultSchema = z.object({
  archived: z.boolean().optional(),
  restored: z.boolean().optional(),
  deleted: z.boolean().optional(),
  archivePolicy: conversationArchivePolicySchema.optional(),
  questionStatus: z.enum(['pending', 'answered', 'cancelled', 'interrupted']).optional(),
  questionDelivery: z.enum(['pending', 'delivered', 'failed']).optional(),
  desktop: desktopOpenResultSchema.optional(),
  uploadId: id.optional(),
  resourceId: id.optional(),
  attachmentId: id.optional(),
  contentVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  draftId: id.optional(),
  revision: revision.optional(),
  slotRevision: revision.optional(),
  sourceRevision: revision.optional(),
  discarded: z.boolean().optional(),
  cancelled: z.boolean().optional(),
  deliveryStage: z.enum(['committed']).optional(),
  status: z.enum(['pending', 'approved', 'denied', 'cancelled']).nullable().optional(),
  resolution: z.enum(['approved', 'denied', 'approved_persistently', 'approved_for_operation', 'approved_for_source', 'approved_for_turn', 'cancelled']).nullable().optional(),
  reviewVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  resolvedAt: z.iso.datetime().optional(),
  reason: z.enum(['changed', 'expired', 'already_resolved', 'unsupported']).optional(),
  draftReceipt: z.object({ draftId: id, committedRevision: revision }).strict().optional(),
}).strict()
export const productCommandReceiptSchema = z.object({
  dataGeneration: id,
  commandId: id,
  method: id,
  decision: z.enum(['accepted', 'rejected']),
  decidedAt: z.iso.datetime(),
  target: productReceiptTargetSchema,
  result: productReceiptResultSchema,
  errorCode: productErrorCodeSchema.optional(),
}).strict().refine(receipt => (receipt.decision === 'rejected') === (receipt.errorCode !== undefined))
export const productCommandResultSchema = z.object({ receipt: productCommandReceiptSchema }).strict()
export const productCommandLookupSchema = z.discriminatedUnion('lookup', [
  z.object({ lookup: z.literal('decided'), receipt: productCommandReceiptSchema }).strict(),
  z.object({ lookup: z.enum(['pending', 'not_found']) }).strict(),
])
