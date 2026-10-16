import type {
  CreatePublicationPageRequest,
  CreatePublicationSectionRequest,
  DocumentSinglePublicationInfo,
  ListDocumentSinglePublicationsResponse,
  PublicationInternalLinkResolution,
  PublicationNavItemExternalTarget,
  PublicationNavItemInput,
  PublicationNavItemInternalTarget,
  PublicationNavItemType,
  PublicationRenderedDocument,
  PublicationSingleDocumentResponse,
  PublicationSiteCustomMediaResponse,
  PublicationSiteCustomMediaScope,
  PublicationSiteHomeConfig,
  PublicationSiteManagementResponse,
  PublicationSiteMediaKind,
  PublicationSiteRenderResponse,
  ReplacePublicationNavItemsRequest,
  TiptapJsonContent,
  TiptapJsonNode,
  UpdateDocumentSinglePublicationSettingRequest,
  UpdatePublicationPageRequest,
  UpdatePublicationSectionRequest,
  UpsertPublicationSiteSettingsRequest,
} from '@haohaoxue/lexora-contracts'
import type { Buffer } from 'node:buffer'
import type { StorageObject } from '../../../infrastructure/storage/storage.interface'
import type { SinglePublicationAccessResolution } from './publication-access.service'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { buffer as readStreamBuffer } from 'node:stream/consumers'
import {
  DOCUMENT_PUBLICATION_DEFAULT_SITE_HOME_CONFIG,
  DOCUMENT_PUBLICATION_ENTRY_STATUS,
  DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET,
  DOCUMENT_PUBLICATION_NAV_ITEM_MAX_DEPTH,
  DOCUMENT_PUBLICATION_NAV_ITEM_TYPE,
  DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_MAX_BYTES_BY_SCOPE,
  DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE_VALUES,
  DOCUMENT_PUBLICATION_SITE_HOME_MODE,
  DOCUMENT_PUBLICATION_SITE_MEDIA_KIND,
  DOCUMENT_PUBLICATION_SITE_MEDIA_KIND_VALUES,
  DOCUMENT_PUBLICATION_SITE_MEDIA_MAX_BYTES_BY_KIND,
  DOCUMENT_PUBLICATION_SITE_MEDIA_MIME_TYPES,
  DOCUMENT_PUBLICATION_SITE_STATUS,
  DOCUMENT_PUBLICATION_SITE_THEME,
  DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE,
  DOCUMENT_SINGLE_PUBLICATION_ROUTE_PREFIX,
  DOCUMENT_SINGLE_PUBLICATION_SCOPE,
  DOCUMENT_SINGLE_PUBLICATION_STATE,
  DOCUMENT_SITE_PUBLICATION_PAGE_SCOPE,
  DOCUMENT_SITE_PUBLICATION_ROUTE_PREFIX,
  DOCUMENT_VISIBILITY,
  PublicationSiteHomeConfigSchema,
  SERVER_PATH,
} from '@haohaoxue/lexora-contracts'
import { buildDocumentBlockIndex, buildDocumentOutline, collectDocumentAssetIds, normalizePublicationHref, prettyBytes } from '@haohaoxue/lexora-shared'
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { DocumentStatus, Prisma } from '@prisma/client'
import { PrismaService } from '../../../database/prisma.service'
import { StorageService } from '../../../infrastructure/storage/storage.service'
import { auditUserSummarySelect, toAuditUserSummary } from '../../users/audit-user-summary'
import { DocumentAccessService } from '../core/access.service'
import { DocumentPublicationAccessService } from './publication-access.service'

const PUBLICATION_SITE_MEDIA_BUCKET = 'document-publication-site-media'
const PUBLICATION_SITE_MEDIA_FALLBACK_FILE_NAME = {
  [DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.LOGO]: 'site-logo',
  [DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.HOME_LOGO]: 'home-logo',
} as const satisfies Record<PublicationSiteMediaKind, string>

type PublicationSiteMediaMimeType = (typeof DOCUMENT_PUBLICATION_SITE_MEDIA_MIME_TYPES)[number]

interface UpdatePublicationSiteMediaInput {
  fileName: string
  mimeType: string
  buffer: Buffer
}

