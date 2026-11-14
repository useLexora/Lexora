import type { ViewClosePlan } from '@/workbench/services/WorkbenchController'
import type { WorkingCopyProvider } from '@/workbench/services/WorkingCopyService'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { createFileClosePreparation } from '../prepareFileClose'

const resource = { scheme: 'file', id: 'document', data: {} }
async function fixture(save: WorkingCopyProvider['save'] = async (_, document) => ({ status: 'saved', document: { ...document, etag: 'saved' } })) {
  const registry = new ContributionRegistry()
  registry.register('files', scope => scope.view({ locations: ['main'], id: 'file', renderer: 'file', label: 'File', supports: () => true, multiple: true }))
  const controller = new WorkbenchController(registry)
  const copies = new WorkingCopyService({ read: async () => ({ text: 'disk', etag: 'original' }), save })
  const persistence = new WorkbenchPersistence({ read: async () => null, write: async () => {} }, controller, copies, () => {})
  await persistence.restore()
  const id = (await controller.open(resource, 'Document'))!
  await copies.open(resource)
  copies.edit(resource, 'unsaved')
  onTestFinished(async () => {
    await persistence.dispose()
    await copies.dispose()
    await controller.dispose()
  })
  return { controller, copies, persistence, view: controller.layout.views[id]! }
}

describe('file close preparation', () => {
  it('keeps later edits when a previously accepted discard becomes stale', async () => {
    const f = await fixture()
    const prepare = createFileClosePreparation({ ...f, onError: () => {}, confirm: async (_, actions) => {
      actions.discard()
      return true
    } })
    const plan = await prepare(f.view) as ViewClosePlan
    expect(plan.validate?.()).toBe(true)
    expect(f.copies.get(resource)?.text).toBe('unsaved')
    f.copies.edit(resource, 'newer')
    expect(plan.validate?.()).toBe(false)
    await expect(plan.complete?.({ revision: 1 })).rejects.toThrow('WORKING_COPY_CHANGED_DURING_CLOSE')
    expect(f.copies.get(resource)?.text).toBe('newer')
    expect(f.copies.dirty(resource)).toBe(true)
  })

  it('does not accept a save that leaves a newer working copy dirty', async () => {
    const write = deferred<Awaited<ReturnType<WorkingCopyProvider['save']>>>()
    const f = await fixture(() => write.promise)
    const prepare = createFileClosePreparation({ ...f, onError: () => {}, confirm: async (_, actions) => {
      const saving = actions.save()
      f.copies.edit(resource, 'newer')
      write.resolve({ status: 'saved', document: { text: 'unsaved', etag: 'saved' } })
      expect(await saving).toBe(false)
      return false
    } })
    expect(await prepare(f.view)).toBe(false)
    expect(f.copies.get(resource)?.text).toBe('newer')
    expect(f.copies.dirty(resource)).toBe(true)
  })
})
