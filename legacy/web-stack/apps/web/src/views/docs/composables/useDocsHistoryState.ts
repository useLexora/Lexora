import type { DocumentVersionSnapshot } from '@haohaoxue/lexora-contracts'
import { isSameDocumentVersionSnapshotContent } from '@haohaoxue/lexora-shared/document'
import { createSharedComposable } from '@vueuse/core'
import { computed, shallowRef, watch } from 'vue'
import {
  buildHistoryPreviewDocument,
  resolveDefaultHistorySnapshotId,
} from '../utils/documentEditor'
import { useActiveDocument } from './useActiveDocument'
import { useDocsContext } from './useDocsContext'

export const useDocsHistoryState = createSharedComposable(() => {
  const { activeDocumentId, pendingHistoryDocumentId, navigateToDocument } = useDocsContext()
  const activeDocument = useActiveDocument()

  const isHistoryMode = shallowRef(false)
  const selectedHistorySnapshotId = shallowRef<string | null>(null)

  const selectedHistorySnapshot = computed(() =>
    resolveSnapshotById(activeDocument.snapshots.value, selectedHistorySnapshotId.value),
  )
  const previewDocument = computed(() => buildHistoryPreviewDocument({
    document: activeDocument.currentDocument.value,
    snapshot: isHistoryMode.value ? selectedHistorySnapshot.value : null,
  }))
  const docsDocumentEditorMode = computed(() => isHistoryMode.value ? 'history' : 'default')
  const isDocsDocumentEditable = computed(() =>
    docsDocumentEditorMode.value === 'default'
    && !activeDocument.isRestoringSnapshot.value
    && Boolean(activeDocument.currentDocument.value?.access.capabilities.canEdit),
  )
  const isSelectedSnapshotCurrentContent = computed(() => {
    if (!selectedHistorySnapshot.value) {
      return false
    }

    if (!activeDocument.currentDocument.value) {
      return false
    }

    return isSameDocumentVersionSnapshotContent({
      schemaVersion: activeDocument.currentDocument.value.schemaVersion,
      title: activeDocument.currentDocument.value.title,
      body: activeDocument.currentDocument.value.body,
    }, selectedHistorySnapshot.value)
  })
  const canRestoreSelectedSnapshot = computed(() =>
    Boolean(selectedHistorySnapshot.value)
    && !isSelectedSnapshotCurrentContent.value
    && !activeDocument.isRestoringSnapshot.value,
  )

  watch(
    [() => activeDocument.currentDocument.value, () => activeDocument.snapshots.value],
    ([nextDocument, nextSnapshots]) => {
      selectedHistorySnapshotId.value = resolveDefaultHistorySnapshotId({
        document: nextDocument,
        snapshots: nextSnapshots,
        currentSelectedSnapshotId: selectedHistorySnapshotId.value,
      })
    },
    { immediate: true },
  )

  watch(
    activeDocumentId,
    (nextDocumentId, previousDocumentId) => {
      if (nextDocumentId === previousDocumentId) {
        return
      }

      isHistoryMode.value = false
    },
  )

  watch(
    [
      pendingHistoryDocumentId,
      activeDocumentId,
      () => activeDocument.currentDocument.value?.id ?? null,
      activeDocument.isDocumentItemLoading,
    ],
    () => {
      void openPendingDocumentHistory()
    },
  )

  async function openHistoryMode() {
    if (!activeDocument.currentDocument.value) {
      return
    }

    isHistoryMode.value = true
    await activeDocument.ensureSnapshotsLoaded()
    selectedHistorySnapshotId.value = resolveDefaultHistorySnapshotId({
      document: activeDocument.currentDocument.value,
      snapshots: activeDocument.snapshots.value,
      currentSelectedSnapshotId: selectedHistorySnapshotId.value,
    })
  }

  function closeHistoryMode() {
    if (activeDocument.isRestoringSnapshot.value) {
      return
    }

    isHistoryMode.value = false
  }

  function selectHistorySnapshot(snapshotId: string) {
    selectedHistorySnapshotId.value = snapshotId
  }

  function selectCurrentHistoryContent() {
    selectedHistorySnapshotId.value = null
  }

  async function restoreSelectedSnapshot() {
    if (!selectedHistorySnapshotId.value || !canRestoreSelectedSnapshot.value) {
      return
    }

    await activeDocument.restoreSnapshot(selectedHistorySnapshotId.value)
    selectedHistorySnapshotId.value = resolveDefaultHistorySnapshotId({
      document: activeDocument.currentDocument.value,
      snapshots: activeDocument.snapshots.value,
      currentSelectedSnapshotId: activeDocument.currentDocument.value?.latestVersionSnapshotId ?? null,
    })
  }

  async function openDocumentHistory(documentId: string) {
    if (
      activeDocument.currentDocument.value?.id === documentId
      && !activeDocument.isDocumentItemLoading.value
    ) {
      await openHistoryMode()
      return
    }

    const isCurrentRouteDocument = activeDocumentId.value === documentId
    const didNavigate = isCurrentRouteDocument || await navigateToDocument(documentId)

    if (!didNavigate) {
      pendingHistoryDocumentId.value = null
      return
    }

    pendingHistoryDocumentId.value = documentId
    await openPendingDocumentHistory()
  }

  async function openPendingDocumentHistory() {
    const pendingDocumentId = pendingHistoryDocumentId.value

    if (!pendingDocumentId) {
      return
    }

    if (
      activeDocumentId.value
      && activeDocumentId.value !== pendingDocumentId
      && !activeDocument.isDocumentItemLoading.value
    ) {
      pendingHistoryDocumentId.value = null
      return
    }

    if (
      activeDocument.isDocumentItemLoading.value
      || activeDocument.currentDocument.value?.id !== pendingDocumentId
    ) {
      return
    }

    pendingHistoryDocumentId.value = null
    await openHistoryMode()
  }

  return {
    canRestoreSelectedSnapshot,
    closeHistoryMode,
    docsDocumentEditorMode,
    isDocsDocumentEditable,
    isHistoryMode,
    openDocumentHistory,
    openHistoryMode,
    previewDocument,
    restoreSelectedSnapshot,
    selectedHistorySnapshotId,
    selectCurrentHistoryContent,
    selectHistorySnapshot,
  }
})

function resolveSnapshotById(snapshots: DocumentVersionSnapshot[], snapshotId: string | null) {
  if (!snapshotId) {
    return null
  }

  return snapshots.find(snapshot => snapshot.id === snapshotId) ?? null
}
