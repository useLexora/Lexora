<script setup lang="ts">
import type { ApplicationSettingsProps } from './typing'
import { NSpin, NSwitch } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

type SettingField = 'notifications' | 'notifyWhenFocused'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const { pending: pendingFields, failed: failedFields, save } = useSettingMutation<SettingField>(patch => props.updateSettings(patch))
const fields = computed(() => [
  { id: 'notifications' as const, key: 'notificationsEnabled' as const },
  ...(props.config?.desktop.notificationsEnabled ? [{ id: 'notifyWhenFocused' as const, key: 'notifyWhenFocused' as const }] : []),
])
</script>

<template>
  <section v-if="config" class="desktop-notifications-settings grid gap-[0.8rem] [container-type:inline-size] [--setting-label-min:9rem] [--setting-control-min:13rem]">
    <h2 class="m-0 text-[0.92rem]">
      {{ t('desktop.notifications.title') }}
    </h2>
    <DesktopSettingsGroup>
      <DesktopSettingRow v-for="field in fields" :key="field.id" v-slot="{ controlAttrs }" :label="t(`desktop.settings.${field.id}`)" :description="t(`desktop.settings.${field.id}Description`)" :error="failedFields.has(field.id) ? error ?? t('desktop.settings.saveFailed') : null" toggle>
        <NSwitch v-bind="controlAttrs" :round="false" :value="config.desktop[field.key]" :disabled="pendingFields.has(field.id)" :aria-disabled="pendingFields.has(field.id)" @update:value="save(field.id, { desktop: { [field.key]: $event } })" />
        <NSpin v-if="pendingFields.has(field.id)" size="small" />
      </DesktopSettingRow>
    </DesktopSettingsGroup>
  </section>
</template>
