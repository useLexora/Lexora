import { z } from 'zod'
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_PASSWORD_REQUIRED_PATTERN,
  USER_CODE_REGEX,
} from './identity/constants'

export {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_PASSWORD_REQUIRED_PATTERN,
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  USER_CODE_PREFIX,
  USER_CODE_REGEX,
} from './identity/constants'

export const UserCodeSchema = z.string().regex(USER_CODE_REGEX)
export const UserEmailSchema = z.string().trim().email()
export const UserDisplayNameSchema = z.string().trim().min(2).max(50)
export const UserAvatarUrlValueSchema = z.string().trim().min(1)
const UserAvatarUrlSchema = UserAvatarUrlValueSchema.nullable()

export const UserAccountIdentitySchema = z.object({
  id: z.string().trim().min(1),
  email: UserEmailSchema.nullable(),
  displayName: UserDisplayNameSchema,
  avatarUrl: UserAvatarUrlSchema,
  userCode: UserCodeSchema,
}).strict()

export const AuditUserSummarySchema = UserAccountIdentitySchema.pick({
  id: true,
  displayName: true,
  avatarUrl: true,
})

export const AuthPasswordSchema = z.string()
  .min(AUTH_PASSWORD_MIN_LENGTH)
  .max(AUTH_PASSWORD_MAX_LENGTH)
  .regex(AUTH_PASSWORD_REQUIRED_PATTERN)