const publicDocumentProjectionSelect = {
  id: true,
  documentId: true,
  projectionRevision: true,
  schemaVersion: true,
  title: true,
  body: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DocumentCurrentProjectionSelect

const publicationDocumentSelect = {
  id: true,
  workspaceId: true,
  parentId: true,
  title: true,
  summary: true,
  createdBy: true,
  createdByUser: {
    select: auditUserSummarySelect,
  },
  visibility: true,
  status: true,
  order: true,
  currentProjectionId: true,
  currentProjection: {
    select: publicDocumentProjectionSelect,
  },
  createdAt: true,
  updatedAt: true,
  trashedAt: true,
} satisfies Prisma.DocumentSelect

type PersistedPublicationDocument = Prisma.DocumentGetPayload<{
  select: typeof publicationDocumentSelect
}>

const publicationSiteSelect = {
  id: true,
  workspaceId: true,
  title: true,
  description: true,
  logoUrl: true,
  theme: true,
  homeMode: true,
  homeDocumentId: true,
  homeConfig: true,
  allowIndexing: true,
  status: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
} satisfies Prisma.DocumentPublicationSiteSelect

const publicationSectionSelect = {
  id: true,
  siteId: true,
  title: true,
  order: true,
  collapsed: true,
  status: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
} satisfies Prisma.DocumentPublicationSectionSelect

const publicationPageSelect = {
  id: true,
  siteId: true,
  sectionId: true,
  documentId: true,
  scope: true,
  order: true,
  status: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
  document: {
    select: {
      title: true,
    },
  },
} satisfies Prisma.DocumentPublicationPageSelect

const publicationNavItemSelect = {
  id: true,
  siteId: true,
  parentId: true,
  type: true,
  label: true,
  icon: true,
  target: true,
  targetId: true,
  url: true,
  openTarget: true,
  order: true,
  status: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
} satisfies Prisma.DocumentPublicationNavItemSelect

type PersistedPublicationSite = Prisma.DocumentPublicationSiteGetPayload<{
  select: typeof publicationSiteSelect
}>

type PersistedPublicationSection = Prisma.DocumentPublicationSectionGetPayload<{
  select: typeof publicationSectionSelect
}>

type PersistedPublicationPage = Prisma.DocumentPublicationPageGetPayload<{
  select: typeof publicationPageSelect
}>

type PersistedPublicationNavItem = Prisma.DocumentPublicationNavItemGetPayload<{
  select: typeof publicationNavItemSelect
}>

const singlePublicationSettingSelect = {
  id: true,
  documentId: true,
  state: true,
  scope: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
} satisfies Prisma.DocumentSinglePublicationSettingSelect

type PersistedSinglePublicationSetting = Prisma.DocumentSinglePublicationSettingGetPayload<{
  select: typeof singlePublicationSettingSelect
}>

@Injectable()
export class DocumentPublicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly documentAccessService: DocumentAccessService,
    private readonly publicationAccessService: DocumentPublicationAccessService,
  ) {}

  async listSinglePublicationTree(userId: string, workspaceId: string): Promise<ListDocumentSinglePublicationsResponse> {
    await this.documentAccessService.assertAccessibleWorkspace(userId, workspaceId)

    const documents = await this.prisma.document.findMany({
      where: {
        workspaceId,
        createdBy: userId,
        visibility: DOCUMENT_VISIBILITY.PRIVATE,
        status: {
          in: [DocumentStatus.ACTIVE, DocumentStatus.LOCKED],
        },
        trashedAt: null,
      },
      select: publicationDocumentSelect,
      orderBy: [
        { order: 'asc' },
        { updatedAt: 'desc' },
      ],
    })
    const settings = await this.prisma.documentSinglePublicationSetting.findMany({
      where: {
        documentId: {
          in: documents.map(document => document.id),
        },
      },
      select: singlePublicationSettingSelect,
    })

    return {
      tree: buildSinglePublicationTree(documents, settings),
    }
  }

  async getSinglePublicationSetting(userId: string, documentId: string): Promise<DocumentSinglePublicationInfo> {
    await this.assertCanPublishOwnPrivateDocument(userId, documentId)
    return this.resolveSinglePublicationInfo(documentId)
  }

  async updateSinglePublicationSetting(
    userId: string,
    documentId: string,
    payload: UpdateDocumentSinglePublicationSettingRequest,
  ): Promise<DocumentSinglePublicationInfo> {
    await this.assertCanPublishOwnPrivateDocument(userId, documentId)
    await this.prisma.documentSinglePublicationSetting.upsert({
      where: { documentId },
      update: {
        state: payload.state,
        scope: payload.scope,
        updatedBy: userId,
      },
      create: {
        documentId,
        state: payload.state,
        scope: payload.scope ?? DOCUMENT_SINGLE_PUBLICATION_SCOPE.PAGE,
        createdBy: userId,
        updatedBy: userId,
      },
      select: singlePublicationSettingSelect,
    })

    return this.resolveSinglePublicationInfo(documentId)
  }

  async getSinglePublicDocument(documentId: string): Promise<PublicationSingleDocumentResponse> {
    const document = await this.loadPublicDocument(documentId)
    const access = await this.publicationAccessService.resolveSinglePublicationAccess(documentId)

    if (!access.published || !document.currentProjection) {
      throw new NotFoundException('公开页面不存在或未发布')
    }

    const renderedDocument = toRenderedDocument(document)
    const body = renderedDocument.body

    return {
      document: renderedDocument,
      outline: buildPublicationOutline(body),
      assetIds: collectDocumentAssetIds(body),
      internalLinks: await this.resolveSingleDocumentInternalLinks(body),
    }
  }

  async getPublicationSiteManagement(userId: string, workspaceId: string): Promise<PublicationSiteManagementResponse> {
    await this.documentAccessService.assertAccessibleWorkspace(userId, workspaceId)
    const site = await this.prisma.documentPublicationSite.findUnique({
      where: { workspaceId },
      select: publicationSiteSelect,
    })

    return site
      ? this.loadPublicationSiteManagement(site)
      : {
          site: null,
          sections: [],
          pages: [],
          navItems: [],
        }
  }

  async updatePublicationSiteSettings(
    userId: string,
    payload: UpsertPublicationSiteSettingsRequest,
  ): Promise<PublicationSiteManagementResponse> {
    const site = await this.getOrCreatePublicationSite(userId, payload.workspaceId)
    const nextSite = await this.prisma.documentPublicationSite.update({
      where: { id: site.id },
      data: {
        title: payload.title,
        description: payload.description,
        logoUrl: payload.logoUrl,
        theme: payload.theme,
        homeMode: payload.homeMode,
        homeDocumentId: payload.homeDocumentId,
        homeConfig: payload.homeConfig ? toPrismaJsonValue(payload.homeConfig) : undefined,
        allowIndexing: payload.allowIndexing,
        status: payload.status,
        updatedBy: userId,
      },
      select: publicationSiteSelect,
    })

    return this.loadPublicationSiteManagement(nextSite)
  }

  async updatePublicationSiteMedia(
    userId: string,
    workspaceId: string,
    mediaKind: string,
    payload: UpdatePublicationSiteMediaInput,
  ): Promise<PublicationSiteManagementResponse> {
    const kind = assertPublicationSiteMediaKind(mediaKind)
    const mediaMimeType = assertPublicationSiteMediaMimeType(payload.mimeType, payload.buffer)
    assertPublicationSiteMediaBuffer(kind, payload.buffer, mediaMimeType)

    const site = await this.getOrCreatePublicationSite(userId, workspaceId)
    const storageKey = buildPublicationSiteMediaStorageKey(site.id, kind)

    await this.storageService.putObject({
      bucket: PUBLICATION_SITE_MEDIA_BUCKET,
      key: storageKey,
      body: payload.buffer,
      contentType: mediaMimeType,
      contentDisposition: {
        type: 'inline',
        fileName: payload.fileName,
        fallbackFileName: PUBLICATION_SITE_MEDIA_FALLBACK_FILE_NAME[kind],
      },
      contentLength: payload.buffer.length,
      cacheControl: 'public, max-age=300',
    })

    const mediaUrl = buildPublicationSiteMediaUrl(site.id, kind)
    const homeConfig = parsePublicationSiteHomeConfig(site.homeConfig)
    const nextSite = await this.prisma.documentPublicationSite.update({
      where: { id: site.id },
      data: kind === DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.LOGO
        ? {
            logoUrl: mediaUrl,
            updatedBy: userId,
          }
        : {
            homeConfig: toPrismaJsonValue({
              ...homeConfig,
              hero: {
                ...homeConfig.hero,
                imageUrl: mediaUrl,
              },
            }),
            updatedBy: userId,
          },
      select: publicationSiteSelect,
    })

    return this.loadPublicationSiteManagement(nextSite)
  }

  async removePublicationSiteMedia(
    userId: string,
    workspaceId: string,
    mediaKind: string,
  ): Promise<PublicationSiteManagementResponse> {
    const kind = assertPublicationSiteMediaKind(mediaKind)
    const site = await this.getOrCreatePublicationSite(userId, workspaceId)
    const homeConfig = parsePublicationSiteHomeConfig(site.homeConfig)
    const nextSite = await this.prisma.documentPublicationSite.update({
      where: { id: site.id },
      data: kind === DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.LOGO
        ? {
            logoUrl: null,
            updatedBy: userId,
          }
        : {
            homeConfig: toPrismaJsonValue({
              ...homeConfig,
              hero: {
                ...homeConfig.hero,
                imageUrl: null,
              },
            }),
            updatedBy: userId,
          },
      select: publicationSiteSelect,
    })

    await this.storageService.deleteObject({
      bucket: PUBLICATION_SITE_MEDIA_BUCKET,
      key: buildPublicationSiteMediaStorageKey(site.id, kind),
    })

    return this.loadPublicationSiteManagement(nextSite)
  }

  async updatePublicationSiteCustomMedia(
    userId: string,
    workspaceId: string,
    mediaScope: string,
    mediaId: string,
    payload: UpdatePublicationSiteMediaInput,
  ): Promise<PublicationSiteCustomMediaResponse> {
    const scope = assertPublicationSiteCustomMediaScope(mediaScope)
    const safeMediaId = assertPublicationSiteCustomMediaId(mediaId)
    const mediaMimeType = assertPublicationSiteMediaMimeType(payload.mimeType, payload.buffer)
    assertPublicationSiteCustomMediaBuffer(scope, payload.buffer, mediaMimeType)

    const site = await this.getOrCreatePublicationSite(userId, workspaceId)

    await this.storageService.putObject({
      bucket: PUBLICATION_SITE_MEDIA_BUCKET,
      key: buildPublicationSiteCustomMediaStorageKey(site.id, scope, safeMediaId),
      body: payload.buffer,
      contentType: mediaMimeType,
      contentDisposition: {
        type: 'inline',
        fileName: payload.fileName,
        fallbackFileName: 'site-media',
      },
      contentLength: payload.buffer.length,
      cacheControl: 'public, max-age=300',
    })

    return {
      mediaUrl: buildPublicationSiteCustomMediaUrl(site.id, scope, safeMediaId),
    }
  }

  async getPublicationSiteMedia(siteId: string, mediaKind: string): Promise<StorageObject> {
    const kind = assertPublicationSiteMediaKind(mediaKind)
    const site = await this.prisma.documentPublicationSite.findUnique({
      where: { id: siteId },
      select: { id: true, logoUrl: true, homeConfig: true },
    })

    if (!site || !isPublicationSiteMediaReferenced(site, kind)) {
      throw new NotFoundException('资源不存在')
    }

    const media = await this.storageService.getObject({
      bucket: PUBLICATION_SITE_MEDIA_BUCKET,
      key: buildPublicationSiteMediaStorageKey(site.id, kind),
    })

    return normalizePublicationSiteMediaObject(media)
  }

  async getPublicationSiteCustomMedia(siteId: string, mediaScope: string, mediaId: string): Promise<StorageObject> {
    const scope = assertPublicationSiteCustomMediaScope(mediaScope)
    const safeMediaId = assertPublicationSiteCustomMediaId(mediaId)
    const site = await this.prisma.documentPublicationSite.findUnique({
      where: { id: siteId },
      select: { id: true },
    })

    if (!site) {
      throw new NotFoundException('资源不存在')
    }

    const media = await this.storageService.getObject({
      bucket: PUBLICATION_SITE_MEDIA_BUCKET,
      key: buildPublicationSiteCustomMediaStorageKey(site.id, scope, safeMediaId),
    })

    return normalizePublicationSiteMediaObject(media)
  }

  async createPublicationSection(
    userId: string,
    payload: CreatePublicationSectionRequest,
  ): Promise<PublicationSiteManagementResponse> {
    const site = await this.getOrCreatePublicationSite(userId, payload.workspaceId)
    await this.prisma.documentPublicationSection.create({
      data: {
        siteId: site.id,
        title: payload.title,
        order: payload.order ?? 0,
        createdBy: userId,
        updatedBy: userId,
      },
      select: publicationSectionSelect,
    })

    return this.loadPublicationSiteManagement(site)
  }

  async updatePublicationSection(
    userId: string,
    sectionId: string,
    payload: UpdatePublicationSectionRequest,
  ): Promise<PublicationSiteManagementResponse> {
    const site = await this.getOrCreatePublicationSite(userId, payload.workspaceId)
    await this.assertSectionBelongsToSite(sectionId, site.id)
    await this.prisma.documentPublicationSection.update({
      where: { id: sectionId },
      data: {
        title: payload.title,
        order: payload.order,
        collapsed: payload.collapsed,
        status: payload.status,
        updatedBy: userId,
      },
      select: publicationSectionSelect,
    })

    return this.loadPublicationSiteManagement(site)
  }

  async removePublicationSection(userId: string, workspaceId: string, sectionId: string): Promise<PublicationSiteManagementResponse> {
    return this.updatePublicationSection(userId, sectionId, {
      workspaceId,
      status: DOCUMENT_PUBLICATION_ENTRY_STATUS.REMOVED,
    })
  }

  async createPublicationPage(
    userId: string,
    payload: CreatePublicationPageRequest,
  ): Promise<PublicationSiteManagementResponse> {
    const site = await this.getOrCreatePublicationSite(userId, payload.workspaceId)
    await this.assertSectionBelongsToSite(payload.sectionId, site.id)
    await this.assertCanPublishOwnPrivateDocument(userId, payload.documentId)
    const document = await this.loadSiteSourceDocument(payload.documentId, site.workspaceId)
    await this.prisma.documentPublicationPage.create({
      data: {
        siteId: site.id,
        sectionId: payload.sectionId,
        documentId: document.id,
        scope: payload.scope,
        order: payload.order ?? 0,
        createdBy: userId,
        updatedBy: userId,
      },
      select: publicationPageSelect,
    })

    return this.loadPublicationSiteManagement(site)
  }

  async updatePublicationPage(
    userId: string,
    pageId: string,
    payload: UpdatePublicationPageRequest,
  ): Promise<PublicationSiteManagementResponse> {
    const site = await this.getOrCreatePublicationSite(userId, payload.workspaceId)
    await this.assertPageBelongsToSite(pageId, site.id)

    if (payload.sectionId) {
      await this.assertSectionBelongsToSite(payload.sectionId, site.id)
    }

    await this.prisma.documentPublicationPage.update({
      where: { id: pageId },
      data: {
        sectionId: payload.sectionId,
        scope: payload.scope,
        order: payload.order,
        status: payload.status,
        updatedBy: userId,
      },
      select: publicationPageSelect,
    })

    return this.loadPublicationSiteManagement(site)
  }

  async removePublicationPage(userId: string, workspaceId: string, pageId: string): Promise<PublicationSiteManagementResponse> {
    return this.updatePublicationPage(userId, pageId, {
      workspaceId,
      status: DOCUMENT_PUBLICATION_ENTRY_STATUS.REMOVED,
    })
  }

  async replacePublicationNavItems(
    userId: string,
    payload: ReplacePublicationNavItemsRequest,
  ): Promise<PublicationSiteManagementResponse> {
    const site = await this.getOrCreatePublicationSite(userId, payload.workspaceId)
    const items = preparePublicationNavItemInputs(payload.items)

    await this.prisma.$bypass.documentPublicationNavItem.deleteMany({
      where: { siteId: site.id },
    })
    const now = new Date()
    await this.prisma.documentPublicationNavItem.createMany({
      data: items.map(item => ({
        id: item.id,
        siteId: site.id,
        parentId: item.parentId,
        type: item.type,
        label: item.label,
        icon: item.icon,
        target: item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL ? item.target : null,
        targetId: item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL ? item.targetId : null,
        url: item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL ? item.url : null,
        openTarget: item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL ? item.openTarget : null,
        order: item.order,
        status: item.status,
        createdAt: now,
        createdBy: userId,
        updatedAt: now,
        updatedBy: userId,
      })),
    })

    return this.loadPublicationSiteManagement(site)
  }

  async getSitePublicPage(siteId: string, documentId?: string | null): Promise<PublicationSiteRenderResponse> {
    const site = await this.loadActivePublicationSite(siteId)
    const { sections, pages, navItems } = await this.loadPublicationSiteItems(site.id)
    const documents = await this.loadSiteDocuments(site.id, site.workspaceId)
    const context = buildSiteDocumentContext(documents)
    const sidebarGroups = buildSiteSidebarGroups({
      siteId: site.id,
      sections,
      pages,
      context,
    })
    const requestedDocumentId = documentId
      ?? (site.homeMode === DOCUMENT_PUBLICATION_SITE_HOME_MODE.DOCUMENT ? site.homeDocumentId : null)
    const currentDocument = requestedDocumentId
      ? resolveSitePublishedDocument(requestedDocumentId, context)
      : null
    const currentPage = currentDocument
      ? toRenderedDocument(currentDocument)
      : null
    const currentBody = currentDocument?.currentProjection
      ? asTiptapJsonContent(currentDocument.currentProjection.body)
      : []

    return {
      site: {
        id: site.id,
        title: site.title,
        description: site.description,
        logoUrl: site.logoUrl,
        theme: site.theme,
        allowIndexing: site.allowIndexing,
      },
      home: parsePublicationSiteHomeConfig(site.homeConfig),
      navItems: navItems
        .filter(item => item.status === DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE)
        .map(toPublicationNavItem)
        .filter(isRenderablePublicationNavItem),
      sidebarGroups,
      currentPage,
      outline: buildPublicationOutline(currentBody),
      internalLinks: await this.resolveSiteDocumentInternalLinks(site.id, currentBody, context),
    }
  }

  private async getOrCreatePublicationSite(userId: string, workspaceId: string): Promise<PersistedPublicationSite> {
    await this.documentAccessService.assertAccessibleWorkspace(userId, workspaceId)
    const site = await this.prisma.documentPublicationSite.findUnique({
      where: { workspaceId },
      select: publicationSiteSelect,
    })

    if (site) {
      return site
    }

    try {
      return await this.prisma.documentPublicationSite.create({
        data: {
          workspaceId,
          title: 'Lexora Docs',
          description: null,
          logoUrl: null,
          theme: DOCUMENT_PUBLICATION_SITE_THEME.DEFAULT,
          homeMode: DOCUMENT_PUBLICATION_SITE_HOME_MODE.LANDING,
          homeDocumentId: null,
          homeConfig: toPrismaJsonValue(DOCUMENT_PUBLICATION_DEFAULT_SITE_HOME_CONFIG),
          allowIndexing: false,
          status: DOCUMENT_PUBLICATION_SITE_STATUS.ACTIVE,
          createdBy: userId,
          updatedBy: userId,
        },
        select: publicationSiteSelect,
      })
    }
    catch (error) {
      if (!isPrismaUniqueConstraintError(error)) {
        throw error
      }

      const concurrentSite = await this.prisma.documentPublicationSite.findUnique({
        where: { workspaceId },
        select: publicationSiteSelect,
      })

      if (!concurrentSite) {
        throw error
      }

      return concurrentSite
    }
  }

  private async loadPublicationSiteManagement(site: PersistedPublicationSite): Promise<PublicationSiteManagementResponse> {
    const { sections, pages, navItems } = await this.loadPublicationSiteItems(site.id)

    return {
      site: toPublicationSite(site),
      sections: sections.map(toPublicationSection),
      pages: pages.map(toPublicationPage),
      navItems: navItems.map(toPublicationNavItem),
    }
  }

  private async loadActivePublicationSite(siteId: string): Promise<PersistedPublicationSite> {
    const site = await this.prisma.documentPublicationSite.findUnique({
      where: { id: siteId },
      select: publicationSiteSelect,
    })

    if (!site || site.status !== DOCUMENT_PUBLICATION_SITE_STATUS.ACTIVE) {
      throw new NotFoundException('发布站点不存在或尚未开启')
    }

    return site
  }

  private async loadPublicationSiteItems(siteId: string) {
    const [sections, pages, navItems] = await Promise.all([
      this.prisma.documentPublicationSection.findMany({
        where: {
          siteId,
          status: {
            not: DOCUMENT_PUBLICATION_ENTRY_STATUS.REMOVED,
          },
        },
        select: publicationSectionSelect,
        orderBy: [
          { order: 'asc' },
          { updatedAt: 'desc' },
        ],
      }),
      this.prisma.documentPublicationPage.findMany({
        where: {
          siteId,
          status: {
            not: DOCUMENT_PUBLICATION_ENTRY_STATUS.REMOVED,
          },
        },
        select: publicationPageSelect,
        orderBy: [
          { order: 'asc' },
          { updatedAt: 'desc' },
        ],
      }),
      this.prisma.documentPublicationNavItem.findMany({
        where: {
          siteId,
          status: {
            not: DOCUMENT_PUBLICATION_ENTRY_STATUS.REMOVED,
          },
        },
        select: publicationNavItemSelect,
        orderBy: [
          { order: 'asc' },
          { updatedAt: 'desc' },
        ],
      }),
    ])

    return {
      sections,
      pages,
      navItems,
    }
  }

  private async loadSiteDocuments(siteId: string, workspaceId: string): Promise<PersistedPublicationDocument[]> {
    const documentIds = await this.publicationAccessService.loadSitePublicationDocumentIds(siteId)

    if (!documentIds.size) {
      return []
    }

    return await this.prisma.document.findMany({
      where: {
        id: {
          in: Array.from(documentIds),
        },
        workspaceId,
        status: {
          in: [DocumentStatus.ACTIVE, DocumentStatus.LOCKED],
        },
        trashedAt: null,
      },
      select: publicationDocumentSelect,
      orderBy: [
        { order: 'asc' },
        { updatedAt: 'desc' },
      ],
    })
  }

  private async loadSiteSourceDocument(documentId: string, workspaceId: string): Promise<PersistedPublicationDocument> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: publicationDocumentSelect,
    })

    if (
      !document
      || document.workspaceId !== workspaceId
      || document.visibility !== DOCUMENT_VISIBILITY.PRIVATE
      || document.trashedAt
    ) {
      throw new NotFoundException('文档不存在或不可发布')
    }

    return document
  }

  private async assertSectionBelongsToSite(sectionId: string, siteId: string): Promise<void> {
    const sections = await this.prisma.documentPublicationSection.findMany({
      where: { siteId },
      select: publicationSectionSelect,
    })

    if (!sections.some(section => section.id === sectionId && section.status !== DOCUMENT_PUBLICATION_ENTRY_STATUS.REMOVED)) {
      throw new NotFoundException('发布分组不存在')
    }
  }

  private async assertPageBelongsToSite(pageId: string, siteId: string): Promise<void> {
    const pages = await this.prisma.documentPublicationPage.findMany({
      where: { siteId },
      select: publicationPageSelect,
    })

    if (!pages.some(page => page.id === pageId && page.status !== DOCUMENT_PUBLICATION_ENTRY_STATUS.REMOVED)) {
      throw new NotFoundException('发布页面不存在')
    }
  }

  private async assertCanPublish(userId: string, documentId: string): Promise<void> {
    const document = await this.documentAccessService.assertCanReadDocument(userId, documentId)

    if (!document.access.capabilities.canPublish) {
      throw new ForbiddenException('无权发布文档')
    }
  }

  private async assertCanPublishOwnPrivateDocument(userId: string, documentId: string): Promise<void> {
    const document = await this.documentAccessService.assertCanReadDocument(userId, documentId)

    if (
      !document.access.capabilities.canPublish
      || document.createdBy !== userId
      || document.visibility !== DOCUMENT_VISIBILITY.PRIVATE
    ) {
      throw new ForbiddenException('只能发布自己私有文档')
    }
  }

  private async resolveSinglePublicationInfo(documentId: string): Promise<DocumentSinglePublicationInfo> {
    const setting = await this.prisma.documentSinglePublicationSetting.findUnique({
      where: { documentId },
      select: singlePublicationSettingSelect,
    })
    const access = await this.publicationAccessService.resolveSinglePublicationAccess(documentId)

    return {
      documentId,
      setting: setting ? toSinglePublicationSetting(setting) : null,
      singlePublicationState: setting?.state ?? DOCUMENT_SINGLE_PUBLICATION_STATE.INHERIT,
      singlePublicationScope: setting?.scope ?? DOCUMENT_SINGLE_PUBLICATION_SCOPE.PAGE,
      effectivePublicationState: resolveEffectivePublicationState({
        ownState: setting?.state ?? DOCUMENT_SINGLE_PUBLICATION_STATE.INHERIT,
        access,
        documentId,
      }),
      inheritedFromDocumentId: access.published && access.sourceDocumentId !== documentId
        ? access.sourceDocumentId
        : null,
    }
  }

  private async loadPublicDocument(documentId: string): Promise<PersistedPublicationDocument> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: publicationDocumentSelect,
    })

    if (
      !document
      || document.trashedAt
      || !document.currentProjection
      || ![DocumentStatus.ACTIVE, DocumentStatus.LOCKED].includes(document.status)
    ) {
      throw new NotFoundException('公开页面不存在或未发布')
    }

    return document
  }

  private async resolveSingleDocumentInternalLinks(body: TiptapJsonContent): Promise<PublicationInternalLinkResolution[]> {
    const links = collectInternalDocumentLinks(body)
    const accessByDocumentId = await this.publicationAccessService.resolveSinglePublicationAccessMap(
      links.map(link => link.targetDocumentId),
    )

    return links.map((link) => {
      const access = accessByDocumentId.get(link.targetDocumentId)
      const published = Boolean(access?.published)

      return {
        targetDocumentId: link.targetDocumentId,
        label: link.label,
        href: published ? `${DOCUMENT_SINGLE_PUBLICATION_ROUTE_PREFIX}/${link.targetDocumentId}` : null,
        published,
        disabledReason: published ? null : '此页面未发布',
      }
    })
  }

  private async resolveSiteDocumentInternalLinks(
    siteId: string,
    body: TiptapJsonContent,
    context: SiteDocumentContext,
  ): Promise<PublicationInternalLinkResolution[]> {
    return collectInternalDocumentLinks(body).map((link) => {
      const published = Boolean(resolveSitePublishedDocument(link.targetDocumentId, context, false))

      return {
        targetDocumentId: link.targetDocumentId,
        label: link.label,
        href: published ? `${DOCUMENT_SITE_PUBLICATION_ROUTE_PREFIX}/${siteId}/${link.targetDocumentId}` : null,
        published,
        disabledReason: published ? null : '此页面未发布',
      }
    })
  }
}

