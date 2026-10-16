<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import type { BlockMenuChildItem } from '../catalog/menuRegistry'
import TiptapIcon from '../../icons/TiptapIcon.vue'
import { getAlignMenuItems } from '../catalog/menuRegistry'
import AlignActionPanel from '../shared/AlignActionPanel.vue'
import BubbleDropdownShell from './BubbleDropdownShell.vue'
import { useBubbleDropdownController } from './useBubbleDropdownController'

/**
 * 对齐下拉属性。
 */
interface AlignDropdownProps {
  /** 编辑器实例 */
  editor: Editor
  /** 提示描述 */
  description?: string
}

const props = defineProps<AlignDropdownProps>()
const {
  actionRegistry,
  close,
  setVisible,
  state,
  visible,
} = useBubbleDropdownController({
  editor: props.editor,
  projectState: (editor) => {
    const items = getAlignMenuItems(editor)

    return {
      items,
      currentAlignIcon: items.find(item => item.kind === 'text-align' && item.isActive)?.icon ?? 'align-left',
      isButtonActive: items.some(item => item.kind === 'text-align' && item.isActive && item.action !== 'align-left'),
    }
  },
})

function handleItemClick(item: BlockMenuChildItem) {
  if (item.kind === 'text-align') {
    actionRegistry.align.executeTextAlign(item.action)
  }
  else {
    actionRegistry.align.executeIndent(item.action)
  }

  close()
}
</script>

<template>
  <BubbleDropdownShell
    :visible="visible"
    :width="208"
    popper-class="tiptap-bubble-align-popover"
    :description="props.description"
    :active="state.isButtonActive"
    @update:visible="setVisible"
  >
    <template #trigger>
      <TiptapIcon :icon="state.currentAlignIcon" class="tiptap-bubble-btn__icon" />
      <TiptapIcon icon="chevron-down" class="tiptap-bubble-btn__chevron" size="0.75rem" />
    </template>

    <AlignActionPanel :items="state.items" @item-click="handleItemClick" />
  </BubbleDropdownShell>
</template>
