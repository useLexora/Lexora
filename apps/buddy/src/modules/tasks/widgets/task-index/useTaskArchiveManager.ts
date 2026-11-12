import type { ConversationArchiveItem } from '@buddy-shared/conversation/conversationArchiveApi'
import type { TaskArchiveActions } from '../../contracts'
import { onScopeDispose, shallowRef, watch } from 'vue'

export interface ArchiveDeleteResult {
  item: ConversationArchiveItem
  status: 'submitted' | 'failed'
  error: string | null
}

export function useTaskArchiveManager(options: {
  actions: () => TaskArchiveActions
  show: () => boolean
  errorMessage: (error: unknown) => string
  notDeletedMessage: () => string
}) {
  const query = shallowRef('')
  const spaceId = shallowRef<string | null | undefined>(undefined)
  const items = shallowRef<readonly ConversationArchiveItem[]>([])
  const cursor = shallowRef<string | null>(null)
  const loading = shallowRef(false)
  const busy = shallowRef(false)
  const error = shallowRef<string | null>(null)
  const results = shallowRef<readonly ArchiveDeleteResult[]>([])
  let generation = 0
  let disposed = false
  let pendingRefresh: ReturnType<typeof setTimeout> | undefined

  async function load(more = false) {
    clearTimeout(pendingRefresh)
    const token = ++generation
    const actions = options.actions()
    if (!options.show() || !actions.ready.value) {
      loading.value = false
      return
    }
    loading.value = true
    error.value = null
    const request = { kind: 'managed' as const, query: query.value.trim(), ...(spaceId.value === undefined ? {} : { spaceId: spaceId.value }), limit: 50, ...(more && cursor.value ? { cursor: cursor.value } : {}) }
    try {
      let page = await actions.list(request)
      const visible = [...page.items]
      if (!more) {
        while (visible.length < items.value.length && page.nextCursor) {
          if (disposed || token !== generation)
            return
          page = await actions.list({ ...request, cursor: page.nextCursor })
          visible.push(...page.items)
        }
      }
      if (disposed || token !== generation)
        return
      items.value = more ? [...items.value, ...visible.filter(item => !items.value.some(old => old.id === item.id))] : visible
      cursor.value = page.nextCursor
    }
    catch (cause) {
      if (!disposed && token === generation)
        error.value = options.errorMessage(cause)
    }
    finally {
      if (!disposed && token === generation) {
        loading.value = false
        if (items.value.some(item => item.deletionStatus === 'pending')) {
          pendingRefresh = setTimeout(function refresh() {
            if (disposed)
              return
            if (busy.value)
              pendingRefresh = setTimeout(refresh, 1500)
            else
              void load()
          }, 1500)
        }
      }
    }
  }

  watch(options.actions, (actions, _, cleanup) => {
    cleanup(actions.onChanged(() => {
      if (!busy.value)
        void load()
    }))
  }, { immediate: true })

  watch([options.show, () => options.actions(), () => options.actions().ready.value, query, spaceId], () => {
    items.value = []
    cursor.value = null
    void load()
  }, { immediate: true, flush: 'sync' })

  async function snapshotSpace(spaceId: string | null): Promise<readonly ConversationArchiveItem[] | null> {
    const actions = options.actions()
    if (busy.value || !actions.ready.value)
      return null
    busy.value = true
    error.value = null
    const targets = new Map<string, ConversationArchiveItem>()
    let nextCursor: string | null = null
    try {
      do {
        const page = await actions.list({ kind: 'managed', spaceId, limit: 100, ...(nextCursor ? { cursor: nextCursor } : {}) })
        if (disposed || !options.show() || !actions.ready.value || options.actions() !== actions)
          return null
        for (const item of page.items) {
          if (item.archivedAt && item.deletionStatus !== 'pending')
            targets.set(item.id, { ...item })
        }
        nextCursor = page.nextCursor
      } while (nextCursor)
      return [...targets.values()]
    }
    catch (cause) {
      if (!disposed && options.actions() === actions)
        error.value = options.errorMessage(cause)
      return null
    }
    finally {
      if (!disposed)
        busy.value = false
    }
  }

  async function deleteBatch(batch: readonly ConversationArchiveItem[]) {
    if (busy.value || !options.actions().ready.value)
      return
    const actions = options.actions()
    const targets = batch.map(item => ({ ...item }))
    const outcomes: ArchiveDeleteResult[] = []
    busy.value = true
    results.value = []
    try {
      for (const item of targets) {
        try {
          const submitted = actions.ready.value && await actions.delete(item.id, item.metadataRevision)
          outcomes.push({ item, status: submitted ? 'submitted' : 'failed', error: submitted ? null : options.notDeletedMessage() })
        }
        catch (cause) {
          outcomes.push({ item, status: 'failed', error: options.errorMessage(cause) })
        }
        if (!disposed && options.actions() === actions)
          results.value = [...outcomes]
      }
      if (!disposed && options.actions() === actions)
        await load()
    }
    finally {
      if (!disposed)
        busy.value = false
    }
  }

  async function restore(item: ConversationArchiveItem) {
    if (busy.value || !options.actions().ready.value)
      return
    busy.value = true
    const token = generation
    try {
      if (!await options.actions().restore(item.id, item.metadataRevision)) {
        if (!disposed && token === generation)
          error.value = options.notDeletedMessage()
        return
      }
      if (!disposed && token === generation)
        await load()
    }
    catch (cause) {
      if (!disposed && token === generation)
        error.value = options.errorMessage(cause)
    }
    finally {
      if (!disposed)
        busy.value = false
    }
  }
  onScopeDispose(() => {
    disposed = true
    clearTimeout(pendingRefresh)
    generation += 1
  })
  return { query, spaceId, items, cursor, loading, busy, error, results, load, snapshotSpace, deleteBatch, restore }
}
