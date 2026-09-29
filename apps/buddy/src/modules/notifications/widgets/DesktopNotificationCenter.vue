<script setup lang="ts">
import type { DesktopNotification } from '../contracts'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { NotificationFilter } from '@/modules/notifications/state/useNotificationCenterStore'
import { Alert20Regular, CheckmarkCircle20Regular } from '@vicons/fluent'
import { NButton, NSpin, NVirtualList } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { filterNotifications } from '@/modules/notifications/state/useNotificationCenterStore'
import DesktopNotificationItem from '@/modules/notifications/widgets/DesktopNotificationItem.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  items: ReadonlyArray<DesktopNotification>
  language: BuddyLocale
  loading: boolean
  unseenCount: number
}>()
const emit = defineEmits<{
  markAllSeen: []
  open: [notification: DesktopNotification]
}>()
const NOTIFICATION_ROW_SIZE = 72

const { t } = useBuddyI18n(() => props.language)
const activeFilter = shallowRef<NotificationFilter>('all')
const filteredItems = computed(() => filterNotifications(props.items, activeFilter.value))
const virtualItems = computed(() => [...filteredItems.value])
const hasNotifications = computed(() => props.items.length > 0)
const hasVisibleNotifications = computed(() => virtualItems.value.length > 0)
const isUnseenEmpty = computed(() => (
  activeFilter.value === 'unseen'
  && hasNotifications.value
  && !hasVisibleNotifications.value
))
const emptyIcon = computed(() => isUnseenEmpty.value
  ? CheckmarkCircle20Regular
  : Alert20Regular)
const emptyTitle = computed(() => t(isUnseenEmpty.value
  ? 'desktop.notifications.unseenEmptyTitle'
  : 'desktop.notifications.emptyTitle'))
</script>

<template>
  <section
    class="desktop-notification-center"
    :class="{ 'has-header': hasNotifications }"
  >
    <header v-if="hasNotifications" class="desktop-notification-center__header">
      <div
        class="desktop-notification-center__filters"
        role="group"
        :aria-label="t('desktop.notifications.filterLabel')"
      >
        <button
          class="desktop-notification-center__filter"
          :class="{ 'is-active': activeFilter === 'all' }"
          type="button"
          :aria-pressed="activeFilter === 'all'"
          @click="activeFilter = 'all'"
        >
          {{ t('desktop.notifications.filterAll') }}
        </button>
        <button
          class="desktop-notification-center__filter"
          :class="{ 'is-active': activeFilter === 'unseen' }"
          type="button"
          :aria-pressed="activeFilter === 'unseen'"
          @click="activeFilter = 'unseen'"
        >
          {{ t('desktop.notifications.filterUnseen') }}
          <span v-if="unseenCount > 0">{{ unseenCount }}</span>
        </button>
      </div>

      <NButton
        v-if="unseenCount > 0"
        class="buddy-icon-button desktop-notification-center__mark-all"
        size="small"
        quaternary
        :aria-label="t('desktop.notifications.markAllSeen')"
        @click="emit('markAllSeen')"
      >
        <template #icon>
          <DesktopIcon name="notificationMarkAllRead" />
        </template>
      </NButton>
    </header>

    <div v-if="loading && items.length === 0" class="desktop-notification-center__loading">
      <NSpin size="small" />
    </div>
    <div
      v-else-if="!hasVisibleNotifications"
      class="desktop-notification-center__empty"
      aria-live="polite"
    >
      <span class="desktop-notification-center__empty-icon" aria-hidden="true">
        <DesktopIcon :component="emptyIcon" />
      </span>
      <b>{{ emptyTitle }}</b>
    </div>
    <NVirtualList
      v-else
      :key="activeFilter"
      class="desktop-notification-center__list"
      :item-size="NOTIFICATION_ROW_SIZE"
      :items="virtualItems"
      key-field="id"
    >
      <template #default="{ item: notification }">
        <DesktopNotificationItem
          :language="language"
          :notification="notification"
          @open="emit('open', $event)"
        />
      </template>
    </NVirtualList>
  </section>
</template>

<style scoped>
.desktop-notification-center {
  display: grid;
  height: min(332px, calc(100dvh - 88px));
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
  background: var(--buddy-surface-raised);
}

.desktop-notification-center.has-header {
  grid-template-rows: 44px minmax(0, 1fr);
}

.desktop-notification-center__header {
  position: relative;
  z-index: 1;
  display: flex;
  height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: var(--buddy-surface-raised);
  box-shadow: var(--buddy-shadow-soft);
  padding: 0 8px;
}

.desktop-notification-center__filters {
  display: flex;
  height: 44px;
  align-items: center;
  gap: 1px;
}

.desktop-notification-center__filter {
  position: relative;
  display: flex;
  height: 28px;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border: 0;
  background: transparent;
  color: var(--buddy-text-secondary);
  cursor: pointer;
  font-size: 12px;
  letter-spacing: 0.04em;
  padding: 0 5px;
}

.desktop-notification-center__filter:hover {
  color: var(--buddy-text-strong);
}

.desktop-notification-center__filter:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: 1px;
}

.desktop-notification-center__filter.is-active {
  color: var(--buddy-accent-text);
  font-weight: 600;
}

.desktop-notification-center__filter.is-active::after {
  position: absolute;
  right: 5px;
  bottom: -8px;
  left: 5px;
  height: 2px;
  border-radius: 1px;
  background: var(--buddy-accent-solid);
  content: '';
}

.desktop-notification-center__filter span {
  color: var(--buddy-accent-text);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
  line-height: 1;
}

.desktop-notification-center__mark-all {
  flex: none;
  color: var(--buddy-text-secondary);
  font-size: 16px;
}

.desktop-notification-center__mark-all:hover {
  color: var(--buddy-accent-text);
}

.desktop-notification-center__loading,
.desktop-notification-center__empty {
  display: grid;
  min-height: 0;
  place-items: center;
  background: var(--buddy-surface-base);
}

.desktop-notification-center__empty {
  align-content: center;
  gap: 9px;
  padding: 16px;
  text-align: center;
}

.desktop-notification-center__empty-icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 8px;
  background: var(--buddy-surface-subtle);
  color: var(--buddy-text-secondary);
  font-size: 16px;
}

.desktop-notification-center__empty b {
  color: var(--buddy-text-strong);
  font-size: 14px;
  font-weight: 600;
}

.desktop-notification-center__list {
  height: 100%;
  min-height: 0;
  overscroll-behavior: contain;
}
</style>
