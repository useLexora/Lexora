import type { ExtensionTaskAction } from '@buddy-shared/extensions/extensionActionApi'
import type { ExtensionApi, ExtensionStatus, ExtensionUnavailableInstallation } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionInstallation } from '@buddy-shared/extensions/extensionInstallation'
import { computed, onScopeDispose, shallowRef } from 'vue'
import { useExtensionOperations } from './useExtensionOperations'

export function useExtensionState(api: ExtensionApi) {
  const taskActions = shallowRef<ExtensionTaskAction[]>([])
  const installed = shallowRef<ExtensionStatus[]>([])
  const unavailable = shallowRef<ExtensionUnavailableInstallation[]>([])
  const unavailableError = shallowRef('')
  const installedError = shallowRef('')
  const installationsError = shallowRef('')
  const error = computed(() => installedError.value || unavailableError.value || installationsError.value)
  const installations = shallowRef<ExtensionInstallation[]>([])
  let disposed = false

  function coalesce(read: (current: () => boolean) => Promise<void>) {
    let revision = 0
    let pending: Promise<void> | undefined
    return () => {
      if (disposed)
        return Promise.resolve()
      revision++
      pending ??= Promise.resolve().then(async () => {
        try {
          let completed: number
          do {
            completed = revision
            const current = completed
            await read(() => !disposed && current === revision)
            if (disposed)
              return
          } while (completed !== revision)
        }
        finally {
          pending = undefined
        }
      })
      return pending
    }
  }

  const refreshStatus = coalesce(async (current) => {
    await Promise.all([
      api.unavailable().then((items) => {
        if (current()) {
          unavailable.value = items
          unavailableError.value = ''
        }
      }).catch((reason) => {
        if (current())
          unavailableError.value = extensionErrorCode(reason)
      }),
      api.taskActions().then((items) => {
        if (current())
          taskActions.value = items
      }).catch(() => {
        if (current())
          taskActions.value = []
      }),
      api.list().then((snapshot) => {
        if (current()) {
          installed.value = snapshot
          installedError.value = ''
        }
      }).catch((reason) => {
        if (current())
          installedError.value = extensionErrorCode(reason)
      }),
    ])
  })
  const refreshInstallations = coalesce(async (current) => {
    try {
      const jobs = await api.installations()
      if (current()) {
        installations.value = jobs
        installationsError.value = ''
      }
    }
    catch (reason) {
      if (current())
        installationsError.value = extensionErrorCode(reason)
    }
  })
  async function refresh() {
    await Promise.all([refreshStatus(), refreshInstallations()])
  }

  onScopeDispose(api.onChanged(() => void refreshStatus()))
  onScopeDispose(api.onInstallationsChanged(() => void refreshInstallations()))
  onScopeDispose(() => {
    disposed = true
  })
  const operations = useExtensionOperations(api, refreshStatus)
  return { api, taskActions, installed, unavailable, installations, error, refresh, refreshInstallations, ...operations }
}

export function extensionErrorCode(reason: unknown): string {
  return reason instanceof Error ? reason.message.match(/EXTENSION_[A-Z_]+/)?.[0] ?? 'EXTENSION_OPERATION_FAILED' : 'EXTENSION_OPERATION_FAILED'
}
