import type { PersonalWorkspaceSummary } from '@haohaoxue/lexora-contracts'
import {
  WORKSPACE_MEMBER_ROLE,
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_TYPE,
} from '@haohaoxue/lexora-contracts'
import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import {
  buildPersonalWorkspaceName,
  buildPersonalWorkspaceSlug,
} from './workspaces.utils'

const personalWorkspaceSelect = {
  id: true,
  type: true,
  name: true,
  description: true,
  iconUrl: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WorkspaceSelect

const personalWorkspaceMembershipSelect = {
  workspace: {
    select: personalWorkspaceSelect,
  },
} satisfies Prisma.WorkspaceMemberSelect

type PersonalWorkspaceRecord = Prisma.WorkspaceGetPayload<{
  select: typeof personalWorkspaceSelect
}>

@Injectable()
export class PersonalWorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async provisionPersonalWorkspaceForUser(
    options: {
      userId: string
      userCode: string
    },
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<PersonalWorkspaceSummary> {
    const existingMembership = await this.findPersonalWorkspaceMembership(options.userId, db)

    if (existingMembership) {
      return mapPersonalWorkspace(existingMembership.workspace)
    }

    try {
      const workspace = await db.workspace.create({
        data: {
          type: WORKSPACE_TYPE.PERSONAL,
          name: buildPersonalWorkspaceName(options.userCode),
          slug: buildPersonalWorkspaceSlug(options.userCode),
          members: {
            create: {
              userId: options.userId,
              role: WORKSPACE_MEMBER_ROLE.OWNER,
              status: WORKSPACE_MEMBER_STATUS.ACTIVE,
              joinedAt: new Date(),
            },
          },
        },
        select: personalWorkspaceSelect,
      })

      return mapPersonalWorkspace(workspace)
    }
    catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error
      }

      const currentMembership = await this.findPersonalWorkspaceMembership(options.userId, db)

      if (currentMembership) {
        return mapPersonalWorkspace(currentMembership.workspace)
      }

      throw error
    }
  }

  async getPersonalWorkspace(userId: string): Promise<PersonalWorkspaceSummary> {
    const membership = await this.findPersonalWorkspaceMembership(userId)

    if (membership) {
      return mapPersonalWorkspace(membership.workspace)
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        userCode: true,
      },
    })

    if (!user) {
      throw new NotFoundException('未找到当前用户')
    }

    return this.provisionPersonalWorkspaceForUser({
      userId: user.id,
      userCode: user.userCode,
    })
  }

  private async findPersonalWorkspaceMembership(
    userId: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    return await db.workspaceMember.findFirst({
      where: {
        userId,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        workspace: {
          type: WORKSPACE_TYPE.PERSONAL,
        },
      },
      select: personalWorkspaceMembershipSelect,
    })
  }
}

function mapPersonalWorkspace(workspace: PersonalWorkspaceRecord): PersonalWorkspaceSummary {
  return {
    id: workspace.id,
    type: WORKSPACE_TYPE.PERSONAL,
    name: workspace.name,
    description: workspace.description,
    iconUrl: workspace.iconUrl,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  }
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2002'
  )
}
