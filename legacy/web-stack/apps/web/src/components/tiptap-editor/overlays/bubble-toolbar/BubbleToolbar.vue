<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import type {
  TiptapEditorCommentRequest,
  TiptapEditorSelectionContextRequest,
} from '../../core/typing'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import LinkPreview from '../link-preview/LinkPreview.vue'
import LinkPanel from '../shared/LinkPanel.vue'
import BubbleToolbarGroup from './BubbleToolbarGroup.vue'
import { useBubbleToolbar } from './useBubbleToolbar'

/**
 * 选择工具栏属性。
 */
interface BubbleToolbarProps {
  /** 编辑器实例 */
  editor: Editor
}

/**
 * 选择工具栏事件。
 */
interface BubbleToolbarEmits {
  requestComment: [request: TiptapEditorCommentRequest]
  requestAddSelectionContext: [request: TiptapEditorSelectionContextRequest]
}

const props = defineProps<BubbleToolbarProps>()
const emits = defineEmits<BubbleToolbarEmits>()
const editor = props.editor
const controller = useBubbleToolbar(editor, {
  onRequestComment: () => emits('requestComment', {
    source: 'bubble-toolbar',
  }),
  onRequestAddSelectionContext: () => emits('requestAddSelectionContext', {
    editor,
    from: editor.state.selection.from,
    to: editor.state.selection.to,
  }),
})
</script>

<template>
  <BubbleMenu
    :editor="editor"
    plugin-key="bubbleToolbarMenu"
    :should-show="controller.overlay.shouldShowToolbar"
    :options="{ placement: 'top', offset: 8 }"
  >
    <div class="tiptap-bubble-toolbar">
      <BubbleToolbarGroup
        v-for="group in controller.state.value.groups"
        :key="group.key"
        :editor="editor"
        :group="group"
        @action-click="controller.handleActionClick"
      />
    </div>
  </BubbleMenu>

  <BubbleMenu
    :editor="editor"
    plugin-key="bubbleToolbarLinkPanel"
    :should-show="controller.overlay.shouldShowLinkPanel"
    :get-referenced-virtual-element="controller.overlay.linkPanel.getReferencedVirtualElement"
    :options="{ placement: 'bottom', offset: 8 }"
  >
    <LinkPanel :controller="controller.overlay.linkPanel" />
  </BubbleMenu>

  <LinkPreview :controller="controller.overlay.linkPreview" />
</template>
