import type {
  DocumentItem,
  DocumentPageWidthMode,
  DocumentPaneState,
  DocumentVersionSnapshot,
  TiptapJsonContent,
} from '@haohaoxue/lexora-contracts'
import type { ActiveDocumentDetail, DocumentSaveFailure } from '../typing'
import type {
  DocumentCurrent,
  RestoreDocumentVersionSnapshotResponse,
} from '@/apis/document'
import {
  DOCUMENT_PANE_STATE,
} from '@haohaoxue/lexora-contracts/document/constants'
import { API_ERROR_CODE } from '@haohaoxue/lexora-contracts/status-code'
import { TIPTAP_SCHEMA_VERSION } from '@haohaoxue/lexora-contracts/tiptap/constants'
import {
  collectDocumentAssetIds,
  getDocumentTitlePlainText,
  getDocumentVersionSnapshotSummary,
  hasDocumentContent,
  hydrateDocumentAssetAttributes,
} from '@haohaoxue/lexora-shared/document'
import { createSharedComposable } from '@vueuse/core'
import {
  shallowRef,
  watch,
} from 'vue'
import {
  getDocumentCurrent as getDocumentCurrentRequest,
  getDocumentVersionSnapshots as getDocumentVersionSnapshotsRequest,
  resolveDocumentAssets as resolveDocumentAssetsRequest,
  restoreDocumentVersionSnapshot as restoreDocumentVersionSnapshotRequest,
  saveDocumentContent as saveDocumentContentRequest,
} from '@/apis/document'
import { translate } from '@/i18n'
import { ElMessage, ElMessageBox } from '@/utils/element-plus'
import { toRequestError } from '@/utils/request-error'
import { useDocsContext } from './useDocsContext'
import { useDocumentAutosave } from './useDocumentAutosave'
import { useDocumentTree } from './useDocumentTree'

const UNSUPPORTED_SCHEMA_VERSION_ERROR_CODE = 'DOCUMENT_UNSUPPORTED_SCHEMA_VERSION'

type RequestError = Error & { status?: number }
type UnsupportedSchemaVersionError = Error & {
  code: typeof UNSUPPORTED_SCHEMA_VERSION_ERROR_CODE
  schemaVersion: unknown
}

interface UseActiveDocumentStateOptions {
  onSaveError?: (error: unknown) => void
  patchDocumentItem: (documentId: string, input: Partial<DocumentItem>) => void
  saveDocument?: typeof saveDocumentContentRequest
}

interface ApplyRestoredSnapshotOptions {
  documentAtRestoreStart: ActiveDocumentDetail
  restoreResponse: RestoreDocumentVersionSnapshotResponse
}

