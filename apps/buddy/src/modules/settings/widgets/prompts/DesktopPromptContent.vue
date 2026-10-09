<script setup lang="ts">
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { watch } from 'vue'
import { createPromptDocument } from './promptDocument'

const props = defineProps<{ content: string }>()
const editor = useEditor({
  content: createPromptDocument(props.content),
  editable: false,
  enableInputRules: false,
  enablePasteRules: false,
  extensions: [StarterKit.configure({
    blockquote: false,
    bold: false,
    bulletList: false,
    code: false,
    codeBlock: false,
    dropcursor: false,
    gapcursor: false,
    hardBreak: false,
    heading: false,
    horizontalRule: false,
    italic: false,
    link: false,
    listItem: false,
    listKeymap: false,
    orderedList: false,
    strike: false,
    trailingNode: false,
    underline: false,
    undoRedo: false,
  })],
  editorProps: { attributes: { spellcheck: 'false' } },
})

watch(() => props.content, content => editor.value?.commands.setContent(createPromptDocument(content), { emitUpdate: false }))
</script>

<template>
  <div class="prompt-content">
    <EditorContent :editor="editor" class="prompt-content__body" />
  </div>
</template>

<style scoped>
.prompt-content { min-width: 0; }
.prompt-content__body { width: 100%; min-width: 0; color: var(--buddy-text-primary); font-size: 13px; line-height: 1.9; }
.prompt-content__body :deep(.tiptap) { outline: none; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; }
.prompt-content__body :deep(p) { min-height: 1.9em; margin: 0; }
</style>