function buildSinglePublicationTree(
  documents: PersistedPublicationDocument[],
  settings: PersistedSinglePublicationSetting[],
): ListDocumentSinglePublicationsResponse['tree'] {
  const settingsByDocumentId = new Map(settings.map(setting => [setting.documentId, setting]))
  const documentsById = new Map(documents.map(document => [document.id, document]))
  const childrenByParent = new Map<string | null, PersistedPublicationDocument[]>()

  for (const document of documents) {
    const parentId = document.parentId && documentsById.has(document.parentId) ? document.parentId : null
    const children = childrenByParent.get(parentId) ?? []
    children.push(document)
    childrenByParent.set(parentId, children)
  }

  for (const children of childrenByParent.values()) {
    children.sort(comparePublicationTreeDocument)
  }

  return (childrenByParent.get(null) ?? []).map(document =>
    buildSinglePublicationTreeItem(document, childrenByParent, settingsByDocumentId, null),
  )
}

interface SiteDocumentContext {
  documentsById: Map<string, PersistedPublicationDocument>
  childrenByParent: Map<string | null, PersistedPublicationDocument[]>
}

function buildSiteDocumentContext(documents: PersistedPublicationDocument[]): SiteDocumentContext {
  const documentsById = new Map(documents.map(document => [document.id, document]))
  const childrenByParent = new Map<string | null, PersistedPublicationDocument[]>()

  for (const document of documents) {
    const children = childrenByParent.get(document.parentId) ?? []
    children.push(document)
    childrenByParent.set(document.parentId, children)
  }

  for (const children of childrenByParent.values()) {
    children.sort(comparePublicationTreeDocument)
  }

  return {
    documentsById,
    childrenByParent,
  }
}

