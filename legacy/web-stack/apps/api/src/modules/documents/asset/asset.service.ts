import type { DocumentAsset, ResolveDocumentAssetsResponse } from '@haohaoxue/lexora-contracts'
import type { SupportedImageMimeType } from '@haohaoxue/lexora-contracts/file'
import type { JwtConfig } from '../../../config/auth.config'
import type { StorageObject } from '../../../infrastructure/storage/storage.interface'
import { Buffer } from 'node:buffer'
import { createSecretKey, randomUUID } from 'node:crypto'
import { SERVER_PATH } from '@haohaoxue/lexora-contracts'
import { FILE_SIZE_LIMITS } from '@haohaoxue/lexora-contracts/file'
import {
  isImageSignatureMatched,
  normalizeFileMimeType,
  normalizeSupportedImageMimeType,
  resolveSafeFileExtension,
  resolveSupportedImageExtension,
} from '@haohaoxue/lexora-shared/file'
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  DocumentAssetKind,
  DocumentAssetStatus,
  Prisma,
} from '@prisma/client'
import { parse, serialize } from 'cookie'
import { jwtVerify, SignJWT } from 'jose'
import { PrismaService } from '../../../database/prisma.service'
import { StorageService } from '../../../infrastructure/storage/storage.service'
import { sha256Hex } from '../../../utils/hash'
import { DocumentAccessService } from '../core/access.service'
import { DocumentPublicationAccessService } from '../publication/publication-access.service'
import { DOCUMENT_IMAGE_TOO_LARGE_MESSAGE } from './asset.constants'

const DOCUMENT_ASSET_BUCKET = 'document-asset'
const DOCUMENT_ASSET_CONTENT_AUDIENCE = 'lexora-document-asset'
const DOCUMENT_ASSET_ACCESS_TOKEN_TYPE = 'document-asset-access'
const DOCUMENT_ASSET_ACCESS_COOKIE_TTL_SECONDS = 60 * 5
const DOCUMENT_ASSET_ACCESS_COOKIE_NAMES = {
  document: 'lexora_document_asset_access',
  publication: 'lexora_publication_asset_access',
} as const
const SINGLE_PUBLICATION_ASSET_SCOPE_PREFIX = 'single:'

type PersistedDocumentAsset = Prisma.DocumentAssetGetPayload<{
  select: typeof documentAssetSelect
}>

type DocumentAssetAccessKind = 'document' | 'publication'

interface DocumentAssetAccessTokenPayload {
  documentId: string
  kind: DocumentAssetAccessKind
  tokenType: typeof DOCUMENT_ASSET_ACCESS_TOKEN_TYPE
  actorId?: string | null
  publicationId?: string | null
  [key: string]: unknown
}

type DocumentAssetAccessScope
  = | {
    documentId: string
    kind: 'document'
  }
  | {
    documentId: string
    kind: 'publication'
    publicationId: string
  }

type DocumentAssetAccessGrantScope = DocumentAssetAccessScope & {
  actorId?: string | null
}

const documentAssetSelect = {
  id: true,
  documentId: true,
  kind: true,
  status: true,
  mimeType: true,
  size: true,
  originalFileName: true,
  width: true,
  height: true,
  createdAt: true,
  bucket: true,
  objectKey: true,
} satisfies Prisma.DocumentAssetSelect

