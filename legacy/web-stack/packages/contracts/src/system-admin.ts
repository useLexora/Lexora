import type { PageData, RequestPageParams } from './common'
import type { UserStatus } from './user'
import { z } from 'zod'
import { AuthMethodSchema, AuthProviderSchema } from './auth'
import {
  CountSchema,
  createPageDataSchema,
  RequestPageParamsSchema,
} from './common'

import {
  AuditUserSummarySchema,
  UserAccountIdentitySchema,
} from './identity'
import {
  UserStatusSchema,
} from './user'

export const SYSTEM_EMAIL_PROVIDER = {
  TENCENT_EXMAIL: 'TENCENT_EXMAIL',
  GOOGLE_WORKSPACE: 'GOOGLE_WORKSPACE',
} as const

export const SYSTEM_EMAIL_PROVIDER_VALUES = [
  SYSTEM_EMAIL_PROVIDER.TENCENT_EXMAIL,
  SYSTEM_EMAIL_PROVIDER.GOOGLE_WORKSPACE,
] as const

export const SYSTEM_EMAIL_PROVIDER_LABELS = {
  [SYSTEM_EMAIL_PROVIDER.TENCENT_EXMAIL]: '腾讯企业邮箱',
  [SYSTEM_EMAIL_PROVIDER.GOOGLE_WORKSPACE]: 'Google Workspace',
} as const satisfies Record<(typeof SYSTEM_EMAIL_PROVIDER_VALUES)[number], string>

export const SYSTEM_EMAIL_PROVIDER_DEFAULTS = {
  [SYSTEM_EMAIL_PROVIDER.TENCENT_EXMAIL]: {
    smtpHost: 'smtp.exmail.qq.com',
    smtpPort: 465,
    smtpSecure: true,
  },
  [SYSTEM_EMAIL_PROVIDER.GOOGLE_WORKSPACE]: {
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: true,
  },
} as const satisfies Record<(typeof SYSTEM_EMAIL_PROVIDER_VALUES)[number], {
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
}>

export const SystemEmailProviderSchema = z.enum(SYSTEM_EMAIL_PROVIDER_VALUES)

const IsoDateTimeStringSchema = z.string().datetime()
const SystemAuditFieldsSchema = z.object({
  updatedAt: IsoDateTimeStringSchema.nullable(),
  updatedBy: z.string().trim().min(1).nullable(),
  updatedByUser: AuditUserSummarySchema.nullable(),
}).strict()
const SystemEmailConfigFieldsSchema = z.object({
  provider: SystemEmailProviderSchema,
  smtpHost: z.string().trim().max(120),
  smtpPort: z.number().int().positive(),
  smtpSecure: z.boolean(),
  smtpUsername: z.string().trim().max(120),
  fromName: z.string().trim().max(80),
  fromEmail: z.string().trim().max(120),
}).strict()

export const SystemAdminOverviewSchema = z.object({
  totalUsers: CountSchema,
  activeUsers: CountSchema,
  disabledUsers: CountSchema,
  systemAdminCount: CountSchema,
  totalDocuments: CountSchema,
  publishedDocuments: CountSchema,
  lockedDocuments: CountSchema,
}).strict()

export const SYSTEM_ADMIN_USER_ROLE_FILTER = {
  SYSTEM_ADMIN: 'system_admin',
  REGULAR_USER: 'regular_user',
} as const

export const SYSTEM_ADMIN_USER_ROLE_FILTER_VALUES = [
  SYSTEM_ADMIN_USER_ROLE_FILTER.SYSTEM_ADMIN,
  SYSTEM_ADMIN_USER_ROLE_FILTER.REGULAR_USER,
] as const

export const SYSTEM_ADMIN_USER_ROLE_FILTER_LABELS = {
  [SYSTEM_ADMIN_USER_ROLE_FILTER.SYSTEM_ADMIN]: '系统管理员',
  [SYSTEM_ADMIN_USER_ROLE_FILTER.REGULAR_USER]: '普通用户',
} as const satisfies Record<(typeof SYSTEM_ADMIN_USER_ROLE_FILTER_VALUES)[number], string>

export const SystemAdminUserRoleFilterSchema = z.enum(SYSTEM_ADMIN_USER_ROLE_FILTER_VALUES)

export const SystemAdminUserItemSchema = UserAccountIdentitySchema.extend({
  status: UserStatusSchema,
  isSystemAdmin: z.boolean(),
  authMethods: z.array(AuthMethodSchema),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
}).strict()

export const GetSystemAdminUsersFiltersSchema = z.object({
  keyword: z.string().trim().max(120).optional(),
  status: UserStatusSchema.optional(),
  role: SystemAdminUserRoleFilterSchema.optional(),
}).strict()

export const GetSystemAdminUsersQuerySchema = RequestPageParamsSchema.extend(
  GetSystemAdminUsersFiltersSchema.shape,
)

export const SystemAdminUserListResponseSchema = createPageDataSchema(SystemAdminUserItemSchema)

