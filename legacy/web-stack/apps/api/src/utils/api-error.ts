import type { ApiErrorCode } from '@haohaoxue/lexora-contracts'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common'

export interface ApiErrorBody {
  code: number
  errorCode: ApiErrorCode
  message: string
}

export function apiBadRequest(errorCode: ApiErrorCode, message = 'Bad request') {
  return new BadRequestException(createApiErrorBody(400, errorCode, message))
}

export function apiForbidden(errorCode: ApiErrorCode, message = 'Forbidden') {
  return new ForbiddenException(createApiErrorBody(403, errorCode, message))
}

export function apiNotFound(errorCode: ApiErrorCode, message = 'Not found') {
  return new NotFoundException(createApiErrorBody(404, errorCode, message))
}

export function apiConflict(errorCode: ApiErrorCode, message = 'Conflict') {
  return new ConflictException(createApiErrorBody(409, errorCode, message))
}

export function apiPayloadTooLarge(errorCode: ApiErrorCode, message = 'Payload too large') {
  return new PayloadTooLargeException(createApiErrorBody(413, errorCode, message))
}

function createApiErrorBody(
  code: number,
  errorCode: ApiErrorCode,
  message: string,
): ApiErrorBody {
  return {
    code,
    errorCode,
    message,
  }
}
