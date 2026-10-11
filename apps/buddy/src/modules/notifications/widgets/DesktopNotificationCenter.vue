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
    class="desktop-notification-center grid h-[min(332px,_calc(100dvh_-_88px))] grid-rows-[minmax(0,_1fr)] overflow-hidden bg-raised"
    :class="{ 'has-header': hasNotifications }"
  >
    <header v-if="hasNotifications" class="relative z-1 flex h-[44px] items-center justify-between gap-[10px] bg-raised shadow-soft py-0 px-[8px]">
      <div
        class="flex h-[44px] items-center gap-[1px]"
        role="group"
        :aria-label="t('desktop.notifications.filterLabel')"
      >
        <button
          class="desktop-notification-center__filter relative flex h-[28px] items-center justify-center gap-[3px] border-0 bg-transparent text-muted cursor-pointer text-[12px] py-0 px-[5px] hover:text-strong focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[1px]"
          :class="{ 'is-active': activeFilter === 'all' }"
          type="button"
          :aria-pressed="activeFilter === 'all'"
          @click="activeFilter = 'all'"
        >
          {{ t('desktop.notifications.filterAll') }}
        </button>
        <button
          class="desktop-notification-center__filter relative flex h-[28px] items-center justify-center gap-[3px] border-0 bg-transparent text-muted cursor-pointer text-[12px] py-0 px-[5px] hover:text-strong focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[1px]"
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
      class="desktop-notification-center__empty content-center gap-[9px] p-[16px] text-center"
      aria-live="polite"
    >
      <span class="grid w-[32px] h-[32px] place-items-center rounded-[8px] bg-subtle text-muted text-[16px]" aria-hidden="true">
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

<style scoped lang="scss">
.desktop-notification-center.has-header {
  grid-template-rows: 44px minmax(0, 1fr);
}

.desktop-notification-center__filter {
  letter-spacing: 0.04em;
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
