import type { DocumentTreeGroup } from '@haohaoxue/lexora-contracts'
import { computed, shallowRef, watch } from 'vue'
import { translate } from '@/i18n'
import { ElMessage, ElMessageBox } from '@/utils/element-plus'
import { collectDocumentItemIds } from '../utils/documentTree'
import { useDocsContext } from './useDocsContext'
import { useDocumentTree } from './useDocumentTree'

export function useDocsSidebarSelection() {
  const { currentWorkspaceId } = useDocsContext()
  const tree = useDocumentTree()
  const isSelectionMode = shallowRef(false)
  const selectedDocumentIds = shallowRef<Set<string>>(new Set())

  const selectedDocumentIdList = computed(() => Array.from(selectedDocumentIds.value))
  const selectedCount = computed(() => selectedDocumentIds.value.size)
  const deletePlan = computed(() => tree.resolveDeletePlan(selectedDocumentIdList.value))
  const affectedDocumentCount = computed(() => deletePlan.value?.affectedDocumentIds.size ?? 0)
  const hasSelectedDocuments = computed(() => Boolean(deletePlan.value))

  watch(currentWorkspaceId, () => {
    resetSelection()
  })

  function enterSelectionMode() {
    isSelectionMode.value = true
    selectedDocumentIds.value = new Set()
  }

  function exitSelectionMode() {
    if (tree.isBatchDeleting.value) {
      return
    }

    resetSelection()
  }

  function replaceSectionSelection(group: DocumentTreeGroup, documentIds: string[]) {
    const sectionDocumentIds = collectDocumentItemIds(group.nodes)
    const nextSelectedDocumentIds = new Set(selectedDocumentIds.value)

    for (const documentId of sectionDocumentIds) {
      nextSelectedDocumentIds.delete(documentId)
    }

    for (const documentId of documentIds) {
      nextSelectedDocumentIds.add(documentId)
    }

    selectedDocumentIds.value = nextSelectedDocumentIds
  }

  async function confirmBatchDelete() {
    if (!hasSelectedDocuments.value || !deletePlan.value) {
      ElMessage.warning(translate('docs.trash.selectToDelete'))
      return
    }

    const confirmed = await ElMessageBox.confirm(
      resolveBatchDeleteConfirmMessage({
        affectedDocumentCount: affectedDocumentCount.value,
        selectedCount: selectedCount.value,
      }),
      translate('docs.trash.batchDeleteTitle'),
      {
        type: 'warning',
        confirmButtonText: translate('docs.common.delete'),
        cancelButtonText: translate('docs.common.cancel'),
      },
    ).then(() => true).catch(() => false)

    if (!confirmed) {
      return
    }

    const result = await tree.batchDeleteDocuments(selectedDocumentIdList.value)

    if (result.deletedDocumentIds.length) {
      resetSelection()
    }
  }

  function resetSelection() {
    isSelectionMode.value = false
    selectedDocumentIds.value = new Set()
  }

  return {
    confirmBatchDelete,
    enterSelectionMode,
    exitSelectionMode,
    hasSelectedDocuments,
    isBatchDeleting: tree.isBatchDeleting,
    isSelectionMode,
    replaceSectionSelection,
    selectedCount,
  }
}

function resolveBatchDeleteConfirmMessage(input: {
  affectedDocumentCount: number
  selectedCount: number
}) {
  if (input.affectedDocumentCount > input.selectedCount) {
    return translate('docs.trash.batchDeleteDescription', {
      affectedCount: input.affectedDocumentCount,
      selectedCount: input.selectedCount,
    })
  }

  return translate('docs.trash.batchDeleteSimpleDescription', { count: input.selectedCount })
}
