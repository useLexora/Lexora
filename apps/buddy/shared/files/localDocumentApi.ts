import type { RuntimeRequestContract } from '../runtime/apiContract'
import { z } from 'zod'
import { extensionFileOpeningSourceSchema } from '../extensions/extensionFileOpening'
import { extensionIdSchema } from '../extensions/extensionManifest'
import { isAbsolutePath } from '../runtime/apiValidation'

export const localDocumentCommitSchema = z.object({
  extensionId: extensionIdSchema,
  operationId: z.string().uuid(),
  path: z.string().min(1).max(32768).refine(isAbsolutePath),
  parentIdentity: z.string().min(1).max(256),
  expected: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(0).max(256 * 1024 * 1024),
  source: extensionFileOpeningSourceSchema.optional(),
}).strict()
export type LocalDocumentCommit = z.infer<typeof localDocumentCommitSchema>
export const localDocumentReceiptSchema = z.object({
  operationId: z.string().uuid(),
  status: z.enum(['applied', 'not-applied', 'needs-recovery', 'pending']),
  version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  error: z.string().optional(),
}).strict()
export type LocalDocumentReceipt = z.infer<typeof localDocumentReceiptSchema>
export const localDocumentRpc = {
  commit: { method: 'localDocuments.commit', input: localDocumentCommitSchema, response: localDocumentReceiptSchema },
  query: { method: 'localDocuments.query', input: localDocumentCommitSchema, response: localDocumentReceiptSchema },
} as const satisfies Record<string, RuntimeRequestContract>