export const useActiveDocument = createSharedComposable(() => {
  const {
    activeDocumentId,
    pendingTitleFocusDocumentId,
    setNavigationConfirmationHandler,
  } = useDocsContext()
  const { patchDocumentItem, rememberLastOpenedDocument } = useDocumentTree()
  const isDocumentItemLoading = shallowRef(false)
  const isSnapshotsLoading = shallowRef(false)
  let loadRequestId = 0
  let restoreRequestId = 0
  let snapshotRequestId = 0

  const state = useActiveDocumentState({
    onSaveError: error => ElMessage.error(resolveDocumentSaveErrorMessage(error)),
    patchDocumentItem,
  })
  setNavigationConfirmationHandler(state.flushSave)

  function updateDocumentTitle(title: TiptapJsonContent) {
    state.updateDocumentTitle(title)
  }

  function updateDocumentContent(content: TiptapJsonContent) {
    state.updateDocumentContent(content)
  }

  async function loadCurrentDocument(id: string | null) {
    restoreRequestId += 1
    snapshotRequestId += 1
    state.finishRestore()
    const requestId = ++loadRequestId

    if (!id) {
      isDocumentItemLoading.value = false
      isSnapshotsLoading.value = false
      state.resetCurrentDocument()
      return
    }

    isDocumentItemLoading.value = true
    isSnapshotsLoading.value = false
    state.resetCurrentDocument()

    try {
      const documentCurrent = await getDocumentCurrentRequest(id)

      if (!isActiveLoadRequest(requestId, id)) {
        return
      }

      const resolvedBodies = await hydrateDocumentBodies(id, [
        documentCurrent.currentProjection.body,
      ])

      if (!isActiveLoadRequest(requestId, id)) {
        return
      }

      const loadedDocument = toActiveDocument({
        ...documentCurrent,
        currentProjection: {
          ...documentCurrent.currentProjection,
          body: resolvedBodies[0] ?? documentCurrent.currentProjection.body,
        },
      })

      if (!isActiveLoadRequest(requestId, id)) {
        return
      }

      state.applyLoadedDocument(loadedDocument, [])

      rememberLastOpenedDocument(id)
    }
    catch (error) {
      if (!isActiveLoadRequest(requestId, id)) {
        return
      }

      state.setDocumentErrorState(resolveDocumentErrorState(error))
    }
    finally {
      if (isActiveLoadRequest(requestId, id)) {
        isDocumentItemLoading.value = false
        isSnapshotsLoading.value = false
      }
    }
  }

  async function confirmNavigation() {
    return await state.flushSave()
  }

  async function restoreSnapshot(snapshotId: string) {
    const documentId = state.currentDocument.value?.id

    if (!documentId || state.isRestoringSnapshot.value) {
      return
    }

    const requestId = ++restoreRequestId
    state.startRestore()

    try {
      const canRestore = await state.flushSave()
      const documentAtRestoreStart = state.currentDocument.value

      if (
        !canRestore
        || !documentAtRestoreStart
        || !isActiveRestoreRequest(requestId, documentId)
      ) {
        return
      }

      const restoredDocument = await restoreDocumentVersionSnapshotRequest(documentAtRestoreStart.id, {
        baseProjectionRevision: documentAtRestoreStart.currentProjectionRevision,
        versionSnapshotId: snapshotId,
      })

      if (!isActiveRestoreRequest(requestId, documentAtRestoreStart.id)) {
        return
      }

      const [hydratedBody] = await hydrateDocumentBodies(documentAtRestoreStart.id, [
        restoredDocument.current.currentProjection.body,
      ])

      if (!isActiveRestoreRequest(requestId, documentAtRestoreStart.id)) {
        return
      }

      const hydratedRestoredDocument = {
        ...restoredDocument,
        current: {
          ...restoredDocument.current,
          currentProjection: {
            ...restoredDocument.current.currentProjection,
            body: hydratedBody ?? restoredDocument.current.currentProjection.body,
          },
        },
      }

      const { isNoopRestore } = state.applyRestoredSnapshot({
        documentAtRestoreStart,
        restoreResponse: hydratedRestoredDocument,
      })
      if (isNoopRestore) {
        ElMessage.info(translate('docs.history.restoreAlreadyCurrent'))
      }
      else {
        ElMessage.success(translate('docs.history.restoreSuccess'))
      }
    }
    catch (error) {
      if (!isActiveRestoreRequest(requestId, documentId)) {
        return
      }

      if (isUnsupportedSchemaVersionError(error)) {
        state.setDocumentErrorState(DOCUMENT_PANE_STATE.UNSUPPORTED_SCHEMA)
      }

      ElMessage.error(resolveDocumentWriteErrorMessage(error))
    }
    finally {
      if (requestId === restoreRequestId) {
        state.finishRestore()
      }
    }
  }

  async function reloadCurrentDocument() {
    const canReload = await state.flushSave()

    if (!canReload) {
      return false
    }

    await loadCurrentDocument(activeDocumentId.value)
    return true
  }

  async function discardLocalChangesAndReload() {
    try {
      await ElMessageBox.confirm(
        translate('docs.autosave.reloadConflictMessage'),
        translate('docs.autosave.reloadConflictTitle'),
        {
          cancelButtonText: translate('docs.common.cancel'),
          confirmButtonText: translate('docs.autosave.reload'),
          type: 'warning',
        },
      )
    }
    catch {
      return
    }

    await loadCurrentDocument(activeDocumentId.value)
  }

  async function ensureSnapshotsLoaded() {
    const documentId = activeDocumentId.value

    if (
      !documentId
      || state.currentDocument.value?.id !== documentId
      || state.loadedSnapshotsDocumentId.value === documentId
      || isSnapshotsLoading.value
    ) {
      return
    }

    const requestId = ++snapshotRequestId
    isSnapshotsLoading.value = true

    try {
      while (isActiveSnapshotRequest(requestId, documentId)) {
        const latestSnapshotIdAtRequestStart: string | null
          = state.currentDocument.value?.latestVersionSnapshotId ?? null
        const loadedSnapshots = await getDocumentVersionSnapshotsRequest(documentId)

        if (!isActiveSnapshotRequest(requestId, documentId)) {
          return
        }

        const resolvedBodies = await hydrateDocumentBodies(documentId, loadedSnapshots.map(snapshot => snapshot.body))

        if (!isActiveSnapshotRequest(requestId, documentId)) {
          return
        }

        if (state.currentDocument.value?.latestVersionSnapshotId !== latestSnapshotIdAtRequestStart) {
          continue
        }

        state.applyLoadedSnapshots(documentId, loadedSnapshots.map((snapshot, index) => ({
          ...snapshot,
          body: resolvedBodies[index] ?? snapshot.body,
        })))
        return
      }
    }
    finally {
      if (requestId === snapshotRequestId) {
        isSnapshotsLoading.value = false
      }
    }
  }

  function isActiveLoadRequest(requestId: number, documentId: string | null) {
    return requestId === loadRequestId && activeDocumentId.value === documentId
  }

  function isActiveSnapshotRequest(requestId: number, documentId: string | null) {
    return requestId === snapshotRequestId
      && activeDocumentId.value === documentId
      && state.currentDocument.value?.id === documentId
  }

  function isActiveRestoreRequest(requestId: number, documentId: string) {
    return requestId === restoreRequestId
      && activeDocumentId.value === documentId
      && state.currentDocument.value?.id === documentId
  }

  function markTitleAutofocusApplied() {
    if (state.currentDocument.value?.id !== pendingTitleFocusDocumentId.value) {
      return
    }

    pendingTitleFocusDocumentId.value = null
  }

  watch(
    activeDocumentId,
    async (nextDocumentId) => {
      await loadCurrentDocument(nextDocumentId)
    },
    { immediate: true },
  )

  watch(
    activeDocumentId,
    (nextDocumentId) => {
      if (
        pendingTitleFocusDocumentId.value
        && nextDocumentId !== pendingTitleFocusDocumentId.value
      ) {
        pendingTitleFocusDocumentId.value = null
      }
    },
  )

  return {
    canRetrySave: state.canRetrySave,
    confirmNavigation,
    currentDocument: state.currentDocument,
    discardLocalChangesAndReload,
    documentErrorState: state.documentErrorState,
    ensureSnapshotsLoaded,
    failureKind: state.failureKind,
    hasUnsavedChanges: state.hasUnsavedChanges,
    isDocumentItemLoading,
    isRestoringSnapshot: state.isRestoringSnapshot,
    isSaving: state.isSaving,
    isSnapshotsLoading,
    markTitleAutofocusApplied,
    patchDocumentPageWidthMode: state.patchDocumentPageWidthMode,
    retrySave: state.retrySave,
    reloadCurrentDocument,
    restoreSnapshot,
    saveState: state.saveState,
    snapshots: state.snapshots,
    updateDocumentContent,
    updateDocumentTitle,
  }
})