@Injectable()
export class DocumentAssetsService {
  private readonly secretKey
  private readonly jwtConfig
  private readonly isProduction

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly documentAccessService: DocumentAccessService,
    private readonly publicationAccessService: DocumentPublicationAccessService,
    configService: ConfigService,
  ) {
    this.jwtConfig = configService.getOrThrow<JwtConfig>('jwt')
    this.secretKey = createSecretKey(Buffer.from(this.jwtConfig.accessSecret, 'utf8'))
    this.isProduction = configService.getOrThrow<boolean>('server.isProduction')
  }

  async uploadImage(input: {
    actorId: string
    documentId: string
    fileName: string
    mimeType: string
    buffer: Buffer
  }): Promise<DocumentAsset> {
    await this.documentAccessService.assertCanEditDocument(input.actorId, input.documentId)

    const mimeType = assertDocumentImageMimeType(input.mimeType)
    assertDocumentImageBuffer(input.buffer, mimeType)
    const assetId = randomUUID()
    const objectKey = buildDocumentAssetObjectKey({
      documentId: input.documentId,
      assetId,
      extension: resolveSupportedImageExtension(mimeType),
    })

    await this.storageService.putObject({
      bucket: DOCUMENT_ASSET_BUCKET,
      key: objectKey,
      body: input.buffer,
      contentType: mimeType,
      contentLength: input.buffer.length,
      contentDisposition: {
        type: 'inline',
        fileName: input.fileName,
        fallbackFileName: 'asset',
      },
      cacheControl: 'private, max-age=300',
    })

    const sha256 = sha256Hex(input.buffer)
    const asset = await this.prisma.documentAsset.create({
      data: {
        id: assetId,
        documentId: input.documentId,
        kind: DocumentAssetKind.IMAGE,
        status: DocumentAssetStatus.READY,
        bucket: DOCUMENT_ASSET_BUCKET,
        objectKey,
        mimeType,
        size: input.buffer.length,
        sha256,
        originalFileName: input.fileName,
        width: null,
        height: null,
        createdBy: input.actorId,
      },
      select: documentAssetSelect,
    })

    return await this.toDocumentAsset(asset)
  }

  async uploadFile(input: {
    actorId: string
    documentId: string
    fileName: string
    mimeType: string
    buffer: Buffer
  }): Promise<DocumentAsset> {
    await this.documentAccessService.assertCanEditDocument(input.actorId, input.documentId)

    const mimeType = normalizeFileMimeType(input.mimeType)
    assertDocumentFileBuffer(input.buffer)
    const assetId = randomUUID()
    const objectKey = buildDocumentAssetObjectKey({
      documentId: input.documentId,
      assetId,
      extension: resolveDocumentFileExtension(input.fileName),
    })

    await this.storageService.putObject({
      bucket: DOCUMENT_ASSET_BUCKET,
      key: objectKey,
      body: input.buffer,
      contentType: mimeType,
      contentLength: input.buffer.length,
      contentDisposition: {
        type: 'attachment',
        fileName: input.fileName,
        fallbackFileName: 'attachment',
      },
      cacheControl: 'private, max-age=300',
    })

    const sha256 = sha256Hex(input.buffer)
    const asset = await this.prisma.documentAsset.create({
      data: {
        id: assetId,
        documentId: input.documentId,
        kind: DocumentAssetKind.FILE,
        status: DocumentAssetStatus.READY,
        bucket: DOCUMENT_ASSET_BUCKET,
        objectKey,
        mimeType,
        size: input.buffer.length,
        sha256,
        originalFileName: input.fileName,
        width: null,
        height: null,
        createdBy: input.actorId,
      },
      select: documentAssetSelect,
    })

    return await this.toDocumentAsset(asset)
  }

  async resolveAssets(input: {
    actorId: string
    documentId: string
    assetIds: string[]
  }): Promise<ResolveDocumentAssetsResponse> {
    await this.documentAccessService.assertCanReadDocument(input.actorId, input.documentId)
    return await this.resolveAssetsForScope({
      documentId: input.documentId,
      kind: 'document',
    }, input.assetIds)
  }

  async resolvePublicationAssets(input: {
    publicationId: string
    documentId: string
    assetIds: string[]
  }): Promise<ResolveDocumentAssetsResponse> {
    await this.assertPublicationDocumentAccess(input.publicationId, input.documentId)
    return await this.resolveAssetsForScope({
      documentId: input.documentId,
      kind: 'publication',
      publicationId: input.publicationId,
    }, input.assetIds)
  }

  async resolveSinglePublicationAssets(input: {
    documentId: string
    assetIds: string[]
  }): Promise<ResolveDocumentAssetsResponse> {
    await this.publicationAccessService.assertSinglePublicationDocumentAccess(input.documentId)
    return await this.resolveAssetsForScope({
      documentId: input.documentId,
      kind: 'publication',
      publicationId: createSinglePublicationAssetScopeId(input.documentId),
    }, input.assetIds)
  }

  async getAssetContent(input: {
    documentId: string
    assetId: string
    cookieHeader?: string
  }): Promise<StorageObject> {
    const payload = await this.verifyAccessCookie({
      expectedScope: {
        kind: 'document',
        documentId: input.documentId,
      },
      cookieHeader: input.cookieHeader,
    })

    if (!payload.actorId) {
      throw new NotFoundException('资源不存在')
    }

    await this.documentAccessService.assertCanReadDocument(payload.actorId, input.documentId)
    return this.loadAssetStorageObject(input.documentId, input.assetId)
  }

  async getPublicationAssetContent(input: {
    publicationId: string
    documentId: string
    assetId: string
    cookieHeader?: string
  }): Promise<StorageObject> {
    await this.verifyAccessCookie({
      expectedScope: {
        kind: 'publication',
        documentId: input.documentId,
        publicationId: input.publicationId,
      },
      cookieHeader: input.cookieHeader,
    })
    await this.assertPublicationDocumentAccess(input.publicationId, input.documentId)
    return this.loadAssetStorageObject(input.documentId, input.assetId)
  }

  async getSinglePublicationAssetContent(input: {
    documentId: string
    assetId: string
    cookieHeader?: string
  }): Promise<StorageObject> {
    await this.verifyAccessCookie({
      expectedScope: {
        kind: 'publication',
        documentId: input.documentId,
        publicationId: createSinglePublicationAssetScopeId(input.documentId),
      },
      cookieHeader: input.cookieHeader,
    })
    await this.publicationAccessService.assertSinglePublicationDocumentAccess(input.documentId)
    return this.loadAssetStorageObject(input.documentId, input.assetId)
  }

  async buildSinglePublicationAssetAccessCookie(documentId: string): Promise<string> {
    return await this.buildAssetAccessCookie({
      kind: 'publication',
      documentId,
      publicationId: createSinglePublicationAssetScopeId(documentId),
      actorId: null,
    })
  }

  async buildAssetAccessCookie(scope: DocumentAssetAccessGrantScope): Promise<string> {
    const token = await this.createAccessToken({
      kind: scope.kind,
      documentId: scope.documentId,
      actorId: scope.actorId ?? null,
      publicationId: scope.kind === 'publication' ? scope.publicationId : null,
      tokenType: DOCUMENT_ASSET_ACCESS_TOKEN_TYPE,
    })

    return serialize(DOCUMENT_ASSET_ACCESS_COOKIE_NAMES[scope.kind], token, {
      path: resolveAssetAccessCookiePath(scope),
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: DOCUMENT_ASSET_ACCESS_COOKIE_TTL_SECONDS,
    })
  }

  private async loadAssetStorageObject(documentId: string, assetId: string): Promise<StorageObject> {
    const asset = await this.prisma.documentAsset.findFirst({
      where: {
        id: assetId,
        documentId,
        document: {
          trashedAt: null,
        },
        deletedAt: null,
        status: DocumentAssetStatus.READY,
      },
      select: documentAssetSelect,
    })

    if (!asset) {
      throw new NotFoundException('资源不存在')
    }

    return this.storageService.getObject({
      bucket: asset.bucket,
      key: asset.objectKey,
    })
  }

  async assertAssetsBelongToDocument(input: {
    documentId: string
    assetIds: string[]
  }): Promise<void> {
    const uniqueAssetIds = normalizeRequestedAssetIds(input.assetIds)

    if (!uniqueAssetIds.length) {
      return
    }

    const count = await this.prisma.documentAsset.count({
      where: {
        documentId: input.documentId,
        id: {
          in: uniqueAssetIds,
        },
        document: {
          trashedAt: null,
        },
        deletedAt: null,
        status: DocumentAssetStatus.READY,
      },
    })

    if (count !== uniqueAssetIds.length) {
      throw new BadRequestException('正文中包含无效资源引用')
    }
  }

  private async resolveAssetsForScope(
    scope: DocumentAssetAccessScope,
    assetIds: string[],
  ): Promise<ResolveDocumentAssetsResponse> {
    const uniqueAssetIds = normalizeRequestedAssetIds(assetIds)

    if (!uniqueAssetIds.length) {
      return {
        assets: [],
        unresolvedAssetIds: [],
      }
    }

    const assets = await this.findReadyAssets(scope.documentId, uniqueAssetIds)
    const assetsById = new Map(assets.map(asset => [asset.id, asset]))
    const orderedAssets = uniqueAssetIds
      .map(assetId => assetsById.get(assetId))
      .filter((asset): asset is PersistedDocumentAsset => Boolean(asset))

    return {
      assets: await Promise.all(orderedAssets.map(asset => this.toDocumentAsset(asset, scope))),
      unresolvedAssetIds: uniqueAssetIds.filter(assetId => !assetsById.has(assetId)),
    }
  }

  private async findReadyAssets(documentId: string, assetIds: string[]): Promise<PersistedDocumentAsset[]> {
    return await this.prisma.documentAsset.findMany({
      where: {
        documentId,
        id: {
          in: assetIds,
        },
        document: {
          trashedAt: null,
        },
        deletedAt: null,
        status: DocumentAssetStatus.READY,
      },
      select: documentAssetSelect,
    })
  }

  private async toDocumentAsset(
    asset: PersistedDocumentAsset,
    scope: DocumentAssetAccessScope = {
      documentId: asset.documentId,
      kind: 'document',
    },
  ): Promise<DocumentAsset> {
    return {
      id: asset.id,
      documentId: asset.documentId,
      kind: toDocumentAssetKind(asset.kind),
      status: toDocumentAssetStatus(asset.status),
      mimeType: asset.mimeType,
      size: asset.size,
      fileName: asset.originalFileName,
      width: asset.width,
      height: asset.height,
      contentUrl: await this.createContentUrl(scope, asset.id),
      createdAt: asset.createdAt.toISOString(),
    }
  }

  private async createContentUrl(scope: DocumentAssetAccessScope, assetId: string): Promise<string> {
    if (scope.kind === 'publication') {
      if (isSinglePublicationAssetScopeId(scope.publicationId)) {
        return `${SERVER_PATH}/p/${scope.documentId}/assets/${assetId}/content`
      }

      return `${SERVER_PATH}/publications/${scope.publicationId}/documents/${scope.documentId}/assets/${assetId}/content`
    }

    return `${SERVER_PATH}/documents/${scope.documentId}/assets/${assetId}/content`
  }

  private async createAccessToken(payload: DocumentAssetAccessTokenPayload): Promise<string> {
    return await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.jwtConfig.issuer)
      .setAudience(DOCUMENT_ASSET_CONTENT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${DOCUMENT_ASSET_ACCESS_COOKIE_TTL_SECONDS}s`)
      .sign(this.secretKey)
  }

  private async verifyAccessCookie(input: {
    expectedScope: DocumentAssetAccessScope
    cookieHeader?: string
  }): Promise<DocumentAssetAccessTokenPayload> {
    const token = parse(input.cookieHeader ?? '')[DOCUMENT_ASSET_ACCESS_COOKIE_NAMES[input.expectedScope.kind]]

    if (!token) {
      throw new NotFoundException('资源不存在')
    }

    try {
      const { payload } = await jwtVerify<DocumentAssetAccessTokenPayload>(
        token,
        this.secretKey,
        {
          issuer: this.jwtConfig.issuer,
          audience: DOCUMENT_ASSET_CONTENT_AUDIENCE,
        },
      )

      if (!isAssetAccessTokenPayloadForScope(payload, input.expectedScope)) {
        throw new NotFoundException('资源不存在')
      }

      return payload
    }
    catch {
      throw new NotFoundException('资源不存在')
    }
  }

  private async assertPublicationDocumentAccess(publicationId: string, documentId: string): Promise<void> {
    const singlePublicationDocumentId = parseSinglePublicationAssetScopeId(publicationId)
    if (singlePublicationDocumentId) {
      if (singlePublicationDocumentId !== documentId) {
        throw new NotFoundException('资源不存在')
      }

      await this.publicationAccessService.assertSinglePublicationDocumentAccess(documentId)
      return
    }

    await this.publicationAccessService.assertSitePublicationDocumentAccess(publicationId, documentId)
  }
}

function isAssetAccessTokenPayloadForScope(
  payload: DocumentAssetAccessTokenPayload,
  scope: DocumentAssetAccessScope,
) {
  if (
    payload.tokenType !== DOCUMENT_ASSET_ACCESS_TOKEN_TYPE
    || payload.kind !== scope.kind
    || typeof payload.documentId !== 'string'
    || payload.documentId !== scope.documentId
    || (payload.actorId !== undefined && payload.actorId !== null && typeof payload.actorId !== 'string')
  ) {
    return false
  }

  if (scope.kind === 'publication') {
    return payload.publicationId === scope.publicationId
  }

  return true
}

function resolveAssetAccessCookiePath(scope: DocumentAssetAccessScope) {
  if (scope.kind === 'publication') {
    if (isSinglePublicationAssetScopeId(scope.publicationId)) {
      return `${SERVER_PATH}/p/${scope.documentId}/assets`
    }

    return `${SERVER_PATH}/publications/${scope.publicationId}/documents/${scope.documentId}/assets`
  }

  return `${SERVER_PATH}/documents/${scope.documentId}/assets`
}

function createSinglePublicationAssetScopeId(documentId: string): string {
  return `${SINGLE_PUBLICATION_ASSET_SCOPE_PREFIX}${documentId}`
}

function parseSinglePublicationAssetScopeId(publicationId: string): string | null {
  if (!isSinglePublicationAssetScopeId(publicationId)) {
    return null
  }

  return publicationId.slice(SINGLE_PUBLICATION_ASSET_SCOPE_PREFIX.length) || null
}

function isSinglePublicationAssetScopeId(publicationId: string): boolean {
  return publicationId.startsWith(SINGLE_PUBLICATION_ASSET_SCOPE_PREFIX)
}

function assertDocumentImageMimeType(mimeType: string): SupportedImageMimeType {
  const normalizedMimeType = normalizeSupportedImageMimeType(mimeType)

  if (normalizedMimeType) {
    return normalizedMimeType
  }

  throw new BadRequestException('图片仅支持 JPG、PNG、WEBP、GIF 格式')
}

function assertDocumentImageBuffer(buffer: Buffer, mimeType: SupportedImageMimeType): void {
  if (!buffer.length) {
    throw new BadRequestException('图片文件不能为空')
  }

  if (buffer.length > FILE_SIZE_LIMITS.DOCUMENT_IMAGE) {
    throw new PayloadTooLargeException(DOCUMENT_IMAGE_TOO_LARGE_MESSAGE)
  }

  if (!isImageSignatureMatched(buffer, mimeType)) {
    throw new BadRequestException('图片文件格式不正确')
  }
}

function assertDocumentFileBuffer(buffer: Buffer): void {
  if (!buffer.length) {
    throw new BadRequestException('附件文件不能为空')
  }

  if (buffer.length > FILE_SIZE_LIMITS.DOCUMENT_FILE) {
    throw new BadRequestException('附件大小不能超过 50MB')
  }
}

function buildDocumentAssetObjectKey(input: {
  documentId: string
  assetId: string
  extension: string
}) {
  return `documents/${input.documentId}/${input.assetId}.${input.extension}`
}

function normalizeRequestedAssetIds(assetIds: string[]): string[] {
  return Array.from(
    new Set(
      assetIds
        .map(assetId => assetId.trim())
        .filter(assetId => assetId.length > 0),
    ),
  )
}

function resolveDocumentFileExtension(fileName: string): string {
  return resolveSafeFileExtension(fileName, 'bin')
}

function toDocumentAssetKind(kind: DocumentAssetKind): DocumentAsset['kind'] {
  return kind.toLowerCase() as DocumentAsset['kind']
}

function toDocumentAssetStatus(status: DocumentAssetStatus): DocumentAsset['status'] {
  return status.toLowerCase() as DocumentAsset['status']
}
