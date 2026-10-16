import type {
  DocumentOperationJob,
  MoveDocumentTreeOperationRequest,
  TiptapJsonContent,
} from '@haohaoxue/lexora-contracts'
import { randomUUID } from 'node:crypto'
import {
  DOCUMENT_OPERATION_JOB_STATUS,
  DOCUMENT_OPERATION_JOB_TYPE,
  DOCUMENT_VERSION_SNAPSHOT_SOURCE,
  DOCUMENT_VISIBILITY,
  TIPTAP_SCHEMA_VERSION,
  WORKSPACE_TYPE,
} from '@haohaoxue/lexora-contracts'
import {
  collectDocumentAssetIds,
  createDocumentTitleContent,
  getDocumentTitlePlainText,
  resolveRootDocumentVisibility,
  rewriteDocumentAssetIds,
  summarizeDocumentContent,
} from '@haohaoxue/lexora-shared'
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  DocumentAssetKind,
  DocumentAssetStatus,
  DocumentOperationJobStatus,
  DocumentOperationJobType,
  Prisma,
  DocumentVisibility as PrismaDocumentVisibility,
} from '@prisma/client'
import { PrismaService } from '../../../database/prisma.service'
import { StorageService } from '../../../infrastructure/storage/storage.service'
import { DocumentAccessService } from '../core/access.service'
import { DocumentOperationQueueService } from './operation-queue.service'

const documentOperationJobSelect = {
  id: true,
  type: true,
  status: true,
  sourceDocumentId: true,
  targetWorkspaceId: true,
  targetParentId: true,
  targetVisibility: true,
  documentsTotal: true,
  documentsDone: true,
  assetsTotal: true,
  assetsDone: true,
  resultDocumentId: true,
  errorMessage: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
} satisfies Prisma.DocumentOperationJobSelect

