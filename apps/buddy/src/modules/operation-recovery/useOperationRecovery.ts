import type { ProductRecoveryItem } from '@buddy-shared/runtime/productRecovery'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { RegisterNotificationAction } from '@/modules/notifications'
import type { DesktopNotification } from '@/modules/notifications/contracts'
import type { TaskChatWorkspace, TaskDraftRestoration } from '@/modules/tasks'
import { computed, nextTick, onScopeDispose, shallowRef, watch } from 'vue'
import { matchesDraftRecovery } from '@/modules/tasks'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

export interface OperationRecoveryProps {
  language: BuddyLocale
  registerAction: RegisterNotificationAction
  notifications: readonly DesktopNotification[]
  workspace: Pick<TaskChatWorkspace, 'restoration' | 'session'> | null
  openDraft: (id: string, signal: AbortSignal) => Promise<boolean>
  openTask: (id: string, branchId: string, signal: AbortSignal) => Promise<void>
}

export function useOperationRecovery(props: OperationRecoveryProps, onError: (error: string) => void) {
  const runtime = requireDesktopApi().localChat.runtime
  const selectedId = shallowRef<string | null>(null)
  const item = shallowRef<ProductRecoveryItem>()
  const loading = shallowRef(false)
  const busy = shallowRef(false)
  const reviewing = shallowRef(false)
  const loadError = shallowRef('')
  const notification = computed(() => props.notifications.find(entry => entry.kind === 'operation.recovery' && entry.action.recoveryId === selectedId.value))
  const target = computed(() => {
    const source = item.value
    return source?.sourceKind === 'conversation' && source.conversationId && source.branchId && source.state !== 'trust_changed'
      ? { conversationId: source.conversationId, branchId: source.branchId }
      : null
  })
  const sourceWorkspace = computed(() => {
    const workspace = props.workspace
    return target.value && workspace && workspace.session.activeConversationId.value === target.value.conversationId
      && workspace.session.activeBranchId.value === target.value.branchId
      ? workspace
      : null
  })
  const match = computed(() => {
    const conflict = sourceWorkspace.value?.restoration.conflict.value
    return item.value && conflict && target.value && matchesDraftRecovery(item.value, conflict, target.value) ? conflict : null
  })
  let request: AbortController | undefined

  function close() {
    request?.abort()
    selectedId.value = null
    item.value = undefined
    reviewing.value = false
    loading.value = false
  }
  watch(notification, (entry, prev) => {
    if (!entry)
      close()
    else if (entry.kind === 'operation.recovery' && prev?.id === entry.id && prev.revision !== entry.revision)
      void review(entry.action.recoveryId, false)
  })
  watch(match, (current) => {
    if (!current)
      reviewing.value = false
  })

  async function openSource(signal: AbortSignal) {
    const source = target.value
    if (!source || !item.value || signal.aborted)
      return
    loading.value = true
    try {
      await props.openTask(source.conversationId, source.branchId, signal)
      await nextTick()
      if (signal.aborted)
        return
      if (match.value)
        reviewing.value = true
      else if (sourceWorkspace.value && !item.value.canRestore)
        close()
    }
    catch (error) {
      if (!signal.aborted)
        onError(resolveLocalChatErrorMessage(error, props.language))
    }
    finally {
      if (!signal.aborted)
        loading.value = false
    }
  }

  async function review(id: string, navigate = true) {
    close()
    const { signal } = request = new AbortController()
    selectedId.value = id
    loadError.value = ''
    loading.value = true
    try {
      const [result] = await runtime.listRecovery(id)
      if (signal.aborted)
        return
      item.value = result
      if (!result) {
        close()
      }
      else {
        selectedId.value = result.id
        if (navigate && result.method === 'composerDrafts.save' && target.value && result.canRestore)
          await openSource(signal)
      }
    }
    catch (error) {
      if (!signal.aborted)
        loadError.value = resolveLocalChatErrorMessage(error, props.language)
    }
    finally {
      if (!signal.aborted)
        loading.value = false
    }
  }
  onScopeDispose(props.registerAction('review-operation', action => review(action.recoveryId)))
  onScopeDispose(close)

  const resolveConflict: TaskDraftRestoration['resolveConflict'] = async (key, choice) => {
    const source = item.value
    const restoration = sourceWorkspace.value?.restoration
    if (!source || !restoration || match.value?.targetKey !== key || busy.value)
      return false
    busy.value = true
    try {
      const resolved = await restoration.resolveConflict(key, choice, source)
      if (resolved && item.value === source)
        close()
      return resolved
    }
    finally {
      busy.value = false
    }
  }

  async function resolve(action: 'restore' | 'acknowledge') {
    const id = item.value?.id
    const signal = request?.signal
    if (!id || !signal || busy.value)
      return
    busy.value = true
    try {
      if (action === 'restore') {
        const draftId = await runtime.restoreRecovery(id)
        if (signal.aborted)
          return
        if (!await props.openDraft(draftId, signal) || signal.aborted)
          return
      }
      await runtime.acknowledgeRecovery(id)
      if (selectedId.value === id)
        close()
    }
    catch (error) {
      onError(resolveLocalChatErrorMessage(error, props.language))
    }
    finally {
      busy.value = false
    }
  }
  return {
    item,
    loading,
    busy,
    loadError,
    target,
    match,
    notification,
    reviewing,
    resolve,
    resolveConflict,
    close,
    refresh: () => selectedId.value && review(selectedId.value, false),
    openSource: () => request && openSource(request.signal),
  }
}
