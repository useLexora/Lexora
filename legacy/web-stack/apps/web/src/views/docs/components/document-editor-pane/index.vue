<script setup lang="ts">
import type {
  DocsDocumentEditorPaneEmits,
  DocsDocumentEditorPaneProps,
} from './typing'
import { useDocumentEditorPane } from '../../composables/useDocumentEditorPane'
import DocsDocumentEditor from '../document-editor'
import DocsDocumentEditorFallback from '../document-editor-fallback'

const props = defineProps<DocsDocumentEditorPaneProps>()
const emits = defineEmits<DocsDocumentEditorPaneEmits>()
const { contentError, handleContentError, handleRetryLoad, shouldShowEditor } = useDocumentEditorPane({
  onRetryLoad: () => emits('retryLoad'),
  props,
})
</script>

<template>
  <section class="docs-document-editor-pane flex min-h-0 flex-1 flex-col">
    <DocsDocumentEditor
      v-if="shouldShowEditor && props.document"
      :document="props.document"
      :mode="props.mode"
      :editable="props.editable"
      :autofocus-title="props.autofocusTitle"
      :active-block-id="props.activeBlockId"
      @update-title="emits('updateTitle', $event)"
      @update-content="emits('updateContent', $event)"
      @content-error="handleContentError"
      @request-comment="emits('requestComment', $event)"
      @request-add-selection-context="emits('requestAddSelectionContext', $event)"
      @request-ai-block-rewrite="emits('requestAiBlockRewrite', $event)"
      @selection-change="emits('selectionChange', $event)"
      @title-autofocus-applied="emits('titleAutofocusApplied')"
    />

    <DocsDocumentEditorFallback
      v-else
      :pane-state="props.paneState"
      :is-loading="props.isLoading"
      :has-fallback-document="props.hasFallbackDocument"
      :content-error="contentError"
      @create-document="emits('createDocument')"
      @open-fallback-document="emits('openFallbackDocument')"
      @retry-load="handleRetryLoad"
    />
  </section>
</template>