export function useActiveDocumentState({
  onSaveError,
  patchDocumentItem,
  saveDocument = saveDocumentContentRequest,
}: UseActiveDocumentStateOptions) {
  const currentDocument = shallowRef<ActiveDocumentDetail | null>(null)
  const snapshots = shallowRef<DocumentVersionSnapshot[]>([])
  const isRestoringSnapshot = shallowRef(false)
  const documentErrorState = shallowRef<DocumentPaneState | null>(null)
  const loadedSnapshotsDocumentId = shallowRef<string | null>(null)
  const save = useDocumentAutosave({
    classifyError: resolveDocumentSaveFailure,
    onError: onSaveError,
    onPersisted: applyPersistedDocument,
    persist: saveDocument,
    readDocument: () => currentDocument.value
      ? {
          id: currentDocument.value.id,
          currentProjectionRevision: currentDocument.value.currentProjectionRevision,
          schemaVersion: currentDocument.value.schemaVersion,
          title: currentDocument.value.title,
          body: currentDocument.value.body,
        }
      : null,
  })
  function updateDocumentTitle(title: TiptapJsonContent) {
    if (!currentDocument.value || isRestoringSnapshot.value) {
      return
    }

    currentDocument.value = {
      ...currentDocument.value,
      title,
    }

    patchDocumentItem(currentDocument.value.id, {
      title: getDocumentTitlePlainText(title),
    })
    save.markDirty()
  }

  function updateDocumentContent(content: TiptapJsonContent) {
    if (!currentDocument.value || isRestoringSnapshot.value) {
      return
    }

    currentDocument.value = {
      ...currentDocument.value,
      body: content,
    }
    save.markDirty()
  }

  function applyLoadedDocument(document: ActiveDocumentDetail, loadedSnapshots: DocumentVersionSnapshot[]) {
    currentDocument.value = document
    snapshots.value = loadedSnapshots
    documentErrorState.value = null
    loadedSnapshotsDocumentId.value = loadedSnapshots.length ? document.id : null
    save.captureLoadedDocument()
    patchDocumentItem(document.id, buildTreePatch({
      title: document.title,
      body: document.body,
      updatedAt: document.updatedAt,
    }))
  }

  function applyLoadedSnapshots(documentId: string, loadedSnapshots: DocumentVersionSnapshot[]) {
    if (currentDocument.value?.id !== documentId) {
      return
    }

    snapshots.value = loadedSnapshots
    loadedSnapshotsDocumentId.value = documentId
  }

  function patchDocumentPageWidthMode(documentId: string, pageWidthMode: DocumentPageWidthMode) {
    if (currentDocument.value?.id !== documentId) {
      return
    }

    currentDocument.value = {
      ...currentDocument.value,
      pageWidthMode,
    }
  }

  function startRestore() {
    isRestoringSnapshot.value = true
  }

  function finishRestore() {
    isRestoringSnapshot.value = false
  }

  function applyRestoredSnapshot({
    documentAtRestoreStart,
    restoreResponse,
  }: ApplyRestoredSnapshotOptions) {
    const nextDocument = toActiveDocument(restoreResponse.current)
    const isNoopRestore = restoreResponse.current.currentProjection.projectionRevision === documentAtRestoreStart.currentProjectionRevision
      && restoreResponse.snapshot.id === documentAtRestoreStart.latestVersionSnapshotId

    currentDocument.value = nextDocument
    snapshots.value = prependSnapshot(snapshots.value, restoreResponse.snapshot)
    save.captureLoadedDocument()
    patchDocumentItem(nextDocument.id, buildTreePatch({
      title: nextDocument.title,
      body: nextDocument.body,
      updatedAt: restoreResponse.current.currentProjection.updatedAt,
    }))

    return {
      isNoopRestore,
      nextDocument,
    }
  }

  function resetCurrentDocument() {
    currentDocument.value = null
    snapshots.value = []
    documentErrorState.value = null
    loadedSnapshotsDocumentId.value = null
    save.reset()
  }

  function setDocumentErrorState(state: DocumentPaneState) {
    currentDocument.value = null
    snapshots.value = []
    documentErrorState.value = state
    loadedSnapshotsDocumentId.value = null
    save.reset()
  }

  function applyPersistedDocument(documentCurrent: DocumentCurrent) {
    if (currentDocument.value?.id !== documentCurrent.document.id) {
      return
    }

    const localDocument = currentDocument.value
    const didLatestSnapshotChange = localDocument.latestVersionSnapshotId
      !== documentCurrent.document.latestVersionSnapshotId
    currentDocument.value = {
      ...localDocument,
      currentProjectionId: documentCurrent.currentProjection.id,
      currentProjectionRevision: documentCurrent.currentProjection.projectionRevision,
      latestVersionSnapshotId: documentCurrent.document.latestVersionSnapshotId,
      summary: documentCurrent.document.summary,
      updatedAt: documentCurrent.document.updatedAt,
    }

    if (didLatestSnapshotChange) {
      loadedSnapshotsDocumentId.value = null
    }

    patchDocumentItem(documentCurrent.document.id, buildTreePatch({
      title: localDocument.title,
      body: localDocument.body,
      updatedAt: documentCurrent.document.updatedAt,
    }))
  }

  return {
    applyLoadedDocument,
    applyLoadedSnapshots,
    applyRestoredSnapshot,
    canRetrySave: save.canRetry,
    currentDocument,
    documentErrorState,
    failureKind: save.failureKind,
    finishRestore,
    isRestoringSnapshot,
    flushSave: save.flush,
    hasUnsavedChanges: save.hasUnsavedChanges,
    isSaving: save.isSaving,
    loadedSnapshotsDocumentId,
    patchDocumentPageWidthMode,
    resetCurrentDocument,
    retrySave: save.retry,
    saveState: save.saveState,
    setDocumentErrorState,
    snapshots,
    startRestore,
    updateDocumentContent,
    updateDocumentTitle,
  }
}

