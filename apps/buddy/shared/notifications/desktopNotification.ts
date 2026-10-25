import { z } from 'zod'

export const DESKTOP_NOTIFICATION_CHANNEL = 'lexora:notifications'
export const desktopNotificationRequestSchema = z.object({ action: z.literal('test') }).strict()
export const desktopNotificationTestResultSchema = z.enum(['shown', 'unavailable', 'failed'])
export type DesktopNotificationTestResult = z.infer<typeof desktopNotificationTestResultSchema>

export interface DesktopNotificationsApi {
  test: () => Promise<DesktopNotificationTestResult>
}
