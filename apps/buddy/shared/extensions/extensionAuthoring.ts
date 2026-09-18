import { z } from 'zod'

export const EXTENSION_BUILD_RPC = 'extensions.build'
export const EXTENSION_REVIEW_REQUEST = 'extensions.reviewPackage'
export const extensionArchiveSchema = z.string().max(24 * 1024 * 1024).regex(/^[A-Z0-9+/]+={0,2}$/i)
export const extensionBuildRequestSchema = z.object({ archive: extensionArchiveSchema }).strict()
export const extensionBuildResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), archive: extensionArchiveSchema, id: z.string(), version: z.string(), diagnostics: z.array(z.string().max(600)).max(30) }).strict(),
  z.object({ ok: z.literal(false), code: z.string(), diagnostics: z.array(z.string().max(600)).max(30) }).strict(),
])
export type ExtensionBuildResult = z.infer<typeof extensionBuildResultSchema>