export const SYSTEM_ADMIN_USER_DETAIL_LIMIT = 8

export const SystemAdminUserDocumentItemSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
}).strict()

export const SystemAdminUserChatSessionItemSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
}).strict()

export const SystemAdminUserDetailSchema = z.object({
  documentTotal: CountSchema,
  chatSessionTotal: CountSchema,
  documents: z.array(SystemAdminUserDocumentItemSchema),
  chatSessions: z.array(SystemAdminUserChatSessionItemSchema),
}).strict()

export const SYSTEM_ADMIN_AUDIT_TARGET_TYPE = {
  USER: 'user',
  SYSTEM_AUTH_CONFIG: 'system_auth_config',
  SYSTEM_EMAIL_CONFIG: 'system_email_config',
  SYSTEM_EMAIL_SERVICE: 'system_email_service',
} as const

export const SYSTEM_ADMIN_AUDIT_TARGET_TYPE_VALUES = [
  SYSTEM_ADMIN_AUDIT_TARGET_TYPE.USER,
  SYSTEM_ADMIN_AUDIT_TARGET_TYPE.SYSTEM_AUTH_CONFIG,
  SYSTEM_ADMIN_AUDIT_TARGET_TYPE.SYSTEM_EMAIL_CONFIG,
  SYSTEM_ADMIN_AUDIT_TARGET_TYPE.SYSTEM_EMAIL_SERVICE,
] as const

export const SYSTEM_ADMIN_AUDIT_TARGET_TYPE_LABELS = {
  [SYSTEM_ADMIN_AUDIT_TARGET_TYPE.USER]: '用户',
  [SYSTEM_ADMIN_AUDIT_TARGET_TYPE.SYSTEM_AUTH_CONFIG]: '注册策略',
  [SYSTEM_ADMIN_AUDIT_TARGET_TYPE.SYSTEM_EMAIL_CONFIG]: '邮件配置',
  [SYSTEM_ADMIN_AUDIT_TARGET_TYPE.SYSTEM_EMAIL_SERVICE]: '邮件服务',
} as const satisfies Record<(typeof SYSTEM_ADMIN_AUDIT_TARGET_TYPE_VALUES)[number], string>

export const SystemAdminAuditTargetTypeSchema = z.enum(SYSTEM_ADMIN_AUDIT_TARGET_TYPE_VALUES)

export const UpdateSystemAdminUserStatusRequestSchema = z.object({
  status: UserStatusSchema,
}).strict()

export const UpdateSystemAdminUserResponseSchema = SystemAdminUserItemSchema.pick({
  id: true,
  status: true,
  isSystemAdmin: true,
})

export const SystemAuthProviderGovernanceSchema = z.object({
  allowLogin: z.boolean(),
  allowRegistration: z.boolean(),
  requireInviteCode: z.boolean(),
}).strict()

export const UpdateSystemAuthProviderGovernanceSchema = SystemAuthProviderGovernanceSchema.partial().strict()

export const SystemAuthProviderGovernanceMapSchema = z.record(AuthProviderSchema, SystemAuthProviderGovernanceSchema)
export const UpdateSystemAuthProviderGovernanceMapSchema = z.partialRecord(AuthProviderSchema, UpdateSystemAuthProviderGovernanceSchema)

export const SystemAuthGovernanceSchema = z.object({
  allowPasswordRegistration: z.boolean(),
  requirePasswordInviteCode: z.boolean(),
  oauthProviders: SystemAuthProviderGovernanceMapSchema,
  hasRegistrationInviteCode: z.boolean(),
  registrationInviteCode: z.string().trim().min(4).max(120).nullable(),
  emailServiceEnabled: z.boolean(),
  systemAdminEmail: z.string().trim().email(),
  systemAdminDisplayName: z.string().trim().min(1).nullable(),
  systemAdminMustChangePassword: z.boolean(),
  systemAdminLastLoginAt: IsoDateTimeStringSchema.nullable(),
  systemAdminPasswordUpdatedAt: IsoDateTimeStringSchema.nullable(),
}).strict()

export const UpdateSystemAuthGovernanceRequestSchema = z.object({
  allowPasswordRegistration: z.boolean().optional(),
  requirePasswordInviteCode: z.boolean().optional(),
  oauthProviders: UpdateSystemAuthProviderGovernanceMapSchema.optional(),
}).strict()

export const UpdateSystemAuthInviteCodeRequestSchema = z.object({
  inviteCode: z.string().trim().max(120).refine(
    value => value.length === 0 || value.length >= 4,
    '邀请码至少 4 位',
  ),
}).strict()

export const SystemEmailLastTestSchema = z.object({
  succeeded: z.boolean(),
  testedAt: IsoDateTimeStringSchema,
  recipientEmail: z.string().trim().email().max(120),
  message: z.string().trim().min(1).max(300).nullable(),
}).strict()

