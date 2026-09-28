import type { ViewCloseDecision } from '../WorkbenchController'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { ContributionRegistry } from '../ContributionRegistry'
import { WorkbenchController } from '../WorkbenchController'

const resource = { scheme: 'task', id: 'one', data: {} }
function create(beforeClose?: (view: import('../../common/workbench').WorkbenchView) => Promise<ViewCloseDecision>) {
  const registry = new ContributionRegistry()
  registry.register('tasks', scope => scope.view({ id: 'task', renderer: 'task', label: 'Task', locations: ['main'], supports: input => input.scheme === 'task', multiple: true }))
  return new WorkbenchController(registry, beforeClose)
}

describe('workbench commit and completion', () => {
  it('rejects direct recursive queue entry from close preparation without losing a view', async () => {
    let nested = true
    const controller: WorkbenchController = create(async () => {
      if (nested)
        await controller.closeMany([])
      return true
    })
    const id = (await controller.open(resource, 'Task'))!
    await expect(controller.close(id)).rejects.toThrow('WORKBENCH_CLOSE_PREPARATION_IN_PROGRESS')
    expect(controller.layout.views[id]?.resource.id).toBe('one')
    nested = false
    expect(await controller.close(id)).toMatchObject({ committed: true, status: 'closed' })
    await controller.dispose()
  })

  it.each(['closed', 'cancelled', 'failed'] as const)('queues other pane operations while an asynchronous close is %s', async (outcome) => {
    const entered = deferred<void>()
    const preparation = deferred<ViewCloseDecision>()
    const preparing: string[] = []
    const controller = create(async (view) => {
      preparing.push(view.resource.id)
      if (view.resource.id === resource.id) {
        entered.resolve()
        return preparation.promise
      }
      return true
    })
    const first = (await controller.open(resource, 'One'))!
    const second = (await controller.open({ ...resource, id: 'two' }, 'Two', { direction: 'right' }))!
    const secondPane = controller.owner(second)!.id
    const third = (await controller.open({ ...resource, id: 'three' }, 'Three', { direction: 'down' }))!
    const close = controller.close(first)
    await entered.promise
    const replacement = controller.open({ ...resource, id: 'four' }, 'Four', { paneId: secondPane })
    const queuedClose = controller.close(third)
    const results = Promise.allSettled([close, replacement, queuedClose])
    expect(preparing).toEqual(['one'])
    expect(Object.keys(controller.layout.views)).toEqual([first, second, third])

    const failure = new Error('Preparation failed')
    if (outcome === 'failed')
      preparation.reject(failure)
    else
      preparation.resolve(outcome === 'closed')

    const [closed, opened, otherClosed] = await results
    if (outcome === 'failed')
      expect(closed).toEqual({ status: 'rejected', reason: failure })
    else
      expect(closed).toMatchObject({ status: 'fulfilled', value: { committed: outcome === 'closed', status: outcome } })
    expect(opened).toEqual({ status: 'fulfilled', value: expect.any(String) })
    expect(otherClosed).toMatchObject({ status: 'fulfilled', value: { committed: true, status: 'closed' } })
    expect(preparing).toEqual(['one', 'two', 'three'])
    expect(Object.values(controller.layout.views).map(view => view.resource.id)).toEqual(outcome === 'closed' ? ['four'] : ['one', 'four'])
    await controller.dispose()
  })

  it('rejects direct recursive opening before it starts asynchronous navigation', async () => {
    const controller: WorkbenchController = create(async () => {
      await controller.open({ ...resource, id: 'replacement' }, 'Replacement', { viewType: 'prepared-task' })
      return true
    })
    controller.registry.register('prepared-tasks', scope => scope.view({ id: 'prepared-task', renderer: 'task', label: 'Prepared task', locations: ['main'], supports: input => input.scheme === 'task', multiple: true, prepareBeforeOpen: true }))
    const id = (await controller.open(resource, 'One', { viewType: 'task' }))!
    await expect(controller.close(id)).rejects.toThrow('WORKBENCH_CLOSE_PREPARATION_IN_PROGRESS')
    expect(controller.layout.views[id]?.resource.id).toBe('one')
    expect(controller.navigation.entries.size).toBe(0)
    await controller.dispose()
  })

  it('owns restoration/open inputs and event-time snapshots', async () => {
    const controller = create()
    const state = { selection: { line: 1 } }
    const input = { ...resource, data: { value: 'original' } }
    const id = (await controller.open(input, 'Task', { state }))!
    const snapshot = controller.layout
    input.data.value = 'mutated'
    state.selection.line = 5
    controller.updateView(id, { title: 'Renamed' })
    expect(snapshot.views[id]).toMatchObject({ title: 'Task', resource: { data: { value: 'original' } }, state: { selection: { line: 1 } } })
    expect(Reflect.set(controller.layout.views, id, null)).toBe(false)
    expect(controller.layout.views[id]?.title).toBe('Renamed')
  })

  it('rechecks preparation identities and preserves input after a rejected close', async () => {
    const prepared = deferred<ViewCloseDecision>()
    const entered = deferred<void>()
    let version = 1
    let deleted = false
    const controller = create(async () => {
      entered.resolve()

      return prepared.promise
    })
    const id = (await controller.open(resource, 'Task'))!
    const close = controller.close(id)
    await entered.promise
    version++
    prepared.resolve({ validate: () => version === 1, complete: () => {
      deleted = true
    } })
    expect(await close).toEqual({ committed: false, status: 'stale' })
    expect(controller.layout.views[id]).toBeDefined()
    expect(deleted).toBe(false)
  })

  it('keeps committed close revision stable under observer reentrancy and executes every completion', async () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
    const outcomes: unknown[] = []
    const controller = create(async () => ({ prepareAuxiliary: current => ({ ...current, pending: true }), complete: ({ revision }) => {
      outcomes.push({ revision, pending: controller.layout.auxiliary.pending })
      throw new Error('Cleanup unavailable')
    } }))
    const id = (await controller.open(resource, 'Task'))!
    const expected = controller.layoutRevision + 1
    controller.onDidChangeLayout((event) => {
      if (event.kind === 'closed') {
        controller.setAuxiliary('other', 1)
        throw new Error('Observer')
      }
    })
    const closed = await controller.close(id)
    expect(closed).toMatchObject({ committed: true, status: 'cleanup-pending', revision: expected, views: [id] })
    expect(controller.layout.views[id]).toBeUndefined()
    expect(outcomes).toEqual([{ revision: expected, pending: true }])
    warning.mockRestore()
  })

  it('allows completion to use the mutation queue without waiting on itself', async () => {
    const controller: WorkbenchController = create(async () => ({ complete: async () => {
      await controller.open({ ...resource, id: 'replacement' }, 'Replacement')
    } }))
    const id = (await controller.open(resource, 'Task'))!
    expect(await controller.close(id)).toMatchObject({ status: 'closed' })
    expect(Object.values(controller.layout.views).map(view => view.resource.id)).toEqual(['replacement'])
  })

  it('drains accepted completion and its auxiliary write during final disposal', async () => {
    const completion = deferred<void>()
    const entered = deferred<void>()
    const controller: WorkbenchController = create(async () => ({ complete: async () => {
      entered.resolve()
      await completion.promise
      controller.setAuxiliary('cleanup', 'finished')
    } }))
    const id = (await controller.open(resource, 'Task'))!
    const close = controller.close(id)
    await entered.promise
    const disposal = controller.dispose()
    expect(await controller.open({ ...resource, id: 'late' }, 'Late')).toBeNull()
    completion.resolve()
    expect(await close).toMatchObject({ status: 'closed' })
    await disposal
    expect(controller.layout.auxiliary.cleanup).toBe('finished')
  })

  it('captures the authoritative command target before observers change focus', async () => {
    const controller = create()
    const first = (await controller.open(resource, 'One'))!
    const pane = controller.layout.activePane
    const second = (await controller.open({ ...resource, id: 'two' }, 'Two', { direction: 'right' }))!
    controller.registry.register('commands', scope => scope.command({ id: 'target', label: 'Target', execute: context => context.view?.id }))
    controller.commands.onDidExecute((event) => {
      if (event.stage === 'started')
        controller.focus(second)
    })
    expect(await controller.commands.execute('target', { paneId: pane })).toEqual({ status: 'completed', result: first })
    expect(controller.context.view?.id).toBe(second)
  })
})
