import type { AuthUserContext } from '../modules/auth/auth.interface'
import { createParamDecorator, ExecutionContext } from '@nestjs/common'

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUserContext => {
    const request = context.switchToHttp().getRequest<{ authUser: AuthUserContext }>()
    return request.authUser
  },
)
