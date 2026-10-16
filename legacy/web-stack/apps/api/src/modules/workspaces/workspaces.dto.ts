import type {
  CreateTeamWorkspaceRequest,
  CreateWorkspaceInviteRequest,
  TransferTeamWorkspaceOwnershipRequest,
} from '@haohaoxue/lexora-contracts'
import {
  WORKSPACE_DESCRIPTION_MAX_LENGTH,
  WORKSPACE_NAME_MAX_LENGTH,
} from '@haohaoxue/lexora-contracts'
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

export class CreateTeamWorkspaceDto implements CreateTeamWorkspaceRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(WORKSPACE_NAME_MAX_LENGTH)
  name!: string

  @IsOptional()
  @IsString()
  @MaxLength(WORKSPACE_DESCRIPTION_MAX_LENGTH)
  description?: string
}

export class CreateWorkspaceInviteDto implements CreateWorkspaceInviteRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  userCode!: string
}

export class TransferTeamWorkspaceOwnershipDto implements TransferTeamWorkspaceOwnershipRequest {
  @IsString()
  @MinLength(1)
  nextOwnerUserId!: string
}
