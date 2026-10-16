import type { SessionUserSchema } from './auth'
import type {
  AuditUserSummarySchema,
} from './identity'
import { z } from 'zod'
import { AuthProviderSchema } from './auth'
import {
  AuthPasswordSchema,
  UserAccountIdentitySchema,
  UserAvatarUrlValueSchema,
  UserEmailSchema,
} from './identity'
import { PermissionListSchema } from './rbac'
import {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  APPEARANCE_PREFERENCE_VALUES,
  LANGUAGE_PREFERENCE,
  LANGUAGE_PREFERENCE_VALUES,
  USER_STATUS_VALUES,
} from './user/constants'

export {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  APPEARANCE_PREFERENCE,
  APPEARANCE_PREFERENCE_LABELS,
  APPEARANCE_PREFERENCE_VALUES,
  LANGUAGE_PREFERENCE,
  LANGUAGE_PREFERENCE_LABELS,
  LANGUAGE_PREFERENCE_VALUES,
  USER_STATUS,
  USER_STATUS_VALUES,
} from './user/constants'

export const LanguagePreferenceSchema = z.enum(LANGUAGE_PREFERENCE_VALUES)
export const ResolvedLanguagePreferenceSchema = z.enum([
  LANGUAGE_PREFERENCE.ZH_CN,
  LANGUAGE_PREFERENCE.EN_US,
])
export const AppearancePreferenceSchema = z.enum(APPEARANCE_PREFERENCE_VALUES)
export const UserStatusSchema = z.enum(USER_STATUS_VALUES)

export const UserOauthBindingSchema = z.object({
  connected: z.boolean(),
  username: z.string().trim().min(1).nullable(),
}).strict()

export const UserOauthBindingsSchema = z.record(AuthProviderSchema, UserOauthBindingSchema)

export const UserSettingsSchema = z.object({
  profile: UserAccountIdentitySchema.pick({
    displayName: true,
    avatarUrl: true,
  }),
  account: UserAccountIdentitySchema.pick({
    email: true,
    userCode: true,
  }).extend({
    hasPasswordAuth: z.boolean(),
    emailVerified: z.boolean(),
    oauthProviders: UserOauthBindingsSchema,
  }).strict(),
  preferences: z.object({
    language: LanguagePreferenceSchema,
    appearance: AppearancePreferenceSchema,
  }).strict(),
}).strict()

export const UpdateCurrentUserProfileRequestSchema = UserAccountIdentitySchema.pick({
  displayName: true,
})

export const UpdateCurrentUserAvatarResponseSchema = z.object({
  avatarUrl: UserAvatarUrlValueSchema,
}).strict()

export const RequestBindEmailCodeRequestSchema = z.object({
  email: UserEmailSchema,
}).strict()

export const RequestBindEmailCodeResponseSchema = z.object({
  requested: z.boolean(),
}).strict()

export const ConfirmBindEmailRequestSchema = z.object({
  email: UserEmailSchema,
  code: z.string().trim().regex(/^\d{6}$/),
  newPassword: AuthPasswordSchema.optional(),
}).strict()

export const DeleteCurrentUserRequestSchema = z.object({
  accountConfirmation: z.string().trim().min(1).max(128),
  confirmationPhrase: z.literal(ACCOUNT_DELETION_CONFIRMATION_PHRASE),
}).strict()

export const DeleteCurrentUserResponseSchema = z.object({
  deleted: z.boolean(),
}).strict()

export const UpdateUserPreferencesRequestSchema = z.object({
  language: LanguagePreferenceSchema.optional(),
  appearance: AppearancePreferenceSchema.optional(),
}).strict()

export const StartOauthBindingRequestSchema = z.object({
  redirectPath: z.string().trim().min(1).max(1024).regex(/^\/(?!\/)/),
}).strict()

export const StartOauthBindingResponseSchema = z.object({
  authorizeUrl: z.string().trim().url(),
}).strict()

export const UserPermissionListSchema = PermissionListSchema

export type UserStatus = z.infer<typeof UserStatusSchema>
export type LanguagePreference = z.infer<typeof LanguagePreferenceSchema>
export type AppearancePreference = z.infer<typeof AppearancePreferenceSchema>
export type ResolvedLanguagePreference = Exclude<LanguagePreference, 'auto'>
export type ResolvedAppearancePreference = Exclude<AppearancePreference, 'auto'>
export type UserAccountIdentity = z.infer<typeof UserAccountIdentitySchema>
export type AuditUserSummary = z.infer<typeof AuditUserSummarySchema>
export type SessionUser = z.infer<typeof SessionUserSchema>

/**
 * 第三方账号绑定状态。
 */
export type UserOauthBinding = z.infer<typeof UserOauthBindingSchema>
export type UserOauthBindings = z.infer<typeof UserOauthBindingsSchema>

/**
 * 当前用户设置。
 */
export type UserSettings = z.infer<typeof UserSettingsSchema>
export type UserSettingsProfile = UserSettings['profile']
export type UserSettingsAccount = UserSettings['account']
export type UserSettingsPreferences = UserSettings['preferences']
export type UpdateCurrentUserProfileRequest = z.infer<typeof UpdateCurrentUserProfileRequestSchema>
export type UpdateCurrentUserAvatarResponse = z.infer<typeof UpdateCurrentUserAvatarResponseSchema>
export type RequestBindEmailCodeRequest = z.infer<typeof RequestBindEmailCodeRequestSchema>
export type RequestBindEmailCodeResponse = z.infer<typeof RequestBindEmailCodeResponseSchema>
export type ConfirmBindEmailRequest = z.infer<typeof ConfirmBindEmailRequestSchema>
export type DeleteCurrentUserRequest = z.infer<typeof DeleteCurrentUserRequestSchema>
export type DeleteCurrentUserResponse = z.infer<typeof DeleteCurrentUserResponseSchema>
export type UpdateUserPreferencesRequest = z.infer<typeof UpdateUserPreferencesRequestSchema>
export type StartOauthBindingRequest = z.infer<typeof StartOauthBindingRequestSchema>
export type StartOauthBindingResponse = z.infer<typeof StartOauthBindingResponseSchema>
export type UserPermissionList = z.infer<typeof UserPermissionListSchema>
