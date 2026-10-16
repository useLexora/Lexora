import type {
  DocumentAccess,
  DocumentAccessCapabilities,
  DocumentVisibility,
  WorkspaceMemberRole,
  WorkspaceType,
} from '@haohaoxue/lexora-contracts'
import {
  DOCUMENT_VISIBILITY,
  WORKSPACE_MEMBER_ROLE,
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_TYPE,
} from '@haohaoxue/lexora-contracts'
import { getWorkspaceDocumentAccessCapabilities } from '@haohaoxue/lexora-shared'
import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../../database/prisma.service'

type PersistedWorkspaceMembership = Prisma.WorkspaceMemberGetPayload<{
  select: typeof accessibleWorkspaceMembershipSelect
}>

type PersistedDocumentAccessRecord = Prisma.DocumentGetPayload<{
  select: typeof documentAccessRecordSelect
}>

export interface AccessibleDocument {
  id: string
  workspaceId: string
  parentId: string | null
  visibility: DocumentVisibility
  createdBy: string
  workspaceType: string
  workspaceMemberRole?: WorkspaceMemberRole | null
  access: DocumentAccess
}

const accessibleWorkspaceMembershipSelect = {
  workspace: {
    select: {
      id: true,
      type: true,
    },
  },
} satisfies Prisma.WorkspaceMemberSelect

const documentAccessRecordSelect = {
  id: true,
  workspaceId: true,
  parentId: true,
  visibility: true,
  createdBy: true,
  trashedAt: true,
  workspace: {
    select: {
      type: true,
      members: {
        select: {
          userId: true,
          role: true,
        },
      },
    },
  },
} satisfies Prisma.DocumentSelect

@Injectable()
export class DocumentAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assertAccessibleWorkspace(userId: string, workspaceId: string): Promise<PersistedWorkspaceMembership['workspace']> {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      },
      select: accessibleWorkspaceMembershipSelect,
    })

    if (!membership) {
      throw new NotFoundException('未找到可访问的空间')
    }

    return membership.workspace
  }

  async listAccessibleWorkspaces(userId: string): Promise<Array<PersistedWorkspaceMembership['workspace']>> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: {
        userId,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      },
      select: accessibleWorkspaceMembershipSelect,
    })

    return memberships.map(membership => membership.workspace)
  }

  async hasWorkspaceAccess(userId: string, workspaceId: string): Promise<boolean> {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      },
      select: {
        userId: true,
      },
    })

    return Boolean(membership)
  }

  async hasWorkspaceOwnerAccess(userId: string, workspaceId: string): Promise<boolean> {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId,
        status: WORKSPACE_MEMBER_STATUS.ACTIVE,
        role: WORKSPACE_MEMBER_ROLE.OWNER,
      },
      select: {
        userId: true,
      },
    })

    return Boolean(membership)
  }

  async assertCanReadDocument(userId: string, documentId: string): Promise<AccessibleDocument> {
    return this.assertDocumentAccess(userId, documentId, {
      requireEdit: false,
      requireTrashed: false,
    })
  }

  async assertCanEditDocument(userId: string, documentId: string): Promise<AccessibleDocument> {
    return this.assertDocumentAccess(userId, documentId, {
      requireEdit: true,
      requireTrashed: false,
    })
  }

  async assertCanManageTrashedDocument(userId: string, documentId: string): Promise<AccessibleDocument> {
    return this.assertDocumentAccess(userId, documentId, {
      requireEdit: true,
      requireTrashed: true,
    })
  }

  private async assertDocumentAccess(
    userId: string,
    documentId: string,
    options: {
      requireEdit: boolean
      requireTrashed: boolean
    },
  ): Promise<AccessibleDocument> {
    const document = await this.loadDocumentAccessRecord(userId, documentId)

    if (!document || (options.requireTrashed ? !document.trashedAt : Boolean(document.trashedAt))) {
      throw new NotFoundException(`Document "${documentId}" not found`)
    }

    const access = resolveWorkspaceAccess({
      userId,
      workspaceType: document.workspace.type,
      workspaceMemberRole: document.workspace.members[0]?.role,
      visibility: document.visibility,
      createdBy: document.createdBy,
    })

    if (!access || (options.requireEdit && !access.capabilities.canEdit)) {
      throw new NotFoundException(`Document "${documentId}" not found`)
    }

    return {
      id: document.id,
      workspaceId: document.workspaceId,
      parentId: document.parentId,
      visibility: document.visibility,
      createdBy: document.createdBy,
      workspaceType: document.workspace.type,
      workspaceMemberRole: document.workspace.members[0]?.role ?? null,
      access,
    }
  }

  private async loadDocumentAccessRecord(userId: string, documentId: string): Promise<PersistedDocumentAccessRecord | null> {
    return await this.prisma.document.findUnique({
      where: { id: documentId },
      select: {
        ...documentAccessRecordSelect,
        workspace: {
          select: {
            type: true,
            members: {
              where: {
                userId,
                status: WORKSPACE_MEMBER_STATUS.ACTIVE,
              },
              select: {
                userId: true,
                role: true,
              },
              take: 1,
            },
          },
        },
      },
    })
  }
}

function resolveWorkspaceAccess(input: {
  userId: string
  workspaceType: WorkspaceType
  workspaceMemberRole?: WorkspaceMemberRole | null
  visibility: string
  createdBy: string
}): DocumentAccess | null {
  const capabilities = getWorkspaceDocumentAccessCapabilities({
    workspaceType: input.workspaceType,
    workspaceMemberRole: input.workspaceMemberRole ?? null,
  })

  if (!capabilities) {
    return null
  }

  if (input.workspaceType === WORKSPACE_TYPE.PERSONAL) {
    return createDocumentAccess('OWNER', capabilities)
  }

  if (input.workspaceType !== WORKSPACE_TYPE.TEAM) {
    return null
  }

  if (input.visibility === DOCUMENT_VISIBILITY.PRIVATE) {
    return input.createdBy === input.userId
      ? createDocumentAccess('OWNER', createMaintainerCapabilities())
      : null
  }

  return createDocumentAccess('WORKSPACE', capabilities)
}

function createDocumentAccess(
  source: DocumentAccess['source'],
  capabilities: DocumentAccessCapabilities,
): DocumentAccess {
  return {
    source,
    capabilities,
  }
}

function createMaintainerCapabilities(): DocumentAccessCapabilities {
  return {
    canRead: true,
    canEdit: true,
    canCreateChild: true,
    canPublish: true,
    canMove: true,
    canTrash: true,
    canRestore: true,
  }
}
