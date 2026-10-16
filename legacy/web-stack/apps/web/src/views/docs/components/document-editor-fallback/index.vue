<script setup lang="ts">
import type {
  DocsDocumentEditorFallbackEmits,
  DocsDocumentEditorFallbackProps,
} from './typing'
import Empty from '@/components/empty'
import Loading from '@/components/loading'
import { useDocumentEditorFallback } from '../../composables/useDocumentEditorFallback'

const props = defineProps<DocsDocumentEditorFallbackProps>()
const emits = defineEmits<DocsDocumentEditorFallbackEmits>()
const { emitAction, fallbackState } = useDocumentEditorFallback({
  onCreateDocument: () => emits('createDocument'),
  onOpenFallbackDocument: () => emits('openFallbackDocument'),
  onRetryLoad: () => emits('retryLoad'),
  props,
})
</script>

<template>
  <div class="docs-document-editor-fallback flex min-h-0 flex-1 items-center justify-center">
    <Loading
      v-if="fallbackState.spin"
      :title="fallbackState.title"
      :description="fallbackState.description"
      :icon="fallbackState.icon"
      :icon-category="fallbackState.iconCategory"
      compact
    />

    <Empty
      v-else
      :title="fallbackState.title"
      :description="fallbackState.description"
      :icon="fallbackState.icon"
      :icon-category="fallbackState.iconCategory"
      :icon-class="{ 'animate-spin': fallbackState.spin }"
      compact
    >
      <div
        v-if="fallbackState.actions.length"
        class="mt-4 flex flex-wrap justify-center gap-3"
      >
        <ElButton
          v-for="action in fallbackState.actions"
          :key="action.event"
          :type="action.type"
          @click="emitAction(action.event)"
        >
          {{ action.label }}
        </ElButton>
      </div>
    </Empty>
  </div>
</template>
