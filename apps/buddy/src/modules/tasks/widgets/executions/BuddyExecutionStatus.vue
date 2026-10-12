<script setup lang="ts">
import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useIntervalFn } from '@vueuse/core'
import { computed, shallowRef, watch } from 'vue'
import { formatChatRunDuration } from '../../model/transcript/chatRunDuration'
import { executionPriority, executionStatus } from './executionPresentation'

const props = defineProps<{ execution: LocalExecution, language: BuddyLocale, stopping?: boolean }>()
const now = shallowRef(Date.now())
const clock = useIntervalFn(() => now.value = Date.now(), 1000)
watch(() => props.execution.phase !== 'closed', active => active ? clock.resume() : clock.pause(), { immediate: true })
const duration = computed(() => formatChatRunDuration(props.execution.startedAt, props.execution.completedAt, now.value))
const label = computed(() => executionStatus(props.stopping ? { ...props.execution, stopping: true } : props.execution, props.language, now.value))
</script>

<template>
  <span class="inline-flex flex-wrap min-w-0 items-baseline gap-x-2 text-[12px]" :class="execution.status === 'failed' ? 'text-danger' : executionPriority(execution) === 0 || execution.cleanup === 'degraded' ? 'text-warning' : 'text-muted'">
    <span role="status" class="break-words">{{ label }}</span>
    <span class="text-muted tabular-nums whitespace-nowrap" aria-live="off">{{ duration }}</span>
  </span>
</template>
