import type {
  CreatePlatformNotificationRequest,
  GetPlatformNotificationsQuery,
  NotificationItem,
  NotificationListQuery,
  NotificationListResponse,
  NotificationMarkAllReadResponse,
  NotificationSummary,
  PlatformNotification,
  PlatformNotificationListResponse,
  TiptapJsonContent,
  UpdatePlatformNotificationRequest,
} from '@haohaoxue/lexora-contracts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import {
  API_ERROR_CODE,
  NOTIFICATION_LIST_FILTER,
  NOTIFICATION_SOURCE_KIND,
  PLATFORM_NOTIFICATION_STATUS,
  TiptapJsonContentPayloadSchema,
} from '@haohaoxue/lexora-contracts'
import { summarizeDocumentContent } from '@haohaoxue/lexora-shared'
import {
  Injectable,
} from '@nestjs/common'
import {
  NotificationSourceKind,
  PlatformNotificationStatus,
  Prisma,
} from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { apiBadRequest, apiNotFound } from '../../utils/api-error'
import { NotificationAssetsService } from './notification-assets.service'
import { collectNotificationImageAssetIds } from './notification-content-assets'

const SYSTEM_NOTIFICATION_SENDER = {
  displayName: 'Lexora',
} as const

const platformNotificationSelect = {
  id: true,
  title: true,
  content: true,
  summary: true,
  status: true,
  publishedAt: true,
  createdAt: true,
  createdBy: true,
  createdByUser: {
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
    },
  },
  updatedAt: true,
  updatedBy: true,
  updatedByUser: {
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
    },
  },
} satisfies Prisma.PlatformNotificationSelect

type PersistedPlatformNotification = Prisma.PlatformNotificationGetPayload<{
  select: typeof platformNotificationSelect
}>

type NotificationItemWithoutReadState = NotificationItem extends infer Item
  ? Item extends NotificationItem
    ? Omit<Item, 'readAt' | 'isUnread'>
    : never
  : never

interface NotificationSourceProjection {
  sourceKey: string
  sourceKind: NotificationSourceKind
  sourceId: string
  messageAt: Date
  item: NotificationItemWithoutReadState
}

type NotificationSourceCursor = Pick<NotificationSourceProjection, 'messageAt' | 'sourceKind' | 'sourceId'>

interface NotificationSourcePage {
  sources: NotificationSourceProjection[]
  hasMore: boolean
}

interface NotificationSourceIdRow {
  id: string
  messageAt: Date
}