function buildSiteSidebarGroups(input: {
  siteId: string
  sections: PersistedPublicationSection[]
  pages: PersistedPublicationPage[]
  context: SiteDocumentContext
}): PublicationSiteRenderResponse['sidebarGroups'] {
  return input.sections
    .filter(section => section.status === DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE)
    .sort(comparePublicationOrderedItem)
    .map((section) => {
      const pages = input.pages
        .filter(page => page.sectionId === section.id && page.status === DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE)
        .sort(comparePublicationOrderedItem)
        .map(page => buildSiteSidebarPage(input.siteId, page, input.context))
        .filter((page): page is NonNullable<typeof page> => Boolean(page))

      return {
        id: section.id,
        title: section.title,
        collapsed: section.collapsed,
        pages,
      }
    })
}

function buildSiteSidebarPage(
  siteId: string,
  page: PersistedPublicationPage,
  context: SiteDocumentContext,
): PublicationSiteRenderResponse['sidebarGroups'][number]['pages'][number] | null {
  const document = context.documentsById.get(page.documentId)

  if (!document) {
    return null
  }

  return {
    id: page.id,
    documentId: document.id,
    title: document.title,
    href: `${DOCUMENT_SITE_PUBLICATION_ROUTE_PREFIX}/${siteId}/${document.id}`,
    children: page.scope === DOCUMENT_SITE_PUBLICATION_PAGE_SCOPE.DESCENDANTS
      ? buildSiteSidebarDescendantPages(siteId, document.id, context)
      : [],
  }
}

