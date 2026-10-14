import type { SessionReferenceAccessList } from '@buddy-shared/conversation/sessionReferenceAccess'
import type { Ref } from 'vue'
import type { TaskChatWorkspace } from '../../contracts'
import { onScopeDispose, shallowRef, watch } from 'vue'

export function useSessionReferenceAccess(options: {
  api: TaskChatWorkspace['context']['references']
  scope: Readonly<Ref<{ conversationId: string, branchId: string } | null>>
  enabled: Readonly<Ref<boolean>>
}) {
  const data = shallowRef<SessionReferenceAccessList | null>(null)
  const loading = shallowRef(false)
  const pending = shallowRef<string | null>(null)
  const failed = shallowRef(false)
  let generation = 0

  async function refresh(): Promise<void> {
    const scope = options.scope.value
    if (!scope || !options.enabled.value || pending.value)
      return
    const ticket = ++generation
    loading.value = true
    try {
      const next = await options.api.listReferenceAccess({ ...scope })
      if (ticket === generation) {
        data.value = next
        failed.value = false
      }
    }
    catch {
      if (ticket === generation)
        failed.value = true
    }
    finally {
      if (ticket === generation)
        loading.value = false
    }
  }

  async function setExcluded(sessionId: string, excluded: boolean): Promise<void> {
    const scope = options.scope.value
    if (!scope || pending.value)
      return
    const ticket = ++generation
    pending.value = sessionId
    failed.value = false
    try {
      const next = await options.api.setReferenceExcluded({ ...scope, sessionId, excluded })
      if (ticket === generation)
        data.value = next
    }
    catch {
      if (ticket === generation)
        failed.value = true
    }
    finally {
      if (ticket === generation) {
        pending.value = null
        loading.value = false
      }
    }
  }

  watch(options.scope, () => {
    generation++
    data.value = null
    pending.value = null
    loading.value = false
    failed.value = false
    void refresh()
  }, { flush: 'sync' })
  watch(options.enabled, (enabled) => {
    if (enabled) {
      void refresh()
    }
    else if (!pending.value) {
      generation++
      loading.value = false
    }
  })
  onScopeDispose(options.api.onChanged(() => void refresh()))
  onScopeDispose(() => generation++)
  return { data, loading, pending, failed, refresh, setExcluded }
}
