import type { OwnedDocumentCollectionId } from '@haohaoxue/lexora-contracts'
import { DOCUMENT_COLLECTION, DOCUMENT_DEFAULT_TITLE } from '@haohaoxue/lexora-contracts/document/constants'
import { resolveRootDocumentVisibility } from '@haohaoxue/lexora-shared/document'
import { createSharedComposable } from '@vueuse/core'
import { computed, shallowRef } from 'vue'
import {
  batchDeleteDocuments as batchDeleteDocumentsRequest,
  createDocument as createDocumentRequest,
} from '@/apis/document'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'
import {
  findDocumentPath,
  isOwnedDocumentCollection,
} from '../utils/documentTree'
import { useDocsContext } from './useDocsContext'
import { useDocumentTreeData } from './useDocumentTreeData'
import { useDocumentTreeDialogs } from './useDocumentTreeDialogs'

interface BatchDeleteDocumentsResult {
  deletedDocumentIds: string[]
  nextDocumentId: string | null
}

export const useDocumentTree = createSharedComposable(() => {
  const {
    activeDocumentId,
    confirmNavigation,
    currentWorkspaceId,
    currentWorkspaceType,
    navigateToDocument,
  } = useDocsContext()
  const treeData = useDocumentTreeData({
    activeDocumentId,
    currentWorkspaceId,
  })
  const isCreating = shallowRef(false)
  const isBatchDeleting = shallowRef(false)
  const dialogs = useDocumentTreeDialogs({
    activeDocumentId,
    confirmNavigation,
    loadTree: treeData.loadTree,
    navigateToDocument,
    patchDocumentItem: treeData.patchDocumentItem,
    resolveDeletePlan: treeData.resolveDeletePlan,
    treeGroups: treeData.treeGroups,
  })
  const isMutatingTree = computed(() =>
    isCreating.value || dialogs.isDeleting.value || dialogs.isRenaming.value || isBatchDeleting.value,
  )

  async function createRootDocumentIn(collectionId: OwnedDocumentCollectionId = DOCUMENT_COLLECTION.PERSONAL) {
    await createDocument(null, collectionId)
  }

  async function createChildDocument(parentDocumentId = activeDocumentId.value) {
    if (!parentDocumentId) {
      return
    }

    const parentPath = findDocumentPath(treeData.treeGroups.value, parentDocumentId)

    if (!parentPath || !isOwnedDocumentCollection(parentPath.collectionId)) {
      return
    }

    await createDocument(parentDocumentId)
  }

  async function deleteDocument(documentId: string) {
    await dialogs.openDeleteDialog(documentId)
  }

  async function batchDeleteDocuments(documentIds: string[]): Promise<BatchDeleteDocumentsResult> {
    if (isBatchDeleting.value || dialogs.deleteActionKind.value) {
      return {
        deletedDocumentIds: [],
        nextDocumentId: activeDocumentId.value,
      }
    }

    const target = treeData.resolveDeletePlan(documentIds)
    const workspaceId = currentWorkspaceId.value

    if (!target || !workspaceId) {
      return {
        deletedDocumentIds: [],
        nextDocumentId: activeDocumentId.value,
      }
    }

    isBatchDeleting.value = true

    try {
      if (
        activeDocumentId.value
        && target.affectedDocumentIds.has(activeDocumentId.value)
        && !await confirmNavigation()
      ) {
        return {
          deletedDocumentIds: [],
          nextDocumentId: activeDocumentId.value,
        }
      }

      const response = await batchDeleteDocumentsRequest({
        workspaceId,
        documentIds: target.rootDocumentIds,
      })
      const deletedDocumentIdSet = new Set(response.deletedDocumentIds)
      await treeData.loadTree()

      if (activeDocumentId.value && deletedDocumentIdSet.has(activeDocumentId.value)) {
        await navigateToDocument(target.nextDocumentId, {
          skipConfirm: true,
        })
      }

      ElMessage.success(translate('docs.documentTree.batchDeleted', { count: response.deletedDocumentIds.length }))

      return {
        deletedDocumentIds: response.deletedDocumentIds,
        nextDocumentId: target.nextDocumentId,
      }
    }
    catch (error) {
      ElMessage.error(error instanceof Error ? error.message : translate('docs.documentTree.batchDeleteFailed'))
      return {
        deletedDocumentIds: [],
        nextDocumentId: activeDocumentId.value,
      }
    }
    finally {
      isBatchDeleting.value = false
    }
  }

  async function createDocument(parentId: string | null, collectionId: OwnedDocumentCollectionId = DOCUMENT_COLLECTION.PERSONAL) {
    const workspaceId = currentWorkspaceId.value

    if (!workspaceId) {
      return
    }

    const canNavigate = await confirmNavigation()

    if (!canNavigate) {
      return
    }

    isCreating.value = true

    try {
      const createdDocument = await createDocumentRequest({
        title: DOCUMENT_DEFAULT_TITLE,
        workspaceId,
        parentId,
        ...(parentId
          ? {}
          : {
              visibility: resolveRootDocumentVisibility({
                workspaceType: currentWorkspaceType.value,
                collectionId,
              }),
            }),
      })
      await treeData.loadTree({ silent: true })
      await navigateToDocument(createdDocument.id, {
        focusTitle: true,
        skipConfirm: true,
      })
    }
    finally {
      isCreating.value = false
    }
  }

  return {
    ...treeData,
    ...dialogs,
    batchDeleteDocuments,
    createChildDocument,
    createRootDocument: createRootDocumentIn,
    deleteDocument,
    isCreating,
    isBatchDeleting,
    isMutatingTree,
  }
})