export function toActiveDocument(documentCurrent: DocumentCurrent): ActiveDocumentDetail {
  assertSupportedSchemaVersion(documentCurrent.currentProjection.schemaVersion)

  return {
    ...documentCurrent.document,
    currentProjectionId: documentCurrent.currentProjection.id,
    currentProjectionRevision: documentCurrent.currentProjection.projectionRevision,
    schemaVersion: documentCurrent.currentProjection.schemaVersion,
    title: documentCurrent.currentProjection.title,
    body: documentCurrent.currentProjection.body,
  }
}

async function hydrateDocumentBodies(documentId: string, bodies: TiptapJsonContent[]) {
  const assetIds = Array.from(new Set(bodies.flatMap(body => collectDocumentAssetIds(body))))

  if (!assetIds.length) {
    return bodies
  }

  const resolvedAssets = await resolveDocumentAssetsRequest(documentId, {
    assetIds,
  })
  const assetsById = Object.fromEntries(
    resolvedAssets.assets.map(asset => [asset.id, asset]),
  )

  return bodies.map(body => hydrateDocumentAssetAttributes(body, assetsById))
}

export function resolveDocumentErrorState(error: unknown): DocumentPaneState {
  if (isUnsupportedSchemaVersionError(error)) {
    return DOCUMENT_PANE_STATE.UNSUPPORTED_SCHEMA
  }

  const requestError = error as RequestError

  if (requestError.status === 403) {
    return DOCUMENT_PANE_STATE.FORBIDDEN
  }

  if (requestError.status === 404) {
    return DOCUMENT_PANE_STATE.NOT_FOUND
  }

  return DOCUMENT_PANE_STATE.ERROR
}

