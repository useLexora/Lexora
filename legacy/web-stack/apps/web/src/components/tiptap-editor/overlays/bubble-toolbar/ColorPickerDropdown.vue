<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import { useI18n } from 'vue-i18n'
import TiptapIcon from '../../icons/TiptapIcon.vue'
import {
  getActiveHighlightColor,
  getActiveTextColor,
} from '../catalog/menuRegistry'
import EditorColorPanel from '../shared/EditorColorPanel.vue'
import BubbleDropdownShell from './BubbleDropdownShell.vue'
import { useBubbleDropdownController } from './useBubbleDropdownController'

/**
 * 颜色面板属性。
 */
interface ColorPickerDropdownProps {
  /** 编辑器实例 */
  editor: Editor
  /** 提示描述 */
  description?: string
}

const props = defineProps<ColorPickerDropdownProps>()
const { t } = useI18n()
const HIGHLIGHT_CLASS_PREFIX_REGEXP = /^tiptap-highlight-/
const {
  actionRegistry,
  setVisible,
  state,
  visible,
} = useBubbleDropdownController({
  editor: props.editor,
  projectState: (editor) => {
    const textColor = getActiveTextColor(editor)
    const backgroundColor = getActiveHighlightColor(editor)

    return {
      textColor,
      backgroundColor,
      isButtonActive: Boolean(textColor || backgroundColor),
      textToken: formatColorToken(textColor, t('editor.common.textColor')),
      backgroundToken: formatColorToken(backgroundColor, t('editor.common.backgroundColor')),
    }
  },
})

function applyTextColor(color: string) {
  actionRegistry.colors.applyText(color)
}

function applyBackgroundColor(color: string) {
  actionRegistry.colors.applyBackground(color)
}

function formatColorToken(className: string, fallback: string) {
  return className
    ? className.replace(HIGHLIGHT_CLASS_PREFIX_REGEXP, '')
    : fallback
}
</script>

<template>
  <BubbleDropdownShell
    :visible="visible"
    :width="260"
    popper-class="tiptap-bubble-color-picker-popover"
    :description="props.description"
    :active="state.isButtonActive"
    @update:visible="setVisible"
  >
    <template #trigger>
      <span class="tiptap-bubble-color-trigger">
        <span
          class="tiptap-bubble-color-trigger__icon-shell"
          :class="[state.textColor || 'is-default', state.backgroundColor]"
          :title="`${state.textToken} / ${state.backgroundToken}`"
        >
          <TiptapIcon icon="color" class="tiptap-bubble-btn__icon" />
        </span>
      </span>
      <TiptapIcon icon="chevron-down" class="tiptap-bubble-btn__chevron" size="0.75rem" />
    </template>

    <EditorColorPanel
      :text-color="state.textColor"
      :background-color="state.backgroundColor"
      @apply-text-color="applyTextColor"
      @apply-background-color="applyBackgroundColor"
    />
  </BubbleDropdownShell>
</template>
