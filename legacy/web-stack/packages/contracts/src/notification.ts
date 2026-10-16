import { z } from 'zod'
import {
  CountSchema,
  createPageDataSchema,
  RequestPageParamsSchema,
} from './common'
import { AuditUserSummarySchema } from './identity'
import { TiptapJsonContentPayloadSchema } from './tiptap/core'

export const NOTIFICATION_SOURCE_KIND = {
  PLATFORM: 'PLATFORM',
} as const

export const NOTIFICATION_SOURCE_KIND_VALUES = [
  NOTIFICATION_SOURCE_KIND.PLATFORM,
] as const

export const NOTIFICATION_LIST_FILTER = {
  ALL: 'all',
  UNREAD: 'unread',
} as const

export const NOTIFICATION_LIST_FILTER_VALUES = [
  NOTIFICATION_LIST_FILTER.ALL,
  NOTIFICATION_LIST_FILTER.UNREAD,
] as const

export const PLATFORM_NOTIFICATION_STATUS = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
} as const

export const PLATFORM_NOTIFICATION_STATUS_VALUES = [
  PLATFORM_NOTIFICATION_STATUS.DRAFT,
  PLATFORM_NOTIFICATION_STATUS.PUBLISHED,
] as const

export const PLATFORM_NOTIFICATION_TITLE_MAX_LENGTH = 60
export const PLATFORM_NOTIFICATION_IMAGE_MAX_BYTES = 2 * 1024 * 1024
export const PLATFORM_NOTIFICATION_ASSET_RESOLVE_MAX_COUNT = 100

export const PLATFORM_NOTIFICATION_ASSET_STATUS = {
  READY: 'ready',
  DELETED: 'deleted',
} as const

export const PLATFORM_NOTIFICATION_ASSET_STATUS_VALUES = [
  PLATFORM_NOTIFICATION_ASSET_STATUS.READY,
  PLATFORM_NOTIFICATION_ASSET_STATUS.DELETED,
] as const

const IsoDateTimeStringSchema = z.string().datetime()
const NonEmptyStringSchema = z.string().trim().min(1)

export const NotificationSourceKindSchema = z.enum(NOTIFICATION_SOURCE_KIND_VALUES)
export const NotificationListFilterSchema = z.enum(NOTIFICATION_LIST_FILTER_VALUES)
export const PlatformNotificationStatusSchema = z.enum(PLATFORM_NOTIFICATION_STATUS_VALUES)
export const PlatformNotificationAssetStatusSchema = z.enum(PLATFORM_NOTIFICATION_ASSET_STATUS_VALUES)

export const NotificationSenderSchema = z.object({
  displayName: z.string().trim().min(1),
  avatarUrl: z.string().trim().min(1).nullable(),
}).strict()

const NotificationItemBaseSchema = z.object({
  id: z.string().trim().min(1),
  sourceId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  content: TiptapJsonContentPayloadSchema,
  contentText: z.string(),
  sender: NotificationSenderSchema,
  messageAt: IsoDateTimeStringSchema,
  createdAt: IsoDateTimeStringSchema,
  readAt: IsoDateTimeStringSchema.nullable(),
  isUnread: z.boolean(),
}).strict()

export const PlatformNotificationItemSchema = NotificationItemBaseSchema.extend({
  kind: z.literal(NOTIFICATION_SOURCE_KIND.PLATFORM),
}).strict()

export const NotificationItemSchema = PlatformNotificationItemSchema

export const NotificationListQuerySchema = z.object({
  filter: NotificationListFilterSchema.default(NOTIFICATION_LIST_FILTER.ALL),
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict()

export const NotificationListResponseSchema = z.object({
  items: z.array(NotificationItemSchema),
  nextCursor: z.string().trim().min(1).nullable(),
  unreadCount: CountSchema,
}).strict()

export const NotificationMarkAllReadResponseSchema = z.object({
  markedCount: CountSchema,
  unreadCount: CountSchema,
}).strict()

export const NotificationSummarySchema = z.object({
  unreadCount: CountSchema,
}).strict()

export const PlatformNotificationSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  content: TiptapJsonContentPayloadSchema,
  summary: z.string(),
  status: PlatformNotificationStatusSchema,
  publishedAt: IsoDateTimeStringSchema.nullable(),
  createdAt: IsoDateTimeStringSchema,
  createdBy: z.string().trim().min(1).nullable(),
  createdByUser: AuditUserSummarySchema.nullable(),
  updatedAt: IsoDateTimeStringSchema,
  updatedBy: z.string().trim().min(1).nullable(),
  updatedByUser: AuditUserSummarySchema.nullable(),
}).strict()

