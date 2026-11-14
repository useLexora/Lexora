import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalTaskMark, LocalTaskMarkState, TaskMarkInput } from '@buddy-shared/conversation/taskMarkApi'
import type { Ref } from 'vue'
import type { TaskMarks } from '../../contracts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

interface TaskMarksOptions {
  api: LocalChatApi['taskMarks']
  conversations: Readonly<Ref<readonly LocalConversationSummary[]>>
  activeConversationId?: Readonly<Ref<string | null>>
  ready: Readonly<Ref<boolean>>
  language: Readonly<Ref<BuddyLocale>>
  stateSource?: Readonly<Ref<ReadonlyMap<string, LocalTaskMarkState>>>
  onStateChanged?: (state: LocalTaskMarkState) => void
  onMarkRemoved?: () => void
}

export function useTaskMarks(options: TaskMarksOptions): TaskMarks & { dispose: () => void } {
  const items = shallowRef<readonly LocalTaskMark[]>([])
  const states = shallowRef<ReadonlyMap<string, LocalTaskMarkState>>(new Map())
  const busy = shallowRef(false)
  const loading = shallowRef(false)
  const error = shallowRef<string | null>(null)
  const suppressed = new Map<string, string | null>()
  const reading = new Set<string>()
  let stopped = false
  let generation = 0
  let mutations = 0
  let refreshAgain = false
  let refreshPromise: Promise<void> | null = null
  let queue = Promise.resolve()

  function setError(value: unknown) {
    if (!stopped)
      error.value = resolveLocalChatErrorMessage(value, options.language.value)
  }

  function applyState(state: LocalTaskMarkState) {
    states.value = new Map(states.value).set(state.conversationId, state)
    options.onStateChanged?.(state)
  }

  async function applyMutationState(state: LocalTaskMarkState, previous: LocalTaskMarkState | undefined, assignment = false) {
    while (true) {
      if (stopped)
        return
      const current = states.value.get(state.conversationId)
      if (current === previous) {
        if (assignment)
          applyAssignment(state)
        else
          applyState(state)
        return
      }
      previous = current
      const [fresh] = await options.api.states([state.conversationId])
      if (!fresh)
        return
      state = fresh
    }
  }

  async function refresh(): Promise<void> {
    if (stopped || !options.ready.value)
      return
    if (mutations > 0 || refreshPromise) {
      refreshAgain = true
      return refreshPromise ?? Promise.resolve()
    }
    const current = ++generation
    const ids = [...new Set([
      ...options.conversations.value.map(item => item.id),
      ...(options.activeConversationId?.value ? [options.activeConversationId?.value] : []),
    ])]
    loading.value = true
    const readStates = async () => {
      const result: LocalTaskMarkState[] = []
      if (!options.stateSource) {
        for (let offset = 0; offset < ids.length; offset += 500)
          result.push(...await options.api.states(ids.slice(offset, offset + 500)))
      }
      return result
    }
    refreshPromise = Promise.all([options.api.list(), readStates()])
      .then(([marks, result]) => {
        if (stopped || current !== generation)
          return
        items.value = marks
        if (!options.stateSource)
          states.value = new Map(result.map(state => [state.conversationId, state]))
        error.value = null
      })
      .catch(setError)
      .finally(() => {
        refreshPromise = null
        if (stopped)
          return
        loading.value = false
        if (refreshAgain && mutations === 0) {
          refreshAgain = false
          void refresh()
        }
      })
    await refreshPromise
  }

  function mutate(operation: () => Promise<void>): Promise<boolean> {
    if (stopped || !options.ready.value)
      return Promise.resolve(false)
    generation += 1
    if (refreshPromise)
      refreshAgain = true
    mutations += 1
    busy.value = true
    const result = queue.then(async () => {
      if (stopped)
        return false
      error.value = null
      try {
        await operation()
        return !stopped
      }
      catch (cause) {
        setError(cause)
        return false
      }
      finally {
        mutations -= 1
        if (!stopped && mutations === 0) {
          busy.value = false
          if (refreshAgain) {
            refreshAgain = false
            void refresh()
          }
        }
      }
    })
    queue = result.then(() => {})
    return result
  }

  async function save(input: TaskMarkInput, id?: string, expectedRevision?: number): Promise<boolean> {
    const value = { name: input.name, description: input.description, color: input.color }
    return mutate(async () => {
      const mark = id ? await options.api.update({ ...value, id, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }) : await options.api.create(value)
      if (!stopped)
        items.value = id ? items.value.map(item => item.id === id ? mark : item) : [...items.value, mark]
    })
  }

  function remove(id: string, expectedRevision?: number): Promise<boolean> {
    return mutate(async () => {
      await options.api.delete(id, ...expectedRevision !== undefined ? [expectedRevision] as const : [])
      if (stopped)
        return
      items.value = items.value.filter(item => item.id !== id)
      states.value = new Map([...states.value].map(([key, state]) => [key, state.markId === id ? { ...state, markId: null } : state]))
      options.onMarkRemoved?.()
    })
  }

  function applyAssignment(state: LocalTaskMarkState) {
    const previousMarkId = states.value.get(state.conversationId)?.markId ?? null
    applyState(state)
    if (previousMarkId !== state.markId) {
      items.value = items.value.map(mark => ({
        ...mark,
        taskCount: Math.max(0, mark.taskCount + Number(mark.id === state.markId) - Number(mark.id === previousMarkId)),
      }))
    }
  }

  function assign(conversationId: string, markId: string | null): Promise<boolean> {
    const expectedAssignmentRevision = states.value.get(conversationId)?.assignmentRevision
    return mutate(async () => {
      const previous = states.value.get(conversationId)
      const state = await options.api.assign(conversationId, markId, ...expectedAssignmentRevision !== undefined ? [expectedAssignmentRevision] as const : [])
      await applyMutationState(state, previous, true)
    })
  }

  function clear(conversationId: string): Promise<boolean> {
    const state = states.value.get(conversationId)
    if (!state)
      return Promise.resolve(false)
    suppressed.delete(conversationId)
    return mutate(async () => {
      const previous = states.value.get(conversationId)
      const result = await options.api.clear({ conversationId, resultRunId: state.resultRunId, readRevision: state.readRevision, ...(state.assignmentRevision !== undefined ? { expectedAssignmentRevision: state.assignmentRevision } : {}) })
      await applyMutationState(result, previous, true)
    })
  }

  function setRead(conversationId: string, read: boolean): Promise<boolean> {
    const state = states.value.get(conversationId)
    if (!state)
      return Promise.resolve(false)
    if (!read)
      suppressed.set(conversationId, state.resultRunId)
    else suppressed.delete(conversationId)
    return mutate(async () => {
      const previous = states.value.get(conversationId)
      const result = await options.api.setRead({ conversationId, read, readRevision: state.readRevision, resultRunId: state.resultRunId })
      await applyMutationState(result, previous)
    })
  }

  async function readResult(conversationId: string, resultRunId: string, readRevision: number): Promise<void> {
    const state = states.value.get(conversationId)
    const key = `${conversationId}:${resultRunId}:${readRevision}`
    if (!state?.unread || state.resultRunId !== resultRunId || state.readRevision !== readRevision
      || reading.has(key) || suppressed.get(conversationId) === resultRunId) {
      return
    }
    reading.add(key)
    try {
      await mutate(async () => {
        if (suppressed.get(conversationId) === resultRunId)
          return
        const previous = states.value.get(conversationId)
        const result = await options.api.setRead({ conversationId, resultRunId, readRevision, read: true })
        await applyMutationState(result, previous)
      })
    }
    finally {
      reading.delete(key)
    }
  }

  const stopStateWatch = options.stateSource
    ? watch(options.stateSource, value => states.value = value, { immediate: true, flush: 'sync' })
    : () => {}
  const stopWatch = options.stateSource
    ? watch(options.ready, () => void refresh(), { immediate: true })
    : watch([options.ready, options.conversations, () => options.activeConversationId?.value], () => void refresh(), { immediate: true })
  function dispose() {
    stopped = true
    generation += 1
    stopWatch()
    stopStateWatch()
  }
  onScopeDispose(dispose, true)

  return {
    dispose,
    items: readonly(items),
    states: readonly(states),
    busy: readonly(busy),
    loading: readonly(loading),
    error: readonly(error),
    refresh,
    save,
    remove,
    assign,
    clear,
    setRead,
    readResult,
    beginVisit: conversationId => suppressed.delete(conversationId),
  }
}
