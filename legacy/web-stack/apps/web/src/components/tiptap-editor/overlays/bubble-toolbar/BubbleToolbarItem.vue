<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import type { BubbleToolbarAction } from '../catalog/actionRegistry'
import type {
  BubbleToolbarTextStyle,
  BubbleToolbarViewGroupItem,
} from '../catalog/bubbleToolbarCatalog'
import TiptapIcon from '../../icons/TiptapIcon.vue'
import AlignDropdown from './AlignDropdown.vue'
import BubbleToolbarButton from './BubbleToolbarButton.vue'
import ColorPickerDropdown from './ColorPickerDropdown.vue'
import TurnIntoDropdown from './TurnIntoDropdown.vue'

/**
 * 气泡工具栏项属性。
 */
interface BubbleToolbarItemProps {
  /** 编辑器实例 */
  editor: Editor
  /** 工具栏项 */
  item: BubbleToolbarViewGroupItem
}

/**
 * 气泡工具栏项事件。
 */
interface BubbleToolbarItemEmits {
  actionClick: [action: BubbleToolbarAction]
}

defineProps<BubbleToolbarItemProps>()
const emits = defineEmits<BubbleToolbarItemEmits>()

const BUBBLE_TOOLBAR_TEXT_STYLE_CLASS_MAP: Record<BubbleToolbarTextStyle, string> = {
  'mark-strong': 'font-bold text-sm',
  'mark-italic': 'text-sm italic',
  'mark-underline': 'text-sm underline',
  'mark-strike': 'text-sm line-through',
  'label': 'text-xs font-medium',
}
</script>

<template>
  <TurnIntoDropdown
    v-if="item.kind === 'component' && item.component === 'turn-into'"
    :editor="editor"
    :description="item.description"
  />
  <AlignDropdown
    v-else-if="item.kind === 'component' && item.component === 'align'"
    :editor="editor"
    :description="item.description"
  />
  <ColorPickerDropdown
    v-else-if="item.kind === 'component' && item.component === 'color'"
    :editor="editor"
    :description="item.description"
  />
  <BubbleToolbarButton
    v-else-if="item.kind === 'action'"
    :description="item.description"
    :active="item.active"
    :disabled="item.disabled"
    :button-variant="item.buttonVariant"
    :data-bubble-action="item.action"
    @mousedown.prevent
    @click="emits('actionClick', item.action)"
  >
    <span
      v-if="item.content.kind === 'text'"
      class="tiptap-bubble-btn__text"
      :class="BUBBLE_TOOLBAR_TEXT_STYLE_CLASS_MAP[item.content.style]"
    >
      {{ item.content.value }}
    </span>
    <TiptapIcon
      v-else
      :icon="item.content.icon"
      class="tiptap-bubble-btn__icon"
    />
  </BubbleToolbarButton>
</template>