interface UnreadNotificationCountRow {
  count: number | bigint
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationAssetsService: NotificationAssetsService,
  ) {}

  async getNotificationSummary(userId: string): Promise<NotificationSummary> {
    return {
      unreadCount: await this.countUnreadNotifications(userId),
    }
  }

  async listNotifications(
    userId: string,
    query: NotificationListQuery,
  ): Promise<NotificationListResponse> {
    const limit = Math.min(Math.max(query.limit, 1), 50)
    const cursor = decodeNotificationCursor(query.cursor)
    const [sourcePage, unreadCount] = await Promise.all([
      query.filter === NOTIFICATION_LIST_FILTER.UNREAD
        ? this.loadUnreadNotificationSourcePage(userId, limit, cursor)
        : this.loadNotificationSourcePage(limit, cursor),
      this.countUnreadNotifications(userId),
    ])
    const readReceiptBySourceKey = query.filter === NOTIFICATION_LIST_FILTER.UNREAD
      ? new Map<string, { readAt: Date }>()
      : await this.loadReadReceiptBySourceKey(userId, sourcePage.sources)
    const pageSources = sourcePage.sources.map(source => ({
      ...source,
      readAt: readReceiptBySourceKey.get(source.sourceKey)?.readAt ?? null,
    }))
    const cursorSource = sourcePage.hasMore ? pageSources[pageSources.length - 1] : null

    return {
      items: pageSources.map(toNotificationItemWithReadState),
      nextCursor: cursorSource ? encodeNotificationCursor(cursorSource) : null,
      unreadCount,
    }
  }

  async markAllAsRead(userId: string): Promise<NotificationMarkAllReadResponse> {
    let markedCount = 0
    let cursor: NotificationSourceCursor | null = null

    while (true) {
      const sourcePage = await this.loadUnreadNotificationSourcePage(userId, 50, cursor)
      const unreadSources = sourcePage.sources

      if (unreadSources.length === 0) {
        break
      }

      await this.prisma.notificationReadReceipt.createMany({
        data: unreadSources.map<Prisma.NotificationReadReceiptCreateManyInput>(source => ({
          id: randomUUID(),
          userId,
          sourceKind: source.sourceKind,
          sourceId: source.sourceId,
        })),
        skipDuplicates: true,
      })

      markedCount += unreadSources.length

      if (!sourcePage.hasMore) {
        break
      }

      cursor = unreadSources[unreadSources.length - 1]
    }

    return {
      markedCount,
      unreadCount: await this.countUnreadNotifications(userId),
    }
  }

  async listPlatformNotifications(
    query: GetPlatformNotificationsQuery,
  ): Promise<PlatformNotificationListResponse> {
    const where = {
      status: query.status ? query.status as PlatformNotificationStatus : undefined,
    } satisfies Prisma.PlatformNotificationWhereInput
    const [total, items] = await Promise.all([
      this.prisma.platformNotification.count({ where }),
      this.prisma.platformNotification.findMany({
        where,
        orderBy: [
          { updatedAt: 'desc' },
          { createdAt: 'desc' },
        ],
        skip: (query.pageNo - 1) * query.pageSize,
        take: query.pageSize,
        select: platformNotificationSelect,
      }),
    ])

    return {
      total,
      items: items.map(mapPlatformNotification),
    }
  }

  async createPlatformNotification(
    actorUserId: string,
    payload: CreatePlatformNotificationRequest,
  ): Promise<PlatformNotification> {
    const content = normalizeTiptapContent(payload.content)
    const assetIds = collectNotificationImageAssetIds(content)
    const status = payload.status as PlatformNotificationStatus
    const now = new Date()
    const notification = await this.prisma.$transaction(async (tx) => {
      await this.notificationAssetsService.assertAssetsCanBeAttached({ assetIds }, tx)
      const notification = await tx.platformNotification.create({
        data: {
          title: payload.title,
          content: toPrismaJsonValue(content),
          summary: summarizeDocumentContent(content, 120, ''),
          status,
          publishedAt: status === PLATFORM_NOTIFICATION_STATUS.PUBLISHED ? now : null,
          createdBy: actorUserId,
          updatedBy: actorUserId,
        },
        select: platformNotificationSelect,
      })
      await this.notificationAssetsService.attachAssetsToNotification({
        notificationId: notification.id,
        assetIds,
      }, tx)

      return notification
    })

    return mapPlatformNotification(notification)
  }

  async updatePlatformNotification(
    actorUserId: string,
    notificationId: string,
    payload: UpdatePlatformNotificationRequest,
  ): Promise<PlatformNotification> {
    if (Object.keys(payload).length === 0) {
      throw apiBadRequest(API_ERROR_CODE.NOTIFICATION_EMPTY_UPDATE)
    }

    const content = payload.content ? normalizeTiptapContent(payload.content) : undefined
    const assetIds = content ? collectNotificationImageAssetIds(content) : undefined
    const status = payload.status as PlatformNotificationStatus | undefined
    const notification = await this.prisma.$transaction(async (tx) => {
      const current = await tx.platformNotification.findUnique({
        where: { id: notificationId },
        select: {
          id: true,
          status: true,
          publishedAt: true,
        },
      })

      if (!current) {
        throw apiNotFound(API_ERROR_CODE.RESOURCE_NOT_FOUND)
      }

      if (current.status === PLATFORM_NOTIFICATION_STATUS.PUBLISHED) {
        throw apiBadRequest(API_ERROR_CODE.NOTIFICATION_PUBLISHED_LOCKED)
      }

      if (assetIds) {
        await this.notificationAssetsService.assertAssetsCanBeAttached({
          notificationId,
          assetIds,
        }, tx)
      }
      const notification = await tx.platformNotification.update({
        where: { id: notificationId },
        data: {
          title: payload.title,
          content: content ? toPrismaJsonValue(content) : undefined,
          summary: content ? summarizeDocumentContent(content, 120, '') : undefined,
          status,
          publishedAt: resolveNextPublishedAt(status, current.publishedAt),
          updatedBy: actorUserId,
        },
        select: platformNotificationSelect,
      })
      if (assetIds) {
        await this.notificationAssetsService.attachAssetsToNotification({
          notificationId: notification.id,
          assetIds,
        }, tx)
      }

      return notification
    })

    return mapPlatformNotification(notification)
  }

  async deletePlatformNotification(actorUserId: string, notificationId: string): Promise<void> {
    const current = await this.prisma.platformNotification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
      },
    })

    if (!current) {
      throw apiNotFound(API_ERROR_CODE.RESOURCE_NOT_FOUND)
    }

    await this.prisma.platformNotification.update({
      where: { id: notificationId },
      data: {
        deletedAt: new Date(),
        deletedBy: actorUserId,
      },
    })
  }

  private async countUnreadNotifications(userId: string): Promise<number> {
    return await this.countUnreadPlatformNotifications(userId)
  }

  private async loadNotificationSourcePage(
    limit: number,
    cursor: NotificationSourceCursor | null,
  ): Promise<NotificationSourcePage> {
    const take = limit + 1
    const platformNotifications = await this.loadPlatformNotificationsPage(take, cursor)
    const sources = platformNotifications.map(mapPlatformNotificationSource)

    return createNotificationSourcePage(sources, limit)
  }

  private async loadPlatformNotificationsPage(
    take: number,
    cursor: NotificationSourceCursor | null,
  ): Promise<PersistedPlatformNotification[]> {
    return this.prisma.platformNotification.findMany({
      where: {
        status: PLATFORM_NOTIFICATION_STATUS.PUBLISHED,
        publishedAt: {
          not: null,
        },
        ...createPlatformNotificationCursorWhere(cursor),
      },
      select: platformNotificationSelect,
      orderBy: [
        { publishedAt: 'desc' },
        { id: 'asc' },
      ],
      take,
    })
  }

  private async loadUnreadNotificationSourcePage(
    userId: string,
    limit: number,
    cursor: NotificationSourceCursor | null,
  ): Promise<NotificationSourcePage> {
    const take = limit + 1
    const platformNotificationRows = await this.loadUnreadPlatformNotificationRows(userId, take, cursor)
    const platformNotifications = await this.loadPlatformNotificationsByIds(platformNotificationRows.map(row => row.id))
    const sources = platformNotifications.map(mapPlatformNotificationSource)

    return createNotificationSourcePage(sources, limit)
  }

  private async loadPlatformNotificationsByIds(ids: string[]): Promise<PersistedPlatformNotification[]> {
    if (ids.length === 0) {
      return []
    }

    return this.prisma.platformNotification.findMany({
      where: {
        id: {
          in: ids,
        },
        status: PLATFORM_NOTIFICATION_STATUS.PUBLISHED,
        publishedAt: {
          not: null,
        },
      },
      select: platformNotificationSelect,
    })
  }

  private async loadUnreadPlatformNotificationRows(
    userId: string,
    take: number,
    cursor: NotificationSourceCursor | null,
  ): Promise<NotificationSourceIdRow[]> {
    return this.prisma.$queryRaw<NotificationSourceIdRow[]>(Prisma.sql`
      SELECT pn."id", pn."publishedAt" AS "messageAt"
      FROM "PlatformNotification" pn
      LEFT JOIN "NotificationReadReceipt" receipt
        ON receipt."userId" = ${userId}
       AND receipt."sourceKind" = 'PLATFORM'::"NotificationSourceKind"
       AND receipt."sourceId" = pn."id"
      WHERE pn."deletedAt" IS NULL
        AND pn."status" = 'PUBLISHED'::"PlatformNotificationStatus"
        AND pn."publishedAt" IS NOT NULL
        AND receipt."id" IS NULL
        ${createPlatformNotificationCursorSql(cursor)}
      ORDER BY pn."publishedAt" DESC, pn."id" ASC
      LIMIT ${take}
    `)
  }

  private async countUnreadPlatformNotifications(userId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<UnreadNotificationCountRow[]>(Prisma.sql`
      SELECT COUNT(*)::int AS "count"
      FROM "PlatformNotification" pn
      LEFT JOIN "NotificationReadReceipt" receipt
        ON receipt."userId" = ${userId}
       AND receipt."sourceKind" = 'PLATFORM'::"NotificationSourceKind"
       AND receipt."sourceId" = pn."id"
      WHERE pn."deletedAt" IS NULL
        AND pn."status" = 'PUBLISHED'::"PlatformNotificationStatus"
        AND pn."publishedAt" IS NOT NULL
        AND receipt."id" IS NULL
    `)

    return Number(rows[0]?.count ?? 0)
  }

  private async loadReadReceiptBySourceKey(
    userId: string,
    sources: Pick<NotificationSourceProjection, 'sourceKind' | 'sourceId' | 'sourceKey'>[],
  ): Promise<Map<string, { readAt: Date }>> {
    if (sources.length === 0) {
      return new Map()
    }

    const readReceipts = await this.prisma.notificationReadReceipt.findMany({
      where: {
        userId,
        OR: sources.map(source => ({
          sourceKind: source.sourceKind,
          sourceId: source.sourceId,
        })),
      },
      select: {
        sourceKind: true,
        sourceId: true,
        readAt: true,
      },
    })

    return new Map(readReceipts.map(receipt => [
      createSourceKey(receipt.sourceKind, receipt.sourceId),
      { readAt: receipt.readAt },
    ]))
  }
}

