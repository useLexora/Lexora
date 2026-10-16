import type { AuthUserContext } from '../modules/auth/auth.interface'
import { createParamDecorator, ExecutionContext } from '@nestjs/common'

export const OptionalCurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUserContext | null => {
    const request = context.switchToHttp().getRequest<{ authUser?: AuthUserContext }>()
    return request.authUser ?? null
  },
)
