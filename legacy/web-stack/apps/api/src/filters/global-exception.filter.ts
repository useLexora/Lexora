import type { ApiErrorCode } from '@haohaoxue/lexora-contracts'
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import {
  API_ERROR_CODE,
  ApiErrorCodeSchema,
  AUTH_ERROR_CODE,
} from '@haohaoxue/lexora-contracts'
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'

type AuthErrorCode = (typeof AUTH_ERROR_CODE)[keyof typeof AUTH_ERROR_CODE]

const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  [AUTH_ERROR_CODE.ACCESS_TOKEN_MISSING]: 'Access token is missing',
  [AUTH_ERROR_CODE.ACCESS_TOKEN_EXPIRED]: 'Access token has expired',
  [AUTH_ERROR_CODE.ACCESS_TOKEN_INVALID]: 'Access token is invalid',
  [AUTH_ERROR_CODE.REFRESH_TOKEN_MISSING]: 'Refresh token is missing',
  [AUTH_ERROR_CODE.REFRESH_TOKEN_INVALID]: 'Refresh token is invalid',
  [AUTH_ERROR_CODE.SESSION_USER_INACTIVE]: 'Session user is inactive',
}

const HTTP_ERROR_MESSAGES: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload too large',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'Unsupported media type',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too many requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal server error',
}

const HTTP_ERROR_CODES: Partial<Record<HttpStatus, ApiErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: API_ERROR_CODE.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: API_ERROR_CODE.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: API_ERROR_CODE.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: API_ERROR_CODE.NOT_FOUND,
  [HttpStatus.CONFLICT]: API_ERROR_CODE.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: API_ERROR_CODE.PAYLOAD_TOO_LARGE,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: API_ERROR_CODE.BAD_REQUEST,
  [HttpStatus.UNPROCESSABLE_ENTITY]: API_ERROR_CODE.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: API_ERROR_CODE.BAD_REQUEST,
  [HttpStatus.INTERNAL_SERVER_ERROR]: API_ERROR_CODE.INTERNAL_SERVER_ERROR,
}

const AUTH_API_ERROR_CODES: Record<AuthErrorCode, ApiErrorCode> = {
  [AUTH_ERROR_CODE.ACCESS_TOKEN_MISSING]: API_ERROR_CODE.AUTH_ACCESS_TOKEN_MISSING,
  [AUTH_ERROR_CODE.ACCESS_TOKEN_EXPIRED]: API_ERROR_CODE.AUTH_ACCESS_TOKEN_EXPIRED,
  [AUTH_ERROR_CODE.ACCESS_TOKEN_INVALID]: API_ERROR_CODE.AUTH_ACCESS_TOKEN_INVALID,
  [AUTH_ERROR_CODE.REFRESH_TOKEN_MISSING]: API_ERROR_CODE.AUTH_REFRESH_TOKEN_MISSING,
  [AUTH_ERROR_CODE.REFRESH_TOKEN_INVALID]: API_ERROR_CODE.AUTH_REFRESH_TOKEN_INVALID,
  [AUTH_ERROR_CODE.SESSION_USER_INACTIVE]: API_ERROR_CODE.AUTH_SESSION_USER_INACTIVE,
}

interface ErrorResponseBody {
  code?: number
  errorCode?: unknown
  message?: string | string[]
}

interface ApiErrorResponse {
  code: number
  errorCode: ApiErrorCode
  message: string
  data: null
}

interface HttpLikeException {
  statusCode?: unknown
  status?: unknown
  message?: unknown
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<FastifyReply>()

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      response
        .status(status)
        .send(this.normalizeHttpError(status, exception.getResponse()))
      return
    }

    const status = this.resolveHttpLikeClientErrorStatus(exception)

    if (status !== null) {
      response
        .status(status)
        .send(this.buildErrorResponse(
          status,
          this.resolveErrorCode(status, status, undefined),
          this.resolveErrorMessage(status, status),
        ))
      return
    }

    this.logger.error(
      exception instanceof Error ? exception.message : 'Unknown error',
      exception instanceof Error ? exception.stack : undefined,
    )

    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send(this.buildErrorResponse(
        HttpStatus.INTERNAL_SERVER_ERROR,
        API_ERROR_CODE.INTERNAL_SERVER_ERROR,
        'Internal server error',
      ))
  }

  private normalizeHttpError(status: number, response: string | object): ApiErrorResponse {
    if (typeof response === 'string') {
      return this.buildErrorResponse(
        status,
        this.resolveErrorCode(status, status, undefined),
        this.resolveErrorMessage(status, status, {
          rawMessage: response,
          hasExplicitErrorCode: false,
        }),
      )
    }

    const body = response as ErrorResponseBody
    const code = typeof body.code === 'number' ? body.code : status
    const hasExplicitErrorCode = ApiErrorCodeSchema.safeParse(body.errorCode).success
    const errorCode = this.resolveErrorCode(status, code, body.errorCode)

    return this.buildErrorResponse(
      code,
      errorCode,
      this.resolveErrorMessage(status, code, {
        rawMessage: body.message,
        hasExplicitErrorCode,
      }),
    )
  }

  private resolveErrorMessage(
    status: number,
    code: number,
    options: {
      rawMessage?: string | string[]
      hasExplicitErrorCode?: boolean
    } = {},
  ): string {
    return this.resolveAuthErrorMessage(code)
      ?? this.resolveBusinessErrorMessage(status, options)
      ?? HTTP_ERROR_MESSAGES[status as HttpStatus]
      ?? 'Unexpected error'
  }

  private buildErrorResponse(
    code: number,
    errorCode: ApiErrorCode,
    message: string,
  ): ApiErrorResponse {
    return {
      code,
      errorCode,
      message,
      data: null,
    }
  }

  private resolveErrorCode(status: number, code: number, rawErrorCode: unknown): ApiErrorCode {
    const parsedErrorCode = ApiErrorCodeSchema.safeParse(rawErrorCode)
    if (parsedErrorCode.success) {
      return parsedErrorCode.data
    }

    return AUTH_API_ERROR_CODES[code as AuthErrorCode]
      ?? HTTP_ERROR_CODES[status as HttpStatus]
      ?? API_ERROR_CODE.INTERNAL_SERVER_ERROR
  }

  private resolveHttpLikeClientErrorStatus(exception: unknown): number | null {
    if (!exception || typeof exception !== 'object') {
      return null
    }

    const error = exception as HttpLikeException
    const status = typeof error.statusCode === 'number'
      ? error.statusCode
      : typeof error.status === 'number'
        ? error.status
        : null

    if (!status || status < 400 || status > 499) {
      return null
    }

    return status
  }

  private resolveAuthErrorMessage(code: number): string | undefined {
    return AUTH_ERROR_MESSAGES[code as AuthErrorCode]
  }

  private resolveBusinessErrorMessage(
    status: number,
    options: {
      rawMessage?: string | string[]
      hasExplicitErrorCode?: boolean
    },
  ): string | undefined {
    if (status >= 500 || options.hasExplicitErrorCode) {
      return undefined
    }

    if (Array.isArray(options.rawMessage)) {
      const message = options.rawMessage
        .map(item => item.trim())
        .filter(Boolean)
        .join('; ')

      return message || undefined
    }

    const message = options.rawMessage?.trim()
    return message || undefined
  }
}
