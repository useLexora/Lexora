import type { DocumentTrashItem } from '@haohaoxue/lexora-contracts'
import { computed, shallowRef, watch } from 'vue'
import {
  getTrashDocuments,
  permanentlyDeleteDocument,
  restoreDocumentFromTrash,
} from '@/apis/document'
import { translate } from '@/i18n'
import { useWorkspaceStore } from '@/stores/workspace'
import { ElMessage, ElMessageBox } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

export function useDocsTrashPage() {
  const workspaceStore = useWorkspaceStore()
  const items = shallowRef<DocumentTrashItem[]>([])
  const isLoading = shallowRef(false)
  const errorMessage = shallowRef('')
  const actionItemId = shallowRef('')
  const currentWorkspaceId = computed(() => workspaceStore.currentWorkspace?.id ?? '')
  let loadRequestId = 0

  watch(currentWorkspaceId, async () => {
    await loadItems()
  }, {
    immediate: true,
  })

  return {
    items,
    isLoading,
    errorMessage,
    actionItemId,
    loadItems,
    restoreItem,
    permanentlyDeleteItem,
  }

  async function loadItems() {
    const workspaceId = currentWorkspaceId.value
    const requestId = ++loadRequestId

    if (!workspaceId) {
      items.value = []
      errorMessage.value = ''
      isLoading.value = false
      return
    }

    isLoading.value = true
    errorMessage.value = ''

    try {
      const nextItems = await getTrashDocuments(workspaceId)

      if (requestId !== loadRequestId) {
        return
      }

      items.value = nextItems
    }
    catch (error) {
      if (requestId !== loadRequestId) {
        return
      }

      items.value = []
      errorMessage.value = getRequestErrorDisplayMessage(error, translate('docs.trash.loadFailed'))
    }
    finally {
      if (requestId === loadRequestId) {
        isLoading.value = false
      }
    }
  }

  async function restoreItem(documentId: string) {
    if (actionItemId.value) {
      return
    }

    actionItemId.value = documentId

    try {
      await restoreDocumentFromTrash(documentId)
      items.value = items.value.filter(item => item.id !== documentId)
      ElMessage.success(translate('docs.trash.restored'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('docs.trash.restoreFailed')))
    }
    finally {
      if (actionItemId.value === documentId) {
        actionItemId.value = ''
      }
    }
  }

  async function permanentlyDeleteItem(documentId: string) {
    if (actionItemId.value) {
      return
    }

    const targetItem = items.value.find(item => item.id === documentId)
    const confirmed = await ElMessageBox.confirm(
      translate('docs.trash.deleteMessage', { title: targetItem?.title ?? translate('docs.deleteDialog.fallbackTitle') }),
      translate('docs.trash.deleteTitle'),
      {
        type: 'warning',
        confirmButtonText: translate('docs.trash.deletePermanently'),
        cancelButtonText: translate('docs.common.cancel'),
      },
    ).then(() => true).catch(() => false)

    if (!confirmed) {
      return
    }

    actionItemId.value = documentId

    try {
      await permanentlyDeleteDocument(documentId)
      items.value = items.value.filter(item => item.id !== documentId)
      ElMessage.success(translate('docs.trash.deleteSuccess'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('docs.trash.deleteFailed')))
    }
    finally {
      if (actionItemId.value === documentId) {
        actionItemId.value = ''
      }
    }
  }
}
