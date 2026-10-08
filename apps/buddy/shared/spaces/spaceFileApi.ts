import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { directoryPageSchema, fileEntrySchema, filePreviewSchema } from '../files/filePreview'
import { idSchema } from '../runtime/apiValidation'

export const spaceFileTargetSchema = z.object({
  spaceId: idSchema,
  directoryId: idSchema,
  revision: z.number().int().positive(),
  path: z.string().max(4096),
}).strict()

export const spaceFileEntrySchema = fileEntrySchema.extend({ writable: z.boolean().optional() })
export const spaceDirectoryPageSchema = directoryPageSchema.extend({ entries: z.array(spaceFileEntrySchema).max(250) })
export const spaceFilePreviewSchema = filePreviewSchema

export const spaceTextDocumentSchema = z.object({
  text: z.string().max(1024 * 1024),
  etag: z.string().length(64),
}).strict()
export type SpaceTextDocument = z.infer<typeof spaceTextDocumentSchema>
export const spaceSaveDocumentSchema = spaceFileTargetSchema.extend({
  text: z.string().max(1024 * 1024),
  etag: z.string().length(64),
}).strict()
export type SpaceSaveDocument = z.infer<typeof spaceSaveDocumentSchema>
export const spaceSaveResultSchema = z.object({
  status: z.enum(['saved', 'conflict']),
  document: spaceTextDocumentSchema,
}).strict()
export type SpaceSaveResult = z.infer<typeof spaceSaveResultSchema>

export const spaceFileLocationSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['directory', 'file']),
}).strict()

export type SpaceFileTarget = z.infer<typeof spaceFileTargetSchema>
export type LocalSpaceFileEntry = DeepReadonly<z.infer<typeof spaceFileEntrySchema>>
export type LocalSpaceDirectoryPage = DeepReadonly<z.infer<typeof spaceDirectoryPageSchema>>
export type LocalSpaceFilePreview = DeepReadonly<z.infer<typeof spaceFilePreviewSchema>>
export type SpaceDirectoryRequest = z.infer<typeof spaceDirectoryRequestSchema>

export const spaceDirectoryRequestSchema = spaceFileTargetSchema.extend({ cursor: z.string().max(512).optional() }).strict()

export const spaceFileMutationSchema = z.discriminatedUnion('operation', [
  spaceFileTargetSchema.extend({ operation: z.literal('create-file'), name: z.string().max(1024) }).strict(),
  spaceFileTargetSchema.extend({ operation: z.literal('create-directory'), name: z.string().max(1024) }).strict(),
  spaceFileTargetSchema.extend({ operation: z.literal('rename'), name: z.string().max(1024) }).strict(),
  spaceFileTargetSchema.extend({ operation: z.literal('trash') }).strict(),
])
export const spaceFileMutationErrorSchema = z.enum(['invalid-name', 'exists', 'missing', 'unsafe-path', 'permission', 'busy', 'unsupported', 'case-only', 'open-resource', 'result-unknown', 'failed'])
export const spaceFileMutationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), path: z.string().max(4096), kind: z.enum(['file', 'directory']) }).strict(),
  z.object({ status: z.literal('failed'), reason: spaceFileMutationErrorSchema }).strict(),
])
export type SpaceFileMutation = z.infer<typeof spaceFileMutationSchema>
export type SpaceFileMutationResult = z.infer<typeof spaceFileMutationResultSchema>
export type SpaceFileMutationError = z.infer<typeof spaceFileMutationErrorSchema>

export const spaceFilesRpc = {
  mutate: { method: 'spaceFiles.mutate', input: spaceFileMutationSchema, response: spaceFileMutationResultSchema },
  readDocument: { method: 'spaceFiles.readDocument', input: spaceFileTargetSchema, response: spaceTextDocumentSchema },
  saveDocument: { method: 'spaceFiles.saveDocument', input: spaceSaveDocumentSchema, response: spaceSaveResultSchema },
  list: { method: 'spaceFiles.list', input: spaceDirectoryRequestSchema, response: spaceDirectoryPageSchema },
  read: { method: 'spaceFiles.read', input: spaceFileTargetSchema, response: spaceFilePreviewSchema },
  locate: { method: 'spaceFiles.locate', input: spaceFileTargetSchema, response: spaceFileLocationSchema },
} as const satisfies Record<string, RuntimeRequestContract>
