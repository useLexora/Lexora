<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import type { TiptapEditorContent, TiptapEditorHandleKeyDown } from '../../core/typing'
import type { DocumentTitleEditorEmits, DocumentTitleEditorProps } from './typing'
import { computed, nextTick, shallowRef, watch } from 'vue'
import TiptapEditor from '../../core/TiptapEditor.vue'
import { fromTiptapDocumentTitleEditorContent, toTiptapDocumentTitleEditorContent } from '../../core/utils'
import { createTitleExtensions } from '../../extensions/createExtensions'

const props = defineProps<DocumentTitleEditorProps>()
const emits = defineEmits<DocumentTitleEditorEmits>()

const titleEditorContent = computed(() => toTiptapDocumentTitleEditorContent(props.title))
const titleEditorExtensions = createTitleExtensions()
const handleTitleEditorKeyDown: TiptapEditorHandleKeyDown = (_, event) => event.key === 'Enter'
const titleEditor = shallowRef<Editor | null>(null)
const hasAppliedAutofocus = shallowRef(false)

function handleUpdateTitle(content: TiptapEditorContent) {
  emits('update:title', fromTiptapDocumentTitleEditorContent(content))
}

function handleEditorChange(editor: Editor | null) {
  titleEditor.value = editor
}

watch(
  [
    () => props.autofocus,
    () => props.editable !== false,
    titleEditor,
  ],
  async ([autofocus, editable, editor]) => {
    if (!autofocus) {
      hasAppliedAutofocus.value = false
      return
    }

    if (!editable || !editor || hasAppliedAutofocus.value) {
      return
    }

    await nextTick()

    if (!props.autofocus || props.editable === false || editor.isDestroyed) {
      return
    }

    const didFocus = editor.commands.focus('end')

    if (!didFocus) {
      return
    }

    hasAppliedAutofocus.value = true
    emits('autofocusApplied')
  },
  {
    flush: 'post',
  },
)
</script>

<template>
  <TiptapEditor
    class="document-title-editor"
    :content="titleEditorContent"
    :initial-extensions="titleEditorExtensions"
    :editable="props.editable"
    :handle-key-down="handleTitleEditorKeyDown"
    @update:content="handleUpdateTitle"
    @editor-change="handleEditorChange"
  />
</template>
