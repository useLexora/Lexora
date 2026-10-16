import type {
  PersonalWorkspaceSummary,
  TeamWorkspaceSummary,
  WorkspaceInviteSummary,
  WorkspaceMemberSummary,
} from '@haohaoxue/lexora-contracts'
import type { FastifyReply } from 'fastify'
import type { AuthUserContext } from '../auth/auth.interface'
import {
  PERMISSIONS,
} from '@haohaoxue/lexora-contracts'
import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Res,
} from '@nestjs/common'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { Public } from '../../decorators/public.decorator'
import { RequirePermissions } from '../../decorators/require-permissions.decorator'
import { PersonalWorkspacesService } from './personal-workspaces.service'
import { TeamWorkspacesService } from './team-workspaces.service'

const TEAM_WORKSPACE_DISABLED_MESSAGE = '团队空间暂未开放'

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly personalWorkspacesService: PersonalWorkspacesService,
    private readonly teamWorkspacesService: TeamWorkspacesService,
  ) {}

  @RequirePermissions(PERMISSIONS.WORKSPACE_READ_SELF)
  @Get('me/personal')
  async getPersonalWorkspace(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<PersonalWorkspaceSummary> {
    return this.personalWorkspacesService.getPersonalWorkspace(authUser.id)
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_READ_SELF)
  @Get('me/teams')
  async listVisibleTeamWorkspaces(): Promise<TeamWorkspaceSummary[]> {
    return []
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_READ_SELF)
  @Get(':workspaceId/members')
  async listTeamWorkspaceMembers(): Promise<WorkspaceMemberSummary[]> {
    this.throwTeamWorkspaceDisabled()
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_READ_SELF)
  @Get(':workspaceId/invites')
  async listPendingWorkspaceInvites(): Promise<WorkspaceInviteSummary[]> {
    this.throwTeamWorkspaceDisabled()
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_CREATE_SELF)
  @Post()
  async createTeamWorkspace(): Promise<TeamWorkspaceSummary> {
    this.throwTeamWorkspaceDisabled()
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_UPDATE_SELF)
  @Post(':workspaceId/ownership/transfer')
  async transferTeamWorkspaceOwnership(): Promise<null> {
    this.throwTeamWorkspaceDisabled()
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_UPDATE_SELF)
  @Post(':workspaceId/leave')
  async leaveTeamWorkspace(): Promise<null> {
    this.throwTeamWorkspaceDisabled()
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_UPDATE_SELF)
  @Post(':workspaceId/members/:memberUserId/remove')
  async removeTeamWorkspaceMember(): Promise<null> {
    this.throwTeamWorkspaceDisabled()
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_UPDATE_SELF)
  @Post(':workspaceId/invites')
  async createWorkspaceInvite(): Promise<WorkspaceInviteSummary> {
    this.throwTeamWorkspaceDisabled()
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_UPDATE_SELF)
  @Post(':workspaceId/invites/:inviteId/cancel')
  async cancelWorkspaceInvite(): Promise<WorkspaceInviteSummary> {
    this.throwTeamWorkspaceDisabled()
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_UPDATE_SELF)
  @Post('invites/:inviteId/accept')
  async acceptWorkspaceInvite(): Promise<WorkspaceInviteSummary> {
    this.throwTeamWorkspaceDisabled()
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_UPDATE_SELF)
  @Post('invites/:inviteId/decline')
  async declineWorkspaceInvite(): Promise<WorkspaceInviteSummary> {
    this.throwTeamWorkspaceDisabled()
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_UPDATE_SELF)
  @Put(':workspaceId/icon')
  async updateTeamWorkspaceIcon(): Promise<TeamWorkspaceSummary> {
    this.throwTeamWorkspaceDisabled()
  }

  @RequirePermissions(PERMISSIONS.WORKSPACE_UPDATE_SELF)
  @Delete(':workspaceId')
  async deleteWorkspace(): Promise<null> {
    this.throwTeamWorkspaceDisabled()
  }

  @Public()
  @Get('icon/:id')
  async getWorkspaceIcon(
    @Param('id') workspaceId: string,
    @Res() response: FastifyReply,
  ): Promise<FastifyReply> {
    const icon = await this.teamWorkspacesService.getWorkspaceIcon(workspaceId)

    response.header('cache-control', 'public, max-age=300')
    response.header('content-type', icon.contentType)

    if (icon.contentLength !== null) {
      response.header('content-length', String(icon.contentLength))
    }

    return response.send(icon.body)
  }

  private throwTeamWorkspaceDisabled(): never {
    throw new ForbiddenException(TEAM_WORKSPACE_DISABLED_MESSAGE)
  }
}
