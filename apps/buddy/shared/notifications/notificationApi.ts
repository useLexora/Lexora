import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema, nullableTimestampSchema, timestampSchema, validationRequestSchemas } from '../runtime/apiValidation'

export const notificationBaseShape = {
  attention: z.enum(['seen', 'unseen']),
  audience: z.literal('device'),
  id: idSchema,
  lifecycle: z.enum(['active', 'resolved']),
  occurredAt: timestampSchema,
  origin: z.literal('local-runtime'),
  resolvedAt: nullableTimestampSchema,
  revision: z.string().min(1),
}

export const modelUpdateNotificationSchema = z.object({
  ...notificationBaseShape,
  action: z.object({ type: z.literal('open-model-settings') }).strict(),
  kind: z.literal('model.source-parameters-updated'),
  payload: z.object({ modelCount: z.number().int().positive() }).strict(),
}).strict()

export const automationRunNotificationShape = {
  ...notificationBaseShape,
  action: z.object({
    conversationId: idSchema,
    runId: idSchema,
    type: z.literal('open-conversation'),
  }).strict(),
  lifecycle: z.literal('resolved'),
  payload: z.object({
    automationId: idSchema,
    automationName: z.string().trim().min(1).max(80),
    errorCode: z.string().max(256).nullable(),
  }).strict(),
  resolvedAt: timestampSchema,
}

export const notificationSchema = z.discriminatedUnion('kind', [
  modelUpdateNotificationSchema,
  z.object({
    ...automationRunNotificationShape,
    kind: z.literal('automation.run.completed'),
  }).strict(),
  z.object({
    ...automationRunNotificationShape,
    kind: z.literal('automation.run.failed'),
  }).strict(),
])

export const notificationListSchema = z.object({
  items: z.array(notificationSchema),
  unseenCount: z.number().int().nonnegative(),
}).strict()

export type LocalNotification = DeepReadonly<z.infer<typeof notificationSchema>>

export type LocalNotificationList = DeepReadonly<z.infer<typeof notificationListSchema>>

export const notificationsRequestSchemas = {
  notificationRevision: z.object({
    notificationId: idSchema,
    revision: z.string().min(1).max(512),
  }).strict(),
} as const

export const notificationsResponseSchemas = {
  notificationList: notificationListSchema,
} as const

export const notificationsRpc = {
  list: { method: 'notifications.list', input: validationRequestSchemas.empty, response: notificationsResponseSchemas.notificationList },
  markSeen: { method: 'notifications.markSeen', input: notificationsRequestSchemas.notificationRevision, response: notificationsResponseSchemas.notificationList },
  markAllSeen: { method: 'notifications.markAllSeen', input: validationRequestSchemas.empty, response: notificationsResponseSchemas.notificationList },
} as const satisfies Record<string, RuntimeRequestContract>

export const notificationsChanged = { method: 'notifications.changed', params: z.object({ revision: z.number().int().nonnegative() }).strict() } as const
export type NotificationsChanged = z.infer<typeof notificationsChanged.params>
