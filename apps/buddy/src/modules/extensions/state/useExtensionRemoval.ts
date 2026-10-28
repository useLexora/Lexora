import type { ExtensionApi, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionCapabilityImpact } from '@buddy-shared/extensions/extensionCapabilities'
import { onScopeDispose, shallowRef } from 'vue'

export function useExtensionRemoval(options: {
  api: Pick<ExtensionApi, 'capabilityImpact' | 'uninstall'>
  run: (action: () => Promise<unknown>, id: string) => Promise<boolean>
  isBusy: (id: string) => boolean
  dismissInstall: (id: string) => void
}) {
  const removing = shallowRef<ExtensionStatus | null>(null)
  const removalImpact = shallowRef<ExtensionCapabilityImpact | null>(null)
  let revision = 0
  let disposed = false

  function cancel() {
    revision++
    removing.value = null
    removalImpact.value = null
  }

  async function askRemove(item: ExtensionStatus) {
    if (disposed || options.isBusy(item.manifest.id))
      return
    cancel()
    const current = revision
    await options.run(async () => {
      const impact = await options.api.capabilityImpact(item.manifest.id)
      if (!disposed && current === revision) {
        removing.value = item
        removalImpact.value = impact
      }
    }, item.manifest.id)
  }

  async function remove(clearData: boolean) {
    const item = removing.value
    const current = revision
    if (!item || !removalImpact.value)
      return
    const removed = await options.run(() => options.api.uninstall(item.manifest.id, { clearData }), item.manifest.id)
    if (removed) {
      options.dismissInstall(item.manifest.id)
      if (!disposed && current === revision)
        cancel()
    }
  }

  onScopeDispose(() => {
    disposed = true
    cancel()
  })
  return { removing, removalImpact, askRemove, remove, cancel }
}
