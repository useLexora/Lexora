<script setup lang="ts">
import { nodeViewProps, NodeViewWrapper } from '@tiptap/vue-3'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { selectMathNode } from './mathNodeSelection'
import { renderKatex } from './renderMath'
import 'katex/dist/katex.min.css'

const props = defineProps(nodeViewProps)
const { t } = useI18n()

const renderRef = useTemplateRef<HTMLElement>('render')
const hasRenderError = shallowRef(false)
const latex = computed(readLatex)
const isEmpty = computed(() => !latex.value.trim())

function readLatex() {
  const latexValue = props.node.attrs.latex

  return typeof latexValue === 'string' ? latexValue : ''
}

function handleSelect(event: Event) {
  event.preventDefault()
  selectMathNode(props.editor, props.getPos)
}

watch(latex, () => {
  nextTick(() => {
    hasRenderError.value = !renderKatex(renderRef.value, latex.value, {
      displayMode: true,
    })
  })
}, {
  immediate: true,
})
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="tiptap-math-block"
    :class="{
      'is-empty': isEmpty,
      'is-invalid': hasRenderError,
    }"
    contenteditable="false"
  >
    <button
      class="tiptap-math-block__render"
      type="button"
      @click="handleSelect"
      @mousedown="handleSelect"
    >
      <span v-if="isEmpty" class="tiptap-math-block__placeholder">{{ t('editor.math.placeholder') }}</span>
      <span v-else ref="render" class="tiptap-math-block__katex" />
    </button>
  </NodeViewWrapper>
</template>
