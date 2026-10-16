import type {
  CreateDocumentRequest,
  CreateDocumentResponse,
  DocumentBase,
  DocumentCurrent,
  DocumentItem,
  DocumentTreeGroup,
  DocumentVisibility,
  OwnedDocumentCollectionId,
  PatchDocumentLayoutRequest,
  PatchDocumentMetaRequest,
  ReadableDocumentSearchResult,
  SearchReadableDocumentsQuery,
  SearchReadableDocumentsResponse,
  TiptapJsonContent,
} from '@haohaoxue/lexora-contracts'
import type { PersistedDocument, WorkspaceDocumentContext } from '../core/documents.utils'
import {
  DOCUMENT_COLLECTION,
  DOCUMENT_DEFAULT_TITLE,
  DOCUMENT_VERSION_SNAPSHOT_SOURCE,
  DOCUMENT_VISIBILITY,
  TIPTAP_SCHEMA_VERSION,
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_TYPE,
} from '@haohaoxue/lexora-contracts'
import {
  createDocumentTitleContent,
  getDocumentTitlePlainText,
  resolveOwnedDocumentCollectionId,
  summarizeDocumentContent,
} from '@haohaoxue/lexora-shared'
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { DocumentStatus, Prisma } from '@prisma/client'
import { PrismaService } from '../../../database/prisma.service'
import { DocumentContentService } from '../content/content.service'
import { DocumentAccessService } from '../core/access.service'
import {
  buildWorkspaceDocumentContext,
  canUserAccessWorkspaceDocument,
  collectDescendantDocumentIds,
  documentSelect,

} from '../core/documents.utils'

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentAccessService: DocumentAccessService,
    private readonly documentContentService: DocumentContentService,
  ) {}

  async createDocument(userId: string, payload: CreateDocumentRequest): Promise<CreateDocumentResponse> {
    const workspace = await this.documentAccessService.assertAccessibleWorkspace(userId, payload.workspaceId)
    const normalizedParentId = payload.parentId ?? null
    let nextVisibility = normalizeDocumentVisibilityForWorkspace({
      workspaceType: workspace.type,
      requestedVisibility: payload.visibility,
    })

    if (normalizedParentId) {
      const parentDocument = await this.documentAccessService.assertCanEditDocument(userId, normalizedParentId)

      if (parentDocument.workspaceId !== workspace.id) {
        throw new BadRequestException('父文档与目标空间不一致')
      }

      if (!parentDocument.access.capabilities.canCreateChild) {
        throw new ForbiddenException('无权在此文档下创建子页面')
      }

      nextVisibility = parentDocument.visibility
    }

    const lastSibling = await this.prisma.document.findFirst({
      where: {
        workspaceId: workspace.id,
        parentId: normalizedParentId,
      },
      orderBy: {
        order: 'desc',
      },
      select: {
        order: true,
      },
    })

    const title = createDocumentTitleContent(payload.title.trim() || DOCUMENT_DEFAULT_TITLE)
    const body: TiptapJsonContent = []

    const document = await this.prisma.$transaction(async (tx) => {
      const createdDocument = await tx.document.create({
        data: {
          workspaceId: workspace.id,
          createdBy: userId,
          visibility: nextVisibility,
          parentId: normalizedParentId,
          title: getDocumentTitlePlainText(title),
          summary: summarizeDocumentContent(body, 120, ''),
          order: (lastSibling?.order ?? -1) + 1,
        },
        select: {
          id: true,
        },
      })

      const currentProjection = await tx.documentCurrentProjection.create({
        data: {
          documentId: createdDocument.id,
          projectionRevision: 1,
          schemaVersion: TIPTAP_SCHEMA_VERSION,
          title: toPrismaJsonValue(title),
          body: toPrismaJsonValue(body),
        },
        select: {
          id: true,
        },
      })

      const versionSnapshot = await tx.documentVersionSnapshot.create({
        data: {
          documentId: createdDocument.id,
          version: 1,
          basedOnProjectionId: currentProjection.id,
          basedOnProjectionRevision: 1,
          schemaVersion: TIPTAP_SCHEMA_VERSION,
          title: toPrismaJsonValue(title),
          body: toPrismaJsonValue(body),
          source: DOCUMENT_VERSION_SNAPSHOT_SOURCE.INITIAL,
          createdBy: userId,
        },
        select: {
          id: true,
        },
      })

      await tx.document.update({
        where: {
          id: createdDocument.id,
        },
        data: {
          currentProjectionId: currentProjection.id,
          currentProjectionRevision: 1,
          latestVersionSnapshotId: versionSnapshot.id,
          versionSnapshotSeq: 1,
        },
      })

      return createdDocument
    })

    return {
      id: document.id,
    }
  }

  async getDocumentTree(userId: string, workspaceId: string): Promise<DocumentTreeGroup[]> {
    const workspace = await this.documentAccessService.assertAccessibleWorkspace(userId, workspaceId)
    const context = await this.loadWorkspaceDocumentContext({
      workspaceId: workspace.id,
      workspaceType: workspace.type,
      userId,
    })
    if (workspace.type === WORKSPACE_TYPE.TEAM) {
      return [
        {
          id: DOCUMENT_COLLECTION.PERSONAL,
          nodes: this.buildWorkspaceGroup(
            context,
            DOCUMENT_COLLECTION.PERSONAL,
            workspace.type,
          ),
        },
        {
          id: DOCUMENT_COLLECTION.TEAM,
          nodes: this.buildWorkspaceGroup(
            context,
            DOCUMENT_COLLECTION.TEAM,
            workspace.type,
          ),
        },
      ]
    }

    return [
      {
        id: DOCUMENT_COLLECTION.PERSONAL,
        nodes: this.buildWorkspaceGroup(
          context,
          DOCUMENT_COLLECTION.PERSONAL,
          workspace.type,
        ),
      },
    ]
  }

  async searchReadableDocumentsForChat(
    userId: string,
    query: SearchReadableDocumentsQuery,
  ): Promise<SearchReadableDocumentsResponse> {
    await this.documentAccessService.assertAccessibleWorkspace(userId, query.workspaceId)

    const normalizedQuery = query.query.trim()
    if (!normalizedQuery) {
      return { documents: [] }
    }

    const documents = await this.prisma.document.findMany({
      where: {
        workspaceId: query.workspaceId,
        title: {
          contains: normalizedQuery,
          mode: 'insensitive',
        },
        status: {
          in: [DocumentStatus.ACTIVE, DocumentStatus.LOCKED],
        },
        trashedAt: null,
        workspace: {
          members: {
            some: {
              userId,
              status: WORKSPACE_MEMBER_STATUS.ACTIVE,
            },
          },
        },
        OR: [
          {
            workspace: {
              type: {
                not: WORKSPACE_TYPE.TEAM,
              },
            },
          },
          {
            visibility: DOCUMENT_VISIBILITY.WORKSPACE,
          },
          {
            createdBy: userId,
          },
        ],
      },
      select: {
        id: true,
        title: true,
        workspaceId: true,
        workspace: {
          select: {
            type: true,
          },
        },
        visibility: true,
        createdBy: true,
      },
      orderBy: [
        { updatedAt: 'desc' },
        { id: 'asc' },
      ],
      take: query.limit,
    })

    return {
      documents: documents
        .filter(document => canUserAccessWorkspaceDocument({
          userId,
          workspaceType: document.workspace.type,
          visibility: document.visibility,
          createdBy: document.createdBy,
        }))
        .map(toReadableDocumentSearchResult),
    }
  }

  async patchDocumentMeta(
    userId: string,
    id: string,
    payload: PatchDocumentMetaRequest,
  ): Promise<DocumentCurrent> {
    const document = await this.documentAccessService.assertCanEditDocument(userId, id)
    let nextParentId = document.parentId
    let nextVisibility = document.visibility

    if (payload.parentId !== undefined) {
      if (!document.access.capabilities.canMove) {
        throw new ForbiddenException('无权移动此文档')
      }

      if (payload.parentId === id) {
        throw new BadRequestException('文档不能移动到自身下方')
      }

      nextParentId = payload.parentId

      if (payload.parentId) {
        const parentDocument = await this.documentAccessService.assertCanEditDocument(userId, payload.parentId)

        if (parentDocument.workspaceId !== document.workspaceId) {
          throw new BadRequestException('不允许跨空间移动文档')
        }

        nextVisibility = parentDocument.visibility
      }
    }

    if (payload.visibility !== undefined && nextParentId === null) {
      if (document.workspaceType !== WORKSPACE_TYPE.TEAM) {
        nextVisibility = DOCUMENT_VISIBILITY.PRIVATE
      }
      else {
        if (document.createdBy !== userId) {
          throw new ForbiddenException('仅创建者可以调整文档可见性')
        }

        nextVisibility = payload.visibility
      }
    }

    if (payload.visibility !== undefined && nextParentId !== null && payload.parentId === undefined) {
      throw new BadRequestException('非根文档不支持单独调整可见性')
    }

    const context = await this.loadWorkspaceDocumentContext({
      workspaceId: document.workspaceId,
      workspaceType: document.workspaceType,
      userId,
    })
    const descendantDocumentIds = new Set<string>()

    collectDescendantDocumentIds(id, context, descendantDocumentIds)
    descendantDocumentIds.delete(id)
    await this.prisma.$transaction(async (tx) => {
      await tx.document.update({
        where: { id },
        data: {
          parentId: nextParentId,
          visibility: nextVisibility,
        },
      })

      if (descendantDocumentIds.size > 0 && nextVisibility !== document.visibility) {
        await tx.document.updateMany({
          where: {
            id: {
              in: Array.from(descendantDocumentIds),
            },
          },
          data: {
            visibility: nextVisibility,
          },
        })
      }
    })

    return await this.documentContentService.getDocumentCurrent(userId, id)
  }

  async patchDocumentLayout(
    userId: string,
    id: string,
    payload: PatchDocumentLayoutRequest,
  ): Promise<DocumentCurrent> {
    await this.documentAccessService.assertCanEditDocument(userId, id)
    await this.prisma.document.update({
      where: { id },
      data: {
        pageWidthMode: payload.pageWidthMode,
      },
    })

    return await this.documentContentService.getDocumentCurrent(userId, id)
  }

  private async loadWorkspaceDocumentContext(input: {
    workspaceId: string
    workspaceType: string
    userId: string
  }): Promise<WorkspaceDocumentContext> {
    const documents = await this.prisma.document.findMany({
      where: {
        workspaceId: input.workspaceId,
        status: {
          in: [DocumentStatus.ACTIVE, DocumentStatus.LOCKED],
        },
        trashedAt: null,
        ...(input.workspaceType === WORKSPACE_TYPE.TEAM
          ? {
              OR: [
                {
                  visibility: DOCUMENT_VISIBILITY.WORKSPACE,
                },
                {
                  createdBy: input.userId,
                },
              ],
            }
          : {}),
      },
      select: documentSelect,
      orderBy: [
        { order: 'asc' },
        { updatedAt: 'desc' },
      ],
    })

    return buildWorkspaceDocumentContext(documents.filter(document =>
      canUserAccessWorkspaceDocument({
        userId: input.userId,
        workspaceType: input.workspaceType,
        visibility: document.visibility,
        createdBy: document.createdBy,
      }),
    ))
  }

  private buildWorkspaceGroup(
    context: WorkspaceDocumentContext,
    collectionId: OwnedDocumentCollectionId,
    workspaceType: string,
  ): DocumentItem[] {
    return (context.childrenByParent.get(null) ?? [])
      .filter(document =>
        resolveOwnedDocumentCollectionId({
          workspaceType,
          visibility: document.visibility,
        }) === collectionId,
      )
      .map(document =>
        this.buildWorkspaceBranch(
          document,
          context,
          workspaceType,
        ),
      )
  }

  private buildWorkspaceBranch(
    document: PersistedDocument,
    context: WorkspaceDocumentContext,
    workspaceType: string,
  ): DocumentItem {
    const collectionId = resolveOwnedDocumentCollectionId({
      workspaceType,
      visibility: document.visibility,
    })
    const children = (context.childrenByParent.get(document.id) ?? [])
      .filter(child =>
        resolveOwnedDocumentCollectionId({
          workspaceType,
          visibility: child.visibility,
        }) === collectionId,
      )
      .map(child =>
        this.buildWorkspaceBranch(
          child,
          context,
          workspaceType,
        ),
      )

    return {
      ...toDocumentBase(document),
      parentId: document.parentId,
      hasChildren: children.length > 0,
      hasContent: Boolean(document.currentProjectionId) && document.summary.length > 0,
      children,
    }
  }
}

function toDocumentBase(document: PersistedDocument): DocumentBase {
  return {
    id: document.id,
    title: document.title,
    summary: document.summary,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  }
}

function toReadableDocumentSearchResult(document: {
  id: string
  title: string
  workspaceId: string
  workspace: {
    type: string
  }
}): ReadableDocumentSearchResult {
  return {
    id: document.id,
    title: document.title,
    workspaceId: document.workspaceId,
    workspaceType: document.workspace.type as ReadableDocumentSearchResult['workspaceType'],
  }
}

function normalizeDocumentVisibilityForWorkspace(input: {
  workspaceType: string
  requestedVisibility: DocumentVisibility | undefined
}): DocumentVisibility {
  if (input.workspaceType !== WORKSPACE_TYPE.TEAM) {
    return DOCUMENT_VISIBILITY.PRIVATE
  }

  return input.requestedVisibility === DOCUMENT_VISIBILITY.WORKSPACE
    ? DOCUMENT_VISIBILITY.WORKSPACE
    : DOCUMENT_VISIBILITY.PRIVATE
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}
