import type { AppearancePreference } from '@haohaoxue/lexora-contracts'
import type { SessionAppearanceOption, SessionContextSwitchAction, SessionMenuUser } from './typing'
import {
  APPEARANCE_PREFERENCE,
  APPEARANCE_PREFERENCE_VALUES,
} from '@haohaoxue/lexora-contracts/user/constants'
import { useClipboard } from '@vueuse/core'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { SvgIconCategory } from '@/components/svg-icon/typing'
import { useSessionNotificationBell } from '@/layouts/components/session-notification-bell/useSessionNotificationBell'
import { useAuthSession } from '@/layouts/composables/useAuthSession'
import { getWorkspaceEntryPath } from '@/layouts/utils/workspace-entry'
import { ADMIN_ROUTE_NAME } from '@/router/constants'
import { useUserStore } from '@/stores/user'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

interface UseSessionUserMenuOptions {
  showContextSwitch: boolean
}

type SessionMenuPanel = 'appearance' | 'notifications' | null

const appearancePreferenceLabelKey = {
  [APPEARANCE_PREFERENCE.AUTO]: 'settings.preference.appearance.auto',
  [APPEARANCE_PREFERENCE.LIGHT]: 'settings.preference.appearance.light',
  [APPEARANCE_PREFERENCE.DARK]: 'settings.preference.appearance.dark',
} as const

export function useSessionUserMenu(options: UseSessionUserMenuOptions) {
  const route = useRoute()
  const router = useRouter()
  const { t } = useI18n({ useScope: 'global' })
  const userStore = useUserStore()
  const menuVisible = shallowRef(false)
  const activeSubmenu = shallowRef<SessionMenuPanel>(null)
  const { currentUser: sessionUser, isLoggingOut, logout } = useAuthSession()
  const {
    activeFilter,
    hasLoadedList,
    hasMoreNotifications,
    hasUnreadNotifications,
    isLoading,
    isLoadingMore,
    isMarkingAllRead,
    loadErrorMessage,
    loadMoreNotifications,
    markAllUnreadNotificationsRead,
    notificationItems,
    refreshNotifications: refreshNotificationState,
    setNotificationFilter,
    unreadNotificationCount,
  } = useSessionNotificationBell()
  const lastKnownUser = shallowRef(sessionUser.value)
  const {
    copy,
    copied: copiedUserCode,
    isSupported: isClipboardSupported,
  } = useClipboard({
    copiedDuring: 1400,
    legacy: true,
  })

  const appearanceOptions = computed<SessionAppearanceOption[]>(() => APPEARANCE_PREFERENCE_VALUES.map(value => ({
    label: t(appearancePreferenceLabelKey[value]),
    value,
  })))
  const appearanceMenuVisible = computed(() => activeSubmenu.value === 'appearance')
  const notificationPanelVisible = computed(() => activeSubmenu.value === 'notifications')
  const currentUser = computed<SessionMenuUser>(() => {
    const user = sessionUser.value ?? lastKnownUser.value!

    return {
      displayName: user.displayName,
      email: user.email ?? '',
      avatarUrl: user.avatarUrl,
      userCode: user.userCode,
    }
  })
  const isAdminRoute = computed(() => Boolean(route.meta?.requiresSystemAdmin))
  const contextSwitchAction = computed<SessionContextSwitchAction | null>(() => {
    if (!options.showContextSwitch) {
      return null
    }

    if (isAdminRoute.value) {
      return {
        label: t('sessionMenu.context.enterWorkspace'),
        iconCategory: SvgIconCategory.UI,
        icon: 'arrow-left',
      }
    }

    if (userStore.isSystemAdmin) {
      return {
        label: t('sessionMenu.context.enterAdmin'),
        iconCategory: SvgIconCategory.UI,
        icon: 'user-admin',
      }
    }

    return null
  })
  const currentAppearance = computed(() => userStore.preferences.appearance)
  const currentAppearanceLabel = computed(() => t(appearancePreferenceLabelKey[currentAppearance.value]))
  const isSavingAppearance = computed(() => userStore.isSavingAppearance)

  watch(sessionUser, (user) => {
    if (user) {
      lastKnownUser.value = user
    }
  })

  watch(menuVisible, (visible) => {
    if (!visible) {
      activeSubmenu.value = null
    }
  })

  return {
    menuVisible,
    appearanceMenuVisible,
    isLoggingOut,
    appearanceOptions,
    currentUser,
    contextSwitchAction,
    currentAppearance,
    currentAppearanceLabel,
    isSavingAppearance,
    toggleAppearanceMenu,
    notificationPanelVisible,
    hasLoadedNotificationList: hasLoadedList,
    isLoadingNotifications: isLoading,
    isLoadingMoreNotifications: isLoadingMore,
    isMarkingAllNotificationsRead: isMarkingAllRead,
    loadNotificationError: loadErrorMessage,
    activeNotificationFilter: activeFilter,
    notificationItems,
    hasMoreNotifications,
    hasUnreadNotifications,
    unreadNotificationCount,
    copiedUserCode,
    toggleNotificationPanel,
    handleCopyUserCode,
    handleNotificationFilterChange,
    handleLoadMoreNotifications,
    handleMarkAllNotificationsRead,
    handleAppearanceSelect,
    switchContext,
    handleLogout,
    getLogoutIconName,
  }

  function toggleAppearanceMenu() {
    if (isSavingAppearance.value) {
      return
    }

    toggleSubmenu('appearance')
  }

  async function toggleNotificationPanel() {
    const nextVisible = activeSubmenu.value !== 'notifications'
    toggleSubmenu('notifications')

    if (nextVisible) {
      await refreshNotificationState()
    }
  }

  function toggleSubmenu(target: NonNullable<SessionMenuPanel>) {
    activeSubmenu.value = activeSubmenu.value === target ? null : target
  }

  function closeMenu() {
    activeSubmenu.value = null
    menuVisible.value = false
  }

  async function handleAppearanceSelect(mode: AppearancePreference) {
    if (isSavingAppearance.value || currentAppearance.value === mode) {
      return
    }

    try {
      await userStore.updateAppearancePreference(mode)
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.preference.saveAppearanceFailed')))
    }
  }

  async function switchContext() {
    closeMenu()

    if (isAdminRoute.value) {
      await router.push(getWorkspaceEntryPath())
      return
    }

    await router.push({ name: ADMIN_ROUTE_NAME })
  }

  async function handleLogout() {
    closeMenu()
    await logout()
  }

  async function handleNotificationFilterChange(...args: Parameters<typeof setNotificationFilter>) {
    await setNotificationFilter(...args)
  }

  async function handleLoadMoreNotifications() {
    await loadMoreNotifications()
  }

  async function handleMarkAllNotificationsRead() {
    await markAllUnreadNotificationsRead()
  }

  async function handleCopyUserCode() {
    if (!isClipboardSupported.value) {
      ElMessage.error(t('sessionMenu.accountCode.copyUnsupported'))
      return
    }

    try {
      await copy(currentUser.value.userCode)
      ElMessage.success(t('sessionMenu.accountCode.copied'))
    }
    catch {
      ElMessage.error(t('sessionMenu.accountCode.copyFailed'))
    }
  }

  function getLogoutIconName() {
    return isLoggingOut.value
      ? 'spinner-orbit'
      : 'logout'
  }
}
