import type {
  CreateDocumentVersionSnapshotRequest,
  CreateDocumentVersionSnapshotResponse,
  DocumentCurrent,
  DocumentCurrentProjection,
  DocumentHistory,
  DocumentVersionSnapshot,
  DocumentVersionSnapshotSource,
  RestoreDocumentVersionSnapshotRequest,
  RestoreDocumentVersionSnapshotResponse,
  SaveDocumentContentRequest,
  SaveDocumentContentResponse,
  TiptapJsonContent,
} from '@haohaoxue/lexora-contracts'
import { DOCUMENT_VERSION_SNAPSHOT_SOURCE } from '@haohaoxue/lexora-contracts'
import {
  collectDocumentAssetIds,
  createDocumentTitleContent,
  getDocumentTitlePlainText,
  hasUnresolvedDocumentAssets,
  isSameDocumentVersionSnapshotContent,
  isValidTiptapDocumentBodyContent,
  stripDocumentAssetRuntimeAttributes,
  summarizeDocumentContent,
} from '@haohaoxue/lexora-shared'
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../../database/prisma.service'
import { auditUserSummarySelect, toAuditUserSummary } from '../../users/audit-user-summary'
import { DocumentAssetsService } from '../asset/asset.service'
import { DocumentAccessService } from '../core/access.service'

const AUTO_VERSION_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000

