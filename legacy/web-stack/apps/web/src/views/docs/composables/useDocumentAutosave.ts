import type {
  DocumentCurrent,
  DocumentSaveState,
  SaveDocumentContentRequest,
  TiptapJsonContent,
  TiptapSchemaVersion,
} from '@haohaoxue/lexora-contracts'
import type { DocumentSaveFailure, DocumentSaveFailureKind } from '../typing'
import { DOCUMENT_SAVE_STATE } from '@haohaoxue/lexora-contracts/document/constants'
import { computed, getCurrentScope, onScopeDispose, shallowRef } from 'vue'

interface AutosaveDocumentSnapshot {
  id: string
  currentProjectionRevision: number
  schemaVersion: TiptapSchemaVersion
  title: TiptapJsonContent
  body: TiptapJsonContent
}

interface DocumentAutosaveOptions {
  classifyError?: (error: unknown) => DocumentSaveFailure
  createIdempotencyKey?: () => string
  debounceMs?: number
  onError?: (error: unknown) => void
  onPersisted: (current: DocumentCurrent) => void
  persist: (documentId: string, payload: SaveDocumentContentRequest) => Promise<DocumentCurrent>
  readDocument: () => AutosaveDocumentSnapshot | null
}

interface PendingSaveAttempt {
  editVersion: number
  documentId: string
  payload: SaveDocumentContentRequest
}

interface ActiveSave {
  promise: Promise<boolean>
  sessionVersion: number
}

export function useDocumentAutosave(options: DocumentAutosaveOptions) {
  const saveState = shallowRef<DocumentSaveState>(DOCUMENT_SAVE_STATE.IDLE)
  const canRetry = shallowRef(true)
  const failureKind = shallowRef<DocumentSaveFailureKind | null>(null)
  const isSaving = computed(() => saveState.value === DOCUMENT_SAVE_STATE.SAVING)
  const hasUnsavedChanges = computed(() =>
    saveState.value !== DOCUMENT_SAVE_STATE.IDLE
    && saveState.value !== DOCUMENT_SAVE_STATE.SAVED,
  )
  const createIdempotencyKey = options.createIdempotencyKey ?? (() => globalThis.crypto.randomUUID())
  const debounceMs = options.debounceMs ?? 600
  let editVersion = 0
  let persistedEditVersion = 0
  let sessionVersion = 0
  let pendingAttempt: PendingSaveAttempt | null = null
  let shouldReplacePendingAttemptOnEdit = false
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let activeSave: ActiveSave | null = null

  function markDirty() {
    editVersion += 1

    if (shouldReplacePendingAttemptOnEdit && pendingAttempt && editVersion > pendingAttempt.editVersion) {
      pendingAttempt = null
      shouldReplacePendingAttemptOnEdit = false
      canRetry.value = true
      failureKind.value = null
    }

    if (saveState.value === DOCUMENT_SAVE_STATE.ERROR && !canRetry.value) {
      return
    }

    if (activeSave?.sessionVersion !== sessionVersion) {
      saveState.value = DOCUMENT_SAVE_STATE.DIRTY
      scheduleSave()
    }
  }

  function scheduleSave() {
    clearSaveTimer()
    saveTimer = setTimeout(() => {
      saveTimer = null
      void flush()
    }, debounceMs)
  }

  function flush(): Promise<boolean> {
    clearSaveTimer()

    if (activeSave?.sessionVersion === sessionVersion) {
      return activeSave.promise
    }

    if (saveState.value === DOCUMENT_SAVE_STATE.ERROR && !canRetry.value) {
      return Promise.resolve(false)
    }

    const currentSessionVersion = sessionVersion
    let nextActiveSave: ActiveSave
    const promise = runSaveLoop(currentSessionVersion).finally(() => {
      if (activeSave === nextActiveSave) {
        activeSave = null
      }
    })
    nextActiveSave = {
      promise,
      sessionVersion: currentSessionVersion,
    }
    activeSave = nextActiveSave
    return promise
  }

  async function runSaveLoop(currentSessionVersion: number): Promise<boolean> {
    while (true) {
      if (currentSessionVersion !== sessionVersion) {
        return false
      }

      pendingAttempt ??= createPendingAttempt()

      if (!pendingAttempt) {
        saveState.value = editVersion > persistedEditVersion
          ? DOCUMENT_SAVE_STATE.DIRTY
          : DOCUMENT_SAVE_STATE.SAVED
        return true
      }

      saveState.value = DOCUMENT_SAVE_STATE.SAVING

      try {
        const persisted = await options.persist(pendingAttempt.documentId, pendingAttempt.payload)

        if (currentSessionVersion !== sessionVersion) {
          return false
        }

        const savedEditVersion = pendingAttempt.editVersion
        pendingAttempt = null
        shouldReplacePendingAttemptOnEdit = false
        persistedEditVersion = Math.max(persistedEditVersion, savedEditVersion)
        canRetry.value = true
        failureKind.value = null
        options.onPersisted(persisted)
      }
      catch (error) {
        if (currentSessionVersion === sessionVersion) {
          const failure = options.classifyError?.(error) ?? {
            canRetry: true,
            kind: 'unknown',
          }
          canRetry.value = failure.canRetry
          failureKind.value = failure.kind
          shouldReplacePendingAttemptOnEdit = failure.replaceOnEdit ?? false
          saveState.value = DOCUMENT_SAVE_STATE.ERROR
          options.onError?.(error)

          if (shouldReplacePendingAttemptOnEdit && pendingAttempt && editVersion > pendingAttempt.editVersion) {
            pendingAttempt = null
            shouldReplacePendingAttemptOnEdit = false
            saveState.value = DOCUMENT_SAVE_STATE.DIRTY
            scheduleSave()
          }
        }
        return false
      }
    }
  }

  function createPendingAttempt(): PendingSaveAttempt | null {
    if (editVersion <= persistedEditVersion) {
      return null
    }

    const document = options.readDocument()

    if (!document) {
      return null
    }

    return {
      editVersion,
      documentId: document.id,
      payload: {
        baseProjectionRevision: document.currentProjectionRevision,
        idempotencyKey: createIdempotencyKey(),
        schemaVersion: document.schemaVersion,
        title: cloneContent(document.title),
        body: cloneContent(document.body),
      },
    }
  }

  function captureLoadedDocument() {
    reset()
  }

  function retry() {
    return flush()
  }

  function reset() {
    sessionVersion += 1
    clearSaveTimer()
    editVersion = 0
    persistedEditVersion = 0
    pendingAttempt = null
    shouldReplacePendingAttemptOnEdit = false
    canRetry.value = true
    failureKind.value = null
    saveState.value = DOCUMENT_SAVE_STATE.IDLE
  }

  function clearSaveTimer() {
    if (!saveTimer) {
      return
    }

    clearTimeout(saveTimer)
    saveTimer = null
  }

  if (getCurrentScope()) {
    onScopeDispose(reset)
  }

  return {
    canRetry,
    captureLoadedDocument,
    flush,
    failureKind,
    hasUnsavedChanges,
    isSaving,
    markDirty,
    reset,
    retry,
    saveState,
  }
}

function cloneContent(content: TiptapJsonContent): TiptapJsonContent {
  return structuredClone(content)
}
