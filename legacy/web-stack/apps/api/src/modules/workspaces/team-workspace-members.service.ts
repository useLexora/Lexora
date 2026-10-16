import type {
  TeamWorkspaceSummary,
  WorkspaceMemberSummary,
} from '@haohaoxue/lexora-contracts'
import {
  WORKSPACE_MEMBER_ROLE,
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_TYPE,
} from '@haohaoxue/lexora-contracts'
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'

const teamWorkspaceMembershipSelect = {
  role: true,
  status: true,
  joinedAt: true,
  workspace: {
    select: {
      id: true,
      type: true,
      name: true,
      description: true,
      iconUrl: true,
      slug: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.WorkspaceMemberSelect

const workspaceMemberSummarySelect = {
  role: true,
  status: true,
  joinedAt: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      userCode: true,
    },
  },
} satisfies Prisma.WorkspaceMemberSelect

type TeamWorkspaceMembershipRecord = Prisma.WorkspaceMemberGetPayload<{
  select: typeof teamWorkspaceMembershipSelect
}>

type WorkspaceMemberSummaryRecord = Prisma.WorkspaceMemberGetPayload<{
  select: typeof workspaceMemberSummarySelect
}>

@Injectable()
export class TeamWorkspaceMembersService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async listVisibleTeamWorkspaces(userId: string): Promise<TeamWorkspaceSummary[]> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: {
        userId,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        workspace: {
          type: WORKSPACE_TYPE.TEAM,
        },
      },
      orderBy: [
        { workspace: { createdAt: 'desc' } },
      ],
      select: teamWorkspaceMembershipSelect,
    })

    return memberships.map(mapTeamWorkspaceMembership)
  }

  async listTeamWorkspaceMembers(userId: string, workspaceId: string): Promise<WorkspaceMemberSummary[]> {
    await this.assertActiveTeamWorkspaceMembership(userId, workspaceId)

    const members = await this.prisma.workspaceMember.findMany({
      where: {
        workspaceId,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        workspace: {
          type: WORKSPACE_TYPE.TEAM,
        },
      },
      orderBy: [
        { role: 'asc' },
        { joinedAt: 'asc' },
        { createdAt: 'asc' },
      ],
      select: workspaceMemberSummarySelect,
    })

    return members.map(mapWorkspaceMemberSummary)
  }

  async getOwnedTeamWorkspaceSummary(
    userId: string,
    workspaceId: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<TeamWorkspaceSummary> {
    const membership = await db.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
        role: WORKSPACE_MEMBER_ROLE.OWNER,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        workspace: {
          type: WORKSPACE_TYPE.TEAM,
        },
      },
      select: teamWorkspaceMembershipSelect,
    })

    if (!membership) {
      throw new NotFoundException('未找到可管理的团队空间')
    }

    return mapTeamWorkspaceMembership(membership)
  }

  async assertOwnerCanManageTeamWorkspace(
    userId: string,
    workspaceId: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const membership = await db.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
        role: WORKSPACE_MEMBER_ROLE.OWNER,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        workspace: {
          type: WORKSPACE_TYPE.TEAM,
        },
      },
      select: {
        workspace: {
          select: {
            id: true,
          },
        },
      },
    })

    if (!membership) {
      throw new NotFoundException('未找到可管理的团队空间')
    }
  }

  async assertActiveTeamWorkspaceMembership(
    userId: string,
    workspaceId: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const membership = await db.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        workspace: {
          type: WORKSPACE_TYPE.TEAM,
        },
      },
      select: {
        role: true,
        status: true,
      },
    })

    if (!membership) {
      throw new NotFoundException('未找到已加入的团队空间')
    }
  }

  async hasActiveTeamWorkspaceMembership(
    workspaceId: string,
    userId: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    const membership = await db.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
      select: {
        status: true,
      },
    })

    return membership?.status === WORKSPACE_MEMBER_STATUS.ACTIVE
  }

  async activateOrCreateInvitedTeamMember(
    workspaceId: string,
    userId: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const existingMember = await db.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
      select: {
        status: true,
      },
    })

    if (existingMember?.status === WORKSPACE_MEMBER_STATUS.ACTIVE) {
      throw new BadRequestException('你已经是该团队成员')
    }

    if (existingMember) {
      await db.workspaceMember.update({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId,
          },
        },
        data: {
          role: WORKSPACE_MEMBER_ROLE.MEMBER,
          status: WORKSPACE_MEMBER_STATUS.ACTIVE,
          joinedAt: new Date(),
        },
      })

      return
    }

    await db.workspaceMember.create({
      data: {
        workspaceId,
        userId,
        role: WORKSPACE_MEMBER_ROLE.MEMBER,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        joinedAt: new Date(),
      },
    })
  }

  async transferTeamWorkspaceOwnership(
    userId: string,
    workspaceId: string,
    nextOwnerUserId: string,
  ): Promise<null> {
    const normalizedNextOwnerUserId = nextOwnerUserId.trim()

    if (!normalizedNextOwnerUserId.length) {
      throw new BadRequestException('请选择新的团队 owner')
    }

    if (normalizedNextOwnerUserId === userId) {
      throw new BadRequestException('不能转移给自己')
    }

    return await this.prisma.$transaction(async (tx) => {
      await this.assertOwnerCanManageTeamWorkspace(userId, workspaceId, tx)

      const nextOwnerMember = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: normalizedNextOwnerUserId,
          },
        },
        select: {
          role: true,
          status: true,
        },
      })

      if (
        !nextOwnerMember
        || (
          nextOwnerMember.role !== WORKSPACE_MEMBER_ROLE.MEMBER
          && nextOwnerMember.role !== WORKSPACE_MEMBER_ROLE.ADMIN
        )
        || nextOwnerMember.status !== WORKSPACE_MEMBER_STATUS.ACTIVE
      ) {
        throw new BadRequestException('只能转移给当前团队成员')
      }

      await tx.workspaceMember.update({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId,
          },
        },
        data: {
          role: WORKSPACE_MEMBER_ROLE.MEMBER,
        },
      })

      await tx.workspaceMember.update({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: normalizedNextOwnerUserId,
          },
        },
        data: {
          role: WORKSPACE_MEMBER_ROLE.OWNER,
        },
      })

      return null
    })
  }

  async leaveTeamWorkspace(userId: string, workspaceId: string): Promise<null> {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        workspace: {
          type: WORKSPACE_TYPE.TEAM,
        },
      },
      select: {
        role: true,
      },
    })

    if (!membership) {
      throw new NotFoundException('未找到已加入的团队空间')
    }

    if (membership.role === WORKSPACE_MEMBER_ROLE.OWNER) {
      throw new BadRequestException('请先转移团队所有权')
    }

    await this.prisma.workspaceMember.update({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
      data: {
        status: WORKSPACE_MEMBER_STATUS.LEFT,
      },
    })

    return null
  }

  async removeTeamWorkspaceMember(
    userId: string,
    workspaceId: string,
    memberUserId: string,
  ): Promise<null> {
    if (memberUserId === userId) {
      throw new BadRequestException('不能移除自己')
    }

    await this.assertOwnerCanManageTeamWorkspace(userId, workspaceId)

    const membership = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: memberUserId,
        },
      },
      select: {
        role: true,
        status: true,
      },
    })

    if (!membership || membership.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
      throw new NotFoundException('未找到团队成员')
    }

    if (membership.role === WORKSPACE_MEMBER_ROLE.OWNER) {
      throw new BadRequestException('不能移除团队 owner')
    }

    await this.prisma.workspaceMember.update({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: memberUserId,
        },
      },
      data: {
        status: WORKSPACE_MEMBER_STATUS.REMOVED,
      },
    })

    return null
  }
}

function mapTeamWorkspaceMembership(
  membership: TeamWorkspaceMembershipRecord,
): TeamWorkspaceSummary {
  return {
    id: membership.workspace.id,
    type: WORKSPACE_TYPE.TEAM,
    name: membership.workspace.name,
    description: membership.workspace.description,
    iconUrl: membership.workspace.iconUrl,
    slug: membership.workspace.slug,
    role: membership.role,
    status: membership.status,
    joinedAt: membership.joinedAt?.toISOString() ?? null,
    createdAt: membership.workspace.createdAt.toISOString(),
    updatedAt: membership.workspace.updatedAt.toISOString(),
  }
}

function mapWorkspaceMemberSummary(member: WorkspaceMemberSummaryRecord): WorkspaceMemberSummary {
  return {
    user: member.user,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt?.toISOString() ?? null,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  }
}