export const SystemEmailConfigSchema = SystemEmailConfigFieldsSchema.extend({
  hasPassword: z.boolean(),
  lastTest: SystemEmailLastTestSchema.nullable(),
}).merge(SystemAuditFieldsSchema)

export const SystemEmailServiceStatusSchema = z.object({
  enabled: z.boolean(),
}).strict()

export const UpdateSystemEmailConfigRequestSchema = SystemEmailConfigFieldsSchema.extend({
  fromEmail: z.string().trim().email().max(120),
  smtpPassword: z.string().trim().max(256).optional(),
  clearPassword: z.boolean().optional(),
})

export const UpdateSystemEmailServiceStatusRequestSchema = z.object({
  enabled: z.boolean(),
}).strict()

export const TestSystemEmailConfigRequestSchema = z.object({
  email: z.string().trim().email().max(120),
}).strict()

export const TestSystemEmailConfigResponseSchema = z.object({
  sent: z.boolean(),
}).strict()

export const SystemAdminAuditLogItemSchema = z.object({
  id: z.string().trim().min(1),
  action: z.string().trim().min(1),
  targetType: SystemAdminAuditTargetTypeSchema,
  targetId: z.string().trim().min(1).nullable(),
  actorUserId: z.string().trim().min(1),
  actorDisplayName: z.string().trim().min(1),
  actorAvatarUrl: z.string().trim().min(1).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: IsoDateTimeStringSchema,
}).strict()

export const GetSystemAdminAuditLogsFiltersSchema = z.object({
  targetType: SystemAdminAuditTargetTypeSchema.optional(),
}).strict()

export const GetSystemAdminAuditLogsQuerySchema = RequestPageParamsSchema.extend(
  GetSystemAdminAuditLogsFiltersSchema.shape,
)

export const SystemAdminAuditLogListResponseSchema = createPageDataSchema(SystemAdminAuditLogItemSchema)

export type SystemAdminUserStatus = UserStatus
export type SystemEmailProvider = z.infer<typeof SystemEmailProviderSchema>
export type SystemAdminOverview = z.infer<typeof SystemAdminOverviewSchema>
export type SystemAdminUserItem = z.infer<typeof SystemAdminUserItemSchema>
export type SystemAdminUserDocumentItem = z.infer<typeof SystemAdminUserDocumentItemSchema>
export type SystemAdminUserChatSessionItem = z.infer<typeof SystemAdminUserChatSessionItemSchema>
export type SystemAdminUserDetail = z.infer<typeof SystemAdminUserDetailSchema>
export type SystemAdminUserRoleFilter = z.infer<typeof SystemAdminUserRoleFilterSchema>
export type SystemAdminAuditTargetType = z.infer<typeof SystemAdminAuditTargetTypeSchema>
export type GetSystemAdminUsersFilters = z.infer<typeof GetSystemAdminUsersFiltersSchema>
export interface GetSystemAdminUsersQuery extends RequestPageParams, GetSystemAdminUsersFilters {}
export interface SystemAdminUserListResponse extends PageData<SystemAdminUserItem> {}
export type UpdateSystemAdminUserStatusRequest = z.infer<typeof UpdateSystemAdminUserStatusRequestSchema>
export type UpdateSystemAdminUserResponse = z.infer<typeof UpdateSystemAdminUserResponseSchema>
export type SystemAuthProviderGovernance = z.infer<typeof SystemAuthProviderGovernanceSchema>
export type SystemAuthGovernance = z.infer<typeof SystemAuthGovernanceSchema>
export type UpdateSystemAuthGovernanceRequest = z.infer<typeof UpdateSystemAuthGovernanceRequestSchema>
export type UpdateSystemAuthInviteCodeRequest = z.infer<typeof UpdateSystemAuthInviteCodeRequestSchema>
export type SystemEmailLastTest = z.infer<typeof SystemEmailLastTestSchema>
export type SystemEmailConfig = z.infer<typeof SystemEmailConfigSchema>
export type SystemEmailServiceStatus = z.infer<typeof SystemEmailServiceStatusSchema>
export type UpdateSystemEmailConfigRequest = z.infer<typeof UpdateSystemEmailConfigRequestSchema>
export type UpdateSystemEmailServiceStatusRequest = z.infer<typeof UpdateSystemEmailServiceStatusRequestSchema>
export type TestSystemEmailConfigRequest = z.infer<typeof TestSystemEmailConfigRequestSchema>
export type TestSystemEmailConfigResponse = z.infer<typeof TestSystemEmailConfigResponseSchema>
export type SystemAdminAuditLogItem = z.infer<typeof SystemAdminAuditLogItemSchema>
export type GetSystemAdminAuditLogsFilters = z.infer<typeof GetSystemAdminAuditLogsFiltersSchema>
export interface GetSystemAdminAuditLogsQuery extends RequestPageParams, GetSystemAdminAuditLogsFilters {}
export interface SystemAdminAuditLogListResponse extends PageData<SystemAdminAuditLogItem> {}
