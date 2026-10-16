import type {
  AgentChatAttachmentContent,
  ChatMessageAttachmentInput,
  ChatPersistedMessageAttachment,
  ChatUploadedAsset,
} from '@haohaoxue/lexora-contracts'
import type { Prisma } from '@prisma/client'
import type { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import {
  AgentChatAttachmentContentSchema,
  CHAT_MESSAGE_ATTACHMENT_TYPE,
  ChatPersistedMessageAttachmentSchema,
  WORKSPACE_MEMBER_STATUS,
} from '@haohaoxue/lexora-contracts'
import { FILE_SIZE_LIMITS } from '@haohaoxue/lexora-contracts/file'
import { isChatUploadedMessageAttachment } from '@haohaoxue/lexora-shared/chat'
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
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  PayloadTooLargeException,
} from '@nestjs/common'
import {
  ChatAssetKind,
  ChatAssetStatus,
} from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { StorageService } from '../../infrastructure/storage/storage.service'
import { sha256Hex } from '../../utils/hash'

const CHAT_ASSET_BUCKET = 'chat-asset'
const CHAT_ASSET_ORPHAN_RETENTION_MS = 6 * 60 * 60 * 1000
const CHAT_ASSET_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const CHAT_ASSET_CLEANUP_BATCH_SIZE = 50

const chatAssetSelect = {
  id: true,
  workspaceId: true,
  ownerUserId: true,
  sessionId: true,
  messageId: true,
  kind: true,
  status: true,
  bucket: true,
  objectKey: true,
  mimeType: true,
  size: true,
  originalFileName: true,
  createdAt: true,
} satisfies Prisma.ChatAssetSelect

type PersistedChatAsset = Prisma.ChatAssetGetPayload<{
  select: typeof chatAssetSelect
}>

export interface ChatAssetStorageLocator {
  id: string
  bucket: string
  objectKey: string
}

