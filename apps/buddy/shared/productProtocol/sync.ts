import { z } from 'zod'
import { PRODUCT_LIMITS } from './limits'
import { productIdSchema, productRevisionSchema } from './scalars'

export const productSyncCursorSchema = z.object({ syncEpoch: productIdSchema, seq: productRevisionSchema }).strict()
export type ProductSyncCursor = z.infer<typeof productSyncCursorSchema>
export const productSubscribeSchema = z.object({ subscriptionId: productIdSchema, topic: z.string().min(1).max(2048), base: productSyncCursorSchema.optional() }).strict()
export const productSnapshotPageSchema = z.object({ subscriptionId: productIdSchema, cursor: z.string().min(1).max(4096) }).strict()
export const productAckSchema = productSyncCursorSchema.extend({ subscriptionId: productIdSchema }).strict()
export const productUnsubscribeSchema = z.object({ subscriptionId: productIdSchema }).strict()
export interface ProductSyncDelta<T = unknown> { subscriptionId: string, syncEpoch: string, fromSeq: string, toSeq: string, changes: readonly T[] }
export type ProductSyncSnapshot<T = unknown> = { subscriptionId: string, mode: 'snapshot', cursor: ProductSyncCursor, items: readonly T[], complete: boolean, nextCursor: string | null } | { subscriptionId: string, mode: 'resume', cursor: ProductSyncCursor }

export function classifyProductDelta(applied: ProductSyncCursor, delta: Pick<ProductSyncDelta, 'syncEpoch' | 'fromSeq' | 'toSeq'>): 'apply' | 'duplicate' | 'resync' {
  const from = productRevisionSchema.safeParse(delta.fromSeq)
  const to = productRevisionSchema.safeParse(delta.toSeq)
  if (!from.success || !to.success || !productSyncCursorSchema.safeParse(applied).success || delta.syncEpoch !== applied.syncEpoch || BigInt(to.data) <= BigInt(from.data))
    return 'resync'
  if (BigInt(to.data) <= BigInt(applied.seq))
    return 'duplicate'
  return from.data === applied.seq ? 'apply' : 'resync'
}

export const productSyncSnapshotSchema = z.discriminatedUnion('mode', [
  z.object({ subscriptionId: productIdSchema, mode: z.literal('snapshot'), cursor: productSyncCursorSchema, items: z.array(z.unknown()).max(PRODUCT_LIMITS.pageItems), complete: z.boolean(), nextCursor: z.string().max(4096).nullable() }).strict().refine(value => value.complete === (value.nextCursor === null)),
  z.object({ subscriptionId: productIdSchema, mode: z.literal('resume'), cursor: productSyncCursorSchema }).strict(),
])
export const productSyncDeltaSchema = z.object({
  subscriptionId: productIdSchema,
  syncEpoch: productIdSchema,
  fromSeq: productRevisionSchema,
  toSeq: productRevisionSchema,
  changes: z.array(z.unknown()).min(1).max(PRODUCT_LIMITS.subscriptionItems),
}).strict().refine(value => productRevisionSchema.safeParse(value.fromSeq).success && productRevisionSchema.safeParse(value.toSeq).success && BigInt(value.fromSeq) < BigInt(value.toSeq))
export const productResyncRequiredSchema = z.object({ subscriptionId: productIdSchema, reason: z.literal('RESYNC_REQUIRED') }).strict()
