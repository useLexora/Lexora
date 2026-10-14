import { z } from 'zod'
import { extensionIdSchema, extensionManifestSchema } from '../../shared/extensions/extensionManifest'
import { extensionScheduleSchema } from '../../shared/extensions/extensionSchedule'

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const extensionSourceSchema = z.object({ catalog: z.string().url(), artifact: z.string().url(), sha256: revisionSchema }).strict()
export const extensionPackageSchema = z.object({ manifest: extensionManifestSchema, revision: revisionSchema, hashes: z.record(z.string(), revisionSchema), source: extensionSourceSchema.nullable().default(null) }).strict()
const recordSchema = z.object({ current: extensionPackageSchema, pending: extensionPackageSchema.nullable(), enabled: z.boolean(), development: z.boolean() }).strict()
export const extensionIndexSchema = z.object({ version: z.literal(1), installed: z.record(extensionIdSchema, recordSchema) }).strict()
export const storedPackageSchema = extensionPackageSchema.extend({ manifest: z.unknown() })
export const storedRecordSchema = recordSchema.extend({ current: storedPackageSchema, pending: storedPackageSchema.nullable() })
export const storedIndexSchema = extensionIndexSchema.extend({ installed: z.record(extensionIdSchema, storedRecordSchema) })
export const extensionJobSchema = extensionScheduleSchema.extend({ extensionId: extensionIdSchema })
export const extensionScheduleStateSchema = z.object({ version: z.literal(1), jobs: z.array(extensionJobSchema).max(512) }).strict()
export type ExtensionPackage = z.infer<typeof extensionPackageSchema>
export type InstalledExtension = z.infer<typeof recordSchema>