export function resolveDocumentWriteErrorMessage(error: unknown): string {
  if (isUnsupportedSchemaVersionError(error)) {
    return translate('docs.history.restoreUnsupportedVersion')
  }

  const requestError = error as RequestError

  if (requestError.status === 409) {
    return translate('docs.history.restoreVersionChanged')
  }

  return translate('docs.history.restoreNoChange')
}

function resolveDocumentSaveErrorMessage(error: unknown): string {
  return translate(`docs.autosave.failure.${resolveDocumentSaveFailure(error).kind}`)
}

export function resolveDocumentSaveFailure(error: unknown): DocumentSaveFailure {
  const requestError = toRequestError(error)
  const status = requestError.status
  const errorCode = requestError.errorCode
  const requestKind = (error as { kind?: unknown } | null)?.kind ?? requestError.kind

  if (status === 409 || errorCode === API_ERROR_CODE.CONFLICT) {
    return { canRetry: false, kind: 'conflict' }
  }

  if (
    status === 401
    || errorCode === API_ERROR_CODE.UNAUTHORIZED
    || errorCode?.startsWith('auth.')
  ) {
    return { canRetry: false, kind: 'session-expired' }
  }

  if (status === 403 || errorCode === API_ERROR_CODE.FORBIDDEN) {
    return { canRetry: false, kind: 'forbidden' }
  }

  if (status === 404 || errorCode === API_ERROR_CODE.NOT_FOUND) {
    return { canRetry: false, kind: 'not-found' }
  }

  if (
    status === 400
    || status === 413
    || status === 422
    || errorCode === API_ERROR_CODE.BAD_REQUEST
    || errorCode === API_ERROR_CODE.PAYLOAD_TOO_LARGE
    || errorCode === API_ERROR_CODE.VALIDATION_FAILED
  ) {
    return {
      canRetry: false,
      kind: 'invalid-content',
      replaceOnEdit: true,
    }
  }

  if (status === 429 || requestKind === 'rate_limit') {
    return { canRetry: true, kind: 'rate-limit' }
  }

  if (requestKind === 'network') {
    return { canRetry: true, kind: 'network' }
  }

  if (
    (typeof status === 'number' && status >= 500)
    || requestKind === 'http'
    || requestKind === 'parse'
  ) {
    return { canRetry: true, kind: 'server' }
  }

  return { canRetry: true, kind: 'unknown' }
}

