<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import MathPanel from './MathPanel.vue'
import { useMathPanel } from './useMathPanel'

interface MathPanelBubbleProps {
  editor: Editor
}

const props = defineProps<MathPanelBubbleProps>()
const controller = useMathPanel(props.editor)
</script>

<template>
  <BubbleMenu
    :editor="editor"
    plugin-key="tiptapMathPanel"
    :should-show="controller.shouldShow"
    :options="{ placement: 'bottom', offset: 8 }"
  >
    <MathPanel :controller="controller" />
  </BubbleMenu>
</template>
