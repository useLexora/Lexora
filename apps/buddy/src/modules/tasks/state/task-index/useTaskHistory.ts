import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalConversation, LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { ConversationHistoryQuery, LocalConversationHistoryItem } from '@buddy-shared/conversation/conversationHistoryApi'
import type { LocalTaskMarkState } from '@buddy-shared/conversation/taskMarkApi'
import type { TaskHistory, TaskHistoryScopeState } from '../../contracts'
import { CONVERSATION_HISTORY_LOOKUP_LIMIT } from '@buddy-shared/conversation/conversationHistoryApi'
import { readonly, shallowRef } from 'vue'

const ENTRY_BATCH_WINDOW_MS = 16

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
  return right.lastActivityAt.localeCompare(left.lastActivityAt)
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
  const entryRequests = new Map<string, PromiseWithResolvers<void>>()
  const queuedEntries = new Set<string>()
  let entryFlush: ReturnType<typeof setTimeout> | null = null
  let attentionIds = new Set<string>()
  let pinnedIds = new Set<string>()
  let activeTaskId: string | null = null
  let attentionGeneration = 0
  let attentionPending: Promise<void> | null = null
  let disposed = false

  function merge(items: readonly LocalConversationHistoryItem[]) {
    for (const item of items) {
      const id = item.conversation.id
      if (item.conversation.archivedAt || item.conversation.deletedAt) {
        entries.delete(id)
        signatures.delete(id)
        attentionIds.delete(id)
        continue
      }
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
        nextIds.forEach(invalidateEntry)
        removed.forEach(invalidateEntry)
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

  function invalidateEntry(id: string) {
    if (entryRequests.has(id))
      queuedEntries.add(id)
  }

  async function flushEntries() {
    while (queuedEntries.size) {
      const batch = [...queuedEntries].slice(0, CONVERSATION_HISTORY_LOOKUP_LIMIT)
      batch.forEach(id => queuedEntries.delete(id))
      const attentionAtStart = attentionIds
      try {
        const result = await api.getHistoryEntries(batch)
        if (disposed)
          break
        const found = new Map(result.map(item => [item.conversation.id, item]))
        for (const id of batch) {
          const item = found.get(id)
          // A newer attention snapshot can rule out an unread row even for a previously unknown ID.
          if (item && attentionAtStart !== attentionIds && needsAttention(item) !== attentionIds.has(id))
            invalidateEntry(id)
          if (queuedEntries.has(id))
            continue
          if (item) {
            merge([item])
          }
          else {
            entries.delete(id)
            signatures.delete(id)
            attentionIds.delete(id)
            for (const scope of records.values())
              scope.ids = scope.ids.filter(value => value !== id)
          }
          entryRequests.get(id)!.resolve()
          entryRequests.delete(id)
        }
        publish()
      }
      catch (error) {
        for (const id of batch) {
          if (!queuedEntries.has(id)) {
            entryRequests.get(id)?.reject(error)
            entryRequests.delete(id)
          }
        }
      }
    }
    entryFlush = null
  }

  function refreshEntries(ids: readonly string[]): Promise<void> {
    if (disposed || !ids.length)
      return Promise.resolve()
    const requests = ids.map((id) => {
      let request = entryRequests.get(id)
      if (!request) {
        request = Promise.withResolvers<void>()
        entryRequests.set(id, request)
        queuedEntries.add(id)
      }
      return request.promise
    })
    entryFlush ??= setTimeout(() => void flushEntries(), ENTRY_BATCH_WINDOW_MS)
    return Promise.all(requests).then(() => {})
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
    const retained = new Set([...pinnedIds, ...(activeTaskId ? [activeTaskId] : [])])
    retained.forEach(invalidateEntry)
    await Promise.all([
      refreshAttention(),
      refreshScopes([...records.values()].map(scope => scope.spaceId)),
      refreshEntries([...retained]),
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
    invalidateEntry(conversation.id)
    const previous = entries.get(conversation.id)
    if (previous && !conversation.deletedAt && !conversation.archivedAt
      && previous.conversation.spaceId === conversation.spaceId
      && previous.conversation.updatedAt === conversation.updatedAt
      && (conversation.lastActivityAt === undefined || previous.conversation.lastActivityAt === conversation.lastActivityAt)
      && previous.conversation.activeBranchId === conversation.activeBranchId) {
      merge([{ ...previous, conversation: { ...previous.conversation, ...conversation } }])
      publish()
      return Promise.resolve()
    }
    attentionGeneration += 1
    invalidateScope(conversation.spaceId)
    if (previous) {
      invalidateScope(previous.conversation.spaceId)
      if (conversation.deletedAt || conversation.archivedAt) {
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
    invalidateEntry(state.conversationId)
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
    if (entryFlush !== null)
      clearTimeout(entryFlush)
    queuedEntries.clear()
    entryRequests.forEach(request => request.resolve())
    entryRequests.clear()
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
    async search(query, cursor) {
      const page = await api.listHistory({ kind: 'search', query, limit: 50, ...(cursor ? { cursor } : {}) })
      return { ...page, items: page.items.filter(item => !item.conversation.archivedAt && !item.conversation.deletedAt) }
    },
    recordAnchor: (section, value) => anchors.value = { ...anchors.value, [section]: value },
  }
  return { history, conversations: readonly(conversations), markStates: readonly(markStates), dispose, applyConversation, applyMarkState, ensureConversation, refreshAttention, refreshConversations, setPinnedIds, updateConversationBranch }
}
