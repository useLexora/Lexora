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
  <div v-if="entry.status === 'failed' || delayed" class="workbench-navigation-status" :role="entry.status === 'failed' ? 'alert' : 'status'">
    <span class="workbench-navigation-status__title">{{ entry.view.title }}</span>
    <span>{{ entry.status === 'failed' ? labels.failed : labels.loading }}</span>
    <button v-if="entry.status === 'failed'" type="button" @click="retry">
      {{ labels.retry }}
    </button>
    <button type="button" @click="controller.navigation.cancel(entry.paneId)">
      {{ labels.cancel }}
    </button>
  </div>
</template>

<style scoped>
.workbench-navigation-status { position: absolute; z-index: 4; top: 3rem; right: 12px; display: flex; align-items: center; gap: 8px; max-width: calc(100% - 24px); padding: 8px 12px; border: 1px solid var(--buddy-border-subtle); border-radius: 6px; background: var(--buddy-surface-base); color: var(--buddy-text-secondary); font-size: 12px; }
.workbench-navigation-status__title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.workbench-navigation-status button { flex-shrink: 0; border: 0; padding: 0; background: transparent; color: var(--buddy-accent-solid); cursor: pointer; }
</style>
