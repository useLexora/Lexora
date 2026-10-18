<script setup lang="ts">
import type { ApplicationSettingsProps } from './typing'
import { NSwitch, NTooltip, useMessage } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'

const props = defineProps<ApplicationSettingsProps & {
  field: 'launchAtLogin' | 'developerToolsEnabled' | 'updateNotificationsEnabled' | 'autoDownloadUpdates' | 'featureAnnouncementsEnabled'
  label: string
  description: string
  disabledReason?: string
}>()
defineSlots<{ labelExtra?: () => unknown, hint?: () => unknown }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { pending: pendingFields, save } = useSettingMutation<typeof props.field>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const pending = computed(() => pendingFields.value.has(props.field))
const hovered = shallowRef(false)
const focused = shallowRef(false)

function update(value: boolean) {
  if (props.disabledReason || pending.value)
    return
  return save(props.field, { desktop: { [props.field]: value } })
}
</script>

<template>
  <DesktopSettingRow v-if="config" class="desktop-application-toggle" :label="label" :description="description" :disabled="!!disabledReason" toggle>
    <template #labelExtra>
      <slot name="labelExtra" />
    </template>
    <template #hint>
      <slot name="hint" />
    </template>
    <template #default="{ controlAttrs }">
      <NTooltip trigger="manual" :show="!!disabledReason && (hovered || focused)" style="max-width: min(20rem, calc(100vw - 3rem))">
        <template #trigger>
          <span
            class="inline-flex rounded-[4px] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
            :tabindex="disabledReason ? 0 : undefined"
            :role="disabledReason ? 'group' : undefined"
            :aria-labelledby="disabledReason ? controlAttrs['aria-labelledby'] : undefined"
            :aria-description="disabledReason"
            @mouseenter="hovered = true"
            @mouseleave="hovered = false"
            @focus="focused = true"
            @blur="focused = false"
            @keydown.esc="hovered = false; focused = false"
          >
            <NSwitch v-bind="controlAttrs" :round="false" :value="config.desktop[field]" :loading="pending" :disabled="pending || !!disabledReason" :aria-disabled="pending || !!disabledReason" @update:value="update" />
          </span>
        </template>
        {{ disabledReason }}
      </NTooltip>
    </template>
  </DesktopSettingRow>
</template>
