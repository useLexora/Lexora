import { z } from 'zod'
import { PERMISSION_VALUES, ROLE_VALUES } from './rbac/constants'

export { PERMISSION_VALUES, PERMISSIONS, ROLE_VALUES, ROLES } from './rbac/constants'

export const PermissionSchema = z.enum(PERMISSION_VALUES)
export const RoleSchema = z.enum(ROLE_VALUES)

export const PermissionListSchema = z.object({
  permissions: z.array(PermissionSchema),
}).strict()

export type PermissionCode = z.infer<typeof PermissionSchema>
export type RoleCode = z.infer<typeof RoleSchema>
