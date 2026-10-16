<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDocumentTree } from '../../composables/useDocumentTree'

const { t } = useI18n()
const {
  closeDeleteDialog,
  confirmDeleteDocument,
  confirmPermanentlyDeleteDocument,
  deleteActionKind,
  deleteDialogDocumentTitle,
  isDeleteDialogOpen,
} = useDocumentTree()

const isSubmitting = computed(() => deleteActionKind.value !== null)
const isDeletingToTrash = computed(() => deleteActionKind.value === 'trash')
const isPermanentlyDeleting = computed(() => deleteActionKind.value === 'permanent')
const dialogTitle = computed(() => t('docs.deleteDialog.title', {
  title: deleteDialogDocumentTitle.value || t('docs.deleteDialog.fallbackTitle'),
}))

function handleDialogVisibleChange(value: boolean) {
  if (value || isSubmitting.value) {
    return
  }

  closeDeleteDialog()
}

function handleDelete() {
  if (isSubmitting.value) {
    return
  }

  void confirmDeleteDocument()
}

function handlePermanentlyDelete() {
  if (isSubmitting.value) {
    return
  }

  void confirmPermanentlyDeleteDocument()
}
</script>

<template>
  <ElDialog
    class="document-delete-dialog"
    :model-value="isDeleteDialogOpen"
    :title="dialogTitle"
    width="30rem"
    align-center
    destroy-on-close
    :close-on-click-modal="false"
    :close-on-press-escape="!isSubmitting"
    :show-close="!isSubmitting"
    @update:model-value="handleDialogVisibleChange"
  >
    <div class="grid gap-2">
      <p class="m-0 text-sm leading-[1.6] text-main">
        {{ t('docs.deleteDialog.description') }}
      </p>
    </div>

    <template #footer>
      <div class="flex items-center justify-between gap-3">
        <ElButton
          type="danger"
          :loading="isPermanentlyDeleting"
          :disabled="isSubmitting"
          @click="handlePermanentlyDelete"
        >
          {{ t('docs.common.permanentDelete') }}
        </ElButton>

        <div class="inline-flex items-center justify-end gap-3">
          <ElButton :disabled="isSubmitting" @click="closeDeleteDialog">
            {{ t('docs.common.cancel') }}
          </ElButton>
          <ElButton
            type="primary"
            :loading="isDeletingToTrash"
            :disabled="isSubmitting"
            @click="handleDelete"
          >
            {{ t('docs.common.delete') }}
          </ElButton>
        </div>
      </div>
    </template>
  </ElDialog>
</template>