const documentOperationCurrentProjectionSelect = {
  id: true,
  documentId: true,
  projectionRevision: true,
  schemaVersion: true,
  title: true,
  body: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DocumentCurrentProjectionSelect

const documentOperationAssetSelect = {
  id: true,
  documentId: true,
  kind: true,
  status: true,
  bucket: true,
  objectKey: true,
  mimeType: true,
  size: true,
  sha256: true,
  originalFileName: true,
  width: true,
  height: true,
  createdBy: true,
} satisfies Prisma.DocumentAssetSelect

const documentOperationDocumentSelect = {
  id: true,
  workspaceId: true,
  createdBy: true,
  visibility: true,
  parentId: true,
  title: true,
  currentProjectionId: true,
  currentProjectionRevision: true,
  latestVersionSnapshotId: true,
  summary: true,
  status: true,
  order: true,
  pageWidthMode: true,
  createdAt: true,
  updatedAt: true,
  trashedAt: true,
  currentProjection: {
    select: documentOperationCurrentProjectionSelect,
  },
  assets: {
    where: {
      status: DocumentAssetStatus.READY,
      deletedAt: null,
    },
    select: documentOperationAssetSelect,
  },
} satisfies Prisma.DocumentSelect

type PersistedDocumentOperationJob = Prisma.DocumentOperationJobGetPayload<{
  select: typeof documentOperationJobSelect
}>

type PersistedOperationDocument = Prisma.DocumentGetPayload<{
  select: typeof documentOperationDocumentSelect
}>

interface CopiedAssetRecord {
  sourceAssetId: string
  data: Prisma.DocumentAssetCreateManyInput
}

interface MoveTarget {
  workspaceId: string
  workspaceType: string
  parentId: string | null
  visibility: PrismaDocumentVisibility
}

interface OperationExecutionResult {
  resultDocumentId: string
  documentsTotal: number
  assetsTotal: number
}

interface LoadDocumentSubtreeOptions {
  includeTrashed?: boolean
}

interface DocumentSubtreeRow {
  id: string
}

@Injectable()
export class DocumentOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentAccessService: DocumentAccessService,
    private readonly storageService: StorageService,
    private readonly queueService: DocumentOperationQueueService,
  ) {}

  async createDuplicateDocumentTreeJob(userId: string, documentId: string): Promise<DocumentOperationJob> {
    const sourceDocument = await this.documentAccessService.assertCanEditDocument(userId, documentId)
    const documents = await this.loadDocumentSubtree(sourceDocument.workspaceId, documentId)
    const job = await this.prisma.documentOperationJob.create({
      data: {
        type: DocumentOperationJobType.DUPLICATE_TREE,
        status: DocumentOperationJobStatus.PENDING,
        sourceDocumentId: documentId,
        targetWorkspaceId: sourceDocument.workspaceId,
        targetParentId: sourceDocument.parentId,
        targetVisibility: sourceDocument.visibility,
        documentsTotal: documents.length,
        assetsTotal: countReferencedAssets(documents),
        createdBy: userId,
      },
      select: documentOperationJobSelect,
    })

    await this.enqueueOrFail(job.id)

    return toDocumentOperationJob(job)
  }

  async createMoveDocumentTreeJob(
    userId: string,
    documentId: string,
    payload: MoveDocumentTreeOperationRequest,
  ): Promise<DocumentOperationJob> {
    const sourceDocument = await this.documentAccessService.assertCanEditDocument(userId, documentId)

    assertCanMoveDocument(sourceDocument)

    const [targetWorkspace, documents] = await Promise.all([
      this.documentAccessService.assertAccessibleWorkspace(userId, payload.targetWorkspaceId),
      this.loadDocumentSubtree(sourceDocument.workspaceId, documentId, {
        includeTrashed: true,
      }),
    ])
    const subtreeIds = new Set(documents.map(document => document.id))

    if (payload.targetParentId && subtreeIds.has(payload.targetParentId)) {
      throw new BadRequestException('文档不能移动到自身或子文档下方')
    }

    const target = await this.resolveMoveTarget(userId, targetWorkspace, payload)

    assertPrivateTeamMoveCanKeepCreator({
      userId,
      target,
      documents,
    })

    const job = await this.prisma.documentOperationJob.create({
      data: {
        type: DocumentOperationJobType.MOVE_TREE,
        status: DocumentOperationJobStatus.PENDING,
        sourceDocumentId: documentId,
        targetWorkspaceId: target.workspaceId,
        targetParentId: target.parentId,
        targetVisibility: target.visibility,
        documentsTotal: documents.length,
        assetsTotal: 0,
        createdBy: userId,
      },
      select: documentOperationJobSelect,
    })

    await this.enqueueOrFail(job.id)

    return toDocumentOperationJob(job)
  }

  async getOperationJob(userId: string, jobId: string): Promise<DocumentOperationJob> {
    const job = await this.prisma.documentOperationJob.findFirst({
      where: {
        id: jobId,
        createdBy: userId,
        deletedAt: null,
      },
      select: documentOperationJobSelect,
    })

    if (!job) {
      throw new NotFoundException('未找到文档任务')
    }

    return toDocumentOperationJob(job)
  }

  async failInterruptedRunningJobs(): Promise<number> {
    const result = await this.prisma.documentOperationJob.updateMany({
      where: {
        status: DocumentOperationJobStatus.RUNNING,
      },
      data: {
        status: DocumentOperationJobStatus.FAILED,
        errorMessage: '服务重启后任务未完成，请重新执行',
        finishedAt: new Date(),
      },
    })

    return result.count
  }

  async runOperationJob(jobId: string): Promise<void> {
    const job = await this.prisma.documentOperationJob.findUnique({
      where: {
        id: jobId,
      },
      select: documentOperationJobSelect,
    })

    if (!job || job.status !== DocumentOperationJobStatus.PENDING) {
      return
    }

    const claimed = await this.prisma.documentOperationJob.updateMany({
      where: {
        id: job.id,
        status: DocumentOperationJobStatus.PENDING,
      },
      data: {
        status: DocumentOperationJobStatus.RUNNING,
        startedAt: new Date(),
      },
    })

    if (claimed.count !== 1) {
      return
    }

    try {
      const result = job.type === DocumentOperationJobType.DUPLICATE_TREE
        ? await this.executeDuplicateDocumentTreeJob(job)
        : await this.executeMoveDocumentTreeJob(job)

      await this.prisma.documentOperationJob.update({
        where: {
          id: job.id,
        },
        data: {
          status: DocumentOperationJobStatus.SUCCEEDED,
          documentsTotal: result.documentsTotal,
          documentsDone: result.documentsTotal,
          assetsTotal: result.assetsTotal,
          assetsDone: result.assetsTotal,
          resultDocumentId: result.resultDocumentId,
          finishedAt: new Date(),
          errorMessage: null,
        },
      })
    }
    catch (error) {
      await this.prisma.documentOperationJob.update({
        where: {
          id: job.id,
        },
        data: {
          status: DocumentOperationJobStatus.FAILED,
          errorMessage: formatOperationError(error),
          finishedAt: new Date(),
        },
      })
    }
  }

  private async executeDuplicateDocumentTreeJob(job: PersistedDocumentOperationJob): Promise<OperationExecutionResult> {
    if (!job.sourceDocumentId) {
      throw new BadRequestException('缺少源文档')
    }

    const sourceDocument = await this.documentAccessService.assertCanEditDocument(job.createdBy, job.sourceDocumentId)
    const sourceDocuments = await this.loadDocumentSubtree(sourceDocument.workspaceId, job.sourceDocumentId)
    const assetsTotal = countReferencedAssets(sourceDocuments)
    const rootDocument = sourceDocuments[0]

    if (!rootDocument) {
      throw new NotFoundException('源文档不存在')
    }

    const copiedDocumentIdBySourceId = new Map(
      sourceDocuments.map(document => [document.id, randomUUID()]),
    )
    const copiedAssetsBySourceDocumentId = new Map<string, CopiedAssetRecord[]>()
    const rewrittenAssetIdBySourceDocumentId = new Map<string, Record<string, string>>()

    await this.prisma.documentOperationJob.update({
      where: {
        id: job.id,
      },
      data: {
        documentsTotal: sourceDocuments.length,
        assetsTotal,
      },
    })

    const copiedAssetsForCleanup: CopiedAssetRecord[] = []
    const rootCopyId = copiedDocumentIdBySourceId.get(rootDocument.id)

    if (!rootCopyId) {
      throw new NotFoundException('源文档不存在')
    }

    try {
      for (const source of sourceDocuments) {
        const copiedDocumentId = copiedDocumentIdBySourceId.get(source.id)

        if (!copiedDocumentId || !source.currentProjection) {
          throw new NotFoundException('源文档当前内容不存在')
        }

        const assetIds = collectReferencedAssetIds(source.currentProjection)
        const copiedAssets = await this.copyReferencedAssets({
          jobId: job.id,
          sourceDocument: source,
          targetDocumentId: copiedDocumentId,
          assetIds,
          createdBy: job.createdBy,
        })

        copiedAssetsBySourceDocumentId.set(source.id, copiedAssets.records)
        rewrittenAssetIdBySourceDocumentId.set(source.id, copiedAssets.assetIdBySourceId)
        copiedAssetsForCleanup.push(...copiedAssets.records)
      }

      await this.prisma.$transaction(async (tx) => {
        await this.shiftSiblingOrdersAfter(tx, {
          workspaceId: rootDocument.workspaceId,
          parentId: rootDocument.parentId,
          visibility: rootDocument.visibility,
          afterOrder: rootDocument.order,
        })

        for (const source of sourceDocuments) {
          const copiedDocumentId = copiedDocumentIdBySourceId.get(source.id)!
          const copiedParentId = source.id === rootDocument.id
            ? rootDocument.parentId
            : copiedDocumentIdBySourceId.get(source.parentId ?? '') ?? null
          const copiedTitleText = source.id === rootDocument.id
            ? `${source.title || '新文档'} 副本`
            : source.title
          const copiedTitle = source.id === rootDocument.id
            ? createDocumentTitleContent(copiedTitleText)
            : asTiptapJsonContent(source.currentProjection?.title)
          const assetIdBySourceId = rewrittenAssetIdBySourceDocumentId.get(source.id) ?? {}
          const copiedBody = rewriteDocumentAssetIds(
            asTiptapJsonContent(source.currentProjection?.body),
            assetIdBySourceId,
          )

          await this.createCopiedDocumentRecord(tx, {
            source,
            documentId: copiedDocumentId,
            parentId: copiedParentId,
            title: copiedTitle,
            body: copiedBody,
            titleText: getDocumentTitlePlainText(copiedTitle) || copiedTitleText,
            order: source.id === rootDocument.id ? rootDocument.order + 1 : source.order,
            createdBy: job.createdBy,
            assets: copiedAssetsBySourceDocumentId.get(source.id) ?? [],
          })
        }
      })
    }
    catch (error) {
      await this.cleanupCopiedAssetObjects(copiedAssetsForCleanup)
      throw error
    }

    return {
      resultDocumentId: rootCopyId,
      documentsTotal: sourceDocuments.length,
      assetsTotal,
    }
  }

  private async executeMoveDocumentTreeJob(job: PersistedDocumentOperationJob): Promise<OperationExecutionResult> {
    if (!job.sourceDocumentId || !job.targetWorkspaceId || !job.targetVisibility) {
      throw new BadRequestException('缺少移动任务参数')
    }

    const sourceDocument = await this.documentAccessService.assertCanEditDocument(job.createdBy, job.sourceDocumentId)

    assertCanMoveDocument(sourceDocument)

    const [targetWorkspace, sourceDocuments] = await Promise.all([
      this.documentAccessService.assertAccessibleWorkspace(job.createdBy, job.targetWorkspaceId),
      this.loadDocumentSubtree(sourceDocument.workspaceId, job.sourceDocumentId, {
        includeTrashed: true,
      }),
    ])
    const target = await this.resolveMoveTarget(job.createdBy, targetWorkspace, {
      targetWorkspaceId: job.targetWorkspaceId,
      targetParentId: job.targetParentId,
      targetCollectionId: job.targetVisibility === DOCUMENT_VISIBILITY.WORKSPACE
        ? 'team'
        : 'personal',
    })
    const subtreeIds = sourceDocuments.map(document => document.id)

    if (target.parentId && subtreeIds.includes(target.parentId)) {
      throw new BadRequestException('文档不能移动到自身或子文档下方')
    }

    assertPrivateTeamMoveCanKeepCreator({
      userId: job.createdBy,
      target,
      documents: sourceDocuments,
    })

    const rootDocument = sourceDocuments[0]

    if (!rootDocument) {
      throw new NotFoundException('源文档不存在')
    }

    await this.prisma.documentOperationJob.update({
      where: {
        id: job.id,
      },
      data: {
        documentsTotal: sourceDocuments.length,
        assetsTotal: 0,
      },
    })

    const isCrossWorkspaceMove = rootDocument.workspaceId !== target.workspaceId
    const isSameContainer = !isCrossWorkspaceMove
      && rootDocument.parentId === target.parentId
      && rootDocument.visibility === target.visibility
    await this.prisma.$transaction(async (tx) => {
      const nextOrder = isSameContainer
        ? rootDocument.order
        : await this.resolveAppendOrder(tx, target)

      if (isCrossWorkspaceMove) {
        await this.clearDocumentTreePublications(tx, {
          documentIds: subtreeIds,
          userId: job.createdBy,
        })
      }

      await tx.document.update({
        where: {
          id: rootDocument.id,
        },
        data: {
          workspaceId: target.workspaceId,
          parentId: target.parentId,
          visibility: target.visibility,
          order: nextOrder,
        },
      })

      const descendantIds = subtreeIds.filter(documentId => documentId !== rootDocument.id)

      if (descendantIds.length > 0) {
        await tx.document.updateMany({
          where: {
            id: {
              in: descendantIds,
            },
          },
          data: {
            workspaceId: target.workspaceId,
            visibility: target.visibility,
          },
        })
      }
    })

    return {
      resultDocumentId: rootDocument.id,
      documentsTotal: sourceDocuments.length,
      assetsTotal: 0,
    }
  }

  private async createCopiedDocumentRecord(
    tx: Prisma.TransactionClient,
    input: {
      source: PersistedOperationDocument
      documentId: string
      parentId: string | null
      title: TiptapJsonContent
      body: TiptapJsonContent
      titleText: string
      order: number
      createdBy: string
      assets: CopiedAssetRecord[]
    },
  ): Promise<void> {
    await tx.document.create({
      data: {
        id: input.documentId,
        workspaceId: input.source.workspaceId,
        visibility: input.source.visibility,
        parentId: input.parentId,
        title: input.titleText,
        summary: summarizeDocumentContent(input.body, 120, ''),
        status: input.source.status,
        order: input.order,
        pageWidthMode: input.source.pageWidthMode,
        createdBy: input.createdBy,
      },
    })

    if (input.assets.length > 0) {
      await tx.documentAsset.createMany({
        data: input.assets.map(asset => asset.data),
      })
    }

    const projection = await tx.documentCurrentProjection.create({
      data: {
        documentId: input.documentId,
        projectionRevision: 1,
        schemaVersion: TIPTAP_SCHEMA_VERSION,
        title: toPrismaJsonValue(input.title),
        body: toPrismaJsonValue(input.body),
      },
      select: {
        id: true,
      },
    })
    const snapshot = await tx.documentVersionSnapshot.create({
      data: {
        documentId: input.documentId,
        version: 1,
        basedOnProjectionId: projection.id,
        basedOnProjectionRevision: 1,
        schemaVersion: TIPTAP_SCHEMA_VERSION,
        title: toPrismaJsonValue(input.title),
        body: toPrismaJsonValue(input.body),
        source: DOCUMENT_VERSION_SNAPSHOT_SOURCE.INITIAL,
        createdBy: input.createdBy,
      },
      select: {
        id: true,
      },
    })

    await tx.document.update({
      where: {
        id: input.documentId,
      },
      data: {
        currentProjectionId: projection.id,
        currentProjectionRevision: 1,
        latestVersionSnapshotId: snapshot.id,
        versionSnapshotSeq: 1,
      },
    })
  }

  private async copyReferencedAssets(input: {
    jobId: string
    sourceDocument: PersistedOperationDocument
    targetDocumentId: string
    assetIds: string[]
    createdBy: string
  }): Promise<{
    assetIdBySourceId: Record<string, string>
    records: CopiedAssetRecord[]
  }> {
    const sourceAssetsById = new Map(input.sourceDocument.assets.map(asset => [asset.id, asset]))
    const assetIdBySourceId: Record<string, string> = {}
    const records: CopiedAssetRecord[] = []

    for (const assetId of input.assetIds) {
      const sourceAsset = sourceAssetsById.get(assetId)

      if (!sourceAsset) {
        throw new BadRequestException('源文档包含无效资源引用')
      }

      const targetAssetId = randomUUID()
      const objectKey = buildDocumentAssetObjectKey({
        documentId: input.targetDocumentId,
        assetId: targetAssetId,
        extension: resolveAssetObjectKeyExtension(sourceAsset.objectKey),
      })
      const storageObject = await this.storageService.getObject({
        bucket: sourceAsset.bucket,
        key: sourceAsset.objectKey,
      })

      await this.storageService.putObject({
        bucket: sourceAsset.bucket,
        key: objectKey,
        body: storageObject.body,
        contentType: sourceAsset.mimeType,
        contentLength: storageObject.contentLength ?? sourceAsset.size,
        contentDisposition: {
          type: sourceAsset.kind === DocumentAssetKind.IMAGE ? 'inline' : 'attachment',
          fileName: sourceAsset.originalFileName,
          fallbackFileName: sourceAsset.kind === DocumentAssetKind.IMAGE ? 'asset' : 'attachment',
        },
        cacheControl: 'private, max-age=300',
      })

      assetIdBySourceId[sourceAsset.id] = targetAssetId
      records.push({
        sourceAssetId: sourceAsset.id,
        data: {
          id: targetAssetId,
          documentId: input.targetDocumentId,
          kind: sourceAsset.kind,
          status: sourceAsset.status,
          bucket: sourceAsset.bucket,
          objectKey,
          mimeType: sourceAsset.mimeType,
          size: sourceAsset.size,
          sha256: sourceAsset.sha256,
          originalFileName: sourceAsset.originalFileName,
          width: sourceAsset.width,
          height: sourceAsset.height,
          createdBy: input.createdBy,
        },
      })

      await this.incrementCopiedAssetProgress(input.jobId)
    }

    return {
      assetIdBySourceId,
      records,
    }
  }

  private async cleanupCopiedAssetObjects(records: CopiedAssetRecord[]): Promise<void> {
    await Promise.all(records.map(async record => await this.storageService.deleteObject({
      bucket: record.data.bucket,
      key: record.data.objectKey,
    })))
  }

  private async loadDocumentSubtree(
    workspaceId: string,
    rootDocumentId: string,
    options: LoadDocumentSubtreeOptions = {},
  ): Promise<PersistedOperationDocument[]> {
    const rows = await this.prisma.$queryRaw<DocumentSubtreeRow[]>(Prisma.sql`
      WITH RECURSIVE "document_subtree" AS (
        SELECT "id"
        FROM "Document"
        WHERE "id" = ${rootDocumentId}
          AND "workspaceId" = ${workspaceId}
          AND "status" IN ('ACTIVE'::"DocumentStatus", 'LOCKED'::"DocumentStatus")
          ${options.includeTrashed ? Prisma.empty : Prisma.sql`AND "trashedAt" IS NULL`}

        UNION ALL

        SELECT child."id"
        FROM "Document" child
        INNER JOIN "document_subtree" parent ON child."parentId" = parent."id"
        WHERE child."workspaceId" = ${workspaceId}
          AND child."status" IN ('ACTIVE'::"DocumentStatus", 'LOCKED'::"DocumentStatus")
          ${options.includeTrashed ? Prisma.empty : Prisma.sql`AND child."trashedAt" IS NULL`}
      )
      SELECT "id"
      FROM "document_subtree"
    `)
    const subtreeIds = rows.map(row => row.id)

    if (subtreeIds.length === 0) {
      throw new NotFoundException('源文档不存在')
    }

    const documents = await this.prisma.document.findMany({
      where: {
        id: {
          in: subtreeIds,
        },
      },
      select: documentOperationDocumentSelect,
      orderBy: [
        { order: 'asc' },
        { updatedAt: 'desc' },
      ],
    })
    const documentsById = new Map(documents.map(document => [document.id, document]))
    const rootDocument = documentsById.get(rootDocumentId)

    if (!rootDocument) {
      throw new NotFoundException('源文档不存在')
    }

    const childrenByParent = new Map<string | null, PersistedOperationDocument[]>()

    for (const document of documents) {
      const siblings = childrenByParent.get(document.parentId) ?? []
      siblings.push(document)
      childrenByParent.set(document.parentId, siblings)
    }

    const result: PersistedOperationDocument[] = []
    collectSubtreeDocuments(rootDocument, childrenByParent, result)

    return result
  }

  private async resolveMoveTarget(
    userId: string,
    workspace: { id: string, type: string },
    payload: MoveDocumentTreeOperationRequest,
  ): Promise<MoveTarget> {
    const normalizedParentId = payload.targetParentId?.trim() || null
    let visibility: PrismaDocumentVisibility = resolveRootDocumentVisibility({
      workspaceType: workspace.type,
      collectionId: payload.targetCollectionId,
    }) as PrismaDocumentVisibility

    if (normalizedParentId) {
      const parentDocument = await this.documentAccessService.assertCanEditDocument(userId, normalizedParentId)

      if (parentDocument.workspaceId !== workspace.id) {
        throw new BadRequestException('目标父文档与目标空间不一致')
      }

      if (!parentDocument.access.capabilities.canCreateChild) {
        throw new ForbiddenException('无权移动到此父文档下')
      }

      visibility = parentDocument.visibility as PrismaDocumentVisibility
    }

    return {
      workspaceId: workspace.id,
      workspaceType: workspace.type,
      parentId: normalizedParentId,
      visibility,
    }
  }

  private async resolveAppendOrder(tx: Prisma.TransactionClient, target: MoveTarget): Promise<number> {
    const lastSibling = await tx.document.findFirst({
      where: {
        workspaceId: target.workspaceId,
        parentId: target.parentId,
        ...(target.parentId === null
          ? {
              visibility: target.visibility,
            }
          : {}),
      },
      orderBy: {
        order: 'desc',
      },
      select: {
        order: true,
      },
    })

    return (lastSibling?.order ?? -1) + 1
  }

  private async shiftSiblingOrdersAfter(
    tx: Prisma.TransactionClient,
    input: {
      workspaceId: string
      parentId: string | null
      visibility: PrismaDocumentVisibility
      afterOrder: number
    },
  ): Promise<void> {
    await tx.document.updateMany({
      where: {
        workspaceId: input.workspaceId,
        parentId: input.parentId,
        order: {
          gt: input.afterOrder,
        },
        ...(input.parentId === null
          ? {
              visibility: input.visibility,
            }
          : {}),
      },
      data: {
        order: {
          increment: 1,
        },
      },
    })
  }

  private async clearDocumentTreePublications(
    tx: Prisma.TransactionClient,
    input: {
      documentIds: string[]
      userId: string
    },
  ): Promise<void> {
    await tx.documentSinglePublicationSetting.updateMany({
      where: {
        documentId: {
          in: input.documentIds,
        },
      },
      data: {
        state: 'DISABLED',
        updatedBy: input.userId,
      },
    })

    await tx.documentPublicationPage.updateMany({
      where: {
        documentId: {
          in: input.documentIds,
        },
        status: 'ACTIVE',
      },
      data: {
        status: 'REMOVED',
        updatedBy: input.userId,
      },
    })

    await tx.documentPublicationSite.updateMany({
      where: {
        homeDocumentId: {
          in: input.documentIds,
        },
      },
      data: {
        homeDocumentId: null,
        updatedBy: input.userId,
      },
    })
  }

  private async enqueueOrFail(jobId: string): Promise<void> {
    try {
      await this.queueService.enqueue(jobId)
    }
    catch (error) {
      await this.prisma.documentOperationJob.update({
        where: {
          id: jobId,
        },
        data: {
          status: DocumentOperationJobStatus.FAILED,
          errorMessage: formatOperationError(error),
          finishedAt: new Date(),
        },
      })

      throw error
    }
  }

  private async incrementCopiedAssetProgress(jobId: string): Promise<void> {
    await this.prisma.documentOperationJob.update({
      where: {
        id: jobId,
      },
      data: {
        assetsDone: {
          increment: 1,
        },
      },
    })
  }
}