function buildSiteSidebarDescendantPages(
  siteId: string,
  parentId: string,
  context: SiteDocumentContext,
): PublicationSiteRenderResponse['sidebarGroups'][number]['pages'][number]['children'] {
  return (context.childrenByParent.get(parentId) ?? []).map(document => ({
    id: document.id,
    documentId: document.id,
    title: document.title,
    href: `${DOCUMENT_SITE_PUBLICATION_ROUTE_PREFIX}/${siteId}/${document.id}`,
    children: buildSiteSidebarDescendantPages(siteId, document.id, context),
  }))
}

function resolveSitePublishedDocument(
  documentId: string,
  context: SiteDocumentContext,
  shouldThrow = true,
): PersistedPublicationDocument | null {
  const document = context.documentsById.get(documentId)

  if (!document || !document.currentProjection) {
    if (shouldThrow) {
      throw new NotFoundException('公开页面不存在或未发布')
    }

    return null
  }

  return document
}

interface PreparedPublicationNavItem {
  id: string
  parentId: string | null
  type: PublicationNavItemType
  label: string | null
  icon: string | null
  target: PublicationNavItemInternalTarget | null
  targetId: string | null
  url: string | null
  openTarget: PublicationNavItemExternalTarget | null
  order: number
  status: PublicationNavItemInput['status']
}

