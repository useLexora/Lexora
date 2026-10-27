import type { LocalDocumentCommit } from '../../shared/files/localDocumentApi'
import { z } from 'zod'
import { extensionFileOpeningSourceSchema } from '../../shared/extensions/extensionFileOpening'
import { localDocumentCommitSchema } from '../../shared/files/localDocumentApi'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const contentSchema = z.object({ key: hash, size: z.number().int().min(0).max(256 * 1024 * 1024) }).strict()
export type WorkingCopyContent = z.infer<typeof contentSchema>
const fileBindingSchema = z.object({
  path: z.string(),
  parentIdentity: z.string(),
  identity: z.string(),
  version: hash.nullable(),
  readonly: z.boolean(),
  source: extensionFileOpeningSourceSchema.optional(),
  revoked: z.boolean().default(false),
}).strict()
export type WorkingCopyFileBinding = z.infer<typeof fileBindingSchema>
const workingCopySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  openedAt: z.number(),
  base: contentSchema,
  file: fileBindingSchema.nullable(),
  recovery: contentSchema.optional(),
  saving: localDocumentCommitSchema.optional(),
}).strict()
export type ExtensionWorkingCopy = z.infer<typeof workingCopySchema>
export const workingCopiesSchema = z.object({ version: z.literal(1), copies: z.array(workingCopySchema).max(240) }).strict()

const legacySchema = z.array(z.object({
  id: z.string().uuid(),
  name: z.string().max(255),
  path: z.string().nullable(),
  parentIdentity: z.string(),
  identity: z.string(),
  version: hash.nullable(),
  snapshot: hash,
  size: z.number(),
  openedAt: z.number(),
  readonly: z.boolean(),
  source: extensionFileOpeningSourceSchema.optional(),
  revoked: z.boolean().optional(),
  draft: contentSchema.optional(),
  pending: z.object({ operationId: z.string().uuid(), key: hash, size: z.number() }).optional(),
}).strict()).max(240)

export function readWorkingCopies(value: unknown, extensionId: string): ExtensionWorkingCopy[] {
  if (!Array.isArray(value))
    return workingCopiesSchema.parse(value).copies
  return legacySchema.parse(value).map(record => workingCopySchema.parse({
    id: record.id,
    name: record.name,
    openedAt: record.openedAt,
    base: { key: record.snapshot, size: record.size },
    file: record.path ? { path: record.path, parentIdentity: record.parentIdentity, identity: record.identity, version: record.version, readonly: record.readonly, source: record.source, revoked: record.revoked ?? false } : null,
    recovery: record.draft,
    saving: record.pending && record.path ? { extensionId, operationId: record.pending.operationId, path: record.path, parentIdentity: record.parentIdentity, expected: record.version, sha256: record.pending.key, size: record.pending.size, source: record.source } satisfies LocalDocumentCommit : undefined,
  }))
}

export function workingCopyContent(copy: ExtensionWorkingCopy): WorkingCopyContent {
  return copy.recovery ?? copy.base
}
