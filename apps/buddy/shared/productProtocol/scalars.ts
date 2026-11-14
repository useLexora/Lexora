import { z } from 'zod'

export const PRODUCT_INTEGER_MAX = 9_223_372_036_854_775_807n
export const productIdSchema = z.string().min(1).max(256)
export const productRevisionSchema = z.string().regex(/^(?:0|[1-9]\d{0,18})$/).refine(value => /^(?:0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= PRODUCT_INTEGER_MAX)
export type ProductRevision = z.infer<typeof productRevisionSchema>

export function encodeProductRevision(value: bigint | number): ProductRevision {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new RangeError('Revision must be exactly representable')
  return productRevisionSchema.parse(String(value))
}

export function decodeSafeProductRevision(value: string): number {
  const revision = BigInt(productRevisionSchema.parse(value))
  if (revision > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('Revision exceeds the current storage representation')
  return Number(revision)
}

const cursorSchema = z.object({
  version: z.literal(1),
  scope: productIdSchema,
  branchId: productIdSchema.nullable(),
  revision: productRevisionSchema,
  upperBound: productRevisionSchema,
  position: productRevisionSchema,
  anchorId: productIdSchema.optional(),
}).strict().refine(cursor => productRevisionSchema.safeParse(cursor.position).success && productRevisionSchema.safeParse(cursor.upperBound).success && BigInt(cursor.position) <= BigInt(cursor.upperBound))
export type ProductPageCursor = z.infer<typeof cursorSchema>
export function encodeProductCursor(cursor: ProductPageCursor): string {
  return `v1.${encodeURIComponent(JSON.stringify(cursorSchema.parse(cursor)))}`
}
export function decodeProductCursor(value: string, expected: Omit<ProductPageCursor, 'version' | 'position' | 'upperBound'>): ProductPageCursor {
  if (!value.startsWith('v1.') || value.length > 4096)
    throw new Error('CURSOR_INVALID')
  const cursor = cursorSchema.parse(JSON.parse(decodeURIComponent(value.slice(3))))
  if (cursor.scope !== expected.scope || cursor.branchId !== expected.branchId || cursor.revision !== expected.revision)
    throw new Error('CURSOR_EXPIRED')
  return cursor
}
