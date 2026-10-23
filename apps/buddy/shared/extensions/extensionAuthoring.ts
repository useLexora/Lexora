import { z } from 'zod'
import { workbenchCapabilityKinds } from '../workbench/workbenchContributionCatalog'
import { workbenchCapabilityQuerySchema } from '../workbench/workbenchUi'
import { extensionLogSchema } from './extensionDiagnostic'
import { extensionAuthorSchema, extensionSlugSchema } from './extensionIdentity'
import { extensionIdSchema, extensionVersionSchema } from './extensionManifest'
import { EXTENSION_ARCHIVE_LIMIT, EXTENSION_PACKAGE_CHUNK_BASE64_LENGTH, EXTENSION_PACKAGE_INLINE_BASE64_LENGTH } from './extensionPackageBudget'

export const EXTENSION_BUILD_RPC = 'extensions.build'
export const EXTENSION_REVIEW_REQUEST = 'extensions.reviewPackage'
export const EXTENSION_INSPECT_RPC = 'extensions.inspect'
export const EXTENSION_CAPABILITIES_RPC = 'extensions.capabilities'
export const EXTENSION_IDENTITY_RPC = 'extensions.identity'
export const extensionIdentityRequestSchema = z.object({ slug: extensionSlugSchema, author: extensionAuthorSchema.optional() }).strict()
export const extensionIdentitySchema = z.object({ id: extensionIdSchema, author: extensionAuthorSchema, engines: z.object({ lexora: z.string() }).strict() }).strict()
export { workbenchCapabilityQuerySchema as extensionCapabilitiesRequestSchema }
export const extensionCapabilitiesSchema = z.object({
  apiVersion: z.number().int().positive(),
  targets: z.array(z.object({
    kind: z.enum(workbenchCapabilityKinds),
    target: z.string(),
    title: z.object({ 'zh-CN': z.string(), 'en-US': z.string() }).strict(),
    scope: z.enum(['application', 'page', 'pane', 'composer', 'resource', 'message']),
    description: z.string().optional(),
    selection: z.enum(['single', 'multiple']).optional(),
    height: z.object({ min: z.number(), max: z.number(), default: z.number() }).strict().optional(),
  }).strict()),
}).strict()
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
  logs: z.array(extensionLogSchema).max(50),
}).strict()
export type ExtensionInspection = z.infer<typeof extensionInspectionSchema>
export const extensionArchiveSchema = z.string().max(EXTENSION_PACKAGE_INLINE_BASE64_LENGTH).regex(/^[A-Z0-9+/]+={0,2}$/i)
export const extensionBuildRequestSchema = z.object({ archive: extensionArchiveSchema }).strict()
export const extensionBuildResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), archive: extensionArchiveSchema, id: extensionIdSchema, name: z.string().min(1).max(100), author: extensionAuthorSchema, version: extensionVersionSchema, diagnostics: z.array(z.string().max(600)).max(30) }).strict(),
  z.object({ ok: z.literal(false), code: z.string(), diagnostics: z.array(z.string().max(600)).max(30) }).strict(),
])
export type ExtensionBuildResult = z.infer<typeof extensionBuildResultSchema>

export const EXTENSION_PACKAGE_TRANSFER_RPC = 'extensions.packageTransfer'
const transferId = z.string().uuid()
const archiveSize = z.number().int().positive().max(EXTENSION_ARCHIVE_LIMIT)
const archiveHash = z.string().regex(/^[a-f0-9]{64}$/)
export const extensionTransferDescriptorSchema = z.object({ size: archiveSize, sha256: archiveHash }).strict()
export const extensionTransferRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('begin'), size: archiveSize, sha256: archiveHash }).strict(),
  z.object({ action: z.literal('upload'), transferId, offset: z.number().int().nonnegative().max(EXTENSION_ARCHIVE_LIMIT), data: z.string().min(4).max(EXTENSION_PACKAGE_CHUNK_BASE64_LENGTH).regex(/^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i) }).strict(),
  z.object({ action: z.literal('build'), transferId }).strict(),
  z.object({ action: z.literal('read'), transferId, offset: z.number().int().nonnegative().max(EXTENSION_ARCHIVE_LIMIT) }).strict(),
  z.object({ action: z.literal('dispose'), transferId }).strict(),
])
export const extensionTransferSessionSchema = z.object({ transferId }).strict()
export const extensionTransferOffsetSchema = z.object({ offset: z.number().int().nonnegative().max(EXTENSION_ARCHIVE_LIMIT) }).strict()
export const extensionTransferChunkSchema = z.object({ offset: z.number().int().nonnegative().max(EXTENSION_ARCHIVE_LIMIT), data: z.string().max(EXTENSION_PACKAGE_CHUNK_BASE64_LENGTH) }).strict()
export const extensionTransferredBuildResultSchema = z.discriminatedUnion('ok', [
  extensionBuildResultSchema.options[0].omit({ archive: true }).extend({ package: extensionTransferDescriptorSchema }),
  extensionBuildResultSchema.options[1],
])
export type ExtensionTransferredBuildResult = z.infer<typeof extensionTransferredBuildResultSchema>