function toNotificationItemWithReadState(
  source: NotificationSourceProjection & { readAt: Date | null },
): NotificationItem {
  return {
    ...source.item,
    readAt: source.readAt?.toISOString() ?? null,
    isUnread: source.readAt === null,
  } as NotificationItem
}

function mapPlatformNotificationSource(notification: PersistedPlatformNotification): NotificationSourceProjection {
  const messageAt = notification.publishedAt ?? notification.createdAt
  const content = normalizeTiptapContent(notification.content)
  const contentText = notification.summary || summarizeDocumentContent(content, 120, '')

  return {
    sourceKey: createSourceKey(NOTIFICATION_SOURCE_KIND.PLATFORM, notification.id),
    sourceKind: NotificationSourceKind.PLATFORM,
    sourceId: notification.id,
    messageAt,
    item: {
      id: createSourceKey(NOTIFICATION_SOURCE_KIND.PLATFORM, notification.id),
      kind: NOTIFICATION_SOURCE_KIND.PLATFORM,
      sourceId: notification.id,
      title: notification.title,
      content,
      contentText,
      sender: {
        ...SYSTEM_NOTIFICATION_SENDER,
        avatarUrl: notification.createdByUser?.avatarUrl ?? null,
      },
      messageAt: messageAt.toISOString(),
      createdAt: notification.createdAt.toISOString(),
    },
  }
}

