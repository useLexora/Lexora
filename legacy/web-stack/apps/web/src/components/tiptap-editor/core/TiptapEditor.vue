<script setup lang="ts">
import type { EditorEvents } from '@tiptap/core'
import type { TiptapEditorContent, TiptapEditorEmits, TiptapEditorProps } from './typing'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { onBeforeUnmount, watch } from 'vue'
import { translate } from '@/i18n'
import { unwrapTiptapContent, wrapTiptapContent } from './utils'

const props = withDefaults(defineProps<TiptapEditorProps>(), {
  editable: true,
})
const emits = defineEmits<TiptapEditorEmits>()

const editor = useEditor({
  content: wrapTiptapContent(props.content),
  extensions: props.initialExtensions,
  editable: props.editable,
  enableContentCheck: true,
  editorProps: {
    attributes: {
      class: 'tiptap-editor__prosemirror',
    },
    handleKeyDown: props.handleKeyDown,
    handleTextInput: props.handleTextInput,
    scrollMargin: props.scrollMargin,
    scrollThreshold: props.scrollThreshold,
  },
  onContentError: handleContentError,
  onUpdate: handleEditorUpdate,
})

function handleEditorUpdate(options: EditorEvents['update']) {
  emits('update:content', unwrapTiptapContent(options.editor.getJSON()))
}

function handleContentError(options: { error: Error }) {
  emits('contentError', options.error)
}

function isSameContent(content: TiptapEditorContent) {
  if (!editor.value) {
    return false
  }

  return JSON.stringify(unwrapTiptapContent(editor.value.getJSON())) === JSON.stringify(content)
}

function syncEditorContent(content: TiptapEditorContent) {
  if (!editor.value) {
    return
  }

  if (isSameContent(content)) {
    return
  }

  editor.value.commands.setContent(wrapTiptapContent(content), {
    emitUpdate: false,
  })
}

function destroyEditor() {
  emits('editorChange', null)
  editor.value?.destroy()
}

watch(
  () => props.content,
  (content) => {
    syncEditorContent(content)
  },
)

watch(
  () => props.initialExtensions,
  (nextExtensions, previousExtensions) => {
    if (!previousExtensions || nextExtensions === previousExtensions) {
      return
    }

    throw new Error(translate('editor.errors.initialExtensionsImmutable'))
  },
)

watch(
  () => props.editable,
  (nextEditable) => {
    editor.value?.setEditable(nextEditable, false)
  },
)

watch(
  editor,
  nextEditor => emits('editorChange', nextEditor ?? null),
  {
    immediate: true,
  },
)

onBeforeUnmount(destroyEditor)
</script>

<template>
  <section class="tiptap-editor">
    <EditorContent v-if="editor" :editor="editor" class="tiptap-editor__content" />
  </section>
</template>
