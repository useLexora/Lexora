<script setup lang="ts">
import type { NetworkPermissionDecision } from '@buddy-shared/permissions/networkPermissions'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NETWORK_PERMISSION_DECISIONS } from '@buddy-shared/permissions/networkPermissions'
import { NSelect } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  language: BuddyLocale
  value: NetworkPermissionDecision
  disabled?: boolean
  labelledBy: string
}>()
const emit = defineEmits<{ change: [value: NetworkPermissionDecision] }>()
const { t } = useBuddyI18n(() => props.language)
const options = computed(() => NETWORK_PERMISSION_DECISIONS.map(value => ({
  label: t(`desktop.browser.permission.${value}`),
  value,
})))
</script>

<template>
  <NSelect :aria-labelledby="labelledBy" :virtual-scroll="false" :consistent-menu-width="false" :value="value" :options="options" :disabled="disabled" @update:value="emit('change', $event)" />
</template>
