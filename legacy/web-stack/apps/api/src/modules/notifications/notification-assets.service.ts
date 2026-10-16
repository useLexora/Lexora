import type {
  PlatformNotificationAsset,
  ResolvePlatformNotificationAssetsResponse,
} from '@haohaoxue/lexora-contracts'
import type { JwtConfig } from '../../config/auth.config'
import type { StorageObject } from '../../infrastructure/storage/storage.interface'
import { Buffer } from 'node:buffer'
import { createSecretKey, randomUUID } from 'node:crypto'
import {
  API_ERROR_CODE,
  PLATFORM_NOTIFICATION_IMAGE_MAX_BYTES,
  SERVER_PATH,
} from '@haohaoxue/lexora-contracts'
import { prettyBytes } from '@haohaoxue/lexora-shared'
import {
  Injectable,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  PlatformNotificationAssetStatus,
  Prisma,
} from '@prisma/client'
import { parse, serialize } from 'cookie'
import { jwtVerify, SignJWT } from 'jose'
import { PrismaService } from '../../database/prisma.service'
import { StorageService } from '../../infrastructure/storage/storage.service'
import { apiBadRequest, apiNotFound, apiPayloadTooLarge } from '../../utils/api-error'
import { sha256Hex } from '../../utils/hash'

const PLATFORM_NOTIFICATION_ASSET_BUCKET = 'notification-asset'
const PLATFORM_NOTIFICATION_ASSET_CONTENT_AUDIENCE = 'lexora-notification-asset'
const PLATFORM_NOTIFICATION_ASSET_ACCESS_TOKEN_TYPE = 'notification-asset-access'
const PLATFORM_NOTIFICATION_ASSET_ACCESS_COOKIE_NAME = 'lexora_notification_asset_access'
const PLATFORM_NOTIFICATION_ASSET_ACCESS_COOKIE_TTL_SECONDS = 60 * 5
const PLATFORM_NOTIFICATION_IMAGE_TOO_LARGE_MESSAGE = `图片大小不能超过 ${prettyBytes(PLATFORM_NOTIFICATION_IMAGE_MAX_BYTES)}`

const PLATFORM_NOTIFICATION_IMAGE_EXTENSION_MAP = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

type PlatformNotificationImageMimeType = keyof typeof PLATFORM_NOTIFICATION_IMAGE_EXTENSION_MAP
type NotificationAssetAccessKind = 'admin' | 'published'

interface NotificationAssetAccessTokenPayload {
  kind: NotificationAssetAccessKind
  tokenType: typeof PLATFORM_NOTIFICATION_ASSET_ACCESS_TOKEN_TYPE
  actorId?: string | null
  [key: string]: unknown
}

type PersistedPlatformNotificationAsset = Prisma.PlatformNotificationAssetGetPayload<{
  select: typeof platformNotificationAssetSelect
}>
type NotificationAssetAttachmentPrisma = Pick<Prisma.TransactionClient, 'platformNotificationAsset'>

const platformNotificationAssetSelect = {
  id: true,
  notificationId: true,
  status: true,
  mimeType: true,
  size: true,
  originalFileName: true,
  width: true,
  height: true,
  createdAt: true,
  bucket: true,
  objectKey: true,
} satisfies Prisma.PlatformNotificationAssetSelect

