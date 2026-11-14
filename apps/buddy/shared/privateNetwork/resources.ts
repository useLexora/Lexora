import { z } from 'zod'
import { productIdSchema as id, productRevisionSchema } from '../productProtocol/scalars'
import { uploadDigestSchema } from './uploads'

export const resourcePrepareSchema = z.object({ resourceId: id, expectedVersion: z.string().min(1).max(256) }).strict()
export const resourceDownloadSchema = z.object({
  downloadId: id,
  resourceId: id,
  contentVersion: uploadDigestSchema,
  sizeBytes: productRevisionSchema,
  mimeType: z.string().max(256),
  name: z.string().max(512),
  expiresAt: z.iso.datetime(),
}).strict()
