<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import type { BlockTriggerMenuExposed } from '../../overlays/block-trigger/typing'
import type { DocumentBodyEditorEmits, DocumentBodyEditorProps } from './typing'
import { shallowRef, useTemplateRef } from 'vue'
import TiptapEditor from '../../core/TiptapEditor.vue'
import BlockTriggerMenu from '../../overlays/block-trigger/BlockTriggerMenu.vue'
import BubbleToolbar from '../../overlays/bubble-toolbar/BubbleToolbar.vue'
import MathPanelBubble from '../../overlays/math-panel/MathPanelBubble.vue'
import EditorOutline from '../../overlays/outline/EditorOutline.vue'
import { useDocumentBodyEditor } from './useDocumentBodyEditor'

const props = withDefaults(defineProps<DocumentBodyEditorProps>(), {
  editable: true,
  activeBlockId: null,
  aiDraftPreview: null,
  aiBlockRewriteEnabled: false,
  documentId: null,
  outlineOptions: () => ({}),
  showOutline: true,
})
const emits = defineEmits<DocumentBodyEditorEmits>()
const bodyEditor = shallowRef<Editor | null>(null)
const blockTriggerMenuRef = useTemplateRef<BlockTriggerMenuExposed>('blockTriggerMenu')
const BODY_EDITOR_SCROLL_THRESHOLD = {
  top: 48,
  right: 0,
  bottom: 48,
  left: 0,
} as const
const BODY_EDITOR_SCROLL_MARGIN = {
  top: 48,
  right: 0,
  bottom: 72,
  left: 0,
} as const
const {
  bodyEditorExtensions,
  handleBodyEditorChange,
  handleBodyEditorKeyDown,
  handleBodyEditorTextInput,
  handleCommentRequest,
  handleUploadFile,
  handleUploadImage,
} = useDocumentBodyEditor({
  bodyEditor,
  blockTriggerMenuRef,
  onAcceptAiDraftPreview: candidateId => emits('acceptAiDraftPreview', candidateId),
  props,
  onRequestComment: request => emits('requestComment', request),
  onRejectAiDraftPreview: candidateId => emits('rejectAiDraftPreview', candidateId),
  onSelectionChange: request => emits('selectionChange', request),
})
</script>

<template>
  <section
    class="document-body-editor"
    :class="`document-body-editor--outline-${props.outlineOptions.layout ?? 'overlay'}`"
  >
    <BubbleToolbar
      v-if="bodyEditor && props.editable"
      :editor="bodyEditor"
      @request-comment="handleCommentRequest"
      @request-add-selection-context="emits('requestAddSelectionContext', $event)"
    />

    <MathPanelBubble
      v-if="bodyEditor && props.editable"
      :editor="bodyEditor"
    />

    <TiptapEditor
      class="document-body-editor__surface"
      :content="props.content"
      :initial-extensions="bodyEditorExtensions"
      :editable="props.editable"
      :handle-key-down="handleBodyEditorKeyDown"
      :handle-text-input="handleBodyEditorTextInput"
      :scroll-threshold="BODY_EDITOR_SCROLL_THRESHOLD"
      :scroll-margin="BODY_EDITOR_SCROLL_MARGIN"
      @update:content="emits('update:content', $event)"
      @content-error="emits('contentError', $event)"
      @editor-change="handleBodyEditorChange"
    />

    <EditorOutline
      v-if="bodyEditor && props.showOutline"
      :editor="bodyEditor"
      :content="props.content"
      :default-expanded="props.outlineOptions.defaultExpanded"
      :mode="props.outlineOptions.mode"
      :placement="props.outlineOptions.placement"
      :show-search="props.outlineOptions.showSearch"
      :surface="props.outlineOptions.surface"
    />

    <BlockTriggerMenu
      v-if="bodyEditor && props.editable"
      ref="blockTriggerMenu"
      :editor="bodyEditor"
      :ai-block-rewrite-enabled="props.aiBlockRewriteEnabled"
      :upload-image="handleUploadImage"
      :upload-file="handleUploadFile"
      @request-comment="handleCommentRequest"
      @request-ai-block-rewrite="emits('requestAiBlockRewrite', $event)"
    />
  </section>
</template>

