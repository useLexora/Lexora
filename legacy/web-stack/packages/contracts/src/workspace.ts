import { z } from 'zod'
import { UserAccountIdentitySchema, UserCodeSchema } from './identity'
import {
  WORKSPACE_DESCRIPTION_MAX_LENGTH,
  WORKSPACE_INVITE_STATUS_VALUES,
  WORKSPACE_MEMBER_ROLE_VALUES,
  WORKSPACE_MEMBER_STATUS_VALUES,
  WORKSPACE_NAME_MAX_LENGTH,
  WORKSPACE_TYPE_VALUES,
} from './workspace/constants'

export {
  WORKSPACE_DESCRIPTION_MAX_LENGTH,
  WORKSPACE_ICON_MAX_BYTES,
  WORKSPACE_ICON_MIME_TYPES,
  WORKSPACE_INVITE_STATUS,
  WORKSPACE_INVITE_STATUS_VALUES,
  WORKSPACE_MEMBER_ROLE,
  WORKSPACE_MEMBER_ROLE_VALUES,
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_MEMBER_STATUS_VALUES,
  WORKSPACE_NAME_MAX_LENGTH,
  WORKSPACE_TYPE,
  WORKSPACE_TYPE_VALUES,
} from './workspace/constants'

export const WorkspaceTypeSchema = z.enum(WORKSPACE_TYPE_VALUES)
export const WorkspaceMemberRoleSchema = z.enum(WORKSPACE_MEMBER_ROLE_VALUES)
export const WorkspaceMemberStatusSchema = z.enum(WORKSPACE_MEMBER_STATUS_VALUES)
export const WorkspaceInviteStatusSchema = z.enum(WORKSPACE_INVITE_STATUS_VALUES)

const IsoDateTimeStringSchema = z.string().datetime()

export const CreateTeamWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH),
  description: z.string().trim().max(WORKSPACE_DESCRIPTION_MAX_LENGTH).optional(),
}).strict()

export const CreateWorkspaceInviteSchema = z.object({
  userCode: UserCodeSchema.or(z.string().trim().min(1).max(32)),
}).strict()

export const TransferTeamWorkspaceOwnershipSchema = z.object({
  nextOwnerUserId: z.string().trim().min(1),
}).strict()

export const PersonalWorkspaceSummarySchema = z.object({
  id: z.string(),
  type: WorkspaceTypeSchema.extract(['PERSONAL']),
  name: z.string(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
}).strict()

export const TeamWorkspaceSummarySchema = z.object({
  id: z.string(),
  type: WorkspaceTypeSchema.extract(['TEAM']),
  name: z.string(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  slug: z.string(),
  role: WorkspaceMemberRoleSchema,
  status: WorkspaceMemberStatusSchema,
  joinedAt: IsoDateTimeStringSchema.nullable(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
}).strict()

export const WorkspaceMemberSummarySchema = z.object({
  user: UserAccountIdentitySchema,
  role: WorkspaceMemberRoleSchema,
  status: WorkspaceMemberStatusSchema,
  joinedAt: IsoDateTimeStringSchema.nullable(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
}).strict()

export const WorkspaceInviteSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  invitee: UserAccountIdentitySchema,
  status: WorkspaceInviteStatusSchema,
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
}).strict()

export type WorkspaceType = z.infer<typeof WorkspaceTypeSchema>
export type WorkspaceMemberRole = z.infer<typeof WorkspaceMemberRoleSchema>
export type WorkspaceMemberStatus = z.infer<typeof WorkspaceMemberStatusSchema>
export type WorkspaceInviteStatus = z.infer<typeof WorkspaceInviteStatusSchema>
export type WorkspaceMemberSummary = z.infer<typeof WorkspaceMemberSummarySchema>

/**
 * 我的空间对应的个人空间摘要。
 */
export type PersonalWorkspaceSummary = z.infer<typeof PersonalWorkspaceSummarySchema>

/**
 * 用户可见的团队空间摘要。
 */
export type TeamWorkspaceSummary = z.infer<typeof TeamWorkspaceSummarySchema>

/**
 * 创建团队空间请求。
 */
export type CreateTeamWorkspaceRequest = z.infer<typeof CreateTeamWorkspaceSchema>

/**
 * 创建团队邀请请求。
 */
export type CreateWorkspaceInviteRequest = z.infer<typeof CreateWorkspaceInviteSchema>

/**
 * 转移团队所有权请求。
 */
export type TransferTeamWorkspaceOwnershipRequest = z.infer<typeof TransferTeamWorkspaceOwnershipSchema>

/**
 * 团队邀请摘要。
 */
export type WorkspaceInviteSummary = z.infer<typeof WorkspaceInviteSummarySchema>
