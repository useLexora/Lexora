import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import type { Observable } from 'rxjs'
import { Injectable } from '@nestjs/common'
import { map } from 'rxjs/operators'

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, { code: number, message: string, data: T }> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<{ code: number, message: string, data: T }> {
    const response = context.switchToHttp().getResponse<FastifyReply>()

    return next.handle().pipe(
      map(data => ({
        code: response.statusCode,
        message: 'success',
        data,
      })),
    )
  }
}
