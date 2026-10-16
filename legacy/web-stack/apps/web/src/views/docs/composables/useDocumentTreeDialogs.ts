import type {
  DocumentCurrent,
  DocumentItem,
  DocumentTreeGroup,
} from '@haohaoxue/lexora-contracts'
import type { ComputedRef, ShallowRef } from 'vue'
import type { DocumentDeleteAction } from '../typing'
import type { DocumentDeletePlan } from '../utils/documentTree'
import type { NavigateToDocumentOptions } from './useDocsContext'
import { createDocumentTitleContent, getDocumentTitlePlainText } from '@haohaoxue/lexora-shared/document'
import { computed, shallowRef } from 'vue'
import {
  deleteDocument as deleteDocumentRequest,
  getDocumentCurrent as getDocumentCurrentRequest,
  permanentlyDeleteDocument as permanentlyDeleteDocumentRequest,
  saveDocumentContent as saveDocumentContentRequest,
} from '@/apis/document'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'
import {
  collectDocumentItemIds,
  findDocumentPath,
  isOwnedDocumentCollection,
} from '../utils/documentTree'

interface UseDocumentTreeDialogsOptions {
  activeDocumentId: ComputedRef<string | null>
  confirmNavigation: () => Promise<boolean>
  loadTree: () => Promise<void>
  navigateToDocument: (documentId: string | null, options?: NavigateToDocumentOptions) => Promise<boolean>
  patchDocumentItem: (documentId: string, input: Partial<DocumentItem>) => void
  resolveDeletePlan: (documentIds: string[]) => DocumentDeletePlan | null
  treeGroups: ShallowRef<DocumentTreeGroup[]>
}

interface PendingDeleteDocumentTarget {
  documentId: string
  documentTitle: string
  affectedDocumentIds: Set<string>
  nextDocumentId: string | null
}

interface PendingMoveDocumentTarget {
  documentId: string
  documentTitle: string
  movingDocumentIds: Set<string>
}

interface PendingRenameDocumentTarget {
  documentId: string
  documentTitle: string
}