@Injectable()
export class NotificationAssetsService {
  private readonly secretKey
  private readonly jwtConfig: JwtConfig
  private readonly isProduction: boolean

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    configService: ConfigService,
  ) {
    this.jwtConfig = configService.getOrThrow<JwtConfig>('jwt')
    this.secretKey = createSecretKey(Buffer.from(this.jwtConfig.accessSecret, 'utf8'))
    this.isProduction = configService.getOrThrow<boolean>('server.isProduction')
  }

  async uploadImage(input: {
    actorId: string
    fileName: string
    mimeType: string
    buffer: Buffer
  }): Promise<PlatformNotificationAsset> {
    const mimeType = assertNotificationImageMimeType(input.mimeType)
    assertNotificationImageBuffer(input.buffer, mimeType)
    const assetId = randomUUID()
    const objectKey = buildNotificationAssetObjectKey({
      assetId,
      extension: PLATFORM_NOTIFICATION_IMAGE_EXTENSION_MAP[mimeType],
    })

    await this.storageService.putObject({
      bucket: PLATFORM_NOTIFICATION_ASSET_BUCKET,
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

    const asset = await this.prisma.platformNotificationAsset.create({
      data: {
        id: assetId,
        status: PlatformNotificationAssetStatus.READY,
        bucket: PLATFORM_NOTIFICATION_ASSET_BUCKET,
        objectKey,
        mimeType,
        size: input.buffer.length,
        sha256: sha256Hex(input.buffer),
        originalFileName: input.fileName,
        width: null,
        height: null,
        createdBy: input.actorId,
      },
      select: platformNotificationAssetSelect,
    })

    return this.toPlatformNotificationAsset(asset)
  }

  async resolveAdminAssets(assetIds: string[]): Promise<ResolvePlatformNotificationAssetsResponse> {
    return await this.resolveAssets(assetIds, {
      where: {},
    })
  }

  async resolvePublishedAssets(input: {
    assetIds: string[]
  }): Promise<ResolvePlatformNotificationAssetsResponse> {
    return await this.resolveAssets(input.assetIds, {
      where: {
        notification: {
          status: 'PUBLISHED',
          publishedAt: {
            not: null,
          },
          deletedAt: null,
        },
      },
    })
  }

  async assertAssetsCanBeAttached(input: {
    notificationId?: string
    assetIds: string[]
  }, prisma: NotificationAssetAttachmentPrisma = this.prisma): Promise<void> {
    const assetIds = normalizeRequestedAssetIds(input.assetIds)

    if (assetIds.length === 0) {
      return
    }

    const count = await prisma.platformNotificationAsset.count({
      where: {
        id: {
          in: assetIds,
        },
        status: PlatformNotificationAssetStatus.READY,
        OR: [
          { notificationId: null },
          ...(input.notificationId ? [{ notificationId: input.notificationId }] : []),
        ],
      },
    })

    if (count !== assetIds.length) {
      throw apiBadRequest(API_ERROR_CODE.NOTIFICATION_ASSET_INVALID)
    }
  }

  async attachAssetsToNotification(input: {
    notificationId: string
    assetIds: string[]
  }, prisma: NotificationAssetAttachmentPrisma = this.prisma): Promise<void> {
    const assetIds = normalizeRequestedAssetIds(input.assetIds)
    await this.assertAssetsCanBeAttached({
      notificationId: input.notificationId,
      assetIds,
    }, prisma)

    if (assetIds.length > 0) {
      const attachResult = await prisma.platformNotificationAsset.updateMany({
        where: {
          id: {
            in: assetIds,
          },
          status: PlatformNotificationAssetStatus.READY,
          OR: [
            { notificationId: null },
            { notificationId: input.notificationId },
          ],
        },
        data: {
          notificationId: input.notificationId,
        },
      })

      if (attachResult.count !== assetIds.length) {
        throw apiBadRequest(API_ERROR_CODE.NOTIFICATION_ASSET_INVALID)
      }
    }

    await prisma.platformNotificationAsset.updateMany({
      where: {
        notificationId: input.notificationId,
        ...(assetIds.length > 0
          ? {
              id: {
                notIn: assetIds,
              },
            }
          : {}),
      },
      data: {
        notificationId: null,
      },
    })
  }

  async getAssetContent(input: {
    assetId: string
    cookieHeader?: string
  }): Promise<StorageObject> {
    const payload = await this.verifyAccessCookie(input.cookieHeader)
    const asset = await this.prisma.platformNotificationAsset.findFirst({
      where: {
        id: input.assetId,
        status: PlatformNotificationAssetStatus.READY,
        ...(payload.kind === 'published'
          ? {
              notification: {
                status: 'PUBLISHED',
                publishedAt: {
                  not: null,
                },
                deletedAt: null,
              },
            }
          : {}),
      },
      select: platformNotificationAssetSelect,
    })

    if (!asset) {
      throw apiNotFound(API_ERROR_CODE.RESOURCE_NOT_FOUND)
    }

    return this.storageService.getObject({
      bucket: asset.bucket,
      key: asset.objectKey,
    })
  }

  async buildAssetAccessCookie(input: {
    kind: NotificationAssetAccessKind
    actorId?: string | null
  }): Promise<string> {
    const token = await this.createAccessToken({
      kind: input.kind,
      actorId: input.actorId ?? null,
      tokenType: PLATFORM_NOTIFICATION_ASSET_ACCESS_TOKEN_TYPE,
    })

    return serialize(PLATFORM_NOTIFICATION_ASSET_ACCESS_COOKIE_NAME, token, {
      path: `${SERVER_PATH}/notifications/assets`,
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: PLATFORM_NOTIFICATION_ASSET_ACCESS_COOKIE_TTL_SECONDS,
    })
  }

  private async resolveAssets(
    assetIds: string[],
    input: {
      where: Prisma.PlatformNotificationAssetWhereInput
    },
  ): Promise<ResolvePlatformNotificationAssetsResponse> {
    const uniqueAssetIds = normalizeRequestedAssetIds(assetIds)

    if (uniqueAssetIds.length === 0) {
      return {
        assets: [],
        unresolvedAssetIds: [],
      }
    }

    const assets = await this.prisma.platformNotificationAsset.findMany({
      where: {
        id: {
          in: uniqueAssetIds,
        },
        status: PlatformNotificationAssetStatus.READY,
        ...input.where,
      },
      select: platformNotificationAssetSelect,
    })
    const assetsById = new Map(assets.map(asset => [asset.id, asset]))
    const orderedAssets = uniqueAssetIds
      .map(assetId => assetsById.get(assetId))
      .filter((asset): asset is PersistedPlatformNotificationAsset => Boolean(asset))

    return {
      assets: orderedAssets.map(asset => this.toPlatformNotificationAsset(asset)),
      unresolvedAssetIds: uniqueAssetIds.filter(assetId => !assetsById.has(assetId)),
    }
  }

  private toPlatformNotificationAsset(asset: PersistedPlatformNotificationAsset): PlatformNotificationAsset {
    return {
      id: asset.id,
      notificationId: asset.notificationId,
      status: asset.status.toLowerCase() as PlatformNotificationAsset['status'],
      mimeType: asset.mimeType,
      size: asset.size,
      fileName: asset.originalFileName,
      width: asset.width,
      height: asset.height,
      contentUrl: `${SERVER_PATH}/notifications/assets/${asset.id}/content`,
      createdAt: asset.createdAt.toISOString(),
    }
  }

  private async createAccessToken(payload: NotificationAssetAccessTokenPayload): Promise<string> {
    return await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.jwtConfig.issuer)
      .setAudience(PLATFORM_NOTIFICATION_ASSET_CONTENT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${PLATFORM_NOTIFICATION_ASSET_ACCESS_COOKIE_TTL_SECONDS}s`)
      .sign(this.secretKey)
  }

  private async verifyAccessCookie(cookieHeader?: string): Promise<NotificationAssetAccessTokenPayload> {
    const token = parse(cookieHeader ?? '')[PLATFORM_NOTIFICATION_ASSET_ACCESS_COOKIE_NAME]

    if (!token) {
      throw apiNotFound(API_ERROR_CODE.RESOURCE_NOT_FOUND)
    }

    try {
      const { payload } = await jwtVerify<NotificationAssetAccessTokenPayload>(
        token,
        this.secretKey,
        {
          issuer: this.jwtConfig.issuer,
          audience: PLATFORM_NOTIFICATION_ASSET_CONTENT_AUDIENCE,
        },
      )

      if (
        payload.tokenType !== PLATFORM_NOTIFICATION_ASSET_ACCESS_TOKEN_TYPE
        || (payload.kind !== 'admin' && payload.kind !== 'published')
      ) {
        throw apiNotFound(API_ERROR_CODE.RESOURCE_NOT_FOUND)
      }

      return payload
    }
    catch {
      throw apiNotFound(API_ERROR_CODE.RESOURCE_NOT_FOUND)
    }
  }
}

function assertNotificationImageMimeType(mimeType: string): PlatformNotificationImageMimeType {
  const normalizedMimeType = mimeType.trim().toLowerCase()

  if (normalizedMimeType in PLATFORM_NOTIFICATION_IMAGE_EXTENSION_MAP) {
    return normalizedMimeType as PlatformNotificationImageMimeType
  }

  throw apiBadRequest(API_ERROR_CODE.NOTIFICATION_IMAGE_UNSUPPORTED_TYPE)
}

function assertNotificationImageBuffer(buffer: Buffer, mimeType: PlatformNotificationImageMimeType): void {
  if (!buffer.length) {
    throw apiBadRequest(API_ERROR_CODE.NOTIFICATION_IMAGE_EMPTY)
  }

  if (buffer.length > PLATFORM_NOTIFICATION_IMAGE_MAX_BYTES) {
    throw apiPayloadTooLarge(API_ERROR_CODE.NOTIFICATION_IMAGE_TOO_LARGE, PLATFORM_NOTIFICATION_IMAGE_TOO_LARGE_MESSAGE)
  }

  if (!isNotificationImageSignatureMatched(buffer, mimeType)) {
    throw apiBadRequest(API_ERROR_CODE.NOTIFICATION_IMAGE_SIGNATURE_MISMATCH)
  }
}

function isNotificationImageSignatureMatched(buffer: Buffer, mimeType: PlatformNotificationImageMimeType): boolean {
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

  if (mimeType === 'image/gif') {
    return buffer.length >= 6
      && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
  }

  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
}

function buildNotificationAssetObjectKey(input: {
  assetId: string
  extension: string
}) {
  return `platform-notifications/${input.assetId}.${input.extension}`
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
