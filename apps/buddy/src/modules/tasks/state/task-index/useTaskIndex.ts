import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { Ref } from 'vue'
import type { TaskIndex } from '../../contracts'
import type { TaskSpaceInput } from './typing'
import type { ApplicationSettings } from '@/modules/settings'
import { useDebounceFn } from '@vueuse/core'
import { onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import { migrateLegacyTaskDrafts } from '../drafts/migrateLegacyTaskDrafts'
import { createTaskArchiveActions } from './createTaskArchiveActions'
import { useTaskActivities } from './useTaskActivities'
import { useTaskIndexData } from './useTaskIndexData'
import { useTaskMarks } from './useTaskMarks'
import { useTaskPinnedItems } from './useTaskPinnedItems'
import { useTaskSidebarPreferences } from './useTaskSidebarPreferences'

interface TaskIndexOptions {
  api: LexoraDesktopApi['localChat']
  applicationSettings: ApplicationSettings
  ready: Readonly<Ref<boolean>>
  beforeTaskDelete?: (id: string) => Promise<boolean>
  beforeTaskMove?: (id: string) => Promise<boolean>
  onTaskDeleted?: (id: string) => void
  onSpaceCreated?: (id: string) => Promise<void>
}

const activityEvents = new Set(['approval.requested', 'approval.resolved', 'run.cancelled', 'run.completed', 'run.failed', 'run.started'])

export function useTaskIndex(options: TaskIndexOptions) {
  const { api, applicationSettings } = options
  const errorMessage = shallowRef<string | null>(null)
  let disposed = false
  function setError(error: unknown) {
    if (!disposed)
      errorMessage.value = resolveLocalChatErrorMessage(error, applicationSettings.language.value)
  }
  const data = useTaskIndexData({ api, onError: setError })
  const activity = useTaskActivities({ api: api.executions, tasks: data.conversations, onError: setError })
  const stopConversationChanges = api.conversations.onChanged(conversation => data.applyConversation(conversation))
  const pins = useTaskPinnedItems(applicationSettings)
  const sidebar = useTaskSidebarPreferences(applicationSettings)
  const marks = useTaskMarks({
    api: api.taskMarks,
    conversations: data.conversations,
    language: applicationSettings.language,
    ready: options.ready,
    stateSource: data.markStates,
    onStateChanged: state => void data.applyMarkState(state).catch(setError),
    onMarkRemoved: () => void data.refreshAttention().catch(setError),
  })
  const stopPins = watch(pins.pinnedItems, (value) => {
    void data.setPinnedIds(value.filter(item => item.kind === 'conversation').map(item => item.id)).catch(setError)
  }, { immediate: true })
  async function refreshAfterMutation() {
    await data.refreshIndex().catch(setError)
  }
  async function createSpace(input: TaskSpaceInput): Promise<LocalSpace | null> {
    try {
      const space = await api.spaces.create(input)
      if (!disposed) {
        data.applySpace(space)
        await refreshAfterMutation()
      }
      return space
    }
    catch (error) {
      setError(error)
      return null
    }
  }
  const index: TaskIndex = {
    archive: createTaskArchiveActions({
      api: api.conversations,
      ready: options.ready,
      beforeClose: options.beforeTaskDelete,
      onClosed: id => !disposed && options.onTaskDeleted?.(id),
      refresh: refreshAfterMutation,
    }),
    activities: activity.activities,
    history: data.history,
    marks,
    pinnedItems: pins.pinnedItems,
    setPinnedItems: pins.setPinnedItems,
    sidebar,
    spaces: data.spaces,
    tasks: data.conversations,
    refresh: data.refreshIndex,
    async createSpace(input) {
      const space = await createSpace(input)
      if (space && !disposed)
        await options.onSpaceCreated?.(space.id)
      return !!space
    },
    async updateSpace(input) {
      try {
        const space = await api.spaces.update(input)
        if (!disposed) {
          data.applySpace(space)
          await refreshAfterMutation()
        }
        return true
      }
      catch (error) {
        setError(error)
        return false
      }
    },
    async deleteSpace(id) {
      try {
        await api.spaces.delete(id)
        await refreshAfterMutation()
        return true
      }
      catch (error) {
        setError(error)
        return false
      }
    },
    async deleteTask(id, expectedRevision) {
      if (!options.ready.value || expectedRevision === undefined)
        return
      try {
        if (options.beforeTaskDelete && !await options.beforeTaskDelete(id))
          return
        if (!options.ready.value || !await api.conversations.deletePermanently(id, expectedRevision))
          return
        if (!disposed)
          options.onTaskDeleted?.(id)
        await Promise.all([data.refreshConversations(), marks.refresh()]).catch(setError)
      }
      catch (error) {
        setError(error)
      }
    },
    async renameTask(id, title) {
      try {
        const conversation = await api.conversations.rename(id, title)
        if (!disposed)
          data.applyConversation(conversation)
        return true
      }
      catch (error) {
        setError(error)
        return false
      }
    },
    async moveTaskToSpace(id, spaceId) {
      if (options.beforeTaskMove && !await options.beforeTaskMove(id))
        return false
      const conversation = await api.conversations.moveToSpace(id, spaceId)
      if (!disposed)
        data.applyConversation(conversation)
      return true
    },
    async selectSpaceDirectory() {
      try {
        return await api.spaces.selectDirectory()
      }
      catch (error) {
        setError(error)
        return null
      }
    },
    async openSpaceDirectory(spaceId) {
      const directory = data.spaces.value.find(space => space.id === spaceId && !space.revokedAt)?.primaryDirectory
      if (!directory || directory.revokedAt)
        return false
      try {
        await api.spaces.revealFile({ spaceId, directoryId: directory.id, revision: directory.revision, path: '' })
        return true
      }
      catch (error) {
        setError(error)
        return false
      }
    },
  }
  const refreshActivity = useDebounceFn(() => disposed ? undefined : data.refreshAttention().catch(setError), 100)
  const spaceRevisions = new Map<string, number>()
  const refreshSpaces = useDebounceFn(() => disposed ? undefined : data.refreshSpaces().catch(setError), 50)
  const stopSpaceChanges = api.spaces.onChanged((event) => {
    if (disposed || (spaceRevisions.get(event.sourceId) ?? 0) >= event.revision)
      return
    spaceRevisions.set(event.sourceId, event.revision)
    if (spaceRevisions.size > 16)
      spaceRevisions.delete(spaceRevisions.keys().next().value!)
    void refreshSpaces()
  })
  const stopEvents = api.chat.onRunEvent((event) => {
    if (activityEvents.has(event.type))
      void refreshActivity()
  })
  function dispose() {
    disposed = true
    stopEvents()
    activity.dispose()
    stopConversationChanges()
    stopSpaceChanges()
    stopPins()
    marks.dispose()
    data.dispose()
  }
  onScopeDispose(dispose, true)
  async function initialize() {
    await data.initialize()
    await migrateLegacyTaskDrafts(api, data.conversations.value)
  }
  return { index, data, createSpace, initialize, refresh: data.refreshIndex, dispose, errorMessage: readonly(errorMessage), dismissError: () => errorMessage.value = null }
}

export type TaskIndexController = ReturnType<typeof useTaskIndex>
