import type { ExtensionApi, ExtensionReview } from '@buddy-shared/extensions/extensionApi'
import type { FileOpeningChoice } from '@buddy-shared/files/fileOpening'
import { shallowReactive } from 'vue'

export interface ExtensionPendingInstall extends Pick<ExtensionReview, 'manifest' | 'iconUrl' | 'installationId'> {
  phase: 'install' | 'apply-update'
  error: string | null
}

export function useExtensionOperations(api: ExtensionApi, refresh: () => Promise<void>) {
  const busyIds = shallowReactive(new Set<string>())
  const pendingInstalls = shallowReactive(new Map<string, ExtensionPendingInstall>())

  async function runOperation(id: string, action: () => Promise<unknown>) {
    if (busyIds.has(id))
      return false
    busyIds.add(id)
    try {
      await action()
      return true
    }
    finally {
      try {
        await refresh()
      }
      finally {
        busyIds.delete(id)
      }
    }
  }

  async function install(review: ExtensionReview, applyUpdate: boolean, choices: FileOpeningChoice[] = []) {
    const id = review.manifest.id
    if (busyIds.has(id))
      return false
    const pending: ExtensionPendingInstall = { manifest: review.manifest, iconUrl: review.iconUrl, installationId: review.installationId, phase: 'install', error: null }
    pendingInstalls.set(id, pending)
    try {
      const result = await runOperation(id, async () => {
        await api.install(review.token, choices)
        if (review.currentVersion && applyUpdate) {
          pendingInstalls.set(id, { ...pending, phase: 'apply-update' })
          await api.applyUpdate(id)
        }
      })
      pendingInstalls.delete(id)
      return result
    }
    catch (reason) {
      const error = reason instanceof Error ? reason.message.match(/EXTENSION_[A-Z_]+/)?.[0] ?? 'EXTENSION_OPERATION_FAILED' : 'EXTENSION_OPERATION_FAILED'
      pendingInstalls.set(id, { ...pendingInstalls.get(id)!, error })
      throw reason
    }
  }

  function dismissInstall(id: string) {
    if (!busyIds.has(id))
      pendingInstalls.delete(id)
  }

  return { busyIds, pendingInstalls, runOperation, install, dismissInstall }
}
