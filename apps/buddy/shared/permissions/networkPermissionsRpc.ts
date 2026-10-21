import { z } from 'zod'

export const networkPermissionGrantSchema = z.object({
  host: z.string().min(1).max(253),
  operation: z.enum(['access', 'download', 'upload']),
}).strict()

export const networkPermissionsRpc = {
  get: 'host.networkPermissions.get',
  allow: 'host.networkPermissions.allow',
} as const