function preparePublicationNavItemInputs(items: PublicationNavItemInput[]): PreparedPublicationNavItem[] {
  const preparedItems = items.map((item): PreparedPublicationNavItem => {
    const id = item.id?.trim() || randomUUID()
    const label = normalizeNullableText(item.label)
    const icon = normalizeNullableText(item.icon)
    const parentId = normalizeNullableText(item.parentId)

    if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
      if (!label) {
        throw new BadRequestException('菜单名称不能为空')
      }

      return {
        id,
        parentId,
        type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP,
        label,
        icon,
        target: null,
        targetId: null,
        url: null,
        openTarget: null,
        order: item.order,
        status: item.status,
      }
    }

    if (!label && !icon) {
      throw new BadRequestException('导航名称和图标至少填写一个')
    }

    if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL) {
      return {
        id,
        parentId,
        type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL,
        label,
        icon,
        target: null,
        targetId: null,
        url: normalizePublicationHref(item.url),
        openTarget: item.openTarget,
        order: item.order,
        status: item.status,
      }
    }

    return {
      id,
      parentId,
      type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL,
      label,
      icon,
      target: item.target,
      targetId: item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME ? null : item.targetId,
      url: null,
      openTarget: null,
      order: item.order,
      status: item.status,
    }
  })
  const groupIds = new Set(
    preparedItems
      .filter(item => item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP)
      .map(item => item.id),
  )
  const itemIds = new Set<string>()

  for (const item of preparedItems) {
    if (itemIds.has(item.id)) {
      throw new BadRequestException('导航项 ID 不能重复')
    }

    itemIds.add(item.id)

    if (item.parentId && !groupIds.has(item.parentId)) {
      throw new BadRequestException('导航子项只能归属到菜单')
    }
  }

  validatePublicationNavItemDepth(preparedItems)

  return preparedItems
}

function validatePublicationNavItemDepth(items: PreparedPublicationNavItem[]) {
  const itemById = new Map(items.map(item => [item.id, item]))
  const depthById = new Map<string, number>()
  const visiting = new Set<string>()

  for (const item of items) {
    const depth = resolvePublicationNavItemDepth(item, {
      depthById,
      itemById,
      visiting,
    })

    if (depth > DOCUMENT_PUBLICATION_NAV_ITEM_MAX_DEPTH) {
      throw new BadRequestException('导航最多支持两级')
    }

    if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP && depth >= DOCUMENT_PUBLICATION_NAV_ITEM_MAX_DEPTH) {
      throw new BadRequestException('二级导航不能设为菜单')
    }
  }
}

function resolvePublicationNavItemDepth(
  item: PreparedPublicationNavItem,
  context: {
    depthById: Map<string, number>
    itemById: Map<string, PreparedPublicationNavItem>
    visiting: Set<string>
  },
): number {
  const cachedDepth = context.depthById.get(item.id)

  if (cachedDepth) {
    return cachedDepth
  }

  if (!item.parentId) {
    context.depthById.set(item.id, 1)
    return 1
  }

  const parent = context.itemById.get(item.parentId)

  if (!parent) {
    throw new BadRequestException('导航父级不存在')
  }

  if (parent.type !== DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
    throw new BadRequestException('导航子项只能归属到菜单')
  }

  if (context.visiting.has(item.id)) {
    throw new BadRequestException('导航层级不能形成循环')
  }

  context.visiting.add(item.id)

  try {
    const depth = resolvePublicationNavItemDepth(parent, context) + 1
    context.depthById.set(item.id, depth)
    return depth
  }
  finally {
    context.visiting.delete(item.id)
  }
}

function toRenderedDocument(document: PersistedPublicationDocument): PublicationRenderedDocument {
  if (!document.currentProjection) {
    throw new NotFoundException('公开页面不存在或未发布')
  }

  return {
    documentId: document.id,
    title: document.title,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.currentProjection.updatedAt.toISOString(),
    owner: toAuditUserSummary(document.createdByUser),
    body: asTiptapJsonContent(document.currentProjection.body),
  }
}

function buildPublicationOutline(body: TiptapJsonContent): PublicationSiteRenderResponse['outline'] {
  const outline: PublicationSiteRenderResponse['outline'] = []
  const parents: PublicationSiteRenderResponse['outline'] = []

  for (const item of buildDocumentOutline(buildDocumentBlockIndex(body))
    .filter(item => item.headingLevel >= 2 && item.headingLevel <= 4)
    .map((item): PublicationSiteRenderResponse['outline'][number] => ({
      id: item.blockId,
      level: item.headingLevel,
      title: item.plainText,
      children: [],
    }))) {
    while (parents.length) {
      const currentParent = parents[parents.length - 1]

      if (!currentParent || currentParent.level < item.level) {
        break
      }

      parents.pop()
    }

    const parent = parents[parents.length - 1]

    if (parent) {
      parent.children.push(item)
    }
    else {
      outline.push(item)
    }

    parents.push(item)
  }

  return outline
}

function toPublicationSite(site: PersistedPublicationSite) {
  return {
    id: site.id,
    workspaceId: site.workspaceId,
    title: site.title,
    description: site.description,
    logoUrl: site.logoUrl,
    theme: site.theme,
    homeMode: site.homeMode,
    homeDocumentId: site.homeDocumentId,
    homeConfig: parsePublicationSiteHomeConfig(site.homeConfig),
    allowIndexing: site.allowIndexing,
    status: site.status,
    createdAt: site.createdAt.toISOString(),
    createdBy: site.createdBy,
    updatedAt: site.updatedAt.toISOString(),
    updatedBy: site.updatedBy,
  }
}

function toPublicationSection(section: PersistedPublicationSection) {
  return {
    id: section.id,
    siteId: section.siteId,
    title: section.title,
    order: section.order,
    collapsed: section.collapsed,
    status: section.status,
    createdAt: section.createdAt.toISOString(),
    createdBy: section.createdBy,
    updatedAt: section.updatedAt.toISOString(),
    updatedBy: section.updatedBy,
  }
}

function toPublicationPage(page: PersistedPublicationPage) {
  return {
    id: page.id,
    siteId: page.siteId,
    sectionId: page.sectionId,
    documentId: page.documentId,
    title: page.document.title,
    scope: page.scope,
    order: page.order,
    status: page.status,
    createdAt: page.createdAt.toISOString(),
    createdBy: page.createdBy,
    updatedAt: page.updatedAt.toISOString(),
    updatedBy: page.updatedBy,
  }
}