const documentCurrentProjectionSelect = {
  id: true,
  documentId: true,
  projectionRevision: true,
  idempotencyKey: true,
  schemaVersion: true,
  title: true,
  body: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DocumentCurrentProjectionSelect

const documentVersionSnapshotSelect = {
  id: true,
  documentId: true,
  version: true,
  basedOnProjectionId: true,
  basedOnProjectionRevision: true,
  schemaVersion: true,
  title: true,
  body: true,
  source: true,
  restoredFromVersionSnapshotId: true,
  idempotencyKey: true,
  label: true,
  createdAt: true,
  createdBy: true,
  createdByUser: {
    select: auditUserSummarySelect,
  },
} satisfies Prisma.DocumentVersionSnapshotSelect

const documentVersionSnapshotMetadataSelect = {
  id: true,
  source: true,
  createdAt: true,
} satisfies Prisma.DocumentVersionSnapshotSelect

const documentCurrentSelect = {
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
  currentProjection: {
    select: documentCurrentProjectionSelect,
  },
} satisfies Prisma.DocumentSelect

type PersistedDocumentCurrent = Prisma.DocumentGetPayload<{
  select: typeof documentCurrentSelect
}>

type PersistedDocumentCurrentProjection = Prisma.DocumentCurrentProjectionGetPayload<{
  select: typeof documentCurrentProjectionSelect
}>

type PersistedDocumentVersionSnapshot = Prisma.DocumentVersionSnapshotGetPayload<{
  select: typeof documentVersionSnapshotSelect
}>

interface CreateVersionSnapshotFromProjectionInput {
  documentId: string
  projection: PersistedDocumentCurrentProjection
  source: DocumentVersionSnapshotSource
  createdBy: string | null
  restoredFromVersionSnapshotId?: string | null
  idempotencyKey?: string | null
  label?: string | null
  createdAt?: Date
}

@Injectable()
export class DocumentContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentAssetsService: DocumentAssetsService,
    private readonly documentAccessService: DocumentAccessService,
  ) {}

  async getDocumentCurrent(
    userId: string,
    id: string,
  ): Promise<DocumentCurrent> {
    const accessibleDocument = await this.documentAccessService.assertCanReadDocument(userId, id)
    const document = await this.loadDocumentCurrentRecord(id)
    return toDocumentCurrent(document, accessibleDocument.access)
  }

  async saveDocumentContent(
    userId: string,
    id: string,
    payload: SaveDocumentContentRequest,
  ): Promise<SaveDocumentContentResponse> {
    const accessibleDocument = await this.documentAccessService.assertCanEditDocument(userId, id)
    const body = stripDocumentAssetRuntimeAttributes(payload.body)
    const title = createDocumentTitleContent(getDocumentTitlePlainText(payload.title))

    if (!isValidTiptapDocumentBodyContent(body)) {
      throw new BadRequestException('正文包含不支持的内容结构')
    }

    this.assertPersistableDocumentAssets(body)
    await this.documentAssetsService.assertAssetsBelongToDocument({
      documentId: id,
      assetIds: collectDocumentAssetIds(body),
    })

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockDocumentForWrite(tx, id)

      const currentDocument = await tx.document.findUnique({
        where: { id },
        select: documentCurrentSelect,
      })

      if (!currentDocument?.currentProjection) {
        throw new NotFoundException(`Document "${id}" current projection not found`)
      }

      const existingProjection = await tx.documentCurrentProjection.findFirst({
        where: {
          documentId: id,
          idempotencyKey: payload.idempotencyKey,
        },
        select: documentCurrentProjectionSelect,
      })

      if (existingProjection) {
        if (currentDocument.currentProjectionId !== existingProjection.id) {
          throw new ConflictException('文档当前投影已变化，请刷新后重试')
        }

        return currentDocument
      }

      if (currentDocument.currentProjectionRevision !== payload.baseProjectionRevision) {
        throw new ConflictException('文档当前投影已变化，请刷新后重试')
      }

      if (isProjectionContentSame(currentDocument.currentProjection, {
        schemaVersion: payload.schemaVersion,
        title,
        body,
      })) {
        return currentDocument
      }

      const nextProjectionRevision = currentDocument.currentProjectionRevision + 1
      const projection = await tx.documentCurrentProjection.create({
        data: {
          documentId: id,
          projectionRevision: nextProjectionRevision,
          idempotencyKey: payload.idempotencyKey,
          schemaVersion: payload.schemaVersion,
          title: toPrismaJsonValue(title),
          body: toPrismaJsonValue(body),
        },
        select: documentCurrentProjectionSelect,
      })
      const document = await tx.document.update({
        where: { id },
        data: {
          currentProjectionId: projection.id,
          currentProjectionRevision: nextProjectionRevision,
          title: getDocumentTitlePlainText(title),
          summary: summarizeDocumentContent(body, 120, ''),
        },
        select: documentCurrentSelect,
      })
      const autoSnapshot = await this.maybeCreateAutoVersionSnapshotFromProjection(tx, {
        documentId: id,
        projection,
      })
      await this.pruneSupersededCurrentProjection(tx, currentDocument.currentProjection.id)

      if (!autoSnapshot) {
        return {
          ...document,
          currentProjection: projection,
        }
      }

      const documentAfterSnapshot = await tx.document.findUnique({
        where: { id },
        select: documentCurrentSelect,
      })

      if (!documentAfterSnapshot?.currentProjection) {
        throw new NotFoundException(`Document "${id}" current projection not found`)
      }

      return documentAfterSnapshot
    })

    return toDocumentCurrent(result, accessibleDocument.access)
  }

  async getDocumentVersionSnapshots(userId: string, id: string): Promise<DocumentVersionSnapshot[]> {
    await this.documentAccessService.assertCanReadDocument(userId, id)

    const snapshots = await this.loadDocumentVersionSnapshots(id)

    return snapshots.map(toDocumentVersionSnapshot)
  }

  async getDocumentHistory(userId: string, id: string): Promise<DocumentHistory> {
    await this.documentAccessService.assertCanReadDocument(userId, id)
    const document = await this.loadDocumentCurrentRecord(id)
    const snapshots = await this.loadDocumentVersionSnapshots(id)
    const currentProjection = document.currentProjection

    if (!currentProjection) {
      throw new NotFoundException(`Document "${id}" current projection not found`)
    }

    const matchedVersionSnapshot = snapshots.find(snapshot => isVersionSnapshotContentSameAsProjection(snapshot, currentProjection)) ?? null

    return {
      current: {
        projectionRevision: document.currentProjectionRevision,
        updatedAt: currentProjection.updatedAt.toISOString(),
        matchedVersionSnapshotId: matchedVersionSnapshot?.id ?? null,
        hasUnversionedChanges: !matchedVersionSnapshot,
      },
      snapshots: snapshots.map(toDocumentVersionSnapshot),
    }
  }

  async createDocumentVersionSnapshot(
    userId: string,
    id: string,
    payload: CreateDocumentVersionSnapshotRequest,
  ): Promise<CreateDocumentVersionSnapshotResponse> {
    await this.documentAccessService.assertCanEditDocument(userId, id)

    const snapshot = await this.prisma.$transaction(async (tx) => {
      await this.lockDocumentForWrite(tx, id)

      const currentDocument = await tx.document.findUnique({
        where: { id },
        select: {
          currentProjectionRevision: true,
          currentProjection: {
            select: documentCurrentProjectionSelect,
          },
        },
      })

      if (!currentDocument?.currentProjection) {
        throw new NotFoundException(`Document "${id}" current projection not found`)
      }

      if (currentDocument.currentProjectionRevision !== payload.basedOnProjectionRevision) {
        throw new ConflictException('文档当前投影已变化，请刷新后重试')
      }

      return await this.createVersionSnapshotFromProjection(tx, {
        documentId: id,
        projection: currentDocument.currentProjection,
        source: payload.source,
        createdBy: userId,
        idempotencyKey: payload.idempotencyKey ?? null,
        label: payload.label ?? null,
      })
    })

    return {
      snapshot: toDocumentVersionSnapshot(snapshot),
      latestVersionSnapshotId: snapshot.id,
    }
  }

  async restoreDocumentVersionSnapshot(
    userId: string,
    id: string,
    payload: RestoreDocumentVersionSnapshotRequest,
  ): Promise<RestoreDocumentVersionSnapshotResponse> {
    const accessibleDocument = await this.documentAccessService.assertCanEditDocument(userId, id)

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockDocumentForWrite(tx, id)

      const [currentDocument, targetSnapshot] = await Promise.all([
        tx.document.findUnique({
          where: { id },
          select: {
            ...documentCurrentSelect,
          },
        }),
        tx.documentVersionSnapshot.findFirst({
          where: {
            documentId: id,
            id: payload.versionSnapshotId,
          },
          select: documentVersionSnapshotSelect,
        }),
      ])

      if (!currentDocument?.currentProjection) {
        throw new NotFoundException(`Document "${id}" current projection not found`)
      }

      if (!targetSnapshot) {
        throw new NotFoundException(`Version snapshot "${payload.versionSnapshotId}" not found`)
      }

      if (currentDocument.currentProjectionRevision !== payload.baseProjectionRevision) {
        throw new ConflictException('文档当前投影已变化，请刷新后重试')
      }

      const nextProjectionRevision = currentDocument.currentProjectionRevision + 1
      const projection = await tx.documentCurrentProjection.create({
        data: {
          documentId: id,
          projectionRevision: nextProjectionRevision,
          schemaVersion: targetSnapshot.schemaVersion,
          title: toPrismaJsonValue(targetSnapshot.title),
          body: toPrismaJsonValue(targetSnapshot.body),
        },
        select: documentCurrentProjectionSelect,
      })
      const restoreSnapshot = await this.createVersionSnapshotFromProjection(tx, {
        documentId: id,
        projection,
        source: DOCUMENT_VERSION_SNAPSHOT_SOURCE.RESTORE,
        restoredFromVersionSnapshotId: targetSnapshot.id,
        createdBy: userId,
      })

      const document = await tx.document.update({
        where: { id },
        data: {
          currentProjectionId: projection.id,
          currentProjectionRevision: nextProjectionRevision,
          latestVersionSnapshotId: restoreSnapshot.id,
          title: getDocumentTitlePlainText(asTiptapJsonContent(targetSnapshot.title)),
          summary: summarizeDocumentContent(asTiptapJsonContent(targetSnapshot.body), 120, ''),
        },
        select: documentCurrentSelect,
      })
      await this.pruneSupersededCurrentProjection(tx, currentDocument.currentProjection.id)

      return {
        current: toDocumentCurrent(document, accessibleDocument.access),
        snapshot: toDocumentVersionSnapshot(restoreSnapshot),
      }
    })

    return result
  }

  private async loadDocumentCurrentRecord(documentId: string): Promise<PersistedDocumentCurrent> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: documentCurrentSelect,
    })

    if (!document?.currentProjection) {
      throw new NotFoundException(`Document "${documentId}" current projection not found`)
    }

    return document
  }

  private async loadDocumentVersionSnapshots(documentId: string): Promise<PersistedDocumentVersionSnapshot[]> {
    return await this.prisma.documentVersionSnapshot.findMany({
      where: {
        documentId,
      },
      select: documentVersionSnapshotSelect,
      orderBy: {
        version: 'desc',
      },
    })
  }

  private async maybeCreateAutoVersionSnapshotFromProjection(
    tx: Prisma.TransactionClient,
    input: {
      documentId: string
      projection: PersistedDocumentCurrentProjection
    },
  ): Promise<PersistedDocumentVersionSnapshot | null> {
    const latestSnapshot = await tx.documentVersionSnapshot.findFirst({
      where: {
        documentId: input.documentId,
      },
      orderBy: {
        version: 'desc',
      },
      select: documentVersionSnapshotMetadataSelect,
    })

    const shouldCreateInitialAutoSnapshot = latestSnapshot?.source === DOCUMENT_VERSION_SNAPSHOT_SOURCE.INITIAL
    const shouldCreateScheduledAutoSnapshot = !latestSnapshot
      || input.projection.createdAt.getTime() - latestSnapshot.createdAt.getTime() >= AUTO_VERSION_SNAPSHOT_INTERVAL_MS

    if (!shouldCreateInitialAutoSnapshot && !shouldCreateScheduledAutoSnapshot) {
      return null
    }

    if (latestSnapshot) {
      const latestSnapshotContent = await tx.documentVersionSnapshot.findUnique({
        where: { id: latestSnapshot.id },
        select: documentVersionSnapshotSelect,
      })

      if (!latestSnapshotContent) {
        throw new NotFoundException(`Version snapshot "${latestSnapshot.id}" not found`)
      }

      if (isVersionSnapshotContentSameAsProjection(latestSnapshotContent, input.projection)) {
        return null
      }
    }

    return await this.createVersionSnapshotFromProjection(tx, {
      documentId: input.documentId,
      projection: input.projection,
      source: DOCUMENT_VERSION_SNAPSHOT_SOURCE.AUTO,
      createdBy: null,
      idempotencyKey: createAutoVersionSnapshotIdempotencyKey(input.projection),
    })
  }

  private async createVersionSnapshotFromProjection(
    tx: Prisma.TransactionClient,
    input: CreateVersionSnapshotFromProjectionInput,
  ): Promise<PersistedDocumentVersionSnapshot> {
    if (input.idempotencyKey) {
      const existingSnapshot = await tx.documentVersionSnapshot.findFirst({
        where: {
          documentId: input.documentId,
          idempotencyKey: input.idempotencyKey,
        },
        select: documentVersionSnapshotSelect,
      })

      if (existingSnapshot) {
        return existingSnapshot
      }
    }

    await this.lockVersionSnapshotSequence(tx, input.documentId)

    if (input.idempotencyKey) {
      const existingSnapshot = await tx.documentVersionSnapshot.findFirst({
        where: {
          documentId: input.documentId,
          idempotencyKey: input.idempotencyKey,
        },
        select: documentVersionSnapshotSelect,
      })

      if (existingSnapshot) {
        return existingSnapshot
      }
    }

    const nextVersion = await this.allocateNextVersionSnapshotNumber(tx, input.documentId)
    const createdSnapshot = await tx.documentVersionSnapshot.create({
      data: {
        documentId: input.documentId,
        version: nextVersion,
        basedOnProjectionId: input.projection.id,
        basedOnProjectionRevision: input.projection.projectionRevision,
        schemaVersion: input.projection.schemaVersion,
        title: toPrismaJsonValue(input.projection.title),
        body: toPrismaJsonValue(input.projection.body),
        source: input.source,
        restoredFromVersionSnapshotId: input.restoredFromVersionSnapshotId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        label: input.label ?? null,
        createdAt: input.createdAt,
        createdBy: input.createdBy,
      },
      select: documentVersionSnapshotSelect,
    })

    await tx.document.update({
      where: { id: input.documentId },
      data: {
        latestVersionSnapshotId: createdSnapshot.id,
      },
    })

    return createdSnapshot
  }

  private async lockVersionSnapshotSequence(tx: Prisma.TransactionClient, documentId: string): Promise<void> {
    await this.lockDocumentForWrite(tx, documentId)
  }

  private async pruneSupersededCurrentProjection(
    tx: Prisma.TransactionClient,
    projectionId: string,
  ): Promise<void> {
    await tx.documentCurrentProjection.deleteMany({
      where: {
        id: projectionId,
        currentForDocument: null,
      },
    })
  }

  private async lockDocumentForWrite(tx: Prisma.TransactionClient, documentId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id"
      FROM "Document"
      WHERE "id" = ${documentId}
      FOR UPDATE
    `)

    if (rows.length === 0) {
      throw new NotFoundException(`Document "${documentId}" not found`)
    }
  }

  private async allocateNextVersionSnapshotNumber(tx: Prisma.TransactionClient, documentId: string): Promise<number> {
    const document = await tx.document.update({
      where: { id: documentId },
      data: {
        versionSnapshotSeq: {
          increment: 1,
        },
      },
      select: {
        versionSnapshotSeq: true,
      },
    })

    return document.versionSnapshotSeq
  }

  private assertPersistableDocumentAssets(body: TiptapJsonContent) {
    if (hasUnresolvedDocumentAssets(body)) {
      throw new BadRequestException('正文中存在未上传完成的资源，请稍后重试')
    }
  }
}

function toDocumentCurrent(
  document: PersistedDocumentCurrent,
  access: Awaited<ReturnType<DocumentAccessService['assertCanReadDocument']>>['access'],
): DocumentCurrent {
  if (!document.currentProjection) {
    throw new NotFoundException(`Document "${document.id}" current projection not found`)
  }

  return {
    document: toDocumentRecord(document, access),
    currentProjection: toDocumentCurrentProjection(document.currentProjection),
  }
}

function toDocumentBase(document: PersistedDocumentCurrent) {
  return {
    id: document.id,
    summary: document.summary,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  }
}

function toDocumentRecord(
  document: PersistedDocumentCurrent,
  access: Awaited<ReturnType<DocumentAccessService['assertCanReadDocument']>>['access'],
) {
  return {
    ...toDocumentBase(document),
    workspaceId: document.workspaceId,
    createdBy: document.createdBy,
    visibility: document.visibility,
    parentId: document.parentId,
    currentProjectionId: document.currentProjectionId,
    currentProjectionRevision: document.currentProjectionRevision,
    latestVersionSnapshotId: document.latestVersionSnapshotId,
    order: document.order,
    status: document.status,
    pageWidthMode: document.pageWidthMode,
    access,
  }
}

function toDocumentCurrentProjection(projection: PersistedDocumentCurrentProjection): DocumentCurrentProjection {
  return {
    id: projection.id,
    documentId: projection.documentId,
    projectionRevision: projection.projectionRevision,
    schemaVersion: projection.schemaVersion as DocumentCurrentProjection['schemaVersion'],
    title: asTiptapJsonContent(projection.title),
    body: asTiptapJsonContent(projection.body),
    createdAt: projection.createdAt.toISOString(),
    updatedAt: projection.updatedAt.toISOString(),
  }
}

function toDocumentVersionSnapshot(snapshot: PersistedDocumentVersionSnapshot): DocumentVersionSnapshot {
  return {
    id: snapshot.id,
    documentId: snapshot.documentId,
    version: snapshot.version,
    basedOnProjectionId: snapshot.basedOnProjectionId,
    basedOnProjectionRevision: snapshot.basedOnProjectionRevision,
    schemaVersion: snapshot.schemaVersion as DocumentVersionSnapshot['schemaVersion'],
    title: asTiptapJsonContent(snapshot.title),
    body: asTiptapJsonContent(snapshot.body),
    source: snapshot.source as DocumentVersionSnapshotSource,
    restoredFromVersionSnapshotId: snapshot.restoredFromVersionSnapshotId,
    idempotencyKey: snapshot.idempotencyKey,
    label: snapshot.label,
    createdAt: snapshot.createdAt.toISOString(),
    createdBy: snapshot.createdBy,
    createdByUser: toAuditUserSummary(snapshot.createdByUser),
  }
}

function isVersionSnapshotContentSameAsProjection(
  snapshot: PersistedDocumentVersionSnapshot,
  projection: PersistedDocumentCurrentProjection,
): boolean {
  return isSameDocumentVersionSnapshotContent(
    {
      schemaVersion: snapshot.schemaVersion as DocumentVersionSnapshot['schemaVersion'],
      title: asTiptapJsonContent(snapshot.title),
      body: asTiptapJsonContent(snapshot.body),
    },
    {
      schemaVersion: projection.schemaVersion as DocumentVersionSnapshot['schemaVersion'],
      title: asTiptapJsonContent(projection.title),
      body: asTiptapJsonContent(projection.body),
    },
  )
}

function isProjectionContentSame(
  projection: PersistedDocumentCurrentProjection,
  content: Pick<SaveDocumentContentRequest, 'schemaVersion' | 'title' | 'body'>,
): boolean {
  return isSameDocumentVersionSnapshotContent(
    {
      schemaVersion: projection.schemaVersion as DocumentVersionSnapshot['schemaVersion'],
      title: asTiptapJsonContent(projection.title),
      body: asTiptapJsonContent(projection.body),
    },
    content,
  )
}

function createAutoVersionSnapshotIdempotencyKey(projection: PersistedDocumentCurrentProjection): string {
  return `auto:projection:${projection.projectionRevision}`
}

function asTiptapJsonContent(value: Prisma.JsonValue): TiptapJsonContent {
  return (Array.isArray(value) ? value : []) as unknown as TiptapJsonContent
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}
