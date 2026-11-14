import { z } from 'zod'

export const approvalReviewSchema = z.object({
  reviewVersion: z.string().regex(/^[a-f0-9]{64}$/),
  contentVersion: z.literal(1),
  operationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  body: z.json(),
  complete: z.boolean(),
  expiresAt: z.iso.datetime(),
  lifetimeId: z.string().min(1),
  allowedDecisions: z.array(z.enum(['approved', 'denied', 'approved_persistently', 'approved_for_operation', 'approved_for_source', 'approved_for_turn'])),
  persistentEffect: z.boolean(),
}).strict()
export type ApprovalReview = z.infer<typeof approvalReviewSchema>
