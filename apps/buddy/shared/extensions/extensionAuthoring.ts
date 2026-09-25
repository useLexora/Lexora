import { z } from 'zod'
import { extensionIdSchema, extensionVersionSchema } from './extensionManifest'

export const EXTENSION_BUILD_RPC = 'extensions.build'
export const EXTENSION_REVIEW_REQUEST = 'extensions.reviewPackage'
export const EXTENSION_INSPECT_RPC = 'extensions.inspect'
export const extensionInspectRequestSchema = z.object({ id: extensionIdSchema }).strict()
export const extensionInspectionSchema = z.object({
  id: extensionIdSchema,
  installed: z.boolean(),
  version: extensionVersionSchema.nullable(),
  pendingVersion: extensionVersionSchema.nullable(),
  enabled: z.boolean(),
  state: z.enum(['not-installed', 'disabled', 'inactive', 'activating', 'active', 'failed', 'blocked']),
  error: z.string().nullable(),
  commands: z.array(z.object({ id: z.string(), title: z.string() }).strict()).max(64),
  navigation: z.string().nullable(),
  views: z.array(z.object({ type: z.string(), placement: z.string().nullable(), ready: z.boolean(), error: z.string().nullable() }).strict()).max(512),
  installations: z.array(z.object({ version: z.string(), status: z.string(), stage: z.string(), error: z.string().nullable() }).strict()).max(5),
  logs: z.array(z.object({ time: z.string(), event: z.string(), code: z.string().optional(), durationMs: z.number().optional() }).strict()).max(50),
}).strict()
export type ExtensionInspection = z.infer<typeof extensionInspectionSchema>
export const extensionArchiveSchema = z.string().max(24 * 1024 * 1024).regex(/^[A-Z0-9+/]+={0,2}$/i)
export const extensionBuildRequestSchema = z.object({ archive: extensionArchiveSchema }).strict()
export const extensionBuildResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), archive: extensionArchiveSchema, id: z.string(), version: z.string(), diagnostics: z.array(z.string().max(600)).max(30) }).strict(),
  z.object({ ok: z.literal(false), code: z.string(), diagnostics: z.array(z.string().max(600)).max(30) }).strict(),
])
export type ExtensionBuildResult = z.infer<typeof extensionBuildResultSchema>
