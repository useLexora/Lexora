import type {
  CreateWorkspaceInviteRequest,
  WorkspaceInviteSummary,
} from '@haohaoxue/lexora-contracts'
import {
  WORKSPACE_INVITE_STATUS,
  WORKSPACE_TYPE,
} from '@haohaoxue/lexora-contracts'
import { isExactUserCodeQuery, normalizeUserCodeQuery } from '@haohaoxue/lexora-shared'
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { TeamWorkspaceMembersService } from './team-workspace-members.service'

const workspaceInviteSelect = {
  id: true,
  status: true,
  workspace: {
    select: {
      id: true,
      name: true,
    },
  },
  inviteeUser: {
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      userCode: true,
    },
  },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WorkspaceInviteSelect

type WorkspaceInviteRecord = Prisma.WorkspaceInviteGetPayload<{
  select: typeof workspaceInviteSelect
}>

@Injectable()
export class TeamWorkspaceInvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teamWorkspaceMembersService: TeamWorkspaceMembersService,
  ) {}

  async listPendingWorkspaceInvites(userId: string, workspaceId: string): Promise<WorkspaceInviteSummary[]> {
    await this.teamWorkspaceMembersService.assertOwnerCanManageTeamWorkspace(userId, workspaceId)

    const invites = await this.prisma.workspaceInvite.findMany({
      where: {
        workspaceId,
        status: WORKSPACE_INVITE_STATUS.PENDING,
        workspace: {
          type: WORKSPACE_TYPE.TEAM,
        },
      },
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: workspaceInviteSelect,
    })

    return invites.map(mapWorkspaceInvite)
  }

  async listPendingWorkspaceInvitesForInvitee(userId: string): Promise<WorkspaceInviteSummary[]> {
    const invites = await this.prisma.workspaceInvite.findMany({
      where: {
        inviteeUserId: userId,
        status: WORKSPACE_INVITE_STATUS.PENDING,
        workspace: {
          type: WORKSPACE_TYPE.TEAM,
        },
      },
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: workspaceInviteSelect,
    })

    return invites.map(mapWorkspaceInvite)
  }

  async createWorkspaceInvite(
    userId: string,
    workspaceId: string,
    payload: CreateWorkspaceInviteRequest,
  ): Promise<WorkspaceInviteSummary> {
    await this.teamWorkspaceMembersService.assertOwnerCanManageTeamWorkspace(userId, workspaceId)

    const normalizedUserCode = normalizeUserCodeQuery(payload.userCode)

    if (!isExactUserCodeQuery(normalizedUserCode)) {
      throw new NotFoundException('未找到用户')
    }

    const inviteeUser = await this.prisma.user.findUnique({
      where: { userCode: normalizedUserCode },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        userCode: true,
      },
    })

    if (!inviteeUser) {
      throw new NotFoundException('未找到用户')
    }

    if (inviteeUser.id === userId) {
      throw new BadRequestException('不能邀请自己')
    }

    if (await this.teamWorkspaceMembersService.hasActiveTeamWorkspaceMembership(workspaceId, inviteeUser.id)) {
      throw new BadRequestException('该用户已经是团队成员')
    }

    const pendingInvite = await this.prisma.workspaceInvite.findFirst({
      where: {
        workspaceId,
        inviteeUserId: inviteeUser.id,
        status: WORKSPACE_INVITE_STATUS.PENDING,
      },
      select: {
        id: true,
      },
    })

    if (pendingInvite) {
      throw new ConflictException('该用户已在邀请中')
    }

    const invite = await this.prisma.workspaceInvite.create({
      data: {
        workspaceId,
        inviteeUserId: inviteeUser.id,
        status: WORKSPACE_INVITE_STATUS.PENDING,
        createdBy: userId,
        updatedBy: userId,
      },
      select: workspaceInviteSelect,
    })

    return mapWorkspaceInvite(invite)
  }

  async cancelWorkspaceInvite(
    userId: string,
    workspaceId: string,
    inviteId: string,
  ): Promise<WorkspaceInviteSummary> {
    await this.teamWorkspaceMembersService.assertOwnerCanManageTeamWorkspace(userId, workspaceId)

    const invite = await this.prisma.workspaceInvite.findFirst({
      where: {
        id: inviteId,
        workspaceId,
        status: WORKSPACE_INVITE_STATUS.PENDING,
      },
      select: {
        id: true,
      },
    })

    if (!invite) {
      throw new NotFoundException('未找到可管理的邀请')
    }

    return mapWorkspaceInvite(await this.prisma.workspaceInvite.update({
      where: { id: inviteId },
      data: {
        status: WORKSPACE_INVITE_STATUS.CANCELED,
        updatedBy: userId,
      },
      select: workspaceInviteSelect,
    }))
  }

  async acceptWorkspaceInvite(userId: string, inviteId: string): Promise<WorkspaceInviteSummary> {
    const invite = await this.getInviteForInvitee(userId, inviteId)

    if (invite.status !== WORKSPACE_INVITE_STATUS.PENDING) {
      throw new BadRequestException('该邀请已不可用')
    }

    return await this.prisma.$transaction(async (tx) => {
      await this.teamWorkspaceMembersService.activateOrCreateInvitedTeamMember(
        invite.workspace.id,
        userId,
        tx,
      )

      return mapWorkspaceInvite(await tx.workspaceInvite.update({
        where: { id: inviteId },
        data: {
          status: WORKSPACE_INVITE_STATUS.ACCEPTED,
          updatedBy: userId,
        },
        select: workspaceInviteSelect,
      }))
    })
  }

  async declineWorkspaceInvite(userId: string, inviteId: string): Promise<WorkspaceInviteSummary> {
    const invite = await this.getInviteForInvitee(userId, inviteId)

    if (invite.status !== WORKSPACE_INVITE_STATUS.PENDING) {
      throw new BadRequestException('该邀请已不可用')
    }

    return mapWorkspaceInvite(await this.prisma.workspaceInvite.update({
      where: { id: inviteId },
      data: {
        status: WORKSPACE_INVITE_STATUS.DECLINED,
        updatedBy: userId,
      },
      select: workspaceInviteSelect,
    }))
  }

  private async getInviteForInvitee(
    userId: string,
    inviteId: string,
  ): Promise<WorkspaceInviteRecord> {
    const invite = await this.prisma.workspaceInvite.findFirst({
      where: {
        id: inviteId,
        inviteeUserId: userId,
        workspace: {
          type: WORKSPACE_TYPE.TEAM,
        },
      },
      select: workspaceInviteSelect,
    })

    if (!invite) {
      throw new NotFoundException('未找到邀请')
    }

    return invite
  }
}

function mapWorkspaceInvite(invite: WorkspaceInviteRecord): WorkspaceInviteSummary {
  return {
    id: invite.id,
    workspaceId: invite.workspace.id,
    workspaceName: invite.workspace.name,
    invitee: invite.inviteeUser,
    status: invite.status,
    createdAt: invite.createdAt.toISOString(),
    updatedAt: invite.updatedAt.toISOString(),
  }
}
