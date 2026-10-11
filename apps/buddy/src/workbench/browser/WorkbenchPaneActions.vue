<script setup lang="ts">
import type { DropdownOption } from 'naive-ui'
import type { SplitDirection } from '../common/workbench'
import { MoreHorizontal20Regular } from '@vicons/fluent'
import { NDropdown } from 'naive-ui'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { panes } from '../common/workbench'
import { useWorkbench } from './workbenchContext'

const props = defineProps<{ viewId: string }>()
const emit = defineEmits<{ split: [direction: SplitDirection] }>()
const { controller, labels, layout } = useWorkbench()
const canClose = computed(() => panes(layout.value.root).length > 1)
const options = computed<DropdownOption[]>(() => {
  const items: DropdownOption[] = [
    { key: 'left', label: labels.value.splitLeft },
    { key: 'right', label: labels.value.split },
    { key: 'up', label: labels.value.splitUp },
    { key: 'down', label: labels.value.splitDown },
  ]
  if (canClose.value) {
    items.push(
      { type: 'divider', key: 'separator' },
      { key: 'close', label: labels.value.close },
    )
  }
  return items
})
function select(key: string) {
  if (key === 'close')
    void controller.close(props.viewId)
  else
    emit('split', key as SplitDirection)
}
</script>

<template>
  <NDropdown trigger="click" :options="options" @select="select">
    <button class="workbench-pane-actions grid place-items-center w-8 h-8 border-0 rounded-icon text-fg bg-transparent cursor-pointer hover:bg-hover ui-focus-ring" type="button" :aria-label="labels.layout" data-testid="pane-layout-menu">
      <DesktopIcon :component="MoreHorizontal20Regular" />
    </button>
  </NDropdown>
</template>
