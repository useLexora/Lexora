import type {
  GetSystemAdminAuditLogsQuery,
  GetSystemAdminUsersQuery,
  SystemAdminAuditTargetType,
  SystemAdminUserRoleFilter,
  SystemAdminUserStatus,
  UpdateSystemAdminUserStatusRequest,
  UpdateSystemAuthInviteCodeRequest,
} from '@haohaoxue/lexora-contracts'
import {
  SYSTEM_ADMIN_AUDIT_TARGET_TYPE_VALUES,
  SYSTEM_ADMIN_USER_ROLE_FILTER_VALUES,
} from '@haohaoxue/lexora-contracts'
import { UserStatus } from '@prisma/client'
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator'
import { RequestPageParamsDto } from '../../dto/request-page-params.dto'

export class GetSystemAdminUsersQueryDto extends RequestPageParamsDto implements GetSystemAdminUsersQuery {
  @IsOptional()
  @MaxLength(120)
  keyword?: string

  @IsOptional()
  @IsEnum(UserStatus)
  status?: SystemAdminUserStatus

  @IsOptional()
  @IsIn(SYSTEM_ADMIN_USER_ROLE_FILTER_VALUES)
  role?: SystemAdminUserRoleFilter
}

export class GetSystemAdminAuditLogsQueryDto extends RequestPageParamsDto implements GetSystemAdminAuditLogsQuery {
  @IsOptional()
  @IsIn(SYSTEM_ADMIN_AUDIT_TARGET_TYPE_VALUES)
  targetType?: SystemAdminAuditTargetType
}

export class UpdateSystemAdminUserStatusDto implements UpdateSystemAdminUserStatusRequest {
  @IsEnum(UserStatus)
  status!: SystemAdminUserStatus
}

export class UpdateSystemAuthInviteCodeDto implements UpdateSystemAuthInviteCodeRequest {
  @IsString()
  @MaxLength(120)
  inviteCode!: string
}
