import type { RuntimeRequestContract } from '../runtime/apiContract'
import { z } from 'zod'
import { idSchema, isAbsolutePath, timestampSchema } from '../runtime/apiValidation'
import { filePreviewSchema } from './filePreview'
import { mediaPreviewLocationSchema } from './mediaPreview'

export const taskFileTargetSchema = z.object({
  conversationId: idSchema,
  path: z.string().min(1).max(32_768).refine(isAbsolutePath),
}).strict()

export const taskFileLinkSchema = z.object({
  conversationId: idSchema,
  href: z.string().min(1).max(32_768),
}).strict()

export const taskFileSchema = z.object({
  target: taskFileTargetSchema,
  name: z.string().min(1),
  kind: z.enum(['file', 'directory']),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
}).strict()

export type TaskFileTarget = z.infer<typeof taskFileTargetSchema>
export type TaskFileLink = z.infer<typeof taskFileLinkSchema>
export type TaskFile = z.infer<typeof taskFileSchema>

export const taskFilesRpc = {
  resolve: { method: 'taskFiles.resolve', input: taskFileLinkSchema, response: taskFileSchema },
  read: { method: 'taskFiles.read', input: taskFileTargetSchema, response: filePreviewSchema },
  locate: { method: 'taskFiles.locate', input: taskFileTargetSchema, response: z.object({ path: z.string().refine(isAbsolutePath), kind: z.enum(['file', 'directory']) }).strict() },
  resolveMedia: { method: 'taskFiles.resolveMedia', input: taskFileTargetSchema, response: mediaPreviewLocationSchema },
  resolveBrowser: { method: 'taskFiles.resolveBrowser', input: taskFileTargetSchema, response: z.object({ entryPath: z.string().refine(isAbsolutePath), rootPath: z.string().refine(isAbsolutePath) }).strict() },
} as const satisfies Record<string, RuntimeRequestContract>