function mapPlatformNotification(notification: PersistedPlatformNotification): PlatformNotification {
  return {
    id: notification.id,
    title: notification.title,
    content: normalizeTiptapContent(notification.content),
    summary: notification.summary,
    status: notification.status as PlatformNotification['status'],
    publishedAt: notification.publishedAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
    createdBy: notification.createdBy,
    createdByUser: toAuditUserSummary(notification.createdByUser),
    updatedAt: notification.updatedAt.toISOString(),
    updatedBy: notification.updatedBy,
    updatedByUser: toAuditUserSummary(notification.updatedByUser),
  }
}

function compareNotificationSource(
  left: Pick<NotificationSourceProjection, 'messageAt' | 'sourceKind' | 'sourceId'>,
  right: Pick<NotificationSourceProjection, 'messageAt' | 'sourceKind' | 'sourceId'>,
) {
  const timeDelta = right.messageAt.getTime() - left.messageAt.getTime()

  if (timeDelta !== 0) {
    return timeDelta
  }

  const kindDelta = left.sourceKind.localeCompare(right.sourceKind)

  if (kindDelta !== 0) {
    return kindDelta
  }

  return left.sourceId.localeCompare(right.sourceId)
}

function createNotificationSourcePage(
  sources: NotificationSourceProjection[],
  limit: number,
): NotificationSourcePage {
  const sortedSources = sources.sort(compareNotificationSource).slice(0, limit + 1)

  return {
    sources: sortedSources.slice(0, limit),
    hasMore: sortedSources.length > limit,
  }
}