function toPublicationNavItem(item: PersistedPublicationNavItem): PublicationSiteRenderResponse['navItems'][number] {
  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
    return {
      id: item.id,
      siteId: item.siteId,
      parentId: item.parentId,
      type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP,
      label: item.label ?? '',
      icon: normalizeNullableText(item.icon),
      target: null,
      targetId: null,
      url: null,
      openTarget: null,
      order: item.order,
      status: item.status,
      createdAt: item.createdAt.toISOString(),
      createdBy: item.createdBy,
      updatedAt: item.updatedAt.toISOString(),
      updatedBy: item.updatedBy,
    }
  }

  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL) {
    return {
      id: item.id,
      siteId: item.siteId,
      parentId: item.parentId,
      type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL,
      label: normalizeNullableText(item.label),
      icon: normalizeNullableText(item.icon),
      target: null,
      targetId: null,
      url: normalizePublicationHref(item.url) ?? '',
      openTarget: item.openTarget ?? 'BLANK',
      order: item.order,
      status: item.status,
      createdAt: item.createdAt.toISOString(),
      createdBy: item.createdBy,
      updatedAt: item.updatedAt.toISOString(),
      updatedBy: item.updatedBy,
    }
  }

  return {
    id: item.id,
    siteId: item.siteId,
    parentId: item.parentId,
    type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL,
    label: normalizeNullableText(item.label),
    icon: normalizeNullableText(item.icon),
    target: item.target ?? DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME,
    targetId: item.targetId,
    url: null,
    openTarget: null,
    order: item.order,
    status: item.status,
    createdAt: item.createdAt.toISOString(),
    createdBy: item.createdBy,
    updatedAt: item.updatedAt.toISOString(),
    updatedBy: item.updatedBy,
  }
}

function isRenderablePublicationNavItem(item: PublicationSiteRenderResponse['navItems'][number]) {
  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL) {
    return Boolean(normalizePublicationHref(item.url))
  }

  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
    return Boolean(item.label.trim())
  }

  return Boolean(item.label?.trim() || item.icon?.trim())
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? ''

  return text || null
}

function parsePublicationSiteHomeConfig(value: Prisma.JsonValue | null): PublicationSiteHomeConfig {
  const parsed = PublicationSiteHomeConfigSchema.safeParse(value)
  const homeConfig = parsed.success
    ? parsed.data
    : PublicationSiteHomeConfigSchema.parse(DOCUMENT_PUBLICATION_DEFAULT_SITE_HOME_CONFIG)

  return {
    ...homeConfig,
    actions: homeConfig.actions
      .map((action) => {
        const href = normalizePublicationHref(action.href)

        return href ? { ...action, href } : null
      })
      .filter(action => action !== null),
  }
}

function assertPublicationSiteMediaKind(value: string): PublicationSiteMediaKind {
  if (DOCUMENT_PUBLICATION_SITE_MEDIA_KIND_VALUES.includes(value as PublicationSiteMediaKind)) {
    return value as PublicationSiteMediaKind
  }

  throw new BadRequestException('不支持的站点图片类型')
}

function assertPublicationSiteCustomMediaScope(value: string): PublicationSiteCustomMediaScope {
  if (DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE_VALUES.includes(value as PublicationSiteCustomMediaScope)) {
    return value as PublicationSiteCustomMediaScope
  }

  throw new BadRequestException('不支持的站点图片类型')
}

function assertPublicationSiteCustomMediaId(value: string): string {
  const mediaId = value.trim()

  if (/^[\w-]{1,80}$/.test(mediaId)) {
    return mediaId
  }

  throw new BadRequestException('站点图片标识不正确')
}

function assertPublicationSiteMediaMimeType(mimeType: string, buffer: Buffer): PublicationSiteMediaMimeType {
  const normalizedMimeType = mimeType.trim().toLowerCase()

  if (DOCUMENT_PUBLICATION_SITE_MEDIA_MIME_TYPES.includes(normalizedMimeType as PublicationSiteMediaMimeType)) {
    return normalizedMimeType as PublicationSiteMediaMimeType
  }

  if (normalizedMimeType === 'application/octet-stream' && isPublicationSiteSvg(buffer)) {
    return 'image/svg+xml'
  }

  throw new BadRequestException('站点图片仅支持 JPG、PNG、WEBP、SVG 格式')
}

function assertPublicationSiteMediaBuffer(
  kind: PublicationSiteMediaKind,
  buffer: Buffer,
  mimeType: PublicationSiteMediaMimeType,
): void {
  assertPublicationSiteImageBuffer(
    buffer,
    mimeType,
    DOCUMENT_PUBLICATION_SITE_MEDIA_MAX_BYTES_BY_KIND[kind],
  )
}

function assertPublicationSiteCustomMediaBuffer(
  scope: PublicationSiteCustomMediaScope,
  buffer: Buffer,
  mimeType: PublicationSiteMediaMimeType,
): void {
  assertPublicationSiteImageBuffer(
    buffer,
    mimeType,
    DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_MAX_BYTES_BY_SCOPE[scope],
  )
}

function assertPublicationSiteImageBuffer(
  buffer: Buffer,
  mimeType: PublicationSiteMediaMimeType,
  maxBytes: number,
): void {
  if (!buffer.length) {
    throw new BadRequestException('站点图片文件不能为空')
  }

  if (buffer.length > maxBytes) {
    throw new BadRequestException(`站点图片大小不能超过 ${prettyBytes(maxBytes)}`)
  }

  if (!isPublicationSiteMediaSignatureMatched(buffer, mimeType)) {
    throw new BadRequestException('站点图片文件格式不正确')
  }

  if (mimeType === 'image/svg+xml' && !isSafePublicationSiteSvg(buffer)) {
    throw new BadRequestException('站点 SVG 包含不支持的内容')
  }
}

function buildPublicationSiteMediaStorageKey(siteId: string, kind: PublicationSiteMediaKind): string {
  return `document-publication-site/${siteId}/${kind}`
}

function buildPublicationSiteCustomMediaStorageKey(
  siteId: string,
  scope: PublicationSiteCustomMediaScope,
  mediaId: string,
): string {
  return `document-publication-site/${siteId}/custom/${scope}/${mediaId}`
}

function buildPublicationSiteMediaUrl(siteId: string, kind: PublicationSiteMediaKind): string {
  return `${SERVER_PATH}/documents/publications/site/media/${siteId}/${kind}?v=${Date.now()}`
}

function buildPublicationSiteCustomMediaUrl(
  siteId: string,
  scope: PublicationSiteCustomMediaScope,
  mediaId: string,
): string {
  return `${SERVER_PATH}/documents/publications/site/media/${siteId}/custom/${scope}/${mediaId}?v=${Date.now()}`
}

function isPublicationSiteMediaReferenced(
  site: { id: string, logoUrl: string | null, homeConfig: Prisma.JsonValue | null },
  kind: PublicationSiteMediaKind,
): boolean {
  const expectedPath = `/documents/publications/site/media/${site.id}/${kind}`

  if (kind === DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.LOGO) {
    return site.logoUrl?.includes(expectedPath) ?? false
  }

  return parsePublicationSiteHomeConfig(site.homeConfig).hero.imageUrl?.includes(expectedPath) ?? false
}

async function normalizePublicationSiteMediaObject(media: StorageObject): Promise<StorageObject> {
  if (media.contentType !== 'application/octet-stream') {
    return media
  }

  const bodyBuffer = await readStreamBuffer(media.body)

  return {
    ...media,
    body: Readable.from(bodyBuffer),
    contentType: isPublicationSiteSvg(bodyBuffer) && isSafePublicationSiteSvg(bodyBuffer)
      ? 'image/svg+xml'
      : media.contentType,
    contentLength: bodyBuffer.length,
  }
}

