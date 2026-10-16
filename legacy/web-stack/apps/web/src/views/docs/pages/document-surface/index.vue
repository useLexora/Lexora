<script setup lang="ts">
import { computed } from 'vue'
import DocsDocumentEditorPane from '../../components/document-editor-pane'
import { useActiveDocument } from '../../composables/useActiveDocument'
import { useDocsChatContextBridge } from '../../composables/useDocsChatContextBridge'
import { useDocsContext } from '../../composables/useDocsContext'
import { useDocsHistoryState } from '../../composables/useDocsHistoryState'
import { useDocsPageActions } from '../../composables/useDocsPageActions'

import { useDocsSurfaceState } from '../../composables/useDocsSurfaceState'

const { activeBlockId, handleRequestComment, pendingTitleFocusDocumentId } = useDocsContext()
const {
  currentDocument,
  isDocumentItemLoading,
  markTitleAutofocusApplied,
  reloadCurrentDocument,
  updateDocumentContent,
  updateDocumentTitle,
} = useActiveDocument()
const { docsDocumentEditorMode, isDocsDocumentEditable } = useDocsHistoryState()
const { handleAddSelectionContext, handleEditorSelectionChange, handleRewriteBlockContext } = useDocsChatContextBridge()
const {
  documentPaneState,
  hasVisibleFallbackDocument: hasFallbackDocument,
  isDocumentSurface,
} = useDocsSurfaceState()
const { createRootDocument, openDefaultDocument } = useDocsPageActions()

const shouldAutofocusTitle = computed(() =>
  docsDocumentEditorMode.value === 'default'
  && isDocumentSurface.value
  && currentDocument.value?.id === pendingTitleFocusDocumentId.value,
)
</script>

<template>
  <DocsDocumentEditorPane
    :document="currentDocument"
    :mode="docsDocumentEditorMode"
    :editable="isDocsDocumentEditable"
    :autofocus-title="shouldAutofocusTitle"
    :active-block-id="activeBlockId"
    :is-loading="isDocumentItemLoading"
    :pane-state="documentPaneState"
    :has-fallback-document="hasFallbackDocument"
    @update-title="updateDocumentTitle"
    @update-content="updateDocumentContent"
    @request-comment="handleRequestComment"
    @request-add-selection-context="handleAddSelectionContext"
    @request-ai-block-rewrite="handleRewriteBlockContext"
    @selection-change="handleEditorSelectionChange"
    @title-autofocus-applied="markTitleAutofocusApplied"
    @create-document="createRootDocument()"
    @open-fallback-document="openDefaultDocument()"
    @retry-load="reloadCurrentDocument"
  />
</template>