export function isUnsupportedSchemaVersionError(error: unknown): error is UnsupportedSchemaVersionError {
  return error instanceof Error
    && (error as Partial<UnsupportedSchemaVersionError>).code === UNSUPPORTED_SCHEMA_VERSION_ERROR_CODE
}

function buildTreePatch(options: {
  title: TiptapJsonContent
  body: TiptapJsonContent
  updatedAt: string
}): Partial<DocumentItem> {
  return {
    title: getDocumentTitlePlainText(options.title),
    summary: getDocumentVersionSnapshotSummary({
      body: options.body,
    }, 120, ''),
    updatedAt: options.updatedAt,
    hasContent: hasDocumentContent(options.body),
  }
}

function prependSnapshot(snapshots: DocumentVersionSnapshot[], nextSnapshot: DocumentVersionSnapshot) {
  return [
    nextSnapshot,
    ...snapshots.filter(snapshot => snapshot.id !== nextSnapshot.id),
  ]
}

function assertSupportedSchemaVersion(schemaVersion: unknown): asserts schemaVersion is typeof TIPTAP_SCHEMA_VERSION {
  if (schemaVersion === TIPTAP_SCHEMA_VERSION) {
    return
  }

  throw createUnsupportedSchemaVersionError(schemaVersion)
}

function createUnsupportedSchemaVersionError(schemaVersion: unknown): UnsupportedSchemaVersionError {
  const error = new Error(`Unsupported document schema version: ${String(schemaVersion)}`) as UnsupportedSchemaVersionError
  error.code = UNSUPPORTED_SCHEMA_VERSION_ERROR_CODE
  error.schemaVersion = schemaVersion
  return error
}
