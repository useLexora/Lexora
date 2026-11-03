import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { UserQuestionAnswer, UserQuestionRequest } from '@buddy-shared/questions/userQuestionApi'
import type { Ref } from 'vue'
import { validateUserQuestionResponse } from '@buddy-shared/questions/userQuestionApi'
import { projectUserQuestionHistory } from '@buddy-shared/questions/userQuestionHistory'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { createUserQuestionInteractionState } from './userQuestionInteraction'

export { createUserQuestionInteractionState } from './userQuestionInteraction'

export function useUserQuestions(options: {
  interaction?: ReturnType<typeof createUserQuestionInteractionState>
  api: LocalChatApi['questions']
  conversationId: Readonly<Ref<string | null>>
  branchId: Readonly<Ref<string | null>>
  ready: Readonly<Ref<boolean>>
}) {
  const records = shallowRef<UserQuestionRequest[]>([])
  const pending = computed(() => records.value.filter(record => record.status === 'pending'))
  const history = computed(() => records.value.flatMap((record) => {
    const entry = projectUserQuestionHistory(record)
    return entry ? [entry] : []
  }).toReversed())
  const { drafts, expandedIds, selectedByScope, selectedQuestionIds, resolvingIds, errors } = options.interaction ?? createUserQuestionInteractionState()
  const loadError = shallowRef(false)
  const scopeKey = computed(() => JSON.stringify([options.conversationId.value, options.branchId.value]))
  const selected = computed(() => pending.value.find(request => request.id === selectedByScope.value.get(scopeKey.value)) ?? pending.value[0] ?? null)
  function select(requestId: string) {
    if (pending.value.some(request => request.id === requestId))
      selectedByScope.value = new Map(selectedByScope.value).set(scopeKey.value, requestId)
  }
  function selectQuestion(requestId: string, questionId: string) {
    if (resolvingIds.value.has(requestId) || !pending.value.some(request => request.id === requestId && request.questions.some(question => question.id === questionId)))
      return
    selectedQuestionIds.value = new Map(selectedQuestionIds.value).set(requestId, questionId)
  }
  let generation = 0
  let disposed = false

  function toggle(set: Ref<Set<string>>, id: string, value = !set.value.has(id)) {
    const next = new Set(set.value)
    if (value)
      next.add(id)
    else
      next.delete(id)
    set.value = next
  }
  function adopt(value: UserQuestionRequest[]) {
    const previous = new Map(records.value.map(record => [record.id, record]))
    value = value.map((record) => {
      const known = previous.get(record.id)
      return known && ((known.status !== 'pending' && record.status === 'pending') || known.delivery?.state === 'delivered') ? known : record
    })
    const nextDrafts = new Map(drafts.value)
    const nextQuestionIds = new Map(selectedQuestionIds.value)
    for (const record of value) {
      if (record.status !== 'pending') {
        nextDrafts.delete(record.id)
        nextQuestionIds.delete(record.id)
        toggle(errors, record.id, false)
        toggle(expandedIds, record.id, false)
        continue
      }
      if (!record.questions.some(question => question.id === nextQuestionIds.get(record.id)) && record.questions[0])
        nextQuestionIds.set(record.id, record.questions[0].id)
      if (!nextDrafts.has(record.id)) {
        nextDrafts.set(record.id, record.questions.map(question => ({ questionId: question.id, selectedOptionIds: [], text: '' })))
        if (record.status === 'pending')
          toggle(expandedIds, record.id, true)
      }
    }
    drafts.value = nextDrafts
    selectedQuestionIds.value = nextQuestionIds
    records.value = value
  }
  async function refresh() {
    const conversationId = options.conversationId.value
    const branchId = options.branchId.value
    const current = ++generation
    if (!conversationId || !branchId || !options.ready.value)
      return
    try {
      const value = await options.api.list({ conversationId, branchId })
      if (!disposed && current === generation) {
        adopt(value)
        loadError.value = false
      }
    }
    catch {
      if (!disposed && current === generation)
        loadError.value = true
    }
  }
  const stop = options.api.onChanged((event) => {
    if (event.conversationId === options.conversationId.value && event.branchId === options.branchId.value)
      void refresh()
  })
  watch(() => [options.conversationId.value, options.branchId.value, options.ready.value] as const, (value, previous) => {
    if (value[0] !== previous?.[0] || value[1] !== previous?.[1]) {
      records.value = []
      loadError.value = false
    }
    void refresh()
  }, { immediate: true })
  onScopeDispose(() => {
    disposed = true
    generation++
    stop()
  })

  function updateAnswer(requestId: string, answer: UserQuestionAnswer) {
    if (resolvingIds.value.has(requestId) || !pending.value.some(record => record.id === requestId))
      return
    drafts.value = new Map(drafts.value).set(requestId, (drafts.value.get(requestId) ?? []).map(value => value.questionId === answer.questionId ? answer : value))
    toggle(errors, requestId, false)
  }
  async function resolve(requestId: string, answer: boolean): Promise<boolean> {
    const request = pending.value.find(record => record.id === requestId)
    if (!request || resolvingIds.value.has(requestId) || !options.ready.value)
      return false
    toggle(resolvingIds, requestId, true)
    toggle(errors, requestId, false)
    const ownsScope = () => !disposed && options.conversationId.value === request.conversationId && options.branchId.value === request.branchId
    try {
      const target = { conversationId: request.conversationId, branchId: request.branchId, requestId }
      const result = answer ? await options.api.answer({ ...target, ...validateUserQuestionResponse(request.questions, { answers: drafts.value.get(requestId) ?? [] }) }) : await options.api.cancel(target)
      if (ownsScope()) {
        adopt(records.value.map(record => record.id === result.id ? result : record))
      }
      return true
    }
    catch {
      toggle(errors, requestId, true)
      if (ownsScope())
        await refresh()
      return false
    }
    finally { toggle(resolvingIds, requestId, false) }
  }
  async function retry(requestId: string) {
    const request = records.value.find(record => record.id === requestId)
    if (!request || resolvingIds.value.has(requestId))
      return
    toggle(resolvingIds, requestId, true)
    try {
      await options.api.retry({ conversationId: request.conversationId, branchId: request.branchId, requestId })
      await refresh()
    }
    catch { await refresh() }
    finally { toggle(resolvingIds, requestId, false) }
  }
  return { retry, records, pending, history, drafts, expandedIds, selectedQuestionIds, selectQuestion, resolvingIds, errors, loadError, selected, select, ready: options.ready, updateAnswer, toggleExpanded: (id: string) => toggle(expandedIds, id), resolve, refresh }
}
export type UserQuestionsController = ReturnType<typeof useUserQuestions>
