import { z } from 'zod'

export const extensionLocalFileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(512),
  mimeType: z.string().max(80),
  size: z.number().int().min(0).max(2 * 1024 ** 3),
  relativePath: z.string().max(32768).optional(),
}).strict()
export const extensionFileExtensionsSchema = z.array(z.string().min(1).max(32).regex(/^(?:[a-z0-9][\w-]*|\*)$/i)).max(64)
export const extensionResourceSelectionSchema = z.object({
  filters: z.array(z.object({ name: z.string().min(1).max(80), extensions: extensionFileExtensionsSchema.min(1) }).strict()).max(12).default([]),
  multiple: z.boolean().default(false),
}).strict()
export const extensionDirectoryScanSchema = z.object({
  id: z.string().uuid(),
  extensions: extensionFileExtensionsSchema.default([]),
  recursive: z.boolean().default(true),
}).strict()
export type ExtensionDirectoryScan = z.infer<typeof extensionDirectoryScanSchema>
export type ExtensionLocalFile = z.infer<typeof extensionLocalFileSchema>
export type ExtensionResourceSelection = z.infer<typeof extensionResourceSelectionSchema>
export const extensionLocalDirectorySchema = z.object({ id: z.string().uuid(), name: z.string().max(512) }).strict()
export type ExtensionLocalDirectory = z.infer<typeof extensionLocalDirectorySchema>

const mimeTypes: Readonly<Record<string, string>> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  epub: 'application/epub+zip',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}
export function extensionResourceMimeType(extension: string): string {
  return mimeTypes[extension.toLowerCase()] ?? 'application/octet-stream'
}
