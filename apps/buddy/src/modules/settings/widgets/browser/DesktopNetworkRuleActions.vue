<script setup lang="ts">
import type { DropdownOption } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { MoreHorizontal20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NTooltip } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  disabled: boolean
  options: DropdownOption[]
}>()
const emit = defineEmits<{
  action: [value: string | number]
  remove: []
}>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="flex justify-end gap-1">
    <NDropdown trigger="click" :options="options" @select="emit('action', $event)">
      <NButton quaternary size="small" class="buddy-icon-button" :disabled="disabled" :aria-label="t('desktop.browser.ruleActions')">
        <DesktopIcon :component="MoreHorizontal20Regular" :size="18" />
      </NButton>
    </NDropdown>
    <NTooltip>
      <template #trigger>
        <NButton quaternary size="small" class="buddy-icon-button" :disabled="disabled" :aria-label="t('desktop.browser.deleteRule')" @click="emit('remove')">
          <DesktopIcon name="delete" :size="18" />
        </NButton>
      </template>
      {{ t('desktop.browser.deleteRule') }}
    </NTooltip>
  </div>
</template>
