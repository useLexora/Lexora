<script setup lang="ts">
import type { DesktopNotification } from '../contracts'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowDownload20Regular, Bot20Regular, CheckmarkCircle20Regular, Warning20Regular } from '@vicons/fluent'
import { computed } from 'vue'

import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  notification: DesktopNotification
}>()
const emit = defineEmits<{
  open: [notification: DesktopNotification]
}>()
const { t } = useBuddyI18n(() => props.language)
const dateFormatter = computed(() => new Intl.DateTimeFormat(props.language, {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
}))
const title = computed(() => {
  if (props.notification.kind === 'app.update-available')
    return t('desktop.update.notificationTitle', { version: props.notification.payload.version })
  if (props.notification.kind === 'model.source-parameters-updated') {
    return t('desktop.notifications.modelSourceUpdatedTitle', {
      count: props.notification.payload.modelCount,
    })
  }
  return props.notification.payload.automationName
})
const description = computed(() => {
  if (props.notification.kind === 'app.update-available')
    return t('desktop.update.notificationDescription')
  if (props.notification.kind === 'model.source-parameters-updated')
    return t('desktop.notifications.modelSourceUpdatedDescription')
  return t(props.notification.kind === 'automation.run.completed'
    ? 'desktop.notifications.automationCompletedDescription'
    : 'desktop.notifications.automationFailedDescription')
})
const icon = computed(() => {
  if (props.notification.kind === 'app.update-available')
    return ArrowDownload20Regular
  if (props.notification.kind === 'automation.run.completed')
    return CheckmarkCircle20Regular
  if (props.notification.kind === 'automation.run.failed')
    return Warning20Regular
  return Bot20Regular
})
</script>

<template>
  <button
    class="desktop-notification-item relative grid box-border w-[calc(100%_-_16px)] h-[66px] grid-cols-[auto_minmax(0,_1fr)] items-start gap-[9px] my-[3px] mx-[8px] border-0 rounded-micro bg-transparent text-inherit cursor-pointer pt-[9px] pr-[22px] pb-[9px] pl-[10px] text-left hover:bg-hover focus-visible:bg-hover ui-focus-ring"
    :class="{
      'is-failed': notification.kind === 'automation.run.failed',
      'is-unseen': notification.attention === 'unseen',
    }"
    type="button"
    @click="emit('open', notification)"
  >
    <span class="desktop-notification-item__icon grid w-[28px] h-[28px] place-items-center rounded-[6px] bg-accent-surface text-accent-text text-[16px]" aria-hidden="true">
      <DesktopIcon :component="icon" />
    </span>
    <span class="desktop-notification-item__copy grid min-w-0">
      <strong>{{ title }}</strong>
      <span>{{ description }}</span>
      <small>
        {{ t(`desktop.notifications.origin.${notification.origin}`) }}
        · {{ dateFormatter.format(new Date(notification.occurredAt)) }}
      </small>
    </span>
    <i v-if="notification.attention === 'unseen'" aria-hidden="true" />
  </button>
</template>

<style scoped lang="scss">
.desktop-notification-item.is-failed .desktop-notification-item__icon {
  background: var(--buddy-status-danger-surface);
  color: var(--buddy-status-danger-text);
}

.desktop-notification-item__copy strong {
  overflow: hidden;
  color: var(--buddy-text-primary);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-notification-item.is-unseen .desktop-notification-item__copy strong {
  color: var(--buddy-text-strong);
  font-weight: 600;
}

.desktop-notification-item__copy > span {
  display: -webkit-box;
  overflow: hidden;
  color: var(--buddy-text-secondary);
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
}

.desktop-notification-item__copy small {
  color: var(--buddy-text-muted);
  font-size: 10px;
  line-height: 14px;
  margin-top: 2px;
}

.desktop-notification-item > i {
  position: absolute;
  top: 14px;
  right: 10px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--buddy-accent-solid);
}
</style>
