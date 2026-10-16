import type { CreateTeamWorkspaceRequest, TeamWorkspaceSummary } from '@haohaoxue/lexora-contracts'
import type { StorageObject } from '../../infrastructure/storage/storage.interface'
import { Buffer } from 'node:buffer'
import {
  WORKSPACE_MEMBER_ROLE,
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_TYPE,
} from '@haohaoxue/lexora-contracts'
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { StorageService } from '../../infrastructure/storage/storage.service'
import { TeamWorkspaceMembersService } from './team-workspace-members.service'
import { WORKSPACE_ICON_BUCKET } from './workspaces.constants'
import {
  assertWorkspaceIconBuffer,
  assertWorkspaceIconMimeType,
  buildWorkspaceIconStorageKey,
  buildWorkspaceIconUrl,
  createWorkspaceSlugResolver,
  normalizeWorkspaceDescription,
  normalizeWorkspaceSlugBase,
  resolveUniqueWorkspaceSlug,
} from './workspaces.utils'

const teamWorkspaceSelect = {
  id: true,
  type: true,
  name: true,
  description: true,
  iconUrl: true,
  slug: true,
  createdAt: true,
  updatedAt: true,
  members: {
    select: {
      role: true,
      status: true,
      joinedAt: true,
    },
    take: 1,
  },
} satisfies Prisma.WorkspaceSelect

type TeamWorkspaceRecord = Prisma.WorkspaceGetPayload<{
  select: typeof teamWorkspaceSelect
}>

/** 空间图标上传输入 */
export interface UpdateWorkspaceIconInput {
  fileName: string
  mimeType: string
  buffer: Buffer
}

@Injectable()
export class TeamWorkspacesService {
  private readonly logger = new Logger(TeamWorkspacesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly teamWorkspaceMembersService: TeamWorkspaceMembersService,
  ) {}

