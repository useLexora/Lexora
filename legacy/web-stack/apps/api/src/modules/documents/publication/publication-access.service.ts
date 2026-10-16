import { Injectable, NotFoundException } from '@nestjs/common'
import {
  DocumentPublicationEntryStatus,
  DocumentPublicationPageScope,
  DocumentPublicationSiteStatus,
  DocumentSinglePublicationState,
  DocumentStatus,
  Prisma,
} from '@prisma/client'
import { PrismaService } from '../../../database/prisma.service'

export interface SinglePublicationAccessResolution {
  published: boolean
  sourceDocumentId: string | null
}

interface SinglePublicationAccessOptions {
  requireCurrentProjection?: boolean
}

const publicationPathDocumentSelect = {
  id: true,
  parentId: true,
  currentProjectionId: true,
  status: true,
  trashedAt: true,
} satisfies Prisma.DocumentSelect

const singlePublicationSettingSelect = {
  documentId: true,
  state: true,
  scope: true,
} satisfies Prisma.DocumentSinglePublicationSettingSelect

type PublicationPathDocument = Prisma.DocumentGetPayload<{
  select: typeof publicationPathDocumentSelect
}>

@Injectable()
export class DocumentPublicationAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveSinglePublicationAccess(
    documentId: string,
    options: SinglePublicationAccessOptions = {},
  ): Promise<SinglePublicationAccessResolution> {
    const accessByDocumentId = await this.resolveSinglePublicationAccessMap([documentId], options)

    return accessByDocumentId.get(documentId) ?? {
      published: false,
      sourceDocumentId: null,
    }
  }

  async resolveSinglePublicationAccessMap(
    documentIds: string[],
    options: SinglePublicationAccessOptions = {},
  ): Promise<Map<string, SinglePublicationAccessResolution>> {
    const uniqueDocumentIds = Array.from(new Set(documentIds))
    const accessByDocumentId = new Map<string, SinglePublicationAccessResolution>(
      uniqueDocumentIds.map(documentId => [documentId, {
        published: false,
        sourceDocumentId: null,
      }]),
    )

    if (!uniqueDocumentIds.length) {
      return accessByDocumentId
    }

    const pathsByDocumentId = await this.loadSinglePublicationPaths(uniqueDocumentIds)
    const pathDocumentIds = Array.from(
      new Set(Array.from(pathsByDocumentId.values()).flatMap(path => path.map(document => document.id))),
    )

    if (!pathDocumentIds.length) {
      return accessByDocumentId
    }

    const settings = await this.prisma.documentSinglePublicationSetting.findMany({
      where: {
        documentId: {
          in: pathDocumentIds,
        },
        state: {
          in: [DocumentSinglePublicationState.ENABLED, DocumentSinglePublicationState.DISABLED],
        },
      },
      select: singlePublicationSettingSelect,
    })
    const settingsByDocumentId = new Map(settings.map(setting => [setting.documentId, setting]))

    for (const documentId of uniqueDocumentIds) {
      const path = pathsByDocumentId.get(documentId)

      if (!path || (options.requireCurrentProjection && !path[0]?.currentProjectionId)) {
        continue
      }

      for (const [index, document] of path.entries()) {
        const setting = settingsByDocumentId.get(document.id)

        if (!setting) {
          continue
        }

        accessByDocumentId.set(documentId, {
          published: setting.state === DocumentSinglePublicationState.ENABLED
            && (index === 0 || setting.scope === DocumentPublicationPageScope.DESCENDANTS),
          sourceDocumentId: document.id,
        })
        break
      }
    }

    return accessByDocumentId
  }

  async assertSinglePublicationDocumentAccess(documentId: string): Promise<void> {
    const access = await this.resolveSinglePublicationAccess(documentId, {
      requireCurrentProjection: true,
    })

    if (!access.published) {
      throw new NotFoundException('资源不存在')
    }
  }

  async loadSitePublicationDocumentIds(siteId: string): Promise<Set<string>> {
    const site = await this.prisma.documentPublicationSite.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        workspaceId: true,
        status: true,
      },
    })

    if (!site || site.status !== DocumentPublicationSiteStatus.ACTIVE) {
      return new Set()
    }

    const pages = await this.prisma.documentPublicationPage.findMany({
      where: {
        siteId,
        status: DocumentPublicationEntryStatus.ACTIVE,
        document: {
          workspaceId: site.workspaceId,
          trashedAt: null,
          status: {
            in: [DocumentStatus.ACTIVE, DocumentStatus.LOCKED],
          },
        },
      },
      select: {
        documentId: true,
        scope: true,
      },
    })
    const documentIds = new Set(pages.map(page => page.documentId))
    const descendantRootIds = pages
      .filter(page => page.scope === DocumentPublicationPageScope.DESCENDANTS)
      .map(page => page.documentId)

    await this.collectDescendantDocumentIds({
      documentIds,
      parentIds: descendantRootIds,
      workspaceId: site.workspaceId,
    })

    const publishedDocuments = await this.prisma.document.findMany({
      where: {
        id: {
          in: Array.from(documentIds),
        },
        workspaceId: site.workspaceId,
        currentProjectionId: {
          not: null,
        },
        status: {
          in: [DocumentStatus.ACTIVE, DocumentStatus.LOCKED],
        },
        trashedAt: null,
      },
      select: {
        id: true,
      },
    })

    return new Set(publishedDocuments.map(document => document.id))
  }

  async assertSitePublicationDocumentAccess(siteId: string, documentId: string): Promise<void> {
    const documentIds = await this.loadSitePublicationDocumentIds(siteId)

    if (!documentIds.has(documentId)) {
      throw new NotFoundException('资源不存在')
    }
  }

  private async loadSinglePublicationPaths(documentIds: string[]): Promise<Map<string, PublicationPathDocument[]>> {
    const pathsByDocumentId = new Map<string, PublicationPathDocument[]>(
      documentIds.map(documentId => [documentId, []]),
    )
    const completedDocumentIds = new Set<string>()
    let currentDocumentIdByTargetId = new Map(documentIds.map(documentId => [documentId, documentId]))

    for (let depth = 0; currentDocumentIdByTargetId.size > 0 && depth < 64; depth += 1) {
      const currentDocumentIds = Array.from(new Set(currentDocumentIdByTargetId.values()))
      const documents = await this.prisma.document.findMany({
        where: {
          id: {
            in: currentDocumentIds,
          },
        },
        select: publicationPathDocumentSelect,
      })
      const documentById = new Map(documents.map(document => [document.id, document]))
      const nextDocumentIdByTargetId = new Map<string, string>()

      for (const [targetDocumentId, currentDocumentId] of currentDocumentIdByTargetId) {
        const document = documentById.get(currentDocumentId)

        if (
          !document
          || document.trashedAt
          || ![DocumentStatus.ACTIVE, DocumentStatus.LOCKED].includes(document.status)
        ) {
          pathsByDocumentId.delete(targetDocumentId)
          continue
        }

        pathsByDocumentId.get(targetDocumentId)?.push(document)

        if (document.parentId) {
          nextDocumentIdByTargetId.set(targetDocumentId, document.parentId)
        }
        else {
          completedDocumentIds.add(targetDocumentId)
        }
      }

      currentDocumentIdByTargetId = nextDocumentIdByTargetId
    }

    for (const documentId of documentIds) {
      if (!completedDocumentIds.has(documentId)) {
        pathsByDocumentId.delete(documentId)
      }
    }

    return pathsByDocumentId
  }

  private async collectDescendantDocumentIds(input: {
    documentIds: Set<string>
    parentIds: string[]
    workspaceId: string
  }): Promise<void> {
    let parentIds = input.parentIds

    for (let depth = 0; parentIds.length && depth < 64; depth += 1) {
      const children = await this.prisma.document.findMany({
        where: {
          workspaceId: input.workspaceId,
          parentId: {
            in: parentIds,
          },
          status: {
            in: [DocumentStatus.ACTIVE, DocumentStatus.LOCKED],
          },
          trashedAt: null,
        },
        select: {
          id: true,
        },
      })

      parentIds = children
        .map(child => child.id)
        .filter((id) => {
          if (input.documentIds.has(id)) {
            return false
          }

          input.documentIds.add(id)
          return true
        })
    }
  }
}
