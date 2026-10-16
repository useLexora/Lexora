<script setup lang="ts">
import type { DocumentSaveStatusEmits, DocumentSaveStatusProps } from './typing'
import { DOCUMENT_SAVE_STATE } from '@haohaoxue/lexora-contracts/document/constants'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<DocumentSaveStatusProps>()
const emits = defineEmits<DocumentSaveStatusEmits>()
const { t } = useI18n()

const isVisible = computed(() => props.saveState !== DOCUMENT_SAVE_STATE.IDLE)
const isError = computed(() => props.saveState === DOCUMENT_SAVE_STATE.ERROR)
const isRetryableError = computed(() => isError.value && props.canRetry)
const isConflict = computed(() => isError.value && props.failureKind === 'conflict')
const stateClass = computed(() => `is-${props.saveState}`)
const statusLabel = computed(() => {
  if (!isError.value || !props.failureKind) {
    return t(`docs.autosave.${props.saveState}`)
  }

  return t(`docs.autosave.failure.${props.failureKind}`)
})
</script>

<template>
  <ElButton
    v-if="isRetryableError"
    type="danger"
    text
    class="document-save-status is-error"
    @click="emits('retry')"
  >
    <span class="document-save-status__dot" />
    <span>{{ statusLabel }}</span>
    <span>{{ t('docs.autosave.retry') }}</span>
  </ElButton>

  <ElButton
    v-else-if="isConflict"
    type="danger"
    text
    class="document-save-status is-error"
    @click="emits('reload')"
  >
    <span class="document-save-status__dot" />
    <span>{{ statusLabel }}</span>
    <span>{{ t('docs.autosave.reload') }}</span>
  </ElButton>

  <div
    v-else-if="isVisible"
    class="document-save-status flex items-center gap-2 text-xs text-secondary"
    :class="stateClass"
    aria-live="polite"
  >
    <span class="document-save-status__dot" />
    <span>{{ statusLabel }}</span>
  </div>
</template>

<style scoped lang="scss">
.document-save-status {
  --document-save-status-color: var(--brand-text-secondary);

  &.is-dirty,
  &.is-saving {
    --document-save-status-color: var(--brand-warning);
  }

  &.is-saved {
    --document-save-status-color: var(--brand-success);
  }

  &.is-error {
    --document-save-status-color: var(--brand-error);
  }
}

.document-save-status__dot {
  width: 0.4rem;
  height: 0.4rem;
  flex: none;
  border-radius: 999px;
  background: var(--document-save-status-color);
  box-shadow: 0 0 0 0.2rem color-mix(in srgb, var(--document-save-status-color) 14%, transparent);
}
</style>
