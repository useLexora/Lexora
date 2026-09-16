import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { deferred } from '../../../../../../__tests__/deferred'
import { useTaskSpaces } from '../useTaskSpaces'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function space(): LocalSpace {
  return { id: 'created', name: 'Created', icon: 'folder', iconColor: 'default', activeRunCount: 0, additionalDirectories: [], createdAt: '2026-09-08T00:00:00.000Z', memoryScope: 'space_only', primaryDirectory: null, revokedAt: null, updatedAt: '2026-09-08T00:00:00.000Z' }
}
function fixture() {
  const scope = effectScope()
  scopes.push(scope)
  const draftId = shallowRef('global-draft')
  const spaceId = shallowRef<string | null>(null)
  const spaces = shallowRef<readonly LocalSpace[]>([])
  const creation = deferred<LocalSpace>()
  const refreshIndex = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const persistWorkspaceState = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  const errors: unknown[] = []
  const owner = scope.run(() => useTaskSpaces({
    api: { create: () => creation.promise, update: async () => space(), delete: async () => ({ ok: true }), selectDirectory: async () => null, revealFile: async () => {} },
    activateDraftScope: (id) => {
      spaceId.value = id
      draftId.value = `${id}-draft`
    },
    applySpace: (value) => { spaces.value = [value] },
    drafts: { discard: async () => {} },
    draftId,
    onError: error => errors.push(error),
    persistWorkspaceState,
    refreshIndex,
    selectDefaultModel() {},
    spaceId,
    spaces,
  }))!
  return { creation, draftId, errors, owner, persistWorkspaceState, refreshIndex, scope, spaceId, spaces }
}
const input = { icon: 'folder' as const, iconColor: 'default' as const, name: 'Created', memoryScope: 'space_only' as const, primaryDirectory: null }

describe('space mutation results', () => {
  it('retains a successful update when the subsequent index refresh fails', async () => {
    const f = fixture()
    f.refreshIndex.mockRejectedValueOnce(new Error('refresh unavailable'))
    expect(await f.owner.updateSpace({ ...input, spaceId: 'created' })).toBe(true)
    expect(f.spaces.value.map(space => space.name)).toEqual(['Created'])
    expect(f.errors).toHaveLength(1)
  })

  it('does not surface an old workspace persistence failure in another draft', async () => {
    const f = fixture()
    const persistence = deferred<boolean>()
    f.spaces.value = [space()]
    f.persistWorkspaceState.mockReturnValueOnce(persistence.promise)
    const activating = f.owner.activateSpaceDraft('created')
    f.draftId.value = 'other-draft'
    persistence.reject(new Error('old persistence failed'))
    await activating
    expect(f.draftId.value).toBe('other-draft')
    expect(f.errors).toEqual([])
  })

  it('retains a successful creation when the subsequent index refresh fails', async () => {
    const f = fixture()
    f.refreshIndex.mockRejectedValueOnce(new Error('refresh unavailable'))
    const creating = f.owner.createSpace(input)
    f.creation.resolve(space())
    expect(await creating).toBe(true)
    expect(f.spaces.value.map(space => space.id)).toEqual(['created'])
    expect(f.spaceId.value).toBe('created')
    expect(f.errors).toHaveLength(1)
  })

  it('adds the saved Space without taking over a draft selected while creation was pending', async () => {
    const f = fixture()
    const creating = f.owner.createSpace(input)
    f.draftId.value = 'other-draft'
    f.creation.resolve(space())
    expect(await creating).toBe(true)
    expect(f.spaces.value.map(space => space.id)).toEqual(['created'])
    expect(f.draftId.value).toBe('other-draft')
    expect(f.spaceId.value).toBeNull()
  })

  it('does not publish state after disposal', async () => {
    const f = fixture()
    const creating = f.owner.createSpace(input)
    f.scope.stop()
    f.creation.resolve(space())
    expect(await creating).toBe(true)
    expect(f.spaces.value).toEqual([])
    expect(f.draftId.value).toBe('global-draft')
  })
})