function collectSubtreeDocuments(
  document: PersistedOperationDocument,
  childrenByParent: ReadonlyMap<string | null, PersistedOperationDocument[]>,
  result: PersistedOperationDocument[],
): void {
  result.push(document)

  for (const child of childrenByParent.get(document.id) ?? []) {
    collectSubtreeDocuments(child, childrenByParent, result)
  }
}

function collectReferencedAssetIds(projection: {
  title: Prisma.JsonValue
  body: Prisma.JsonValue
}): string[] {
  return Array.from(new Set([
    ...collectDocumentAssetIds(asTiptapJsonContent(projection.title)),
    ...collectDocumentAssetIds(asTiptapJsonContent(projection.body)),
  ]))
}

function countReferencedAssets(documents: PersistedOperationDocument[]): number {
  return documents.reduce((total, document) => {
    if (!document.currentProjection) {
      return total
    }

    return total + collectReferencedAssetIds(document.currentProjection).length
  }, 0)
}

function assertPrivateTeamMoveCanKeepCreator(input: {
  userId: string
  target: MoveTarget
  documents: PersistedOperationDocument[]
}): void {
  if (
    input.target.workspaceType !== WORKSPACE_TYPE.TEAM
    || input.target.visibility !== DOCUMENT_VISIBILITY.PRIVATE
  ) {
    return
  }

  if (input.documents.every(document => document.createdBy === input.userId)) {
    return
  }

  throw new BadRequestException('只能将自己创建的文档移动到团队私有区')
}

