<script setup lang="ts">
import type { PendingWorkbenchView } from '../services/WorkbenchNavigation'
import { onScopeDispose, shallowRef } from 'vue'
import { useWorkbench } from './workbenchContext'

const props = defineProps<{ entry: PendingWorkbenchView }>()
const { controller, labels } = useWorkbench()
const delayed = shallowRef(false)
const timer = setTimeout(() => delayed.value = true, 200)
onScopeDispose(() => clearTimeout(timer))
function retry() {
  void controller.open(props.entry.view.resource, props.entry.view.title, { ...props.entry.options, signal: undefined })
}
</script>

<template>
  <div v-if="entry.status === 'failed' || delayed" class="workbench-navigation-status absolute z-4 top-12 right-[12px] flex items-center gap-[8px] max-w-[calc(100%_-_24px)] py-[8px] px-[12px] border-1 border-solid border-border rounded-[6px] bg-surface text-muted text-[12px]" :role="entry.status === 'failed' ? 'alert' : 'status'">
    <span class="overflow-hidden whitespace-nowrap text-ellipsis">{{ entry.view.title }}</span>
    <span>{{ entry.status === 'failed' ? labels.failed : labels.loading }}</span>
    <button v-if="entry.status === 'failed'" type="button" @click="retry">
      {{ labels.retry }}
    </button>
    <button type="button" @click="controller.navigation.cancel(entry.paneId)">
      {{ labels.cancel }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.workbench-navigation-status button { flex-shrink: 0; border: 0; padding: 0; background: transparent; color: var(--buddy-accent-solid); cursor: pointer; }
</style>