export function useDocumentTreeDialogs(options: UseDocumentTreeDialogsOptions) {
  const deleteDialogTarget = shallowRef<PendingDeleteDocumentTarget | null>(null)
  const deleteActionKind = shallowRef<DocumentDeleteAction | null>(null)
  const moveDialogTarget = shallowRef<PendingMoveDocumentTarget | null>(null)
  const renameDialogTarget = shallowRef<PendingRenameDocumentTarget | null>(null)
  const isRenaming = shallowRef(false)

  const isDeleting = computed(() => deleteActionKind.value !== null)
  const isDeleteDialogOpen = computed(() => Boolean(deleteDialogTarget.value))
  const deleteDialogDocumentTitle = computed(() => deleteDialogTarget.value?.documentTitle ?? '')
  const isMoveDialogOpen = computed(() => Boolean(moveDialogTarget.value))
  const isRenameDialogOpen = computed(() => Boolean(renameDialogTarget.value))

  async function openDeleteDialog(documentId: string) {
    if (deleteActionKind.value) {
      return
    }

    const target = resolveDeleteTarget(documentId)

    if (!target) {
      return
    }

    deleteDialogTarget.value = target
  }

  function closeDeleteDialog() {
    if (deleteActionKind.value) {
      return
    }

    deleteDialogTarget.value = null
  }

  async function confirmDeleteDocument() {
    await executeDeleteDocument('trash')
  }

  async function confirmPermanentlyDeleteDocument() {
    await executeDeleteDocument('permanent')
  }

  function openMoveDialog(documentId: string) {
    const targetPath = findDocumentPath(options.treeGroups.value, documentId)
    const targetDocument = targetPath?.nodes.at(-1)

    if (!targetPath || !targetDocument || !isOwnedDocumentCollection(targetPath.collectionId)) {
      return
    }

    moveDialogTarget.value = {
      documentId,
      documentTitle: targetDocument.title,
      movingDocumentIds: collectDocumentItemIds([targetDocument]),
    }
  }

  function closeMoveDialog() {
    moveDialogTarget.value = null
  }

  function openRenameDialog(documentId: string) {
    const targetPath = findDocumentPath(options.treeGroups.value, documentId)
    const targetDocument = targetPath?.nodes.at(-1)

    if (!targetPath || !targetDocument || !isOwnedDocumentCollection(targetPath.collectionId)) {
      return
    }

    renameDialogTarget.value = {
      documentId,
      documentTitle: targetDocument.title,
    }
  }

  function closeRenameDialog() {
    if (isRenaming.value) {
      return
    }

    renameDialogTarget.value = null
  }

  async function confirmRenameDocument(title: string): Promise<DocumentCurrent | null> {
    const target = renameDialogTarget.value
    const normalizedTitle = title.trim()

    if (!target || isRenaming.value || !normalizedTitle) {
      return null
    }

    if (normalizedTitle === target.documentTitle) {
      renameDialogTarget.value = null
      return null
    }

    if (target.documentId === options.activeDocumentId.value) {
      return null
    }

    isRenaming.value = true

    try {
      const currentDocument = await getDocumentCurrentRequest(target.documentId)
      const current = await saveDocumentContentRequest(target.documentId, {
        baseProjectionRevision: currentDocument.currentProjection.projectionRevision,
        idempotencyKey: crypto.randomUUID(),
        schemaVersion: currentDocument.currentProjection.schemaVersion,
        title: createDocumentTitleContent(normalizedTitle),
        body: currentDocument.currentProjection.body,
      })

      options.patchDocumentItem(target.documentId, {
        hasContent: current.document.summary.length > 0,
        summary: current.document.summary,
        title: getDocumentTitlePlainText(current.currentProjection.title),
        updatedAt: current.document.updatedAt,
      })
      renameDialogTarget.value = null
      return current
    }
    finally {
      isRenaming.value = false
    }
  }

  async function executeDeleteDocument(action: DocumentDeleteAction) {
    const target = deleteDialogTarget.value

    if (!target || deleteActionKind.value) {
      return
    }

    deleteActionKind.value = action

    try {
      if (
        options.activeDocumentId.value
        && target.affectedDocumentIds.has(options.activeDocumentId.value)
        && !await options.confirmNavigation()
      ) {
        return
      }

      await (action === 'trash'
        ? deleteDocumentRequest(target.documentId)
        : permanentlyDeleteDocumentRequest(target.documentId))
      deleteDialogTarget.value = null
      await options.loadTree()

      if (options.activeDocumentId.value && target.affectedDocumentIds.has(options.activeDocumentId.value)) {
        await options.navigateToDocument(target.nextDocumentId, {
          skipConfirm: true,
        })
      }

      ElMessage.success(action === 'trash'
        ? translate('docs.documentTree.deleted')
        : translate('docs.documentTree.deletedPermanently'))
    }
    catch (error) {
      ElMessage.error(error instanceof Error
        ? error.message
        : action === 'trash'
          ? translate('docs.documentTree.deleteFailed')
          : translate('docs.documentTree.deletePermanentlyFailed'))
    }
    finally {
      deleteActionKind.value = null
    }
  }

  function resolveDeleteTarget(documentId: string): PendingDeleteDocumentTarget | null {
    const targetPath = findDocumentPath(options.treeGroups.value, documentId)
    const targetDocument = targetPath?.nodes.at(-1)
    const deletePlan = options.resolveDeletePlan([documentId])

    if (!targetPath || !targetDocument || !deletePlan) {
      return null
    }

    return {
      documentId,
      documentTitle: targetDocument.title,
      affectedDocumentIds: deletePlan.affectedDocumentIds,
      nextDocumentId: deletePlan.nextDocumentId,
    }
  }

  return {
    closeDeleteDialog,
    closeMoveDialog,
    closeRenameDialog,
    confirmDeleteDocument,
    confirmPermanentlyDeleteDocument,
    confirmRenameDocument,
    deleteActionKind,
    deleteDialogDocumentTitle,
    isDeleteDialogOpen,
    isDeleting,
    isMoveDialogOpen,
    isRenameDialogOpen,
    isRenaming,
    moveDialogTarget,
    openDeleteDialog,
    openMoveDialog,
    openRenameDialog,
    renameDialogTarget,
  }
}
