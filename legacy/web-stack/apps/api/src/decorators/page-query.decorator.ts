import type { FastifyRequest } from 'fastify'
import {
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common'

export const PageQuery = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<FastifyRequest>()
    const query = (request.query ?? {}) as Record<string, unknown>

    return {
      pageNo: query.pageNo,
      pageSize: query.pageSize,
    }
  },
)