  async createTeamWorkspace(
    userId: string,
    payload: CreateTeamWorkspaceRequest,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<TeamWorkspaceSummary> {
    const normalizedName = payload.name.trim()
    const normalizedDescription = normalizeWorkspaceDescription(payload.description)
    const baseSlug = normalizeWorkspaceSlugBase(normalizedName)
    const slug = await resolveUniqueWorkspaceSlug({
      baseSlug,
      findWorkspaceBySlug: createWorkspaceSlugResolver(db),
    })

    const workspace = await db.workspace.create({
      data: {
        type: WORKSPACE_TYPE.TEAM,
        name: normalizedName,
        description: normalizedDescription,
        slug,
        members: {
          create: {
            userId,
            role: WORKSPACE_MEMBER_ROLE.OWNER,
            status: WORKSPACE_MEMBER_STATUS.ACTIVE,
            joinedAt: new Date(),
          },
        },
      },
      select: teamWorkspaceSelect,
    })

    return mapTeamWorkspace(workspace)
  }

  async updateTeamWorkspaceIcon(
    userId: string,
    workspaceId: string,
    payload: UpdateWorkspaceIconInput,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<TeamWorkspaceSummary> {
    await this.teamWorkspaceMembersService.assertOwnerCanManageTeamWorkspace(userId, workspaceId, db)

    const workspace = await db.workspace.findUnique({
      where: {
        id: workspaceId,
      },
      select: {
        id: true,
        iconStorageKey: true,
        type: true,
      },
    })

    if (!workspace || workspace.type !== WORKSPACE_TYPE.TEAM) {
      throw new NotFoundException('未找到可管理的团队空间')
    }

    const iconMimeType = assertWorkspaceIconMimeType(payload.mimeType)
    assertWorkspaceIconBuffer(payload.buffer, iconMimeType)
    const iconStorageKey = buildWorkspaceIconStorageKey(workspaceId, iconMimeType)

    await this.storageService.putObject({
      bucket: WORKSPACE_ICON_BUCKET,
      key: iconStorageKey,
      body: payload.buffer,
      contentType: iconMimeType,
      contentDisposition: {
        type: 'inline',
        fileName: payload.fileName,
        fallbackFileName: 'workspace-icon',
      },
      contentLength: payload.buffer.length,
      cacheControl: 'public, max-age=300',
    })

    const iconUrl = buildWorkspaceIconUrl(workspaceId)

    try {
      await db.workspace.update({
        where: { id: workspaceId },
        data: {
          iconUrl,
          iconStorageKey,
        },
      })
    }
    catch (error) {
      await this.removeUploadedWorkspaceIconAfterFailedUpdate({
        workspaceId,
        storageKey: iconStorageKey,
        error,
      })
    }

    await this.tryRemoveWorkspaceIconObject(workspace.iconStorageKey, {
      workspaceId,
      reason: 'replace',
    })

    return this.teamWorkspaceMembersService.getOwnedTeamWorkspaceSummary(userId, workspaceId, db)
  }

  async deleteWorkspace(userId: string, workspaceId: string): Promise<null> {
    const workspace = await this.prisma.workspace.findUnique({
      where: {
        id: workspaceId,
      },
      select: {
        id: true,
        type: true,
        iconStorageKey: true,
      },
    })

    if (!workspace) {
      throw new NotFoundException('未找到可管理的空间')
    }

    if (workspace.type === WORKSPACE_TYPE.PERSONAL) {
      throw new BadRequestException('PERSONAL Workspace 不允许删除')
    }

    await this.teamWorkspaceMembersService.assertOwnerCanManageTeamWorkspace(userId, workspaceId)
    await this.prisma.$bypass.workspace.delete({
      where: {
        id: workspaceId,
      },
    })
    await this.tryRemoveWorkspaceIconObject(workspace.iconStorageKey, {
      workspaceId,
      reason: 'delete',
    })

    return null
  }

  async getWorkspaceIcon(workspaceId: string): Promise<StorageObject> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        iconStorageKey: true,
      },
    })

    if (!workspace?.iconStorageKey) {
      throw new NotFoundException('空间图标不存在')
    }

    return this.storageService.getObject({
      bucket: WORKSPACE_ICON_BUCKET,
      key: workspace.iconStorageKey,
    })
  }

  private async removeWorkspaceIconObject(storageKey: string | null | undefined): Promise<void> {
    if (!storageKey) {
      return
    }

    await this.storageService.deleteObject({
      bucket: WORKSPACE_ICON_BUCKET,
      key: storageKey,
    })
  }

  private async tryRemoveWorkspaceIconObject(
    storageKey: string | null | undefined,
    options: {
      workspaceId: string
      reason: 'replace' | 'delete'
    },
  ): Promise<void> {
    if (!storageKey) {
      return
    }

    try {
      await this.removeWorkspaceIconObject(storageKey)
    }
    catch (error) {
      this.logger.warn(
        `workspace ${options.workspaceId} ${options.reason} icon cleanup failed: ${this.formatStorageCleanupError(error)}`,
      )
    }
  }

  private async removeUploadedWorkspaceIconAfterFailedUpdate(options: {
    workspaceId: string
    storageKey: string
    error: unknown
  }): Promise<never> {
    try {
      await this.removeWorkspaceIconObject(options.storageKey)
    }
    catch (cleanupError) {
      this.logger.warn(
        `workspace ${options.workspaceId} uploaded icon rollback failed: ${this.formatStorageCleanupError(cleanupError)}`,
      )
    }

    throw options.error
  }

  private formatStorageCleanupError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim()
    }

    return 'unknown storage error'
  }
}

function mapTeamWorkspace(workspace: TeamWorkspaceRecord): TeamWorkspaceSummary {
  const membership = workspace.members[0]

  return {
    id: workspace.id,
    type: WORKSPACE_TYPE.TEAM,
    name: workspace.name,
    description: workspace.description,
    iconUrl: workspace.iconUrl,
    slug: workspace.slug,
    role: membership.role,
    status: membership.status,
    joinedAt: membership.joinedAt?.toISOString() ?? null,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  }
}
