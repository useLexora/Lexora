<script setup lang="ts">
import type { DocsDocumentEditorEmits, DocsDocumentEditorProps } from './typing'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DocumentContentSurface } from '@/components/tiptap-editor'
import dayjs, { formatDateTime } from '@/utils/dayjs'
import { useDocsAiCandidate } from '../../composables/useDocsAiCandidate'
import { useDocumentEditor } from '../../composables/useDocumentEditor'

const props = defineProps<DocsDocumentEditorProps>()
const emits = defineEmits<DocsDocumentEditorEmits>()
const { t } = useI18n()
const { isHistoryMode, isEditable } = useDocumentEditor(props)
const docsAiCandidate = useDocsAiCandidate()
const activeDocumentAiCandidate = computed(() =>
  docsAiCandidate.activeCandidate.value?.documentId === props.document.id
    ? docsAiCandidate.activeCandidate.value
    : null,
)
const footerMetaItems = computed(() => [
  {
    label: t('docs.documentMeta.createdAt'),
    value: formatDateTime(props.document.createdAt),
  },
  {
    label: t('docs.documentMeta.updatedAt'),
    value: dayjs(props.document.updatedAt).fromNow(),
  },
])
</script>

<template>
  <section class="docs-document-editor flex min-h-0 flex-1 flex-col" :class="{ 'is-history-mode': isHistoryMode }">
    <DocumentContentSurface
      class="docs-document-editor__surface"
      :document-id="props.document.id"
      :title="props.document.title"
      :body="props.document.body"
      :page-width-mode="props.document.pageWidthMode"
      :editable="isEditable"
      :autofocus-title="props.autofocusTitle"
      :footer-meta-items="footerMetaItems"
      :active-block-id="props.activeBlockId"
      :body-ai-draft-preview="activeDocumentAiCandidate"
      :body-ai-block-rewrite-enabled="true"
      :show-outline="isEditable"
      @update-title="emits('updateTitle', $event)"
      @update-content="emits('updateContent', $event)"
      @content-error="emits('contentError', $event)"
      @request-comment="emits('requestComment', $event)"
      @request-add-selection-context="emits('requestAddSelectionContext', $event)"
      @request-body-ai-block-rewrite="emits('requestAiBlockRewrite', $event)"
      @selection-change="emits('selectionChange', $event)"
      @accept-body-ai-draft-preview="docsAiCandidate.acceptCandidate"
      @reject-body-ai-draft-preview="docsAiCandidate.rejectCandidate"
      @title-autofocus-applied="emits('titleAutofocusApplied')"
    />
  </section>
</template>

<style scoped lang="scss">
.docs-document-editor {
  &.is-history-mode {
    :deep(.document-content-surface) {
      background:
        linear-gradient(
          180deg,
          color-mix(in srgb, var(--brand-primary) 3%, white 97%) 0%,
          var(--brand-bg-surface) 24%
        );
    }

    :deep(.document-content-surface__title) {
      padding-bottom: 0.875rem;
      border-bottom-color: color-mix(in srgb, var(--brand-border-base) 62%, transparent);
    }

    :deep(.document-content-surface__body) {
      padding-top: 0.875rem;
      background:
        linear-gradient(
          180deg,
          transparent 0%,
          transparent calc(100% - 5rem),
          color-mix(in srgb, var(--brand-bg-surface) 95%, var(--brand-fill-lighter)) 100%
        );
    }
  }
}
</style>
