import type {
  NotificationItem,
  NotificationListFilter,
  NotificationSummary,
} from '@/apis/notification'
import { NOTIFICATION_LIST_FILTER } from '@haohaoxue/lexora-contracts/notification'
import dayjs from 'dayjs'
import {
  computed,
  onMounted,
  reactive,
  shallowRef,
  watch,
} from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getNotificationSummary,
  listNotifications,
  markAllNotificationsRead,
} from '@/apis/notification'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

type Translate = ReturnType<typeof useI18n>['t']

export type SessionNotificationItem = NotificationItem & {
  senderLabel: string
  receivedLabel: string
}

const EMPTY_NOTIFICATION_SUMMARY: NotificationSummary = {
  unreadCount: 0,
}
const NOTIFICATION_PAGE_LIMIT = 20
const emptyCursorByFilter = {
  [NOTIFICATION_LIST_FILTER.ALL]: null,
  [NOTIFICATION_LIST_FILTER.UNREAD]: null,
} satisfies Record<NotificationListFilter, string | null>

export function useSessionNotificationBell() {
  const { t } = useI18n({ useScope: 'global' })
  const popoverVisible = shallowRef(false)
  const summary = shallowRef<NotificationSummary>(EMPTY_NOTIFICATION_SUMMARY)
  const activeFilter = shallowRef<NotificationListFilter>(NOTIFICATION_LIST_FILTER.ALL)
  const notificationItems = shallowRef<SessionNotificationItem[]>([])
  const nextCursorByFilter = reactive<Record<NotificationListFilter, string | null>>({ ...emptyCursorByFilter })
  const isLoading = shallowRef(false)
  const isLoadingMore = shallowRef(false)
  const isMarkingAllRead = shallowRef(false)
  const hasLoaded = shallowRef(false)
  const hasLoadedList = shallowRef(false)
  const loadErrorMessage = shallowRef('')
  let summaryRequestId = 0
  let listRequestId = 0

  const unreadNotificationCount = computed(() => summary.value.unreadCount)
  const hasUnreadNotifications = computed(() => unreadNotificationCount.value > 0)
  const hasMoreNotifications = computed(() => Boolean(nextCursorByFilter[activeFilter.value]))

  watch(popoverVisible, (visible) => {
    if (visible) {
      void refreshNotifications()
    }
  })

  onMounted(() => {
    void loadSummary()
  })

  async function loadSummary() {
    const requestId = ++summaryRequestId

    isLoading.value = true
    loadErrorMessage.value = ''

    try {
      const nextSummary = await getNotificationSummary()

      if (requestId !== summaryRequestId) {
        return
      }

      summary.value = nextSummary
      hasLoaded.value = true
    }
    catch (error) {
      if (requestId !== summaryRequestId) {
        return
      }

      loadErrorMessage.value = getRequestErrorDisplayMessage(error, t('sessionMenu.notifications.loadFailed'))

      if (!hasLoaded.value) {
        summary.value = EMPTY_NOTIFICATION_SUMMARY
      }
    }
    finally {
      if (requestId === summaryRequestId) {
        isLoading.value = false
      }
    }
  }

  async function loadNotificationList(options: { reset?: boolean } = {}) {
    const reset = options.reset ?? true
    const requestId = ++listRequestId
    const filter = activeFilter.value
    const cursor = reset ? undefined : nextCursorByFilter[filter] ?? undefined

    if (!reset && !cursor) {
      return
    }

    if (reset) {
      isLoading.value = true
    }
    else {
      isLoadingMore.value = true
    }
    loadErrorMessage.value = ''

    try {
      const response = await listNotifications({
        filter,
        cursor,
        limit: NOTIFICATION_PAGE_LIMIT,
      })

      if (requestId !== listRequestId || filter !== activeFilter.value) {
        return
      }

      notificationItems.value = reset
        ? response.items.map(item => toSessionNotificationItem(item, t))
        : [...notificationItems.value, ...response.items.map(item => toSessionNotificationItem(item, t))]
      nextCursorByFilter[filter] = response.nextCursor
      summary.value = { unreadCount: response.unreadCount }
      hasLoadedList.value = true
    }
    catch (error) {
      if (requestId !== listRequestId) {
        return
      }

      loadErrorMessage.value = getRequestErrorDisplayMessage(error, t('sessionMenu.notifications.loadFailed'))

      if (!hasLoadedList.value || reset) {
        notificationItems.value = []
      }
    }
    finally {
      if (requestId === listRequestId) {
        isLoading.value = false
        isLoadingMore.value = false
      }
    }
  }

  async function refreshNotifications() {
    await Promise.all([
      loadSummary(),
      loadNotificationList({ reset: true }),
    ])
  }

  async function loadMoreNotifications() {
    if (isLoading.value || isLoadingMore.value || !hasMoreNotifications.value) {
      return
    }

    await loadNotificationList({ reset: false })
  }

  async function setNotificationFilter(filter: NotificationListFilter) {
    if (activeFilter.value === filter) {
      return
    }

    activeFilter.value = filter
    nextCursorByFilter[filter] = null
    notificationItems.value = []
    hasLoadedList.value = false
    await loadNotificationList({ reset: true })
  }

  async function markAllUnreadNotificationsRead() {
    if (isMarkingAllRead.value || !hasUnreadNotifications.value) {
      return
    }

    isMarkingAllRead.value = true

    try {
      const response = await markAllNotificationsRead()
      summary.value = { unreadCount: response.unreadCount }
      await loadNotificationList({ reset: true })
      ElMessage.success(t('sessionMenu.notifications.markedAllRead'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('sessionMenu.notifications.markAllReadFailed')))
    }
    finally {
      isMarkingAllRead.value = false
    }
  }

  return {
    activeFilter,
    hasLoaded,
    hasLoadedList,
    hasMoreNotifications,
    hasUnreadNotifications,
    isLoading,
    isLoadingMore,
    isMarkingAllRead,
    loadErrorMessage,
    loadMoreNotifications,
    loadNotificationList,
    loadSummary,
    markAllUnreadNotificationsRead,
    notificationItems,
    popoverVisible,
    refreshNotifications,
    setNotificationFilter,
    unreadNotificationCount,
  }
}

function toSessionNotificationItem(item: NotificationItem, _t: Translate): SessionNotificationItem {
  return {
    ...item,
    senderLabel: item.sender.displayName,
    receivedLabel: dayjs(item.messageAt).format('YYYY-MM-DD HH:mm'),
  }
}