<style scoped lang="scss">
.document-body-editor {
  :deep(.tiptap-editor) {
    position: relative;
  }

  :deep(.tiptap-document-ai-anchor-preview__selection) {
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--brand-primary) 12%, transparent);
  }

  :deep(.tiptap-document-ai-anchor-preview__block) {
    border-radius: 0.25rem;
    outline: 1px solid color-mix(in srgb, var(--brand-primary) 18%, transparent);
    outline-offset: -1px;
    background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
  }

  :deep(.tiptap-document-ai-anchor-preview__cursor) {
    position: absolute;
    z-index: 2;
    top: 0;
    left: 0;
    display: block;
    width: 1px;
    min-height: 1em;
    background: color-mix(in srgb, var(--brand-primary) 76%, transparent);
    pointer-events: none;
  }

  :deep(.tiptap-document-ai-draft-preview__deleted) {
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--el-color-danger) 9%, transparent);
    color: color-mix(in srgb, var(--brand-text-secondary) 78%, transparent);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--el-color-danger) 60%, transparent);
    text-decoration-thickness: 0.08em;
  }

  :deep(.tiptap-document-ai-draft-preview__deleted-block) {
    border-radius: 0.25rem;
    outline: 1px solid color-mix(in srgb, var(--el-color-danger) 18%, transparent);
    outline-offset: -1px;
    background: color-mix(in srgb, var(--el-color-danger) 7%, transparent);
    color: color-mix(in srgb, var(--brand-text-secondary) 78%, transparent);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--el-color-danger) 60%, transparent);
    text-decoration-thickness: 0.08em;
  }

  :deep(.tiptap-document-ai-draft-preview) {
    margin: 0;
    padding: 0;
    color: var(--brand-text-primary);
  }

  :deep(.tiptap-document-ai-draft-preview__empty-anchor) {
    display: none;
  }

  :deep(.tiptap-document-ai-draft-preview--block) {
    display: block;
  }

  :deep(.tiptap-document-ai-draft-preview__local-editor) {
    display: block;
    background: transparent;
  }

  :deep(.tiptap-document-ai-draft-preview__prosemirror) {
    min-height: 0;
    height: auto;
    padding: 0;
    background: transparent;
    pointer-events: auto;
  }

  :deep(.tiptap-document-ai-draft-preview__prosemirror > *) {
    border-radius: 0.125rem;
    background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
  }

  :deep(.tiptap-document-ai-draft-preview__prosemirror > :first-child) {
    margin-top: 0;
  }

  :deep(.tiptap-document-ai-draft-preview__prosemirror > :last-child) {
    margin-bottom: 0;
  }

  :deep(.tiptap-document-ai-draft-preview--block .tiptap-document-ai-draft-preview__inserted) {
    border-radius: 0.125rem;
    background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
  }

  :deep(.tiptap-document-ai-draft-preview--inline) {
    display: inline;
    border-radius: 0.125rem;
    background: color-mix(in srgb, var(--brand-primary) 9%, transparent);
    box-decoration-break: clone;
  }

  :deep(.tiptap-document-ai-draft-preview__actions) {
    display: inline-flex;
    position: absolute;
    z-index: 3;
    top: 0;
    left: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem;
    border: 1px solid color-mix(in srgb, var(--brand-primary) 22%, var(--brand-border-base));
    border-radius: 0.375rem;
    background: color-mix(in srgb, var(--brand-bg-surface-raised) 94%, transparent);
    box-shadow: var(--brand-shadow-hairline);
    pointer-events: auto;
  }

  :deep(.tiptap-document-ai-draft-preview__button) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 1.5rem;
    padding: 0 0.5rem;
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
    border-radius: 0.25rem;
    background: var(--brand-bg-surface);
    color: var(--brand-text-secondary);
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 500;

    &:hover {
      color: var(--brand-text-primary);
      background: color-mix(in srgb, var(--brand-fill-light) 68%, transparent);
    }

    &.is-primary {
      border-color: color-mix(in srgb, var(--brand-primary) 48%, transparent);
      background: var(--brand-primary);
      color: #fff;

      &:hover {
        color: #fff;
        background: color-mix(in srgb, var(--brand-primary) 88%, #000);
      }
    }
  }
}
</style>
