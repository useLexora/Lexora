import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'

export const fileEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(['directory', 'file']),
  unavailable: z.boolean(),
  identity: z.string().nullable().optional(),
}).strict()

export const directoryPageSchema = z.object({
  entries: z.array(fileEntrySchema).max(250),
  nextCursor: z.string().nullable(),
}).strict()

export const filePreviewSchema = z.object({
  kind: z.enum(['text', 'image', 'binary', 'oversized']),
  sizeBytes: z.number().int().nonnegative(),
  text: z.string().max(1024 * 1024).nullable(),
  imageUrl: z.string().max(12 * 1024 * 1024).nullable(),
}).strict()

export type FilePreview = DeepReadonly<z.infer<typeof filePreviewSchema>>
export type FileEntry = DeepReadonly<z.infer<typeof fileEntrySchema>>
export type DirectoryPage = DeepReadonly<z.infer<typeof directoryPageSchema>>
