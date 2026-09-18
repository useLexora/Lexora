import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope } from 'vue'
import { deferred } from '../../../../../../__tests__/deferred'
import { useTaskIndexData } from '../useTaskIndexData'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function space(name: string): LocalSpace {
  return { id: 'space', name, icon: 'folder', iconColor: 'default', activeRunCount: 0, additionalDirectories: [], createdAt: '2026-09-08T00:00:00.000Z', memoryScope: 'space_only', primaryDirectory: null, revokedAt: null, updatedAt: '2026-09-08T00:00:00.000Z' }
}
function fixture() {
  const pending: ReturnType<typeof deferred<readonly LocalSpace[]>>[] = []
  const scope = effectScope()
  scopes.push(scope)
  const index = scope.run(() => useTaskIndexData({ api: {
    conversations: { list: async () => [] },
    spaces: { list: () => {
      const request = deferred<readonly LocalSpace[]>()
      pending.push(request)
      return request.promise
    } },
  } }))!
  return { index, pending, scope }
}

describe('task index refresh', () => {
  it('shares an initialized index across concurrent task consumers and retries failed initialization', async () => {
    const f = fixture()
    const failed = f.index.initialize()
    f.pending[0]!.reject(new Error('runtime unavailable'))
    await expect(failed).rejects.toThrow('runtime unavailable')
    const first = f.index.initialize()
    const second = f.index.initialize()
    f.pending[1]!.resolve([space('shared')])
    await Promise.all([first, second])
    expect(f.index.spaces.value.map(item => item.name)).toEqual(['shared'])
    await f.index.initialize()
    expect(f.pending).toHaveLength(2)
  })

  it.each(['resolve', 'reject'] as const)('retains the newer Space list when an earlier request finishes with %s', async (outcome) => {
    const f = fixture()
    const first = f.index.refreshIndex()
    const second = f.index.refreshIndex()
    f.pending[1]!.resolve([space('latest')])
    await second
    if (outcome === 'resolve')
      f.pending[0]!.resolve([space('old')])
    else
      f.pending[0]!.reject(new Error('old failure'))
    await first
    expect(f.index.spaces.value.map(item => item.name)).toEqual(['latest'])
  })

  it('protects a saved Space from a query begun before the mutation', async () => {
    const f = fixture()
    const loading = f.index.refreshIndex()
    f.index.applySpace(space('saved'))
    f.pending[0]!.resolve([space('before save')])
    await loading
    expect(f.index.spaces.value.map(item => item.name)).toEqual(['saved'])
  })

  it('does not publish pending results or failures after disposal', async () => {
    const f = fixture()
    f.index.replaceSpaces([space('before disposal')])
    const loading = f.index.refreshIndex()
    f.scope.stop()
    f.pending[0]!.resolve([space('disposed')])
    await loading
    expect(f.index.spaces.value.map(item => item.name)).toEqual(['before disposal'])
  })
})
