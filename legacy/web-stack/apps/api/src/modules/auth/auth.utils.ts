import type { Prisma } from '@prisma/client'
import type { OAuthProfile } from './auth.interface'
import { API_ERROR_CODE, AUTH_ERROR_CODE } from '@haohaoxue/lexora-contracts'
import { UnauthorizedException } from '@nestjs/common'

type AuthErrorCode = (typeof AUTH_ERROR_CODE)[keyof typeof AUTH_ERROR_CODE]

const AUTH_API_ERROR_CODES: Record<AuthErrorCode, (typeof API_ERROR_CODE)[keyof typeof API_ERROR_CODE]> = {
  [AUTH_ERROR_CODE.ACCESS_TOKEN_MISSING]: API_ERROR_CODE.AUTH_ACCESS_TOKEN_MISSING,
  [AUTH_ERROR_CODE.ACCESS_TOKEN_EXPIRED]: API_ERROR_CODE.AUTH_ACCESS_TOKEN_EXPIRED,
  [AUTH_ERROR_CODE.ACCESS_TOKEN_INVALID]: API_ERROR_CODE.AUTH_ACCESS_TOKEN_INVALID,
  [AUTH_ERROR_CODE.REFRESH_TOKEN_MISSING]: API_ERROR_CODE.AUTH_REFRESH_TOKEN_MISSING,
  [AUTH_ERROR_CODE.REFRESH_TOKEN_INVALID]: API_ERROR_CODE.AUTH_REFRESH_TOKEN_INVALID,
  [AUTH_ERROR_CODE.SESSION_USER_INACTIVE]: API_ERROR_CODE.AUTH_SESSION_USER_INACTIVE,
}

export function authUnauthorized(code: AuthErrorCode, message: string) {
  return new UnauthorizedException({
    code,
    errorCode: AUTH_API_ERROR_CODES[code],
    message,
  })
}

export function buildOauthAccountData(profile: OAuthProfile) {
  return {
    providerUsername: profile.username,
    providerEmail: null,
    providerEmailVerified: false,
    rawProfile: profile.rawProfile as Prisma.InputJsonValue,
  }
}
