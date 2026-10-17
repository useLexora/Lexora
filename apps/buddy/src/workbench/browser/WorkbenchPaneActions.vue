<script setup lang="ts">
import type { DropdownOption } from 'naive-ui'
import type { SplitDirection } from '../common/workbench'
import { Dismiss20Regular, MoreHorizontal20Regular, SplitHorizontal20Regular } from '@vicons/fluent'
import { NDropdown } from 'naive-ui'
import { computed, h } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { panes } from '../common/workbench'
import { useWorkbench } from './workbenchContext'

const props = defineProps<{ viewId: string, actions?: DropdownOption[], label?: string }>()
const emit = defineEmits<{ split: [direction: SplitDirection], select: [key: string | number] }>()
const { controller, labels, layout } = useWorkbench()
const canClose = computed(() => panes(layout.value.root).length > 1)
const options = computed<DropdownOption[]>(() => {
  const items: DropdownOption[] = [
    {
      key: 'split',
      label: labels.value.splitMenu,
      icon: () => h(DesktopIcon, { component: SplitHorizontal20Regular }),
      children: [
        { key: 'left', label: labels.value.splitLeft },
        { key: 'right', label: labels.value.split },
        { key: 'up', label: labels.value.splitUp },
        { key: 'down', label: labels.value.splitDown },
      ],
    },
    ...(props.actions ?? []).filter(action => action.type !== 'divider'),
  ]
  if (canClose.value) {
    items.push(
      { type: 'divider', key: 'separator' },
      { key: 'close', label: labels.value.close, icon: () => h(DesktopIcon, { component: Dismiss20Regular }) },
    )
  }
  return items
})
function select(key: string | number) {
  if (key === 'close')
    void controller.close(props.viewId)
  else if (key === 'left' || key === 'right' || key === 'up' || key === 'down')
    emit('split', key)
  else
    emit('select', key)
}
</script>

<template>
  <NDropdown class="workbench-pane-menu buddy-spaced-submenus" trigger="click" placement="bottom-end" :options="options" @select="select">
    <button class="workbench-pane-actions grid place-items-center w-8 h-8 border-0 rounded-icon text-fg bg-transparent cursor-pointer hover:bg-hover ui-focus-ring" type="button" :aria-label="label ?? labels.layout" data-testid="pane-layout-menu">
      <DesktopIcon :component="MoreHorizontal20Regular" />
    </button>
  </NDropdown>
</template>