function isPublicationSiteMediaSignatureMatched(buffer: Buffer, mimeType: PublicationSiteMediaMimeType): boolean {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF
  }

  if (mimeType === 'image/png') {
    return buffer.length >= 8
      && buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4E
      && buffer[3] === 0x47
      && buffer[4] === 0x0D
      && buffer[5] === 0x0A
      && buffer[6] === 0x1A
      && buffer[7] === 0x0A
  }

  if (mimeType === 'image/svg+xml') {
    return isPublicationSiteSvg(buffer)
  }

  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
}

function isPublicationSiteSvg(buffer: Buffer): boolean {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trimStart()

  return text.startsWith('<svg') || /^<\?xml[\s\S]{0,512}<svg/i.test(text)
}

function isSafePublicationSiteSvg(buffer: Buffer): boolean {
  const text = buffer.toString('utf8')

  return !/<script[\s>]/i.test(text)
    && !/<foreignObject[\s>]/i.test(text)
    && !/<(?:iframe|object|embed)[\s>]/i.test(text)
    && !/\son[a-z]+\s*=/i.test(text)
    && !/(?:href|xlink:href)\s*=\s*["']\s*javascript:/i.test(text)
}

function comparePublicationOrderedItem(left: { order: number, updatedAt: Date }, right: { order: number, updatedAt: Date }) {
  if (left.order !== right.order) {
    return left.order - right.order
  }

  return right.updatedAt.getTime() - left.updatedAt.getTime()
}

function buildSinglePublicationTreeItem(
  document: PersistedPublicationDocument,
  childrenByParent: Map<string | null, PersistedPublicationDocument[]>,
  settingsByDocumentId: Map<string, PersistedSinglePublicationSetting>,
  inheritedEnabledDocumentId: string | null,
): ListDocumentSinglePublicationsResponse['tree'][number] {
  const setting = settingsByDocumentId.get(document.id)
  const ownState = setting?.state ?? DOCUMENT_SINGLE_PUBLICATION_STATE.INHERIT
  const ownScope = setting?.scope ?? DOCUMENT_SINGLE_PUBLICATION_SCOPE.PAGE
  const effectivePublicationState = resolveTreeEffectiveState(ownState, inheritedEnabledDocumentId)
  const nextInheritedEnabledDocumentId = ownState === DOCUMENT_SINGLE_PUBLICATION_STATE.ENABLED && ownScope === DOCUMENT_SINGLE_PUBLICATION_SCOPE.DESCENDANTS
    ? document.id
    : effectivePublicationState === DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.INHERITED_ENABLED
      ? inheritedEnabledDocumentId
      : null
  const children = (childrenByParent.get(document.id) ?? []).map(child =>
    buildSinglePublicationTreeItem(child, childrenByParent, settingsByDocumentId, nextInheritedEnabledDocumentId),
  )

  return {
    id: document.id,
    title: document.title,
    parentId: document.parentId,
    hasChildren: children.length > 0,
    hasContent: Boolean(document.currentProjectionId) && document.summary.length > 0,
    singlePublicationState: ownState,
    singlePublicationScope: ownScope,
    effectivePublicationState,
    inheritedFromDocumentId: effectivePublicationState === DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.INHERITED_ENABLED
      ? inheritedEnabledDocumentId
      : null,
    children,
  }
}

function resolveTreeEffectiveState(
  ownState: string,
  inheritedEnabledDocumentId: string | null,
) {
  if (ownState === DOCUMENT_SINGLE_PUBLICATION_STATE.ENABLED) {
    return DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.ENABLED
  }

  if (ownState === DOCUMENT_SINGLE_PUBLICATION_STATE.DISABLED) {
    return DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.DISABLED
  }

  return inheritedEnabledDocumentId
    ? DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.INHERITED_ENABLED
    : DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.UNPUBLISHED
}

function resolveEffectivePublicationState(input: {
  ownState: string
  access: SinglePublicationAccessResolution
  documentId: string
}) {
  if (input.ownState === DOCUMENT_SINGLE_PUBLICATION_STATE.ENABLED) {
    return DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.ENABLED
  }

  if (input.ownState === DOCUMENT_SINGLE_PUBLICATION_STATE.DISABLED) {
    return DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.DISABLED
  }

  return input.access.published && input.access.sourceDocumentId !== input.documentId
    ? DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.INHERITED_ENABLED
    : DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.UNPUBLISHED
}

function comparePublicationTreeDocument(left: PersistedPublicationDocument, right: PersistedPublicationDocument) {
  if (left.order !== right.order) {
    return left.order - right.order
  }

  return right.updatedAt.getTime() - left.updatedAt.getTime()
}

function toSinglePublicationSetting(setting: PersistedSinglePublicationSetting) {
  return {
    id: setting.id,
    documentId: setting.documentId,
    state: setting.state,
    scope: setting.scope,
    createdAt: setting.createdAt.toISOString(),
    createdBy: setting.createdBy,
    updatedAt: setting.updatedAt.toISOString(),
    updatedBy: setting.updatedBy,
  }
}

function asTiptapJsonContent(value: Prisma.JsonValue): TiptapJsonContent {
  return (Array.isArray(value) ? value : []) as unknown as TiptapJsonContent
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function collectInternalDocumentLinks(content: TiptapJsonContent): Array<{ targetDocumentId: string, label: string }> {
  const links: Array<{ targetDocumentId: string, label: string }> = []

  for (const node of content) {
    collectInternalDocumentLinksFromNode(node, links)
  }

  return links
}

function collectInternalDocumentLinksFromNode(
  node: TiptapJsonNode | undefined,
  links: Array<{ targetDocumentId: string, label: string }>,
) {
  if (!node) {
    return
  }

  const targetDocumentId = readInternalDocumentLinkTarget(node)

  if (targetDocumentId) {
    links.push({
      targetDocumentId,
      label: typeof node.text === 'string' && node.text.trim() ? node.text.trim() : targetDocumentId,
    })
  }

  if (!Array.isArray(node.content)) {
    return
  }

  for (const child of node.content) {
    collectInternalDocumentLinksFromNode(child, links)
  }
}

function readInternalDocumentLinkTarget(node: TiptapJsonNode): string | null {
  if (!Array.isArray(node.marks)) {
    return null
  }

  for (const mark of node.marks) {
    if (mark?.type !== 'link') {
      continue
    }

    const href = mark.attrs?.href
    const documentId = typeof href === 'string' ? parseInternalDocumentHref(href) : null

    if (documentId) {
      return documentId
    }
  }

  return null
}

function parseInternalDocumentHref(href: string): string | null {
  const normalizedHref = href.trim()

  if (!normalizedHref) {
    return null
  }

  let url: URL

  try {
    url = new URL(normalizedHref, 'https://lexora.local')
  }
  catch {
    return null
  }

  const pathSegments = url.pathname.split('/').filter(Boolean)

  if (pathSegments.length !== 2 || (pathSegments[0] !== 'docs' && pathSegments[0] !== 'p')) {
    return null
  }

  return decodeURIComponent(pathSegments[1] ?? '')
}

function isPrismaUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}
