<script setup lang="ts">
import type { ToolResourceBlocker } from '@buddy-shared/runs/toolExecutionPhase'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useIntervalFn, useNow } from '@vueuse/core'
import { NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ language: BuddyLocale, runId?: string, blocker?: ToolResourceBlocker }>()
const { t } = useBuddyI18n(() => props.language)
const now = useNow({ scheduler: update => useIntervalFn(update, 1000) })
const elapsed = computed(() => Math.max(0, Math.floor((now.value.getTime() - (props.blocker?.since ?? now.value.getTime())) / 1000)))
const owner = computed(() => props.blocker?.runId === props.runId ? t('desktop.chat.resourceSameRun') : props.blocker?.title || t('desktop.chat.resourceOtherTask'))
</script>

<template>
  <NTooltip :disabled="!blocker">
    <template #trigger>
      <span class="overflow-hidden text-ellipsis">{{ t('desktop.chat.processToolResourceWaiting') }}</span>
    </template>
    <span v-if="blocker">{{ t(blocker.state === 'active' ? 'desktop.chat.resourceOwnerActive' : 'desktop.chat.resourceOwnerQueued', { name: owner, seconds: elapsed }) }}</span>
  </NTooltip>
</template>