function buildDocumentAssetObjectKey(input: {
  documentId: string
  assetId: string
  extension: string
}): string {
  return `documents/${input.documentId}/${input.assetId}.${input.extension}`
}

function resolveAssetObjectKeyExtension(objectKey: string): string {
  const extension = objectKey.split('.').at(-1)?.trim().toLowerCase()

  if (extension && /^[a-z0-9]{1,16}$/.test(extension)) {
    return extension
  }

  return 'bin'
}

function asTiptapJsonContent(value: Prisma.JsonValue | undefined): TiptapJsonContent {
  return (Array.isArray(value) ? value : []) as unknown as TiptapJsonContent
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function assertCanMoveDocument(document: Awaited<ReturnType<DocumentAccessService['assertCanEditDocument']>>) {
  if (!document.access.capabilities.canMove) {
    throw new ForbiddenException('无权移动此文档')
  }
}

function toDocumentOperationJob(job: PersistedDocumentOperationJob): DocumentOperationJob {
  return {
    id: job.id,
    type: toDocumentOperationJobType(job.type),
    status: toDocumentOperationJobStatus(job.status),
    sourceDocumentId: job.sourceDocumentId,
    targetWorkspaceId: job.targetWorkspaceId,
    targetParentId: job.targetParentId,
    targetVisibility: job.targetVisibility,
    documentsTotal: job.documentsTotal,
    documentsDone: job.documentsDone,
    assetsTotal: job.assetsTotal,
    assetsDone: job.assetsDone,
    resultDocumentId: job.resultDocumentId,
    errorMessage: job.errorMessage,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  }
}

function toDocumentOperationJobType(type: DocumentOperationJobType): DocumentOperationJob['type'] {
  return type === DocumentOperationJobType.DUPLICATE_TREE
    ? DOCUMENT_OPERATION_JOB_TYPE.DUPLICATE_TREE
    : DOCUMENT_OPERATION_JOB_TYPE.MOVE_TREE
}

function toDocumentOperationJobStatus(status: DocumentOperationJobStatus): DocumentOperationJob['status'] {
  if (status === DocumentOperationJobStatus.PENDING) {
    return DOCUMENT_OPERATION_JOB_STATUS.PENDING
  }

  if (status === DocumentOperationJobStatus.RUNNING) {
    return DOCUMENT_OPERATION_JOB_STATUS.RUNNING
  }

  if (status === DocumentOperationJobStatus.SUCCEEDED) {
    return DOCUMENT_OPERATION_JOB_STATUS.SUCCEEDED
  }

  return DOCUMENT_OPERATION_JOB_STATUS.FAILED
}

function formatOperationError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : '文档任务执行失败'
}
