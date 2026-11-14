import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { Ref } from 'vue'
import type { TaskActivity } from '../../contracts'
import { useDebounceFn } from '@vueuse/core'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'

interface ActivityScope {
  version: number
}

export function useTaskActivities(options: {
  api: Pick<LexoraDesktopApi['localChat']['executions'], 'activity' | 'onChanged'>
  tasks: Readonly<Ref<readonly LocalConversationSummary[]>>
  onError: (error: unknown) => void
}) {
  const waiting = shallowRef<ReadonlySet<string>>(new Set())
  const scopes = new Map<string, ActivityScope>()
  const pending = new Set<string>()
  let disposed = false

  function setWaiting(id: string, value: boolean) {
    if (waiting.value.has(id) === value)
      return
    const next = new Set(waiting.value)
    if (value)
      next.add(id)
    else
      next.delete(id)
    waiting.value = next
  }

  async function refresh(id: string) {
    const scope = scopes.get(id)
    if (!scope || disposed)
      return
    const version = ++scope.version
    const current = () => !disposed && scopes.get(id) === scope && scope.version === version
    try {
      const activity = await options.api.activity({ conversationId: id })
      if (current())
        setWaiting(id, activity.hasBlockingAnswer)
    }
    catch (error) {
      if (current()) {
        setWaiting(id, false)
        options.onError(error)
      }
    }
  }

  const flush = useDebounceFn(() => {
    const ids = [...pending]
    pending.clear()
    for (const id of ids)
      void refresh(id)
  }, 100, { maxWait: 500 })
  const stopChanges = options.api.onChanged((event) => {
    const scope = scopes.get(event.conversationId)
    if (!scope || disposed)
      return
    scope.version++
    pending.add(event.conversationId)
    void flush()
  })
  const stopTasks = watch(() => options.tasks.value.filter(task => task.activity === 'running'), (tasks) => {
    const active = new Set(tasks.map(task => task.id))
    for (const id of scopes.keys()) {
      if (!active.has(id)) {
        scopes.delete(id)
        pending.delete(id)
        setWaiting(id, false)
      }
    }
    for (const task of tasks) {
      if (scopes.has(task.id))
        continue
      scopes.set(task.id, { version: 0 })
      setWaiting(task.id, false)
      void refresh(task.id)
    }
  }, { immediate: true })

  function dispose() {
    disposed = true
    stopChanges()
    stopTasks()
    scopes.clear()
    pending.clear()
  }
  onScopeDispose(dispose, true)

  const activities = computed<ReadonlyMap<string, TaskActivity>>(() => new Map(options.tasks.value.map(task => [
    task.id,
    task.activity === 'running' && waiting.value.has(task.id) ? 'awaiting_answer' : task.activity,
  ])))
  return { activities, dispose }
}
