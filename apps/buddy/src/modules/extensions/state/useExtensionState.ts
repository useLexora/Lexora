import type { ExtensionApi, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionInstallation } from '@buddy-shared/extensions/extensionInstallation'
import { computed, onScopeDispose, shallowRef } from 'vue'

export function useExtensionState(api: ExtensionApi) {
  const installed = shallowRef<ExtensionStatus[]>([])
  const installedError = shallowRef('')
  const installationsError = shallowRef('')
  const error = computed(() => installedError.value || installationsError.value)
  const installations = shallowRef<ExtensionInstallation[]>([])
  let revision = 0
  let disposed = false
  async function refresh() {
    const current = ++revision
    const currentResult = () => !disposed && current === revision
    await Promise.all([
      api.list().then((snapshot) => {
        if (currentResult()) {
          installed.value = snapshot
          installedError.value = ''
        }
      }).catch((reason) => {
        if (currentResult())
          installedError.value = extensionErrorCode(reason)
      }),
      api.installations().then((jobs) => {
        if (currentResult()) {
          installations.value = jobs
          installationsError.value = ''
        }
      }).catch((reason) => {
        if (currentResult())
          installationsError.value = extensionErrorCode(reason)
      }),
    ])
  }
  onScopeDispose(api.onChanged(() => void refresh()))
  onScopeDispose(() => {
    disposed = true
    revision++
  })
  return { api, installed, installations, error, refresh }
}

export function extensionErrorCode(reason: unknown): string {
  return reason instanceof Error ? reason.message.match(/EXTENSION_[A-Z_]+/)?.[0] ?? 'EXTENSION_OPERATION_FAILED' : 'EXTENSION_OPERATION_FAILED'
}
