import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'

export const FILE_IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

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
  kind: z.enum(['text', 'image', 'audio', 'video', 'binary', 'oversized']),
  sizeBytes: z.number().int().nonnegative(),
  text: z.string().max(1024 * 1024).nullable(),
  imageUrl: z.string().max(32_768).nullable(),
  mediaUrl: z.string().max(32_768).optional(),
}).strict()

export type FilePreview = DeepReadonly<z.infer<typeof filePreviewSchema>>
export type FileEntry = DeepReadonly<z.infer<typeof fileEntrySchema>>
export type DirectoryPage = DeepReadonly<z.infer<typeof directoryPageSchema>>
