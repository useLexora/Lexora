import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { ApplicationSettings } from '@/modules/settings'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useTaskIndex } from '../useTaskIndex'
import { useTaskSpaces } from '../useTaskSpaces'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.useRealTimers()
})
function space(): LocalSpace {
  return { id: 'created', name: 'Created', icon: 'folder', iconColor: 'default', activeRunCount: 0, additionalDirectories: [], createdAt: '2026-09-08T00:00:00.000Z', memoryScope: 'space_only', primaryDirectory: null, revokedAt: null, updatedAt: '2026-09-08T00:00:00.000Z' }
}
function fixture() {
  const scope = effectScope()
  const paneScope = effectScope()
  scopes.push(scope, paneScope)
  const draftId = shallowRef('global-draft')
  const spaceId = shallowRef<string | null>(null)
  const creation = deferred<LocalSpace>()
  let savedSpaces: LocalSpace[] = []
  let savedTasks: LocalConversationSummary[] = [{ id: 'task', title: 'Task', activity: 'idle', activeBranchId: 'branch', spaceId: null, deletedAt: null, createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z', approvalPolicy: 'policy', executionProfile: 'workspace_write', modelSelection: null, automationOccurrence: null }]
  const listeners = new Set<(event: LocalRunEvent) => void>()
  const beforeDelete = vi.fn(async () => true)
  const deleted: string[] = []
  const listSpaces = vi.fn(async () => savedSpaces)
  const persistWorkspaceState = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  const errors: unknown[] = []
  const api = {
    spaces: { list: listSpaces, create: async () => {
      const value = await creation.promise
      savedSpaces = [value]
      return value
    }, update: async () => {
      savedSpaces = [space()]
      return savedSpaces[0]
    }, delete: async () => ({ ok: true }), selectDirectory: async () => null, revealFile: async () => {} },
    conversations: { list: async () => savedTasks, delete: async (id: string) => {
      savedTasks = savedTasks.filter(task => task.id !== id)
      return true
    } },
    chat: { onRunEvent: (listener: (event: LocalRunEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    } },
    taskMarks: { list: async () => [], states: async () => [] },
    workspaceState: { read: async () => null },
  } as unknown as LexoraDesktopApi['localChat']
  const index = scope.run(() => useTaskIndex({ api, applicationSettings: { config: shallowRef(null), language: shallowRef('zh-CN') } as unknown as ApplicationSettings, ready: shallowRef(true), beforeTaskDelete: beforeDelete, onTaskDeleted: id => deleted.push(id) }))!
  const owner = paneScope.run(() => useTaskSpaces({
    index,
    activateDraftScope: (id) => {
      spaceId.value = id
      draftId.value = `${id}-draft`
    },
    draftId,
    onError: error => errors.push(error),
    persistWorkspaceState,
    selectDefaultModel() {},
    spaceId,
  }))!
  return { index, creation, draftId, errors, owner, persistWorkspaceState, listSpaces, scope, paneScope, spaceId, beforeDelete, deleted, activity(value: LocalConversationSummary['activity']) {
    savedTasks = savedTasks.map(task => ({ ...task, activity: value }))
    for (const listener of listeners) listener({ type: 'approval.requested', runId: 'run', sequence: 1, payload: {}, createdAt: '2026-09-18T00:00:00Z' })
  } }
}
const input = { icon: 'folder' as const, iconColor: 'default' as const, name: 'Created', memoryScope: 'space_only' as const, primaryDirectory: null }

describe('shared task index ownership', () => {
  it('updates background task activity without an open task view', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.paneScope.stop()
    await f.index.initialize()
    expect(f.index.index.tasks.value[0]?.activity).toBe('idle')
    f.activity('awaiting_approval')
    await vi.advanceTimersByTimeAsync(100)
    expect(f.index.index.tasks.value[0]?.activity).toBe('awaiting_approval')
  })
  it('preserves the task when closing its working copies is cancelled', async () => {
    const f = fixture()
    await f.index.initialize()
    f.beforeDelete.mockResolvedValueOnce(false)
    await f.index.index.deleteTask('task')
    expect(f.index.index.tasks.value.map(task => task.id)).toEqual(['task'])
    expect(f.deleted).toEqual([])
    await f.index.index.deleteTask('task')
    expect(f.index.index.tasks.value).toEqual([])
    expect(f.deleted).toEqual(['task'])
  })
  it('retains a successful update when the subsequent index refresh fails', async () => {
    const f = fixture()
    f.listSpaces.mockRejectedValueOnce(new Error('refresh unavailable'))
    expect(await f.index.index.updateSpace({ ...input, spaceId: 'created' })).toBe(true)
    expect(f.index.index.spaces.value.map(space => space.name)).toEqual(['Created'])
    expect(f.index.errorMessage.value).not.toBeNull()
  })
  it('does not surface an old persistence failure in another draft', async () => {
    const f = fixture()
    const persistence = deferred<boolean>()
    f.index.data.applySpace(space())
    f.persistWorkspaceState.mockReturnValueOnce(persistence.promise)
    const activating = f.owner.activateSpaceDraft('created')
    f.draftId.value = 'other-draft'
    persistence.reject(new Error('old persistence failed'))
    await activating
    expect(f.draftId.value).toBe('other-draft')
    expect(f.errors).toEqual([])
  })
  it('retains a successful creation when refreshing the index fails', async () => {
    const f = fixture()
    f.listSpaces.mockRejectedValueOnce(new Error('refresh unavailable'))
    const creating = f.owner.createSpace(input)
    f.creation.resolve(space())
    expect(await creating).toBe(true)
    expect(f.index.index.spaces.value.map(space => space.id)).toEqual(['created'])
    expect(f.spaceId.value).toBe('created')
    expect(f.index.errorMessage.value).not.toBeNull()
  })
  it('adds a saved Space without taking over another draft', async () => {
    const f = fixture()
    const creating = f.owner.createSpace(input)
    f.draftId.value = 'other-draft'
    f.creation.resolve(space())
    expect(await creating).toBe(true)
    expect(f.index.index.spaces.value.map(space => space.id)).toEqual(['created'])
    expect(f.spaceId.value).toBeNull()
  })
  it('does not replace a newer Space selection in the same stable draft', async () => {
    const f = fixture()
    const creating = f.owner.createSpace(input)
    f.spaceId.value = 'newer-space'
    f.creation.resolve(space())
    expect(await creating).toBe(true)
    expect(f.index.index.spaces.value.map(space => space.id)).toEqual(['created'])
    expect(f.draftId.value).toBe('global-draft')
    expect(f.spaceId.value).toBe('newer-space')
  })
  it('keeps the shared result after closing the originating pane', async () => {
    const f = fixture()
    const creating = f.owner.createSpace(input)
    f.paneScope.stop()
    f.creation.resolve(space())
    expect(await creating).toBe(true)
    expect(f.index.index.spaces.value.map(space => space.id)).toEqual(['created'])
    expect(f.draftId.value).toBe('global-draft')
  })
  it('does not publish late results after the whole workspace is disposed', async () => {
    const f = fixture()
    const creating = f.owner.createSpace(input)
    f.paneScope.stop()
    f.scope.stop()
    f.creation.resolve(space())
    expect(await creating).toBe(true)
    expect(f.index.index.spaces.value).toEqual([])
  })
})
