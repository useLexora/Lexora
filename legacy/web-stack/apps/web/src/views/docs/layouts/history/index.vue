<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import DocsDocumentEditorPane from '../../components/document-editor-pane'
import { useActiveDocument } from '../../composables/useActiveDocument'
import { useDocsContext } from '../../composables/useDocsContext'
import { useDocsHistoryState } from '../../composables/useDocsHistoryState'
import { useDocsPageActions } from '../../composables/useDocsPageActions'
import { useDocsSurfaceState } from '../../composables/useDocsSurfaceState'
import DocsHistoryPanel from '../history-panel'

const { activeBlockId, handleRequestComment } = useDocsContext()
const { t } = useI18n()
const {
  isDocumentItemLoading,
  isRestoringSnapshot,
  isSnapshotsLoading,
  reloadCurrentDocument,
  updateDocumentContent,
  updateDocumentTitle,
} = useActiveDocument()
const {
  canRestoreSelectedSnapshot,
  closeHistoryMode,
  docsDocumentEditorMode,
  isDocsDocumentEditable,
  previewDocument,
  restoreSelectedSnapshot,
} = useDocsHistoryState()
const { documentPaneState, hasVisibleFallbackDocument: hasFallbackDocument } = useDocsSurfaceState()
const { createRootDocument, openDefaultDocument } = useDocsPageActions()
</script>

<template>
  <section class="docs-history-view flex h-full min-h-0 flex-col bg-surface">
    <header class="docs-history-view__header grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-6 py-3.5 max-[1180px]:grid-cols-1 max-[1180px]:justify-items-center">
      <ElButton
        text
        class="docs-history-view__back justify-self-start text-secondary max-[1180px]:justify-self-stretch"
        :disabled="isRestoringSnapshot"
        @click="closeHistoryMode"
      >
        <span class="inline-flex items-center gap-1.5 text-[13px] font-medium">
          <SvgIcon category="ui" icon="arrow-left" size="14px" />
          <span>{{ t('docs.history.back') }}</span>
        </span>
      </ElButton>

      <ElButton
        type="primary"
        class="min-w-32"
        :disabled="!canRestoreSelectedSnapshot"
        :loading="isRestoringSnapshot"
        @click="restoreSelectedSnapshot"
      >
        {{ t('docs.history.restore') }}
      </ElButton>

      <div class="min-w-0 max-[1180px]:hidden" />
    </header>

    <div class="flex min-h-0 flex-1 max-[1180px]:flex-col">
      <DocsDocumentEditorPane
        :document="previewDocument"
        :mode="docsDocumentEditorMode"
        :editable="isDocsDocumentEditable"
        :active-block-id="activeBlockId"
        :is-loading="isDocumentItemLoading"
        :pane-state="documentPaneState"
        :has-fallback-document="hasFallbackDocument"
        @update-title="updateDocumentTitle"
        @update-content="updateDocumentContent"
        @request-comment="handleRequestComment"
        @create-document="createRootDocument()"
        @open-fallback-document="openDefaultDocument()"
        @retry-load="reloadCurrentDocument"
      />

      <DocsHistoryPanel :is-loading="isSnapshotsLoading" />
    </div>
  </section>
</template>

<style scoped lang="scss">
.docs-history-view {
  .docs-history-view__header {
    border-bottom: 1px solid color-mix(in srgb, var(--brand-border-base) 78%, transparent);
    background: color-mix(in srgb, var(--brand-bg-surface) 92%, white 8%);
  }

  .docs-history-view__back {
    &:hover {
      color: var(--brand-text-primary);
    }
  }
}
</style>
