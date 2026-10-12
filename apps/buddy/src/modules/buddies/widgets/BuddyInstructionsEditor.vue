<script setup lang="ts">
import type { JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { watch } from 'vue'

const props = defineProps<{
  modelValue: string
  placeholder: string
  labelledBy: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function createInstructionsDocument(content: string): JSONContent {
  return {
    type: 'doc',
    content: content.split('\n').map(text => ({
      type: 'paragraph',
      content: text ? [{ type: 'text', text }] : [],
    })),
  }
}

let hydrating = false

const editor = useEditor({
  content: createInstructionsDocument(props.modelValue),
  editable: !props.disabled,
  extensions: [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      link: false,
      listItem: false,
      orderedList: false,
      strike: false,
    }),
  ],
  editorProps: {
    attributes: () => ({
      'spellcheck': 'false',
      'class': 'buddy-instructions-tiptap',
      'role': 'textbox',
      'aria-multiline': 'true',
      'aria-labelledby': props.labelledBy,
      'aria-placeholder': props.placeholder,
    }),
  },
  onUpdate: ({ editor }) => {
    if (!hydrating)
      emit('update:modelValue', editor.getText({ blockSeparator: '\n' }))
  },
})

watch(
  () => props.modelValue,
  (value) => {
    if (!editor.value)
      return
    const current = editor.value.getText({ blockSeparator: '\n' })
    if (value !== current) {
      hydrating = true
      editor.value.commands.setContent(createInstructionsDocument(value), { emitUpdate: false })
      hydrating = false
    }
  },
)

watch(
  () => props.disabled,
  (disabled) => {
    editor.value?.setEditable(!disabled)
  },
)
</script>

<template>
  <div
    class="buddy-instructions-editor mx-2 mb-2 cursor-text border border-transparent rounded-md border-solid transition-colors focus-within:border-accent-border-hover"
    :class="{ 'is-disabled': disabled }"
  >
    <div class="relative max-h-[280px] overflow-y-auto px-2 py-2.5">
      <EditorContent v-if="editor" :editor="editor" class="buddy-instructions-content" />
      <div
        v-if="!modelValue.trim()"
        class="pointer-events-none absolute left-2 right-2 top-2.5 select-none text-[13px] text-muted leading-[1.8]"
      >
        {{ placeholder }}
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.buddy-instructions-editor {
  background: color-mix(in srgb, var(--buddy-surface-subtle) 40%, var(--buddy-surface-base));

  &.is-disabled {
    opacity: 0.65;
    pointer-events: none;
  }
}

.buddy-instructions-content {
  width: 100%;
  min-width: 0;
  color: var(--buddy-text-primary);
  font-size: 13px;
  line-height: 1.8;

  :deep(.tiptap) {
    outline: none;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 2;
    min-height: 96px;
  }

  :deep(p) {
    margin: 0;
    min-height: 1.8em;
  }
}
</style>
