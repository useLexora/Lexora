<script setup lang="ts">
import type { ApplicationSettingsProps } from './typing'
import { NSwitch, useMessage } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

const props = defineProps<ApplicationSettingsProps & {
  field: 'launchAtLogin' | 'developerToolsEnabled' | 'updateNotificationsEnabled'
  label: string
  description: string
}>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { pending: pendingFields, save } = useSettingMutation<typeof props.field>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const pending = computed(() => pendingFields.value.has(props.field))

function update(value: boolean) {
  return save(props.field, { desktop: { [props.field]: value } })
}
</script>

<template>
  <DesktopSettingsGroup v-if="config" class="desktop-application-toggle [container-type:inline-size] [--setting-row-py:0.9rem] [--setting-control-min:0px] [--setting-control-max:max-content]">
    <DesktopSettingRow v-slot="{ controlAttrs }" :label="label" :description="description" toggle>
      <NSwitch v-bind="controlAttrs" :round="false" :value="config.desktop[field]" :loading="pending" :disabled="pending" :aria-disabled="pending" @update:value="update" />
    </DesktopSettingRow>
  </DesktopSettingsGroup>
</template>
