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
    class="desktop-notification-item"
    :class="{
      'is-failed': notification.kind === 'automation.run.failed',
      'is-unseen': notification.attention === 'unseen',
    }"
    type="button"
    @click="emit('open', notification)"
  >
    <span class="desktop-notification-item__icon" aria-hidden="true">
      <DesktopIcon :component="icon" />
    </span>
    <span class="desktop-notification-item__copy">
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

<style scoped>
.desktop-notification-item {
  position: relative;
  display: grid;
  box-sizing: border-box;
  width: calc(100% - 16px);
  height: 66px;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 9px;
  margin: 3px 8px;
  border: 0;
  border-radius: var(--buddy-radius-micro);
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 9px 22px 9px 10px;
  text-align: left;
}

.desktop-notification-item:hover,
.desktop-notification-item:focus-visible {
  background: var(--buddy-surface-subtle);
}

.desktop-notification-item:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: -2px;
}

.desktop-notification-item__icon {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 6px;
  background: var(--buddy-accent-surface);
  color: var(--buddy-accent-text);
  font-size: 16px;
}

.desktop-notification-item.is-failed .desktop-notification-item__icon {
  background: var(--buddy-status-danger-surface);
  color: var(--buddy-status-danger-text);
}

.desktop-notification-item__copy {
  display: grid;
  min-width: 0;
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