@Injectable()
export class ChatAssetsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatAssetsService.name)
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private cleanupInFlight = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupOrphanAssets().catch(error => this.logger.warn(
        error instanceof Error ? error.message : 'chat asset orphan cleanup failed',
      ))
    }, CHAT_ASSET_CLEANUP_INTERVAL_MS)
    const cleanupTimer = this.cleanupTimer as { unref?: () => void }
    cleanupTimer.unref?.()
  }

  onModuleDestroy(): void {
    if (!this.cleanupTimer) {
      return
    }

    clearInterval(this.cleanupTimer)
    this.cleanupTimer = null
  }

  async uploadImage(input: {
    actorId: string
    workspaceId: string
    fileName: string
    mimeType: string
    buffer: Buffer
  }): Promise<ChatUploadedAsset> {
    await this.assertWorkspaceAccess(input.actorId, input.workspaceId)

    const mimeType = assertChatImageMimeType(input.mimeType)
    assertNonEmptyBuffer(input.buffer, '图片不能为空')
    assertChatImageBuffer(input.buffer, mimeType)

    const assetId = randomUUID()
    const objectKey = buildChatAssetObjectKey({
      workspaceId: input.workspaceId,
      assetId,
      extension: resolveSupportedImageExtension(mimeType),
    })

    await this.storageService.putObject({
      bucket: CHAT_ASSET_BUCKET,
      key: objectKey,
      body: input.buffer,
      contentType: mimeType,
      contentLength: input.buffer.length,
      contentDisposition: {
        type: 'inline',
        fileName: input.fileName,
        fallbackFileName: 'image',
      },
      cacheControl: 'private, max-age=300',
    })

    const asset = await this.prisma.chatAsset.create({
      data: {
        id: assetId,
        workspaceId: input.workspaceId,
        ownerUserId: input.actorId,
        kind: ChatAssetKind.IMAGE,
        status: ChatAssetStatus.READY,
        bucket: CHAT_ASSET_BUCKET,
        objectKey,
        mimeType,
        size: input.buffer.length,
        sha256: sha256Hex(input.buffer),
        originalFileName: normalizeFileName(input.fileName, 'image'),
      },
      select: chatAssetSelect,
    })

    return toChatUploadedAsset(asset)
  }

  async uploadFile(input: {
    actorId: string
    workspaceId: string
    fileName: string
    mimeType: string
    buffer: Buffer
  }): Promise<ChatUploadedAsset> {
    await this.assertWorkspaceAccess(input.actorId, input.workspaceId)

    const mimeType = normalizeFileMimeType(input.mimeType)
    assertNonEmptyBuffer(input.buffer, '文件不能为空')
    assertChatFileBuffer(input.buffer)

    const assetId = randomUUID()
    const objectKey = buildChatAssetObjectKey({
      workspaceId: input.workspaceId,
      assetId,
      extension: resolveSafeFileExtension(input.fileName),
    })

    await this.storageService.putObject({
      bucket: CHAT_ASSET_BUCKET,
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

    const asset = await this.prisma.chatAsset.create({
      data: {
        id: assetId,
        workspaceId: input.workspaceId,
        ownerUserId: input.actorId,
        kind: ChatAssetKind.FILE,
        status: ChatAssetStatus.READY,
        bucket: CHAT_ASSET_BUCKET,
        objectKey,
        mimeType,
        size: input.buffer.length,
        sha256: sha256Hex(input.buffer),
        originalFileName: normalizeFileName(input.fileName, 'attachment'),
      },
      select: chatAssetSelect,
    })

    return toChatUploadedAsset(asset)
  }

  async resolveUploadedAttachments(input: {
    actorId: string
    workspaceId: string
    sessionId?: string
    reusableMessageIds?: string[]
    attachments: ChatMessageAttachmentInput[]
  }): Promise<Map<string, Extract<ChatPersistedMessageAttachment, { type: 'image' | 'file' }>>> {
    const uploadedAttachments = input.attachments.filter(isChatUploadedMessageAttachment)
    if (uploadedAttachments.length === 0) {
      return new Map()
    }

    const assetIds = unique(uploadedAttachments.map(attachment => attachment.assetId))
    const assets = await this.prisma.chatAsset.findMany({
      where: {
        id: { in: assetIds },
        workspaceId: input.workspaceId,
        ownerUserId: input.actorId,
        OR: buildReusableAssetWhere(input),
        status: ChatAssetStatus.READY,
        deletedAt: null,
      },
      select: chatAssetSelect,
    })
    const assetById = new Map(assets.map(asset => [asset.id, asset]))

    if (assetById.size !== assetIds.length) {
      throw new BadRequestException('上传附件不存在或不可访问')
    }

    return new Map(uploadedAttachments.map((attachment) => {
      const asset = assetById.get(attachment.assetId)
      if (!asset) {
        throw new BadRequestException('上传附件不存在或不可访问')
      }

      assertAttachmentMatchesAsset(attachment, asset)

      const persisted = {
        id: attachment.id,
        type: attachment.type,
        placement: attachment.placement,
        assetId: asset.id,
        title: asset.originalFileName,
        fileName: asset.originalFileName,
        mimeType: asset.mimeType,
        size: asset.size,
      }
      return [attachment.id, persisted]
    }))
  }

  async bindAssetsToMessage(
    tx: Prisma.TransactionClient,
    input: {
      actorId: string
      workspaceId: string
      sessionId: string
      messageId: string
      reusableMessageIds?: string[]
      attachments: ChatPersistedMessageAttachment[]
    },
  ): Promise<void> {
    const assetIds = unique(input.attachments
      .filter(isChatUploadedMessageAttachment)
      .map(attachment => attachment.assetId))

    if (assetIds.length === 0) {
      return
    }

    const result = await tx.chatAsset.updateMany({
      where: {
        id: { in: assetIds },
        workspaceId: input.workspaceId,
        ownerUserId: input.actorId,
        sessionId: null,
        messageId: null,
        status: ChatAssetStatus.READY,
        deletedAt: null,
      },
      data: {
        sessionId: input.sessionId,
        messageId: input.messageId,
      },
    })

    if (result.count !== assetIds.length) {
      const accessibleAssets = await tx.chatAsset.findMany({
        where: {
          id: { in: assetIds },
          workspaceId: input.workspaceId,
          ownerUserId: input.actorId,
          OR: [
            {
              sessionId: input.sessionId,
              messageId: input.messageId,
            },
            ...buildReusableBoundAssetWhere(input),
          ],
          status: ChatAssetStatus.READY,
          deletedAt: null,
        },
        select: {
          id: true,
        },
      })

      if (accessibleAssets.length !== assetIds.length) {
        throw new BadRequestException('上传附件不存在或不可访问')
      }
    }
  }

  async cleanupOrphanAssets(now = new Date()): Promise<number> {
    if (this.cleanupInFlight) {
      return 0
    }

    this.cleanupInFlight = true
    try {
      const cutoff = new Date(now.getTime() - CHAT_ASSET_ORPHAN_RETENTION_MS)
      const assets = await this.prisma.chatAsset.findMany({
        where: {
          sessionId: null,
          messageId: null,
          status: ChatAssetStatus.READY,
          deletedAt: null,
          createdAt: {
            lt: cutoff,
          },
        },
        orderBy: {
          createdAt: 'asc',
        },
        take: CHAT_ASSET_CLEANUP_BATCH_SIZE,
        select: chatAssetSelect,
      })

      if (assets.length === 0) {
        return 0
      }

      await Promise.all(assets.map(asset => this.storageService.deleteObject({
        bucket: asset.bucket,
        key: asset.objectKey,
      })))

      const result = await this.prisma.chatAsset.updateMany({
        where: {
          id: {
            in: assets.map(asset => asset.id),
          },
          sessionId: null,
          messageId: null,
          deletedAt: null,
        },
        data: {
          deletedAt: now,
        },
      })

      return result.count
    }
    finally {
      this.cleanupInFlight = false
    }
  }

  async deleteStoredAssets(assets: ChatAssetStorageLocator[], deletedAt = new Date()): Promise<number> {
    const assetsById = new Map(assets.map(asset => [asset.id, asset]))
    const uniqueAssets = [...assetsById.values()]
    if (uniqueAssets.length === 0) {
      return 0
    }

    await Promise.all(uniqueAssets.map(asset => this.storageService.deleteObject({
      bucket: asset.bucket,
      key: asset.objectKey,
    })))

    const result = await this.prisma.chatAsset.updateMany({
      where: {
        id: {
          in: uniqueAssets.map(asset => asset.id),
        },
        deletedAt: null,
      },
      data: {
        deletedAt,
      },
    })

    return result.count
  }

  async getGenerationAssetContent(input: {
    generationId: string
    assetId: string
  }): Promise<AgentChatAttachmentContent> {
    const generation = await this.prisma.chatMessageGeneration.findFirst({
      where: {
        generationId: input.generationId,
        deletedAt: null,
      },
      select: {
        sessionId: true,
        actorUserId: true,
        session: {
          select: {
            workspaceId: true,
          },
        },
        triggerUserMessageId: true,
      },
    })

    if (!generation) {
      throw new NotFoundException('聊天生成不存在')
    }

    const triggerUserMessage = await this.prisma.chatSessionMessage.findUnique({
      where: {
        id: generation.triggerUserMessageId,
      },
      select: {
        metadata: true,
      },
    })

    if (!triggerUserMessage) {
      throw new NotFoundException('聊天触发消息不存在')
    }

    const attachment = parseUserMessageAttachments(triggerUserMessage.metadata)
      .filter(isChatUploadedMessageAttachment)
      .find(item => item.assetId === input.assetId)

    if (!attachment) {
      throw new NotFoundException('聊天附件不存在')
    }

    const asset = await this.prisma.chatAsset.findFirst({
      where: {
        id: input.assetId,
        workspaceId: generation.session.workspaceId,
        ownerUserId: generation.actorUserId,
        sessionId: generation.sessionId,
        status: ChatAssetStatus.READY,
        deletedAt: null,
      },
      select: chatAssetSelect,
    })

    if (!asset) {
      throw new NotFoundException('聊天附件不存在')
    }

    assertAttachmentMatchesAsset(attachment, asset)

    const object = await this.storageService.getObject({
      bucket: asset.bucket,
      key: asset.objectKey,
    })
    const buffer = await readableToBuffer(object.body, getChatAttachmentMaxBytes(attachment.type))

    return AgentChatAttachmentContentSchema.parse({
      ...attachment,
      contentBase64: buffer.toString('base64'),
    })
  }

  private async assertWorkspaceAccess(userId: string, workspaceId: string): Promise<void> {
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

    if (!membership) {
      throw new NotFoundException('聊天空间不存在')
    }
  }
}

export function getChatAttachmentMaxBytes(type: 'image' | 'file'): number {
  return type === CHAT_MESSAGE_ATTACHMENT_TYPE.IMAGE
    ? FILE_SIZE_LIMITS.CHAT_IMAGE_ATTACHMENT
    : FILE_SIZE_LIMITS.CHAT_FILE_ATTACHMENT
}

function parseUserMessageAttachments(metadata: unknown): ChatPersistedMessageAttachment[] {
  if (!isRecord(metadata)) {
    throw new BadRequestException('聊天消息附件元数据无效')
  }

  const result = ChatPersistedMessageAttachmentSchema.array().safeParse(metadata.attachments)
  if (!result.success) {
    throw new BadRequestException('聊天消息附件元数据无效')
  }

  return result.data
}

function toChatUploadedAsset(asset: PersistedChatAsset): ChatUploadedAsset {
  return {
    id: asset.id,
    type: asset.kind === ChatAssetKind.IMAGE ? 'image' : 'file',
    fileName: asset.originalFileName,
    mimeType: asset.mimeType,
    size: asset.size,
    createdAt: asset.createdAt.toISOString(),
  }
}

function assertAttachmentMatchesAsset(
  attachment: Extract<ChatPersistedMessageAttachment | ChatMessageAttachmentInput, { type: 'image' | 'file' }>,
  asset: PersistedChatAsset,
): void {
  const expectedKind = attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.IMAGE ? ChatAssetKind.IMAGE : ChatAssetKind.FILE
  if (asset.kind !== expectedKind) {
    throw new BadRequestException('上传附件类型不匹配')
  }
  if (attachment.mimeType !== asset.mimeType || attachment.size !== asset.size) {
    throw new BadRequestException('上传附件元数据不匹配')
  }
}

function assertChatImageMimeType(mimeType: string) {
  const normalized = normalizeSupportedImageMimeType(mimeType)
  if (normalized) {
    return normalized
  }

  throw new BadRequestException('暂不支持该图片格式')
}

function assertChatImageBuffer(buffer: Buffer, mimeType: ReturnType<typeof assertChatImageMimeType>): void {
  if (buffer.length > FILE_SIZE_LIMITS.CHAT_IMAGE_ATTACHMENT) {
    throw new PayloadTooLargeException('图片大小超过限制')
  }

  if (isImageSignatureMatched(buffer, mimeType)) {
    return
  }

  throw new BadRequestException('图片内容与格式不匹配')
}

function assertNonEmptyBuffer(buffer: Buffer, message: string): void {
  if (buffer.length === 0) {
    throw new BadRequestException(message)
  }
}

function assertChatFileBuffer(buffer: Buffer): void {
  if (buffer.length > FILE_SIZE_LIMITS.CHAT_FILE_ATTACHMENT) {
    throw new PayloadTooLargeException('文件大小超过限制')
  }
}

function normalizeFileName(fileName: string, fallback: string): string {
  return fileName.trim() || fallback
}

function buildChatAssetObjectKey(input: {
  workspaceId: string
  assetId: string
  extension: string
}): string {
  return input.extension
    ? `chat/${input.workspaceId}/${input.assetId}.${input.extension}`
    : `chat/${input.workspaceId}/${input.assetId}`
}

async function readableToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.length
    if (totalBytes > maxBytes) {
      throw new PayloadTooLargeException('聊天附件大小超过限制')
    }
    chunks.push(buffer)
  }

  return Buffer.concat(chunks, totalBytes)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function buildReusableAssetWhere(input: {
  sessionId?: string
  reusableMessageIds?: string[]
}): Prisma.ChatAssetWhereInput[] {
  return [
    {
      sessionId: null,
      messageId: null,
    },
    ...buildReusableBoundAssetWhere(input),
  ]
}

function buildReusableBoundAssetWhere(input: {
  sessionId?: string
  reusableMessageIds?: string[]
}): Prisma.ChatAssetWhereInput[] {
  const reusableMessageIds = unique(input.reusableMessageIds ?? [])
  if (!input.sessionId || reusableMessageIds.length === 0) {
    return []
  }

  return [
    {
      sessionId: input.sessionId,
      messageId: {
        in: reusableMessageIds,
      },
    },
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
