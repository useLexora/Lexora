import { createSharedComposable } from '@vueuse/core'
import { computed, shallowRef } from 'vue'

export const useDocsPublicationDialog = createSharedComposable(() => {
  const publicationDialogDocumentId = shallowRef('')
  const isPublicationDialogOpen = computed(() => Boolean(publicationDialogDocumentId.value))

  function openDocumentPublicationDialog(documentId: string) {
    publicationDialogDocumentId.value = documentId
  }

  function handlePublicationDialogVisibleChange(visible: boolean) {
    if (visible) {
      return
    }

    publicationDialogDocumentId.value = ''
  }

  return {
    handlePublicationDialogVisibleChange,
    isPublicationDialogOpen,
    openDocumentPublicationDialog,
    publicationDialogDocumentId,
  }
})
