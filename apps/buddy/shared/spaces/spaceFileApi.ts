import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { directoryPageSchema, fileEntrySchema, filePreviewSchema } from '../files/filePreview'
import { mediaPreviewLocationSchema } from '../files/mediaPreview'
import { idSchema } from '../runtime/apiValidation'

export const spaceFileTargetSchema = z.object({
  spaceId: idSchema,
  directoryId: idSchema,
  revision: z.number().int().positive(),
  path: z.string().max(4096),
}).strict()

export const spaceFileEntrySchema = fileEntrySchema
export const spaceDirectoryPageSchema = directoryPageSchema
export const spaceFilePreviewSchema = filePreviewSchema

export const spaceTextDocumentSchema = z.object({
  text: z.string().max(1024 * 1024),
  etag: z.string().length(64),
}).strict()
export type SpaceTextDocument = z.infer<typeof spaceTextDocumentSchema>
export const spaceSaveDocumentSchema = spaceFileTargetSchema.extend({
  text: z.string().max(1024 * 1024),
  etag: z.string().length(64),
  operationId: z.string().uuid(),
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

export const spaceFileActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('createFile') }).strict(),
  z.object({ kind: z.literal('createDirectory') }).strict(),
  z.object({ kind: z.literal('rename'), destination: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('copy'), destination: spaceFileTargetSchema }).strict(),
  z.object({ kind: z.literal('move'), destination: spaceFileTargetSchema }).strict(),
  z.object({ kind: z.literal('trash') }).strict(),
  z.object({ kind: z.literal('restore'), originalOperationId: z.string().uuid() }).strict(),
])
export const spaceFileMutationSchema = spaceFileTargetSchema.extend({
  operationId: z.string().uuid(),
  action: spaceFileActionSchema,
}).strict()
export type SpaceFileMutation = z.infer<typeof spaceFileMutationSchema>
export const spaceFileOperationSchema = z.object({
  operationId: z.string().uuid(),
  kind: z.string(),
  path: z.string().nullable(),
  destination: z.string().nullable(),
  temporaryPath: z.string().nullable(),
  status: z.enum(['prepared', 'executing', 'applied', 'not-applied', 'needs-recovery', 'acknowledged']),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  restorable: z.boolean(),
}).strict()
export type SpaceFileOperation = z.infer<typeof spaceFileOperationSchema>
export const spaceFileOperationRequestSchema = spaceFileTargetSchema.extend({ operationId: z.string().uuid() }).strict()
export const spaceFilesChanged = {
  method: 'spaceFiles.changed',
  params: z.object({ spaceId: idSchema, directoryId: idSchema, directoryRevision: z.number().int().positive(), revision: z.number().int().positive(), operationId: z.string(), kind: z.enum(['saved', 'conflict', 'response-denied', 'changed']) }).strict(),
}
export type SpaceFilesChange = z.infer<typeof spaceFilesChanged.params>

export const spaceFilesRpc = {
  resolveMedia: { method: 'spaceFiles.resolveMedia', input: spaceFileTargetSchema, response: mediaPreviewLocationSchema },
  mutate: { method: 'spaceFiles.mutate', input: spaceFileMutationSchema, response: spaceFileOperationSchema },
  history: { method: 'spaceFiles.history', input: spaceFileTargetSchema, response: z.array(spaceFileOperationSchema) },
  query: { method: 'spaceFiles.query', input: spaceFileOperationRequestSchema, response: spaceFileOperationSchema.nullable() },
  acknowledge: { method: 'spaceFiles.acknowledge', input: spaceFileOperationRequestSchema, response: spaceFileOperationSchema },
  cancel: { method: 'spaceFiles.cancel', input: spaceFileOperationRequestSchema, response: z.null() },
  readDocument: { method: 'spaceFiles.readDocument', input: spaceFileTargetSchema, response: spaceTextDocumentSchema },
  saveDocument: { method: 'spaceFiles.saveDocument', input: spaceSaveDocumentSchema, response: spaceSaveResultSchema },
  list: { method: 'spaceFiles.list', input: spaceDirectoryRequestSchema, response: spaceDirectoryPageSchema },
  read: { method: 'spaceFiles.read', input: spaceFileTargetSchema, response: spaceFilePreviewSchema },
  locate: { method: 'spaceFiles.locate', input: spaceFileTargetSchema, response: spaceFileLocationSchema },
} as const satisfies Record<string, RuntimeRequestContract>
