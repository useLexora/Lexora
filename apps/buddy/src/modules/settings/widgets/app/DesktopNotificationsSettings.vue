<script setup lang="ts">
import type { ApplicationSettingsProps } from './typing'
import { NButton, NSpin, NSwitch, useMessage } from 'naive-ui'
import { computed, onDeactivated, onScopeDispose, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopNotificationSoundSettings from './DesktopNotificationSoundSettings.vue'

type SettingField = 'notifications' | 'subtaskNotifications' | 'notifyWhenFocused'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const testing = shallowRef(false)
let testRevision = 0
const { pending: pendingFields, failed: failedFields, save } = useSettingMutation<SettingField>(patch => props.updateSettings(patch))
const fields = computed(() => [
  { id: 'notifications' as const, key: 'notificationsEnabled' as const },
  ...(props.config?.desktop.notificationsEnabled
    ? [
        { id: 'subtaskNotifications' as const, key: 'subtaskNotificationsEnabled' as const },
        { id: 'notifyWhenFocused' as const, key: 'notifyWhenFocused' as const },
      ]
    : []),
])

async function testNotification() {
  if (testing.value || pendingFields.value.size > 0)
    return
  const revision = ++testRevision
  testing.value = true
  try {
    const result = await requireDesktopApi().notifications.test()
    if (revision !== testRevision)
      return
    if (result === 'shown')
      message.success(t('desktop.settings.notificationTestShown'))
    else if (result === 'unavailable')
      message.warning(t('desktop.settings.notificationTestUnavailable'))
    else
      message.error(t('desktop.settings.notificationTestFailed'))
  }
  catch {
    if (revision === testRevision)
      message.error(t('desktop.settings.notificationTestFailed'))
  }
  finally {
    if (revision === testRevision)
      testing.value = false
  }
}

function leave() {
  testRevision++
  testing.value = false
}
onDeactivated(leave)
onScopeDispose(leave)
</script>

<template>
  <section v-if="config" class="desktop-notifications-settings grid gap-[0.8rem] [container-type:inline-size] [--setting-label-min:9rem] [--setting-control-min:13rem]">
    <header class="flex items-center justify-between gap-3">
      <h2 class="m-0 text-[0.92rem]">
        {{ t('desktop.notifications.title') }}
      </h2>
      <NButton size="small" :loading="testing" :disabled="testing || pendingFields.size > 0" @click="testNotification">
        {{ t('desktop.settings.notificationTest') }}
      </NButton>
    </header>
    <DesktopSettingsGroup>
      <DesktopSettingRow v-for="field in fields" :key="field.id" v-slot="{ controlAttrs }" :label="t(`desktop.settings.${field.id}`)" :description="t(`desktop.settings.${field.id}Description`)" :error="failedFields.has(field.id) ? error ?? t('desktop.settings.saveFailed') : null" toggle>
        <NSwitch v-bind="controlAttrs" :round="false" :value="config.desktop[field.key]" :disabled="pendingFields.has(field.id)" :aria-disabled="pendingFields.has(field.id)" @update:value="save(field.id, { desktop: { [field.key]: $event } })" />
        <NSpin v-if="pendingFields.has(field.id)" size="small" />
      </DesktopSettingRow>
    </DesktopSettingsGroup>
    <DesktopNotificationSoundSettings v-bind="props" :disabled="pendingFields.has('notifications')" />
  </section>
</template>
