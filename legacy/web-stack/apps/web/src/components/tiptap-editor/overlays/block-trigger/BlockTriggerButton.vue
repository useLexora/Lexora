<script setup lang="ts">
import TiptapIcon from '../../icons/TiptapIcon.vue'
import MenuGlyph from '../shared/MenuGlyph.vue'

/** 块触发按钮属性。 */
interface BlockTriggerButtonProps {
  /** 当前块图标 */
  icon: string
  /** 当前块标签 */
  label: string
  /** 是否展开 */
  isOpen: boolean
  /** 是否显示 */
  isPeekVisible: boolean
  /** 是否允许拖拽 */
  canDrag: boolean
  /** 是否正在拖拽 */
  isDragging: boolean
}

/** 块触发按钮事件。 */
interface BlockTriggerButtonEmits {
  dragstart: [event: DragEvent]
  dragend: []
}

defineProps<BlockTriggerButtonProps>()
const emits = defineEmits<BlockTriggerButtonEmits>()
</script>

<template>
  <button
    class="tiptap-block-trigger-btn"
    :class="{
      'is-open': isOpen,
      'is-peek-visible': isPeekVisible,
      'is-draggable': canDrag,
      'is-dragging': isDragging,
      'is-empty-trigger': icon === '+',
    }"
    type="button"
    :title="label"
    :draggable="canDrag"
    @dragstart="emits('dragstart', $event)"
    @dragend="emits('dragend')"
  >
    <span class="tiptap-block-trigger-btn__content">
      <span class="tiptap-block-trigger-btn__glyph">
        <MenuGlyph :icon="icon" />
      </span>

      <span v-if="canDrag" class="tiptap-block-trigger-btn__drag-handle">
        <TiptapIcon icon="drag-handle" />
      </span>
    </span>
  </button>
</template>
