import type { AuthProviderName } from '@haohaoxue/lexora-contracts'
import type {
  ChangePasswordRequest,
  CreateRegistrationInviteGrantRequest,
  ExchangeCodeRequest,
  LogoutResponse,
  PasswordLoginRequest,
  PasswordRegisterRequest,
  RegistrationInviteGrantResponse,
  RequestEmailVerificationRequest,
  RequestEmailVerificationResponse,
  StartOAuthLoginRequest,
  StartOAuthLoginResponse,
  TokenExchangeResponse,
} from './typing'
import { axios } from '@/utils/axios'

export * from './typing'

export function createRegistrationInviteGrant(
  data: CreateRegistrationInviteGrantRequest,
): Promise<RegistrationInviteGrantResponse> {
  return axios.request({
    method: 'post',
    url: '/auth/registration-invite/grants',
    data,
  })
}

export function startOAuthLogin(
  provider: AuthProviderName,
  data: StartOAuthLoginRequest = {},
): Promise<StartOAuthLoginResponse> {
  return axios.request({
    method: 'post',
    url: `/auth/oauth/${provider}/start`,
    data,
  })
}

export function exchangeAuthCode(data: ExchangeCodeRequest): Promise<TokenExchangeResponse> {
  return axios.request({
    method: 'post',
    url: '/auth/exchange-code',
    data,
    withCookieAuth: true,
  })
}

export function loginWithPassword(data: PasswordLoginRequest): Promise<TokenExchangeResponse> {
  return axios.request({
    method: 'post',
    url: '/auth/login/password',
    data,
    withCookieAuth: true,
  })
}

export function requestEmailVerification(
  data: RequestEmailVerificationRequest,
): Promise<RequestEmailVerificationResponse> {
  return axios.request({
    method: 'post',
    url: '/auth/verify-email/request',
    data,
  })
}

export function registerWithPassword(data: PasswordRegisterRequest): Promise<TokenExchangeResponse> {
  return axios.request({
    method: 'post',
    url: '/auth/register/password',
    data,
    withCookieAuth: true,
  })
}

export function refreshAccessToken(): Promise<TokenExchangeResponse> {
  return axios.request({
    method: 'post',
    url: '/auth/refresh',
    withCookieAuth: true,
  })
}

export function logoutAuthSession(): Promise<LogoutResponse> {
  return axios.request({
    method: 'post',
    url: '/auth/logout',
    withCookieAuth: true,
  })
}

export function changePassword(data: ChangePasswordRequest): Promise<TokenExchangeResponse> {
  return axios.request({
    method: 'post',
    url: '/auth/password/change',
    data,
    withCookieAuth: true,
  })
}
