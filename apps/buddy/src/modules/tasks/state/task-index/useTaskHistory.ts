import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalConversation, LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { ConversationHistoryQuery, LocalConversationHistoryItem } from '@buddy-shared/conversation/conversationHistoryApi'
import type { LocalTaskMarkState } from '@buddy-shared/conversation/taskMarkApi'
import type { TaskHistory, TaskHistoryScopeState } from '../../contracts'
import { readonly, shallowRef } from 'vue'

interface HistoryScope {
  spaceId: string | null
  ids: string[]
  cursor: string | null
  quota: number
  hasMore: boolean
  initialized: boolean
  dirty: boolean
  generation: number
  pending: Promise<void> | null
}

function scopeKey(spaceId: string | null) {
  return spaceId === null ? 'global' : `space:${spaceId}`
}

function needsAttention(item: LocalConversationHistoryItem) {
  return item.markState.markId !== null || item.markState.unread || item.conversation.activity !== 'idle'
}

function compareTasks(left: LocalConversationSummary, right: LocalConversationSummary) {
  return right.updatedAt.localeCompare(left.updatedAt)
    || right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id)
}

export function useTaskHistory(api: Pick<LocalChatApi['conversations'], 'listHistory' | 'getHistoryEntries'>) {
  const conversations = shallowRef<readonly LocalConversationSummary[]>([])
  const markStates = shallowRef<ReadonlyMap<string, LocalTaskMarkState>>(new Map())
  const scopes = shallowRef<ReadonlyMap<string, TaskHistoryScopeState>>(new Map())
  const anchors = shallowRef<TaskHistory['anchors']['value']>({ pinned: null, spaces: null, tasks: null })
  const entries = new Map<string, LocalConversationHistoryItem>()
  const signatures = new Map<string, string>()
  const records = new Map<string, HistoryScope>()
  const entryRequests = new Map<string, Promise<void>>()
  let attentionIds = new Set<string>()
  let pinnedIds = new Set<string>()
  let activeTaskId: string | null = null
  let attentionGeneration = 0
  let attentionPending: Promise<void> | null = null
  let entryGeneration = 0
  let disposed = false

  function merge(items: readonly LocalConversationHistoryItem[]) {
    for (const item of items) {
      const id = item.conversation.id
      const signature = JSON.stringify(item)
      if (signatures.get(id) === signature)
        continue
      const previous = entries.get(id)
      entries.set(id, {
        conversation: previous && JSON.stringify(previous.conversation) === JSON.stringify(item.conversation)
          ? previous.conversation
          : item.conversation,
        markState: previous && JSON.stringify(previous.markState) === JSON.stringify(item.markState)
          ? previous.markState
          : item.markState,
      })
      signatures.set(id, signature)
    }
  }

  function attentionCount(spaceId: string | null) {
    let count = 0
    for (const id of attentionIds) {
      if (!pinnedIds.has(id) && entries.get(id)?.conversation.spaceId === spaceId)
        count += 1
    }
    return count
  }

  function publish() {
    if (disposed)
      return
    const ids = new Set([...attentionIds, ...pinnedIds])
    if (activeTaskId)
      ids.add(activeTaskId)
    for (const scope of records.values()) {
      const ordinaryQuota = Math.max(0, scope.quota - attentionCount(scope.spaceId))
      const ordinaryIds = scope.ids.filter(id => !attentionIds.has(id) && !pinnedIds.has(id))
      for (const id of ordinaryIds.slice(0, ordinaryQuota))
        ids.add(id)
    }
    const next = [...ids].flatMap(id => entries.get(id)?.conversation ?? []).sort(compareTasks)
    if (next.length !== conversations.value.length || next.some((item, index) => item !== conversations.value[index]))
      conversations.value = next
    const nextStates = new Map(next.map(task => [task.id, entries.get(task.id)!.markState]))
    if (nextStates.size !== markStates.value.size || [...nextStates].some(([id, state]) => markStates.value.get(id) !== state))
      markStates.value = nextStates
  }

  function publishScope(scope: HistoryScope) {
    if (disposed)
      return
    const key = scopeKey(scope.spaceId)
    const value = { initialized: scope.initialized, loading: scope.pending !== null, hasMore: !scope.initialized || scope.hasMore }
    const previous = scopes.value.get(key)
    if (previous && previous.initialized === value.initialized && previous.loading === value.loading && previous.hasMore === value.hasMore)
      return
    scopes.value = new Map(scopes.value).set(key, value)
  }

  function getScope(spaceId: string | null) {
    const key = scopeKey(spaceId)
    let scope = records.get(key)
    if (!scope) {
      scope = { spaceId, ids: [], cursor: null, quota: spaceId === null ? 10 : 5, hasMore: true, initialized: false, dirty: true, generation: 0, pending: null }
      records.set(key, scope)
    }
    return scope
  }

  function readScope(scope: HistoryScope, more = false): Promise<void> {
    if (disposed)
      return Promise.resolve()
    if (scope.pending)
      return scope.pending
    if (!scope.dirty && scope.initialized && (!more || !scope.hasMore))
      return Promise.resolve()
    const expanding = more && scope.initialized
    const request = Promise.resolve().then(async () => {
      while (true) {
        if (disposed)
          return
        const generation = scope.generation
        const retainedCount = attentionCount(scope.spaceId)
        const quota = expanding ? Math.max(scope.quota, retainedCount) + 10 : scope.quota
        const ordinaryQuota = Math.max(0, quota - retainedCount)
        const append = !scope.dirty && scope.initialized
        const ids = append ? [...scope.ids] : []
        const collected: LocalConversationHistoryItem[] = []
        let cursor = append ? scope.cursor : null
        let hasMore = scope.hasMore
        try {
          do {
            const page = await api.listHistory({
              kind: 'ordinary',
              spaceId: scope.spaceId,
              excludeIds: [...pinnedIds].sort(),
              limit: Math.max(1, Math.min(100, ordinaryQuota - ids.length)),
              ...(cursor ? { cursor } : {}),
            })
            if (disposed)
              return
            if (generation !== scope.generation)
              break
            if (ordinaryQuota === 0) {
              hasMore = page.items.length > 0
              cursor = null
              break
            }
            collected.push(...page.items)
            ids.push(...page.items.map(item => item.conversation.id))
            cursor = page.nextCursor
            hasMore = cursor !== null
          } while (hasMore && ids.length < ordinaryQuota)
        }
        catch (error) {
          if (disposed)
            return
          if (generation !== scope.generation)
            continue
          throw error
        }
        if (generation !== scope.generation)
          continue
        merge(collected)
        scope.ids = [...new Set(ids)]
        scope.cursor = cursor
        scope.quota = quota
        scope.hasMore = hasMore
        scope.initialized = true
        scope.dirty = false
        publish()
        return
      }
    }).finally(() => {
      scope.pending = null
      publishScope(scope)
    })
    scope.pending = request
    publishScope(scope)
    return request
  }

  function invalidateScope(spaceId: string | null) {
    const scope = records.get(scopeKey(spaceId))
    if (!scope)
      return
    scope.generation += 1
    scope.dirty = true
  }

  async function refreshScopes(spaceIds: Iterable<string | null>) {
    const affected = [...new Set(spaceIds)]
    affected.forEach(invalidateScope)
    await Promise.all(affected.map(id => records.get(scopeKey(id))).filter((scope): scope is HistoryScope => !!scope).map(scope => readScope(scope)))
  }

  function refreshAttention(): Promise<void> {
    attentionGeneration += 1
    if (attentionPending)
      return attentionPending
    attentionPending = Promise.resolve().then(async () => {
      while (true) {
        if (disposed)
          return
        const generation = attentionGeneration
        const items: LocalConversationHistoryItem[] = []
        let cursor: string | null = null
        try {
          do {
            const query: ConversationHistoryQuery = { kind: 'attention', limit: 100, ...(cursor ? { cursor } : {}) }
            const page = await api.listHistory(query)
            if (disposed)
              return
            if (generation !== attentionGeneration)
              break
            items.push(...page.items)
            cursor = page.nextCursor
          } while (cursor)
        }
        catch (error) {
          if (disposed)
            return
          if (generation !== attentionGeneration)
            continue
          throw error
        }
        if (generation !== attentionGeneration)
          continue
        const nextIds = new Set(items.map(item => item.conversation.id))
        const affected = new Set<string | null>()
        for (const id of attentionIds) {
          if (!nextIds.has(id)) {
            const entry = entries.get(id)
            if (entry)
              affected.add(entry.conversation.spaceId)
          }
        }
        for (const item of items) {
          const previous = entries.get(item.conversation.id)
          if (!attentionIds.has(item.conversation.id) || previous?.conversation.spaceId !== item.conversation.spaceId) {
            affected.add(item.conversation.spaceId)
            if (previous)
              affected.add(previous.conversation.spaceId)
          }
        }
        const removed = [...attentionIds].filter(id => !nextIds.has(id))
        entryGeneration += 1
        affected.forEach(invalidateScope)
        merge(items)
        attentionIds = nextIds
        if (removed.length)
          await refreshEntries(removed)
        publish()
        await refreshScopes(affected)
        if (generation === attentionGeneration)
          return
      }
    }).finally(() => attentionPending = null)
    return attentionPending
  }

  function refreshEntries(ids: readonly string[]): Promise<void> {
    if (disposed || ids.length === 0)
      return Promise.resolve()
    const unique = [...new Set(ids)].sort()
    const key = JSON.stringify(unique)
    const pending = entryRequests.get(key)
    if (pending)
      return pending
    const request = Promise.resolve().then(async () => {
      for (let offset = 0; offset < unique.length; offset += 500) {
        const batch = unique.slice(offset, offset + 500)
        while (true) {
          if (disposed)
            return
          const generation = entryGeneration
          let result: readonly LocalConversationHistoryItem[]
          try {
            result = await api.getHistoryEntries(batch)
          }
          catch (error) {
            if (disposed)
              return
            if (generation !== entryGeneration)
              continue
            throw error
          }
          if (disposed)
            return
          if (generation !== entryGeneration)
            continue
          merge(result)
          const found = new Set(result.map(item => item.conversation.id))
          for (const id of batch) {
            if (!found.has(id)) {
              entries.delete(id)
              signatures.delete(id)
              attentionIds.delete(id)
              for (const scope of records.values())
                scope.ids = scope.ids.filter(value => value !== id)
            }
          }
          break
        }
      }
      publish()
    }).finally(() => entryRequests.delete(key))
    entryRequests.set(key, request)
    return request
  }

  async function ensureConversation(id: string) {
    if (!entries.has(id))
      await refreshEntries([id])
  }

  async function setActiveTask(id: string | null) {
    activeTaskId = id
    publish()
    if (id)
      await ensureConversation(id)
    publish()
  }

  async function setPinnedIds(ids: readonly string[]) {
    const next = new Set(ids)
    if (next.size === pinnedIds.size && ids.every(id => pinnedIds.has(id)))
      return
    pinnedIds = next
    publish()
    await Promise.all([
      refreshEntries([...next].filter(id => !entries.has(id))),
      refreshScopes([...records.values()].map(scope => scope.spaceId)),
    ])
  }

  async function refreshConversations() {
    await Promise.all([
      refreshAttention(),
      refreshScopes([...records.values()].map(scope => scope.spaceId)),
      refreshEntries([...new Set([...pinnedIds, ...(activeTaskId ? [activeTaskId] : [])])]),
      readScope(getScope(null)),
    ])
  }

  async function reconcileConversation(conversation: LocalConversation, previousSpaceId: string | null | undefined) {
    const affected = new Set([conversation.spaceId, ...(previousSpaceId !== undefined ? [previousSpaceId] : [])])
    await refreshEntries([conversation.id])
    const next = entries.get(conversation.id)
    if (next && needsAttention(next))
      attentionIds.add(conversation.id)
    else
      attentionIds.delete(conversation.id)
    publish()
    await refreshScopes(affected)
  }

  function applyConversation(conversation: LocalConversation) {
    if (disposed)
      return Promise.resolve()
    const previous = entries.get(conversation.id)
    if (previous && !conversation.deletedAt
      && previous.conversation.spaceId === conversation.spaceId
      && previous.conversation.updatedAt === conversation.updatedAt
      && previous.conversation.activeBranchId === conversation.activeBranchId) {
      merge([{ ...previous, conversation: { ...previous.conversation, ...conversation } }])
      publish()
      return Promise.resolve()
    }
    entryGeneration += 1
    attentionGeneration += 1
    invalidateScope(conversation.spaceId)
    if (previous) {
      invalidateScope(previous.conversation.spaceId)
      if (conversation.deletedAt) {
        entries.delete(conversation.id)
        signatures.delete(conversation.id)
        attentionIds.delete(conversation.id)
      }
      else {
        merge([{ ...previous, conversation: { ...previous.conversation, ...conversation } }])
      }
      publish()
    }
    return reconcileConversation(conversation, previous?.conversation.spaceId)
  }

  async function applyMarkState(state: LocalTaskMarkState) {
    if (disposed)
      return
    entryGeneration += 1
    attentionGeneration += 1
    const previous = entries.get(state.conversationId)
    if (!previous) {
      await refreshEntries([state.conversationId])
      if (disposed)
        return
      const entry = entries.get(state.conversationId)
      if (entry && needsAttention(entry))
        attentionIds.add(state.conversationId)
      publish()
      if (entry)
        await refreshScopes([entry.conversation.spaceId])
      return
    }
    const next = { ...previous, markState: state }
    const changedMembership = needsAttention(previous) !== needsAttention(next)
    merge([next])
    if (needsAttention(next))
      attentionIds.add(state.conversationId)
    else
      attentionIds.delete(state.conversationId)
    publish()
    if (changedMembership)
      await refreshScopes([previous.conversation.spaceId])
  }

  function updateConversationBranch(conversationId: string, branchId: string, updatedAt: string) {
    const previous = entries.get(conversationId)
    if (previous)
      return applyConversation({ ...previous.conversation, activeBranchId: branchId, updatedAt })
    return Promise.resolve()
  }

  function dispose() {
    disposed = true
    entryGeneration += 1
    attentionGeneration += 1
    for (const scope of records.values())
      scope.generation += 1
  }

  const history: TaskHistory = {
    scopes: readonly(scopes),
    anchors: readonly(anchors),
    ensureScope: spaceId => readScope(getScope(spaceId)),
    loadMore: spaceId => readScope(getScope(spaceId), true),
    setActiveTask,
    search: (query, cursor) => api.listHistory({ kind: 'search', query, limit: 50, ...(cursor ? { cursor } : {}) }),
    recordAnchor: (section, value) => anchors.value = { ...anchors.value, [section]: value },
  }
  return { history, conversations: readonly(conversations), markStates: readonly(markStates), dispose, applyConversation, applyMarkState, ensureConversation, refreshAttention, refreshConversations, setPinnedIds, updateConversationBranch }
}