function createPlatformNotificationCursorWhere(
  cursor: NotificationSourceCursor | null,
): Prisma.PlatformNotificationWhereInput {
  if (!cursor) {
    return {}
  }

  const sameTimeKindDelta = NotificationSourceKind.PLATFORM.localeCompare(cursor.sourceKind)
  const or: Prisma.PlatformNotificationWhereInput[] = [
    {
      publishedAt: {
        lt: cursor.messageAt,
      },
    },
  ]

  if (sameTimeKindDelta > 0) {
    or.push({ publishedAt: cursor.messageAt })
  }
  else if (sameTimeKindDelta === 0) {
    or.push({
      publishedAt: cursor.messageAt,
      id: {
        gt: cursor.sourceId,
      },
    })
  }

  return { OR: or }
}

function createPlatformNotificationCursorSql(cursor: NotificationSourceCursor | null): Prisma.Sql {
  if (!cursor) {
    return Prisma.empty
  }

  const sameTimeKindDelta = NotificationSourceKind.PLATFORM.localeCompare(cursor.sourceKind)
  const sameTimeSql = sameTimeKindDelta > 0
    ? Prisma.sql`OR pn."publishedAt" = ${cursor.messageAt}`
    : sameTimeKindDelta === 0
      ? Prisma.sql`OR (pn."publishedAt" = ${cursor.messageAt} AND pn."id" > ${cursor.sourceId})`
      : Prisma.empty

  return Prisma.sql`AND (pn."publishedAt" < ${cursor.messageAt} ${sameTimeSql})`
}

function encodeNotificationCursor(source: NotificationSourceCursor): string {
  return Buffer.from(JSON.stringify({
    messageAt: source.messageAt.toISOString(),
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
  })).toString('base64url')
}

function decodeNotificationCursor(cursor: string | undefined): NotificationSourceCursor | null {
  if (!cursor) {
    return null
  }

  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      messageAt?: unknown
      sourceKind?: unknown
      sourceId?: unknown
    }
    const messageAt = typeof value.messageAt === 'string' ? new Date(value.messageAt) : null

    if (
      !messageAt
      || Number.isNaN(messageAt.getTime())
      || typeof value.sourceKind !== 'string'
      || typeof value.sourceId !== 'string'
      || !Object.values(NotificationSourceKind).includes(value.sourceKind as NotificationSourceKind)
    ) {
      return null
    }

    return {
      messageAt,
      sourceKind: value.sourceKind as NotificationSourceKind,
      sourceId: value.sourceId,
    }
  }
  catch {
    return null
  }
}

function createSourceKey(sourceKind: NotificationSourceKind | string, sourceId: string) {
  return `${sourceKind}:${sourceId}`
}

function normalizeTiptapContent(content: unknown): TiptapJsonContent {
  return TiptapJsonContentPayloadSchema.parse(content)
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function resolveNextPublishedAt(
  status: PlatformNotificationStatus | undefined,
  currentPublishedAt: Date | null,
) {
  if (!status) {
    return undefined
  }

  if (status === PLATFORM_NOTIFICATION_STATUS.DRAFT) {
    return null
  }

  return currentPublishedAt ?? new Date()
}

function toAuditUserSummary(user: { id: string, displayName: string | null, avatarUrl: string | null } | null) {
  return user
    ? {
        id: user.id,
        displayName: user.displayName ?? '用户',
        avatarUrl: user.avatarUrl,
      }
    : null
}
