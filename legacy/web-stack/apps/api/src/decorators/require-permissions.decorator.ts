import type { PermissionCode } from '@haohaoxue/lexora-contracts'
import { SetMetadata } from '@nestjs/common'

export const REQUIRE_PERMISSIONS_KEY = 'require_permissions'

export function RequirePermissions(...permissions: PermissionCode[]) {
  return SetMetadata(REQUIRE_PERMISSIONS_KEY, permissions)
}
