import { z } from 'zod'
import {
  AUTH_METHOD_VALUES,
  AUTH_PROVIDER,
  AUTH_PROVIDER_VALUES,
} from './auth/constants'
import {
  AuthPasswordSchema,
  UserAccountIdentitySchema,
  UserDisplayNameSchema,
  UserEmailSchema,
} from './identity'
import { PermissionListSchema, RoleSchema } from './rbac'

export {
  AUTH_CALLBACK_PATH,
  AUTH_METHOD,
  AUTH_METHOD_LABELS,
  AUTH_METHOD_VALUES,
  AUTH_PROVIDER,
  AUTH_PROVIDER_ALIAS_MAP,
  AUTH_PROVIDER_VALUES,
  OAUTH_REDIRECT_BIND_STATUS,
  OAUTH_REDIRECT_ERROR_CODE,
  OAUTH_REDIRECT_QUERY,
} from './auth/constants'

export const AuthProviderSchema = z.enum(AUTH_PROVIDER_VALUES)
export const AuthMethodSchema = z.enum(AUTH_METHOD_VALUES)

const AuthTokenSchema = z.string().trim().min(1)
const EmailVerificationCodeSchema = z.string().trim().regex(/^\d{6}$/)
const RegistrationInviteCodeSchema = z.string().trim().min(4).max(120)
const RegistrationInviteGrantTokenSchema = z.string().trim().min(32)
const IsoDateTimeStringSchema = z.string().datetime()

export const SessionUserSchema = UserAccountIdentitySchema.extend({
  roles: z.array(RoleSchema),
  authMethods: z.array(AuthMethodSchema),
  mustChangePassword: z.boolean(),
  emailVerified: z.boolean(),
}).merge(PermissionListSchema)

export const ExchangeCodeRequestSchema = z.object({
  code: z.string().trim().min(20),
}).strict()

export const TokenExchangeResponseSchema = z.object({
  accessToken: AuthTokenSchema,
  expiresIn: z.number().int().positive(),
  user: SessionUserSchema,
}).strict()

export const LogoutResponseSchema = z.object({
  loggedOut: z.boolean(),
}).strict()

export const PasswordLoginRequestSchema = z.object({
  email: UserEmailSchema,
  password: AuthPasswordSchema,
}).strict()

export const RequestEmailVerificationRequestSchema = z.object({
  email: UserEmailSchema,
  registrationInviteGrantToken: RegistrationInviteGrantTokenSchema.optional(),
}).strict()

export const RequestEmailVerificationResponseSchema = z.object({
  requested: z.boolean(),
}).strict()

export const PasswordRegisterRequestSchema = z.object({
  email: UserEmailSchema,
  code: EmailVerificationCodeSchema,
  displayName: UserDisplayNameSchema,
  password: AuthPasswordSchema,
  registrationInviteGrantToken: RegistrationInviteGrantTokenSchema.optional(),
}).strict()

export const ChangePasswordRequestSchema = z.object({
  currentPassword: AuthPasswordSchema,
  newPassword: AuthPasswordSchema,
}).strict()

export const AuthProviderCapabilitySchema = z.object({
  enabled: z.boolean(),
  allowRegistration: z.boolean(),
  inviteCodeRequired: z.boolean(),
}).strict()

export const AuthCapabilitiesSchema = z.object({
  emailBindingEnabled: z.boolean(),
  passwordRegistrationEnabled: z.boolean(),
  passwordRegistrationInviteCodeRequired: z.boolean(),
  providers: z.object({
    [AUTH_PROVIDER.GOOGLE]: AuthProviderCapabilitySchema,
    [AUTH_PROVIDER.GITHUB]: AuthProviderCapabilitySchema,
    [AUTH_PROVIDER.LINUX_DO]: AuthProviderCapabilitySchema,
  }).strict(),
}).strict()

export const CreateRegistrationInviteGrantRequestSchema = z.object({
  method: AuthMethodSchema,
  email: UserEmailSchema.optional(),
  inviteCode: RegistrationInviteCodeSchema,
}).strict()

export const RegistrationInviteGrantResponseSchema = z.object({
  grantToken: RegistrationInviteGrantTokenSchema,
  expiresAt: IsoDateTimeStringSchema,
}).strict()

export const StartOAuthLoginRequestSchema = z.object({
  registrationInviteGrantToken: RegistrationInviteGrantTokenSchema.optional(),
}).strict()

export const StartOAuthLoginResponseSchema = z.object({
  authorizeUrl: z.string().trim().url(),
}).strict()

export type AuthProviderName = z.infer<typeof AuthProviderSchema>
export type AuthMethodName = z.infer<typeof AuthMethodSchema>

/**
 * 一次性登录码交换请求。
 */
export type ExchangeCodeRequest = z.infer<typeof ExchangeCodeRequestSchema>

/**
 * 访问令牌交换响应。
 */
export type TokenExchangeResponse = z.infer<typeof TokenExchangeResponseSchema>

/**
 * 登出响应。
 */
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>

export type PasswordLoginRequest = z.infer<typeof PasswordLoginRequestSchema>

export type RequestEmailVerificationRequest = z.infer<typeof RequestEmailVerificationRequestSchema>

export type RequestEmailVerificationResponse = z.infer<typeof RequestEmailVerificationResponseSchema>

export type PasswordRegisterRequest = z.infer<typeof PasswordRegisterRequestSchema>

export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>

/**
 * 第三方认证能力。
 */
export type AuthProviderCapability = z.infer<typeof AuthProviderCapabilitySchema>

/**
 * 认证能力配置。
 */
export type AuthCapabilities = z.infer<typeof AuthCapabilitiesSchema>

export type CreateRegistrationInviteGrantRequest = z.infer<typeof CreateRegistrationInviteGrantRequestSchema>

export type RegistrationInviteGrantResponse = z.infer<typeof RegistrationInviteGrantResponseSchema>

export type StartOAuthLoginRequest = z.infer<typeof StartOAuthLoginRequestSchema>

export type StartOAuthLoginResponse = z.infer<typeof StartOAuthLoginResponseSchema>
