import { z } from 'zod'

export const extensionDocumentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  location: z.string().max(1024),
  version: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  writable: z.boolean(),
  kind: z.enum(['file', 'draft']),
  recovery: z.boolean(),
  openedAt: z.number(),
}).strict()
export type ExtensionDocument = z.infer<typeof extensionDocumentSchema>
export const extensionDocumentWriteSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(255).regex(/^[^/\\\0]+$/).optional(),
  version: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  size: z.number().int().min(0).max(256 * 1024 * 1024),
  operationId: z.string().uuid(),
  mode: z.enum(['save', 'saveAs', 'draft', 'create']),
}).strict().refine(input => input.mode === 'create' || input.mode === 'saveAs' || (!!input.id && !!input.revision), 'Saving a working copy requires its identity and revision')
export type ExtensionDocumentWrite = z.infer<typeof extensionDocumentWriteSchema>
