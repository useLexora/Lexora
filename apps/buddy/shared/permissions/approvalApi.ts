import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema, nullableTimestampSchema, optionalLimitSchema, timestampSchema } from '../runtime/apiValidation'
import { APPROVAL_GRANT_SCOPES, APPROVAL_REVIEW_KINDS, approvalReviewPayloadMatchesKind, approvalReviewPayloadSchema } from './approvalReviewPayload'

export const approvalSchema = z.object({
  createdAt: timestampSchema,
  id: idSchema,
  kind: z.enum(APPROVAL_REVIEW_KINDS),
  payload: approvalReviewPayloadSchema,
  resolvedAt: nullableTimestampSchema,
  runId: idSchema,
  status: z.enum(['pending', 'approved', 'denied', 'cancelled']),
  summary: z.string().min(1),
  toolCallId: idSchema,
}).strict().refine(
  approval => approvalReviewPayloadMatchesKind(approval.payload, approval.kind),
  { path: ['payload'] },
)

export type LocalApproval = DeepReadonly<z.infer<typeof approvalSchema>>

export const approvalsRequestSchemas = {
  approvalId: z.object({ approvalId: idSchema }).strict(),
  approvalGrant: z.object({ approvalId: idSchema, scope: z.enum(APPROVAL_GRANT_SCOPES) }).strict(),
  listApprovals: z.object({
    conversationId: idSchema.optional(),
    branchId: idSchema.optional(),
    limit: optionalLimitSchema,
    runId: idSchema.nullable().optional(),
    status: z.enum(['pending', 'approved', 'denied', 'cancelled']).nullable().optional(),
  }).strict().refine(input => Boolean(input.conversationId) === Boolean(input.branchId), { message: 'Conversation and branch must be supplied together' }),
} as const

export const approvalsResponseSchemas = {
  approval: approvalSchema,
  approvals: z.array(approvalSchema),
} as const

export const approvalsRpc = {
  list: { method: 'approvals.list', input: approvalsRequestSchemas.listApprovals, response: approvalsResponseSchemas.approvals },
  approve: { method: 'approvals.approve', input: approvalsRequestSchemas.approvalGrant, response: approvalsResponseSchemas.approval },
  deny: { method: 'approvals.deny', input: approvalsRequestSchemas.approvalId, response: approvalsResponseSchemas.approval },
} as const satisfies Record<string, RuntimeRequestContract>
