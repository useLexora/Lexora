import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { ChangeRecoveryResolveRequest, LocalChangeRecoveryItem } from '@buddy-shared/changes/changeApi'
import type { Ref } from 'vue'
import type { TaskChangeRecovery } from '../../contracts'
import { onScopeDispose, readonly, shallowRef, watch } from 'vue'

export function useChangeRecovery(options: {
  conversationId: Readonly<Ref<string | null>>
  ready: Readonly<Ref<boolean>>
  api: {
    changes: Pick<LocalChatApi['changes'], 'recovery' | 'onChanged'>
    chat: Pick<LocalChatApi['chat'], 'onRunEvent'>
  }
}): TaskChangeRecovery {
  const items = shallowRef<readonly LocalChangeRecoveryItem[]>([])
  const busy = shallowRef(false)
  const error = shallowRef<TaskChangeRecovery['error']['value']>(null)
  const waived = shallowRef(false)
  let generation = 0
  let requestId = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function scope() {
    const conversationId = options.conversationId.value
    if (disposed || !options.ready.value || !conversationId)
      return null
    const currentGeneration = generation
    const request = ++requestId
    return {
      conversationId,
      current: () => !disposed && currentGeneration === generation && request === requestId,
    }
  }

  async function refresh(): Promise<void> {
    if (busy.value)
      return
    const target = scope()
    if (!target)
      return
    try {
      const result = await options.api.changes.recovery.list({ conversationId: target.conversationId })
      if (target.current()) {
        items.value = result
        if (error.value === 'loadFailed')
          error.value = null
      }
    }
    catch {
      if (target.current())
        error.value = 'loadFailed'
    }
  }

  async function recheck(): Promise<void> {
    if (busy.value)
      return
    if (!items.value.length) {
      await refresh()
      return
    }
    const target = scope()
    if (!target)
      return
    const invocationIds = items.value.map(item => item.invocationId)
    busy.value = true
    error.value = null
    waived.value = false
    try {
      for (let offset = 0; offset < invocationIds.length; offset += 100) {
        const result = await options.api.changes.recovery.recheck({
          conversationId: target.conversationId,
          invocationIds: invocationIds.slice(offset, offset + 100),
        })
        if (!target.current())
          return
        items.value = result
      }
    }
    catch {
      if (target.current())
        error.value = 'recheckFailed'
    }
    finally {
      if (target.current())
        busy.value = false
    }
  }

  async function resolve(input: ChangeRecoveryResolveRequest): Promise<boolean> {
    if (busy.value || input.conversationId !== options.conversationId.value)
      return false
    const target = scope()
    if (!target)
      return false
    busy.value = true
    error.value = null
    waived.value = false
    try {
      const result = await options.api.changes.recovery.resolve(input)
      if (!target.current())
        return false
      items.value = result
      const unresolved = result.some(item => input.items.some(selected => selected.invocationId === item.invocationId))
      waived.value = !unresolved
      if (unresolved)
        error.value = 'resolveFailed'
      return !unresolved
    }
    catch {
      if (target.current())
        error.value = 'resolveFailed'
      return false
    }
    finally {
      if (target.current()) {
        busy.value = false
        scheduleRefresh()
      }
    }
  }

  function scheduleRefresh() {
    if (timer || disposed)
      return
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, 80)
  }

  const stopChanges = options.api.changes.onChanged(scheduleRefresh)
  const stopEvents = options.api.chat.onRunEvent((event) => {
    if (['tool.completed', 'tool.failed', 'run.completed', 'run.failed', 'run.cancelled'].includes(event.type))
      scheduleRefresh()
  })
  watch([options.conversationId, options.ready], () => {
    generation++
    items.value = []
    busy.value = false
    error.value = null
    waived.value = false
    void refresh()
  }, { immediate: true, flush: 'sync' })
  onScopeDispose(() => {
    disposed = true
    generation++
    clearTimeout(timer)
    stopChanges()
    stopEvents()
  })

  return {
    conversationId: options.conversationId,
    items: readonly(items),
    busy: readonly(busy),
    error: readonly(error),
    waived: readonly(waived),
    recheck,
    resolve,
    dismissWaived: () => { waived.value = false },
  }
}
