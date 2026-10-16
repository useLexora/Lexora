import type { PermissionCode } from '@haohaoxue/lexora-contracts'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { ForbiddenException, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { REQUIRE_PERMISSIONS_KEY } from '../decorators/require-permissions.decorator'

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<PermissionCode[]>(
      REQUIRE_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    )

    if (!requiredPermissions?.length) {
      return true
    }

    const request = context.switchToHttp().getRequest<{ authUser?: { permissions: PermissionCode[] } }>()
    const userPermissions = new Set(request.authUser?.permissions ?? [])

    const missingPermissions = requiredPermissions.filter(
      permission => !userPermissions.has(permission),
    )

    if (missingPermissions.length) {
      throw new ForbiddenException(`Missing permissions: ${missingPermissions.join(', ')}`)
    }

    return true
  }
}
