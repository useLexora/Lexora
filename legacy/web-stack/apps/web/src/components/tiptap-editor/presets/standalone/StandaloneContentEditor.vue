<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import type {
  TiptapEditorResolveImageSrc,
  TiptapEditorUploadedImage,
} from '../../content/typing'
import type { TiptapEditorContent } from '../../core/typing'
import { shallowRef } from 'vue'
import { translate } from '@/i18n'
import TiptapEditor from '../../core/TiptapEditor.vue'
import { createBodyExtensions } from '../../extensions/createExtensions'
import StandaloneContentToolbar from './StandaloneContentToolbar.vue'

interface StandaloneContentEditorProps {
  content: TiptapEditorContent
  editable?: boolean
  placeholder?: string
  canUploadImage?: boolean
  uploadImage?: (file: File) => Promise<TiptapEditorUploadedImage>
  resolveImageSrc?: TiptapEditorResolveImageSrc
}

interface StandaloneContentEditorEmits {
  'update:content': [content: TiptapEditorContent]
  'contentError': [error: Error]
}

const props = withDefaults(defineProps<StandaloneContentEditorProps>(), {
  editable: true,
  placeholder: translate('editor.placeholders.standalone'),
  canUploadImage: false,
  uploadImage: undefined,
  resolveImageSrc: undefined,
})
const emits = defineEmits<StandaloneContentEditorEmits>()
const editor = shallowRef<Editor | null>(null)
const extensions = createBodyExtensions({
  blockIds: false,
  placeholder: props.placeholder,
  emptyLinePlaceholder: '',
  uploadImage: props.uploadImage,
  resolveImageSrc: props.resolveImageSrc,
})

function handleEditorChange(nextEditor: Editor | null) {
  editor.value = nextEditor
}
</script>

<template>
  <section class="standalone-content-editor">
    <StandaloneContentToolbar
      v-if="editor && props.editable"
      :editor="editor"
      :can-upload-image="props.canUploadImage"
      :upload-image="props.uploadImage"
    />

    <TiptapEditor
      class="standalone-content-editor__surface"
      :content="props.content"
      :initial-extensions="extensions"
      :editable="props.editable"
      @update:content="emits('update:content', $event)"
      @content-error="emits('contentError', $event)"
      @editor-change="handleEditorChange"
    />
  </section>
</template>
