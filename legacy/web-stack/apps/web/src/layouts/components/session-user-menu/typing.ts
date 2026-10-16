import type { AppearancePreference, NotificationListFilter } from '@haohaoxue/lexora-contracts'
import type { SvgIconProps } from '@/components/svg-icon/typing'
import type { SessionNotificationItem } from '@/layouts/components/session-notification-bell/useSessionNotificationBell'

export interface SessionMenuUser {
  displayName: string
  email: string
  avatarUrl: string | null
  userCode: string
}

export interface SessionAppearanceOption {
  label: string
  value: AppearancePreference
}

export interface SessionAppearancePanelProps {
  currentAppearance: AppearancePreference
  isSaving: boolean
  options: SessionAppearanceOption[]
}

export interface SessionContextSwitchAction {
  label: string
  iconCategory: NonNullable<SvgIconProps['category']>
  icon: string
}

export interface SessionNotificationPanelProps {
  hasLoadedList: boolean
  isLoading: boolean
  isLoadingMore: boolean
  isMarkingAllRead: boolean
  loadErrorMessage: string
  activeFilter: NotificationListFilter
  notificationItems: SessionNotificationItem[]
  unreadCount: number
  hasMore: boolean
}