export const CreatePlatformNotificationRequestSchema = z.object({
  title: z.string().trim().min(1).max(PLATFORM_NOTIFICATION_TITLE_MAX_LENGTH),
  content: TiptapJsonContentPayloadSchema,
  status: PlatformNotificationStatusSchema.default(PLATFORM_NOTIFICATION_STATUS.DRAFT),
}).strict()

export const UpdatePlatformNotificationRequestSchema = z.object({
  title: z.string().trim().min(1).max(PLATFORM_NOTIFICATION_TITLE_MAX_LENGTH).optional(),
  content: TiptapJsonContentPayloadSchema.optional(),
  status: PlatformNotificationStatusSchema.optional(),
}).strict()

export const GetPlatformNotificationsQuerySchema = RequestPageParamsSchema.extend({
  status: PlatformNotificationStatusSchema.optional(),
})

export const PlatformNotificationListResponseSchema = createPageDataSchema(PlatformNotificationSchema)

export const PlatformNotificationAssetSchema = z.object({
  id: z.string().trim().min(1),
  notificationId: z.string().trim().min(1).nullable(),
  status: PlatformNotificationAssetStatusSchema,
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  fileName: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  contentUrl: z.string().nullable(),
  createdAt: IsoDateTimeStringSchema,
}).strict()

export const ResolvePlatformNotificationAssetsSchema = z.object({
  assetIds: z.array(NonEmptyStringSchema).min(1).max(PLATFORM_NOTIFICATION_ASSET_RESOLVE_MAX_COUNT),
}).strict()

export const ResolvePlatformNotificationAssetsResponseSchema = z.object({
  assets: PlatformNotificationAssetSchema.array(),
  unresolvedAssetIds: z.string().array(),
}).strict()

/**
 * 当前用户的消息提醒聚合。
 */
export type NotificationSourceKind = z.infer<typeof NotificationSourceKindSchema>
export type NotificationListFilter = z.infer<typeof NotificationListFilterSchema>
export type PlatformNotificationStatus = z.infer<typeof PlatformNotificationStatusSchema>
export type NotificationSender = z.infer<typeof NotificationSenderSchema>
export type NotificationItem = z.infer<typeof NotificationItemSchema>
export type PlatformNotificationItem = z.infer<typeof PlatformNotificationItemSchema>
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>
export type NotificationMarkAllReadResponse = z.infer<typeof NotificationMarkAllReadResponseSchema>
export type NotificationSummary = z.infer<typeof NotificationSummarySchema>
export type PlatformNotification = z.infer<typeof PlatformNotificationSchema>
export type PlatformNotificationAssetStatus = z.infer<typeof PlatformNotificationAssetStatusSchema>
export type PlatformNotificationAsset = z.infer<typeof PlatformNotificationAssetSchema>
export type CreatePlatformNotificationRequest = z.infer<typeof CreatePlatformNotificationRequestSchema>
export type UpdatePlatformNotificationRequest = z.infer<typeof UpdatePlatformNotificationRequestSchema>
export type GetPlatformNotificationsQuery = z.infer<typeof GetPlatformNotificationsQuerySchema>
export type PlatformNotificationListResponse = z.infer<typeof PlatformNotificationListResponseSchema>
export type ResolvePlatformNotificationAssetsRequest = z.infer<typeof ResolvePlatformNotificationAssetsSchema>
export type ResolvePlatformNotificationAssetsResponse = z.infer<typeof ResolvePlatformNotificationAssetsResponseSchema>
