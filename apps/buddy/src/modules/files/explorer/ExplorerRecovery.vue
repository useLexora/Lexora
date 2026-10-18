<script setup lang="ts">
import type { SpaceFileOperation } from '@buddy-shared/spaces/spaceFileApi'
import { NButton, useDialog } from 'naive-ui'
import { computed } from 'vue'
import { explorerLabels } from './explorerLabels'

const props = defineProps<{ operations: readonly SpaceFileOperation[], language: string, busy: boolean }>()
const emit = defineEmits<{ acknowledge: [operation: SpaceFileOperation] }>()
const labels = computed(() => explorerLabels(props.language))
const operationLabels = computed<Record<string, string>>(() => ({
  write: labels.value.write,
  createFile: labels.value.newFile,
  createDirectory: labels.value.newFolder,
  rename: labels.value.rename,
  copy: labels.value.copy,
  move: labels.value.move,
  trash: labels.value.trash,
  restore: labels.value.restore,
}))
const dialog = useDialog()
function acknowledge(operation: SpaceFileOperation) {
  dialog.warning({ title: labels.value.recovery, content: labels.value.recoveryDetail, positiveText: labels.value.acknowledge, negativeText: labels.value.cancel, onPositiveClick: () => emit('acknowledge', operation) })
}
</script>

<template>
  <div class="explorer-recovery max-h-[240px] overflow-auto p-[12px] border-t-1 border-t-solid border-t-border" role="alert">
    <p class="m-0 text-muted text-[12px]">
      {{ labels.recovery }}
    </p>
    <div v-for="operation in operations" :key="operation.operationId" class="grid gap-1 py-[6px]">
      <span class="text-[12px]">{{ operationLabels[operation.kind] ?? labels.operation }}</span>
      <span v-if="operation.path" class="break-all text-[12px]">{{ labels.source }}: {{ operation.path }}</span>
      <span v-if="operation.destination" class="break-all text-[12px]">{{ labels.destination }}: {{ operation.destination }}</span>
      <span v-if="operation.temporaryPath" class="text-[11px] break-all text-muted">{{ labels.temporary }}: {{ operation.temporaryPath }}</span>
      <NButton text size="tiny" :disabled="busy" @click="acknowledge(operation)">
        {{ labels.acknowledge }}
      </NButton>
    </div>
  </div>
</template>
