<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { BlockTriggerMenuEmits, BlockTriggerMenuExposed, BlockTriggerMenuProps } from './typing'
import BlockTriggerButton from './BlockTriggerButton.vue'
import BlockTriggerPanels from './BlockTriggerPanels.vue'
import { useBlockTriggerMenu } from './useBlockTriggerMenu'

const props = defineProps<BlockTriggerMenuProps>()
const emits = defineEmits<BlockTriggerMenuEmits>()
const {
  activePanel,
  anchorStyle,
  applyBackgroundColor,
  applyTextColor,
  closeMenu,
  dropIndicatorStyle,
  fileInputRef,
  handleDragEnd,
  handleDragStart,
  handleAlignItemClick,
  handleMenuItemClick,
  handlePickFileResult,
  handlePickImageResult,
  handleQuickItemClick,
  handleTriggerMouseEnter,
  handleTriggerMouseLeave,
  imageInputRef,
  isDragging,
  isTriggerButtonVisible,
  linkPanel,
  openMenu,
  state,
  shouldRenderTriggerMenu,
  visible,
} = useBlockTriggerMenu({
  editor: props.editor,
  aiBlockRewriteEnabled: props.aiBlockRewriteEnabled,
  onRequestAiBlockRewrite: request => emits('requestAiBlockRewrite', request),
  onRequestComment: request => emits('requestComment', request),
  uploadImage: props.uploadImage,
  uploadFile: props.uploadFile,
})

function assignImageInputRef(element: Element | ComponentPublicInstance | null) {
  imageInputRef.value = element as HTMLInputElement | null
}

function assignFileInputRef(element: Element | ComponentPublicInstance | null) {
  fileInputRef.value = element as HTMLInputElement | null
}

defineExpose<BlockTriggerMenuExposed>({
  openMenu,
})
</script>

<template>
  <div
    v-if="dropIndicatorStyle"
    class="tiptap-block-trigger-drop-indicator"
    :style="dropIndicatorStyle"
  />

  <div
    v-if="shouldRenderTriggerMenu"
    class="tiptap-block-trigger-anchor"
    :style="anchorStyle"
    @click="openMenu"
    @mouseenter="handleTriggerMouseEnter"
    @mouseleave="handleTriggerMouseLeave"
  >
    <ElPopover
      v-model:visible="visible"
      trigger="hover"
      placement="bottom-start"
      :offset="8"
      :show-arrow="false"
      popper-class="tiptap-block-trigger-popover"
      @hide="closeMenu"
    >
      <template #reference>
        <BlockTriggerButton
          :icon="state.currentTriggerIcon"
          :label="state.currentTriggerLabel"
          :is-open="visible"
          :is-peek-visible="isTriggerButtonVisible"
          :can-drag="state.canDrag"
          :is-dragging="isDragging"
          @dragstart="handleDragStart"
          @dragend="handleDragEnd"
        />
      </template>

      <BlockTriggerPanels
        :state="state"
        :active-panel="activePanel"
        :link-panel="linkPanel"
        @quick-item-click="handleQuickItemClick"
        @menu-item-click="handleMenuItemClick"
        @align-item-click="handleAlignItemClick"
        @apply-text-color="applyTextColor"
        @apply-background-color="applyBackgroundColor"
      />

      <input
        :ref="assignImageInputRef"
        type="file"
        accept="image/gif,image/jpeg,image/png,image/webp"
        class="hidden"
        @change="handlePickImageResult"
      >
      <input
        :ref="assignFileInputRef"
        type="file"
        class="hidden"
        @change="handlePickFileResult"
      >
    </ElPopover>
  </div>
</template>
