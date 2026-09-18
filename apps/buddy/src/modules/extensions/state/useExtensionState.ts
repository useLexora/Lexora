import type { ExtensionApi, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionInstallation } from '@buddy-shared/extensions/extensionInstallation'
import { computed, onScopeDispose, shallowRef } from 'vue'

export function useExtensionState(api: ExtensionApi) {
  const installed = shallowRef<ExtensionStatus[]>([])
  const error = shallowRef('')
  const installations = shallowRef<ExtensionInstallation[]>([])
  const navigation = computed(() => installed.value.filter(item => item.enabled && item.compatible && item.manifest.contributes.navigation).map(item => ({ id: item.manifest.id, title: item.manifest.contributes.navigation!.title, iconUrl: item.iconUrl })))
  let revision = 0
  let disposed = false
  async function refresh() {
    const current = ++revision
    try {
      const [snapshot, jobs] = await Promise.all([api.list(), api.installations()])
      if (disposed || current !== revision)
        return
      installed.value = snapshot
      installations.value = jobs
      error.value = ''
    }
    catch (reason) {
      if (!disposed && current === revision)
        error.value = extensionErrorCode(reason)
    }
  }
  onScopeDispose(api.onChanged(() => void refresh()))
  onScopeDispose(() => {
    disposed = true
    revision++
  })
  return { api, installed, installations, navigation, error, refresh }
}

export function extensionErrorCode(reason: unknown): string {
  return reason instanceof Error ? reason.message.match(/EXTENSION_[A-Z_]+/)?.[0] ?? 'EXTENSION_OPERATION_FAILED' : 'EXTENSION_OPERATION_FAILED'
}
