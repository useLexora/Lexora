import type { ResourceRef } from '@/workbench/common/workbench'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { WorkspaceFileMutationGuard } from '../WorkspaceFileMutationGuard'

const target = { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'src' }
const resource: ResourceRef = { scheme: 'file', id: 'one', data: { ...target, path: 'src/file.ts' } }

describe('local workspace mutation gate', () => {
  it('blocks any opened resource, including a clean editor or preview, without dropping it', () => {
    const guard = new WorkspaceFileMutationGuard()
    expect(guard.acquire(target, () => [resource])).toBeNull()
    expect(guard.allowed(resource)).toBe(true)
    expect(guard.acquire(target, () => [{ ...resource, scheme: 'file-preview' }])).toBeNull()
    expect(resource.data.path).toBe('src/file.ts')
  })
  it('blocks only the captured directory boundary and releases after the operation', () => {
    const guard = new WorkspaceFileMutationGuard()
    const release = guard.acquire(target, () => [])!
    target.path = 'changed-after-capture'
    expect(guard.allowed(resource)).toBe(false)
    expect(guard.acquire({ ...target, path: 'other' }, () => [])).toBeNull()
    expect(guard.allowed({ ...resource, data: { ...resource.data, path: 'src-other/file.ts' } })).toBe(true)
    expect(guard.allowed({ ...resource, data: { ...resource.data, revision: 2 } })).toBe(true)
    release()
    release()
    expect(guard.allowed(resource)).toBe(true)
    target.path = 'src'
  })
  it('protects open, edit and save entry points and resumes them after release', async () => {
    const guard = new WorkspaceFileMutationGuard()
    const copies = new WorkingCopyService({ canAccess: value => guard.allowed(value), read: async () => ({ text: 'disk', etag: 'a' }), save: async (_, document) => ({ status: 'saved', document }) })
    await copies.open(resource)
    const release = guard.acquire(target, () => [])!
    await expect(copies.open(resource)).rejects.toThrow('WORKING_COPY_BLOCKED')
    copies.edit(resource, 'blocked text')
    expect(copies.get(resource)?.text).toBe('disk')
    expect(await copies.save(resource)).toMatchObject({ status: 'unavailable', reason: 'blocked' })
    release()
    copies.edit(resource, 'allowed text')
    expect((await copies.save(resource)).status).toBe('saved')
    await copies.dispose()
  })
  it('rejects opening a workbench view during a mutation', async () => {
    const guard = new WorkspaceFileMutationGuard()
    const registry = new ContributionRegistry()
    registry.register('fixture', scope => scope.view({ id: 'files', renderer: 'fixture', label: 'File', locations: ['main'], multiple: true, supports: value => value.scheme === 'file' }))
    const controller = new WorkbenchController(registry, undefined, undefined, value => guard.allowed(value))
    const release = guard.acquire(target, () => [])!
    expect(await controller.open(resource, 'file')).toBeNull()
    expect(Object.values(controller.layout.views)).toHaveLength(0)
    release()
    expect(await controller.open(resource, 'file')).toBeTruthy()
    await controller.dispose()
  })
  it('rechecks a pending open after its asynchronous close preparation', async () => {
    const guard = new WorkspaceFileMutationGuard()
    const registry = new ContributionRegistry()
    registry.register('fixture', scope => scope.view({ id: 'files', renderer: 'fixture', label: 'File', locations: ['main'], multiple: true, supports: value => value.scheme === 'file' }))
    const entered = deferred<void>()
    const decision = deferred<true>()
    const controller = new WorkbenchController(registry, async () => {
      entered.resolve()
      return decision.promise
    }, undefined, value => guard.allowed(value))
    const previous = await controller.open({ ...resource, id: 'other', data: { ...resource.data, path: 'unaffected.md' } }, 'Other')
    const pending = controller.open(resource, 'File')
    await entered.promise
    const release = guard.acquire(target, () => controller.renderedViews.map(view => view.resource))!
    expect(release).toBeTruthy()
    decision.resolve(true)
    expect(await pending).toBeNull()
    expect(Object.keys(controller.layout.views)).toEqual([previous])
    release()
    await controller.dispose()
  })
})
