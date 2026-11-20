import type { LocalNotification } from '../../shared/notifications/notificationApi'
import type { ProductRecoveryItem } from '../../shared/runtime/productRecovery'

import type { DesktopUpdateNotification } from './desktopUpdates'

export const deviceNotificationPrefix = 'desktop:'
export const recoveryNotificationPrefix = `${deviceNotificationPrefix}operation-recovery:`

export interface DesktopRecoveryNotification {
  readonly id: string
  readonly revision: ProductRecoveryItem['state']
  readonly kind: 'operation.recovery'
  readonly origin: 'desktop'
  readonly lifecycle: 'active'
  readonly occurredAt: string
  readonly attention: 'seen' | 'unseen'
  readonly action: { readonly type: 'review-operation', readonly recoveryId: string }
  readonly presentation: {
    readonly title: 'desktop.recovery.title'
    readonly description: `desktop.recovery.${ProductRecoveryItem['state']}`
    readonly icon: 'messageRetry'
  }
}

export type PublishedDeviceNotification = Omit<DesktopRecoveryNotification, 'attention'>
export type DeviceNotification = LocalNotification | DesktopRecoveryNotification
export type DesktopNotification = DeviceNotification | DesktopUpdateNotification

export interface DeviceNotificationList {
  readonly items: readonly DeviceNotification[]
  readonly unseenCount: number
}

export function compareNotifications(left: DesktopNotification, right: DesktopNotification): number {
  if (left.attention !== right.attention)
    return left.attention === 'unseen' ? -1 : 1
  const leftActive = left.kind === 'app.update-available' || left.lifecycle === 'active'
  const rightActive = right.kind === 'app.update-available' || right.lifecycle === 'active'
  if (leftActive !== rightActive)
    return leftActive ? -1 : 1
  return right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)
}
