import type {
  DocumentOperationJob,
  DocumentTreeCollectionId,
  MoveDocumentTreeOperationRequest,
} from '@haohaoxue/lexora-contracts/document'
import {
  DOCUMENT_COLLECTION,
  DOCUMENT_OPERATION_JOB_STATUS,
  DOCUMENT_PANE_STATE,
} from '@haohaoxue/lexora-contracts/document/constants'
import { sleep } from '@haohaoxue/lexora-shared/time'
import { createSharedComposable } from '@vueuse/core'
import { shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  createDocumentDuplicateOperation,
  createDocumentMoveOperation,
  getDocumentOperationJob,
} from '@/apis/document'
import { translate } from '@/i18n'
import { useUiStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { ElMessage, ElNotification } from '@/utils/element-plus'
import { useActiveDocument } from './useActiveDocument'
import { useDocsContext } from './useDocsContext'
import { useDocsSurfaceState } from './useDocsSurfaceState'
import { useDocumentTree } from './useDocumentTree'

const DOCUMENT_OPERATION_POLL_INTERVAL_MS = 1000
const DOCUMENT_OPERATION_WAIT_TIMEOUT_MS = 5 * 60 * 1000
const DOCUMENT_OPERATION_LONG_RUNNING_DOCUMENTS_THRESHOLD = 8
const DOCUMENT_OPERATION_LONG_RUNNING_ASSETS_THRESHOLD = 3

export const useDocsPageActions = createSharedComposable(() => {
  const router = useRouter()
  const uiStore = useUiStore()
  const workspaceStore = useWorkspaceStore()
  const {
    activeDocumentId,
    currentWorkspaceId,
    isSelectingInitialDocument,
    navigateToDocument,
  } = useDocsContext()
  const tree = useDocumentTree()
  const activeDocument = useActiveDocument()
  const surfaceState = useDocsSurfaceState()
  const isDocumentOperationRunning = shallowRef(false)

  let lastInaccessibleRedirectDocumentId: string | null = null

  watch(
    currentWorkspaceId,
    async (nextWorkspaceId, previousWorkspaceId) => {
      if (nextWorkspaceId === previousWorkspaceId) {
        return
      }

      await tree.loadTree()

      if (
        !surfaceState.isDocumentSurface.value
        || !nextWorkspaceId
        || activeDocumentId.value === surfaceState.visibleDefaultDocumentId.value
      ) {
        return
      }

      await navigateToDocument(surfaceState.visibleDefaultDocumentId.value, {
        replace: true,
        skipConfirm: true,
      })
    },
  )

  watch(
    [currentWorkspaceId, tree.activeCollectionId],
    async ([, nextActiveCollectionId], previousState) => {
      const [, previousActiveCollectionId] = previousState ?? []
      const isInitialRun = previousState === undefined
      const hasResolvedHiddenDocument
        = !isInitialRun && Boolean(nextActiveCollectionId) && nextActiveCollectionId !== previousActiveCollectionId

      if (!isInitialRun && !hasResolvedHiddenDocument) {
        return
      }

      if (!surfaceState.isDocumentSurface.value) {
        return
      }

      if (
        !activeDocumentId.value
        || !nextActiveCollectionId
        || surfaceState.visibleActiveCollectionId.value
      ) {
        return
      }

      await navigateToDocument(surfaceState.visibleDefaultDocumentId.value, {
        replace: true,
        skipConfirm: true,
      })
    },
    { immediate: true },
  )

  watch(
    [
      activeDocumentId,
      currentWorkspaceId,
      surfaceState.documentPaneState,
      surfaceState.visibleDefaultDocumentId,
      surfaceState.isDocumentSurface,
      activeDocument.isDocumentItemLoading,
    ],
    async ([nextDocumentId, nextWorkspaceId, nextPaneState, nextDefaultDocumentId, isDocumentSurface, isDocumentItemLoading]) => {
      if (!isDocumentSurface || !nextWorkspaceId || !nextDocumentId || isDocumentItemLoading) {
        return
      }

      if (
        nextPaneState !== DOCUMENT_PANE_STATE.NOT_FOUND
        && nextPaneState !== DOCUMENT_PANE_STATE.FORBIDDEN
      ) {
        return
      }

      if (lastInaccessibleRedirectDocumentId === nextDocumentId) {
        return
      }

      lastInaccessibleRedirectDocumentId = nextDocumentId
      const targetDocumentId = nextDefaultDocumentId === nextDocumentId
        ? null
        : nextDefaultDocumentId

      ElMessage.warning(resolveInaccessibleDocumentRedirectMessage({
        paneState: nextPaneState,
        hasFallbackDocument: Boolean(targetDocumentId),
      }))

      await navigateToDocument(targetDocumentId, {
        replace: true,
        skipConfirm: true,
      })
    },
  )

  async function openDocument(documentId: string) {
    lastInaccessibleRedirectDocumentId = null
    await navigateToDocument(documentId)
  }

  async function openDefaultDocument(input: { replace?: boolean } = {}) {
    if (!surfaceState.visibleDefaultDocumentId.value) {
      return
    }

    lastInaccessibleRedirectDocumentId = null
    await navigateToDocument(surfaceState.visibleDefaultDocumentId.value, input)
  }

  async function createRootDocument(collectionId: DocumentTreeCollectionId = DOCUMENT_COLLECTION.PERSONAL) {
    lastInaccessibleRedirectDocumentId = null
    await tree.createRootDocument(collectionId)
  }

  async function duplicateDocumentTree(documentId: string) {
    const isCurrentDocument = activeDocument.currentDocument.value?.id === documentId

    if (isCurrentDocument) {
      const canContinue = await activeDocument.confirmNavigation()

      if (!canContinue) {
        return
      }
    }

    try {
      isDocumentOperationRunning.value = true
      const response = await createDocumentDuplicateOperation(documentId)
      const job = await waitDocumentOperationJob(response.job, {
        runningTitle: translate('docs.operation.duplicateCreatingTitle'),
        runningMessage: translate('docs.operation.duplicateCreatingMessage'),
      })

      await tree.loadTree()

      if (job.resultDocumentId) {
        await navigateToDocument(job.resultDocumentId, {
          skipConfirm: true,
        })
      }

      ElMessage.success(translate('docs.operation.duplicateCreated'))
    }
    catch (error) {
      ElMessage.error(error instanceof Error ? error.message : translate('docs.operation.duplicateFailed'))
    }
    finally {
      isDocumentOperationRunning.value = false
    }
  }

  async function moveDocumentTree(
    documentId: string,
    payload: MoveDocumentTreeOperationRequest,
  ) {
    const isCurrentDocument = activeDocument.currentDocument.value?.id === documentId

    if (isCurrentDocument) {
      const canContinue = await activeDocument.confirmNavigation()

      if (!canContinue) {
        return
      }
    }

    try {
      isDocumentOperationRunning.value = true
      const response = await createDocumentMoveOperation(documentId, payload)
      const job = await waitDocumentOperationJob(response.job, {
        runningTitle: translate('docs.operation.moveMovingTitle'),
        runningMessage: translate('docs.operation.moveMovingMessage'),
      })

      if (payload.targetWorkspaceId !== currentWorkspaceId.value) {
        workspaceStore.selectWorkspace(payload.targetWorkspaceId)
      }

      await tree.loadTree()

      if (job.resultDocumentId) {
        await navigateToDocument(job.resultDocumentId, {
          skipConfirm: true,
        })
      }

      if (isCurrentDocument) {
        await activeDocument.reloadCurrentDocument()
      }

      ElMessage.success(translate('docs.operation.moved'))
    }
    catch (error) {
      ElMessage.error(error instanceof Error ? error.message : translate('docs.operation.moveFailed'))
    }
    finally {
      isDocumentOperationRunning.value = false
    }
  }

  async function loadInitialTree() {
    await tree.loadTree()

    if (
      !surfaceState.isDocumentSurface.value
      || activeDocumentId.value
      || !surfaceState.visibleDefaultDocumentId.value
    ) {
      return
    }

    isSelectingInitialDocument.value = true

    try {
      await navigateToDocument(surfaceState.visibleDefaultDocumentId.value, {
        replace: true,
        skipConfirm: true,
      })
    }
    finally {
      isSelectingInitialDocument.value = false
    }
  }

  function openTrashPage() {
    uiStore.setLastDocsControlCenterRouteName('docs-trash')
    void router.push({
      name: 'docs-trash',
    })
  }

  function openPublicationSettingsPage() {
    uiStore.setLastDocsControlCenterRouteName('docs-publications')
    void router.push({
      name: 'docs-publications',
    })
  }

  function openDocsControlCenterPage() {
    void router.push({
      name: uiStore.lastDocsControlCenterRouteName,
    })
  }

  return {
    createRootDocument,
    duplicateDocumentTree,
    isDocumentOperationRunning,
    loadInitialTree,
    moveDocumentTree,
    openDocsControlCenterPage,
    openDefaultDocument,
    openDocument,
    openPublicationSettingsPage,
    openTrashPage,
  }
})

function resolveInaccessibleDocumentRedirectMessage(input: {
  paneState: string
  hasFallbackDocument: boolean
}) {
  if (input.paneState === DOCUMENT_PANE_STATE.FORBIDDEN) {
    return input.hasFallbackDocument
      ? translate('docs.operation.inaccessibleFallback')
      : translate('docs.operation.inaccessibleReturned')
  }

  return input.hasFallbackDocument
    ? translate('docs.operation.missingFallback')
    : translate('docs.operation.missingReturned')
}

async function waitDocumentOperationJob(
  initialJob: DocumentOperationJob,
  message: {
    runningTitle: string
    runningMessage: string
  },
): Promise<DocumentOperationJob> {
  const shouldShowLongRunningHint = initialJob.documentsTotal > DOCUMENT_OPERATION_LONG_RUNNING_DOCUMENTS_THRESHOLD
    || initialJob.assetsTotal > DOCUMENT_OPERATION_LONG_RUNNING_ASSETS_THRESHOLD
  const notification = shouldShowLongRunningHint
    ? ElNotification({
        title: message.runningTitle,
        message: message.runningMessage,
        duration: 0,
      })
    : null

  try {
    let currentJob = initialJob
    const startedAt = Date.now()

    while (
      currentJob.status === DOCUMENT_OPERATION_JOB_STATUS.PENDING
      || currentJob.status === DOCUMENT_OPERATION_JOB_STATUS.RUNNING
    ) {
      if (Date.now() - startedAt > DOCUMENT_OPERATION_WAIT_TIMEOUT_MS) {
        throw new Error(translate('docs.operation.taskTimeout'))
      }

      await sleep(DOCUMENT_OPERATION_POLL_INTERVAL_MS)
      currentJob = await getDocumentOperationJob(currentJob.id)
    }

    if (currentJob.status === DOCUMENT_OPERATION_JOB_STATUS.FAILED) {
      throw new Error(currentJob.errorMessage ?? translate('docs.operation.taskFailed'))
    }

    return currentJob
  }
  finally {
    notification?.close()
  }
}
