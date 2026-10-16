<script setup lang="ts">
import type {
  DocumentContentSurfaceEmits,
  DocumentContentSurfaceProps,
} from './typing'
import { DOCUMENT_PAGE_WIDTH_MODE } from '@haohaoxue/lexora-contracts/document/constants'
import { computed } from 'vue'
import DocumentBodyEditor from '../body/DocumentBodyEditor.vue'
import DocumentTitleEditor from '../title/DocumentTitleEditor.vue'

const props = withDefaults(defineProps<DocumentContentSurfaceProps>(), {
  documentId: null,
  editable: true,
  activeBlockId: null,
  bodyAiDraftPreview: null,
  bodyAiBlockRewriteEnabled: false,
  pageWidthMode: DOCUMENT_PAGE_WIDTH_MODE.DEFAULT,
  showOutline: true,
  footerMetaItems: () => [],
})
const emits = defineEmits<DocumentContentSurfaceEmits>()

const titleEditorKey = computed(() => `${props.documentId ?? 'document'}:title`)
const bodyEditorKey = computed(() => `${props.documentId ?? 'document'}:body`)
const pageWidthClass = computed(() => ({
  [DOCUMENT_PAGE_WIDTH_MODE.NARROW]: 'is-page-width-narrow',
  [DOCUMENT_PAGE_WIDTH_MODE.DEFAULT]: 'is-page-width-default',
  [DOCUMENT_PAGE_WIDTH_MODE.FULL]: 'is-page-width-full',
})[props.pageWidthMode])
</script>

<template>
  <section class="document-content-surface" :class="pageWidthClass">
    <div class="document-content-surface__title">
      <DocumentTitleEditor
        :key="titleEditorKey"
        class="document-content-surface__title-editor"
        :title="props.title"
        :autofocus="props.autofocusTitle"
        :editable="props.editable"
        @update:title="emits('updateTitle', $event)"
        @autofocus-applied="emits('titleAutofocusApplied')"
      />
    </div>

    <div class="document-content-surface__body">
      <DocumentBodyEditor
        :key="bodyEditorKey"
        class="document-content-surface__body-editor"
        :document-id="props.documentId"
        :content="props.body"
        :active-block-id="props.activeBlockId"
        :ai-draft-preview="props.bodyAiDraftPreview"
        :ai-block-rewrite-enabled="props.bodyAiBlockRewriteEnabled"
        :editable="props.editable"
        :show-outline="props.showOutline"
        @update:content="emits('updateContent', $event)"
        @content-error="emits('contentError', $event)"
        @request-comment="emits('requestComment', $event)"
        @request-add-selection-context="emits('requestAddSelectionContext', $event)"
        @request-ai-block-rewrite="emits('requestBodyAiBlockRewrite', $event)"
        @selection-change="emits('selectionChange', $event)"
        @accept-ai-draft-preview="emits('acceptBodyAiDraftPreview', $event)"
        @reject-ai-draft-preview="emits('rejectBodyAiDraftPreview', $event)"
      />
    </div>

    <footer v-if="props.footerMetaItems.length" class="document-content-surface__footer">
      <div
        v-for="item in props.footerMetaItems"
        :key="item.label"
        class="document-content-surface__footer-meta"
      >
        <span class="document-content-surface__footer-label">{{ item.label }}：</span>
        <span class="document-content-surface__footer-value">{{ item.value }}</span>
      </div>
    </footer>
  </section>
</template>

<style scoped lang="scss">
.document-content-surface {
  --document-content-surface-inline-start: 1.25rem;
  --document-content-surface-inline-end: 1.25rem;
  --document-content-surface-inline-size: 100%;
  display: flex;
  flex: 1 1 0%;
  flex-direction: column;
  min-height: 0;
  background: var(--brand-bg-surface);

  &.is-page-width-narrow {
    --document-content-surface-inline-size: min(100%, 42rem);
  }

  &.is-page-width-default {
    --document-content-surface-inline-size: min(100%, 64rem);
  }

  &.is-page-width-full {
    --document-content-surface-inline-size: 100%;
  }

  .document-content-surface__title {
    padding:
      1.625rem
      var(--document-content-surface-inline-end)
      1rem
      var(--document-content-surface-inline-start);
    border-bottom: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
    background: inherit;
  }

  .document-content-surface__title-editor {
    --document-content-surface-title-font-size: 1.6rem;
    --document-content-surface-title-line-height: 1.2;
    --document-content-surface-title-height: 1.92rem;
    --tiptap-content-min-height: auto;
    --tiptap-prosemirror-min-height: auto;
    --tiptap-prosemirror-height: var(--document-content-surface-title-height);
    --tiptap-prosemirror-color: var(--brand-text-primary);
    --tiptap-prosemirror-font-size: var(--document-content-surface-title-font-size);
    --tiptap-prosemirror-font-weight: 700;
    --tiptap-prosemirror-line-height: var(--document-content-surface-title-line-height);
    --tiptap-prosemirror-letter-spacing: 0;
    --tiptap-placeholder-color: var(--brand-text-placeholder);
    width: var(--document-content-surface-inline-size);
    max-width: 100%;
    min-height: auto;
    height: var(--document-content-surface-title-height);
    margin-inline: auto;
    overflow: hidden;

    :deep(.tiptap-editor) {
      min-height: 0;
      height: var(--document-content-surface-title-height);
      overflow: hidden;
    }

    :deep(.tiptap-editor__content) {
      min-height: 0;
      height: var(--document-content-surface-title-height);
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
    }

    :deep(.tiptap-editor__content::-webkit-scrollbar) {
      display: none;
    }

    :deep(.tiptap-editor__prosemirror) {
      width: max-content;
      min-width: 100%;
      max-width: none;
      overflow: visible;
      white-space: pre;
    }

    :deep(.tiptap-editor__prosemirror p) {
      display: inline;
      margin: 0;
      white-space: pre;
    }

    :deep(.tiptap-editor__prosemirror p:not(:first-child)::before) {
      content: ' ';
    }
  }

  .document-content-surface__body {
    position: relative;
    display: flex;
    flex: 1 1 0%;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 0 32px;
  }

  .document-content-surface__body-editor {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    flex: 1 0 auto;
    width: 100%;
    min-width: 0;
    min-height: 100%;
    padding-inline: var(--document-content-surface-inline-start) var(--document-content-surface-inline-end);
    box-sizing: border-box;

    :deep(.document-body-editor__surface) {
      grid-area: 1 / 1;
      flex: 1 1 0%;
      width: var(--document-content-surface-inline-size);
      max-width: 100%;
      min-width: 0;
      min-height: 0;
      margin-inline: auto;
    }
  }

  .document-content-surface__footer {
    display: flex;
    align-items: center;
    gap: 0.5rem 1rem;
    flex-shrink: 0;
    flex-basis: var(--default-footer-height);
    height: var(--default-footer-height);
    overflow: hidden;
    padding-inline: var(--document-content-surface-inline-start) var(--document-content-surface-inline-end);
    border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
    box-sizing: border-box;
    background: inherit;
    color: color-mix(in srgb, var(--brand-text-secondary) 82%, transparent);
    font-size: 12px;
    line-height: 1.25rem;
  }

  .document-content-surface__footer-meta {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    white-space: nowrap;
  }

  .document-content-surface__footer-label {
    color: color-mix(in srgb, var(--brand-text-primary) 72%, transparent);
    font-weight: 600;
  }

  .document-content-surface__footer-value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>
