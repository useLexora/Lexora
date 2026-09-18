import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { createLayout, panes } from '../../common/workbench'
import { resolveWorkbenchDrop } from '../../common/workbenchDrop'
import { ContributionRegistry } from '../ContributionRegistry'
import { restoreWorkbenchLayout, WorkbenchController } from '../WorkbenchController'
import { WorkbenchPersistence } from '../WorkbenchPersistence'
import { WorkingCopyService } from '../WorkingCopyService'

const resource = { scheme: 'file', id: 'example', data: { path: 'example.md' } }
function registry() {
  const registry = new ContributionRegistry()
  registry.register('files', scope => scope.view({ id: 'text', label: 'Text', supports: input => input.scheme === 'file', multiple: true }))
  return registry
}
describe('workbench resource ownership', () => {
  it('opens a retained context view without stealing focus and restores its owner state', async () => {
    const contributions = registry()
    contributions.register('context', scope => scope.view({ id: 'context.file', label: 'File', location: 'context', supports: input => input.scheme === 'context-file', multiple: true }))
    const controller = new WorkbenchController(contributions)
    const task = await controller.open(resource, 'Task')
    const viewId = (await controller.open({ ...resource, scheme: 'context-file' }, 'Document', { focus: false, state: { contextTabId: 'directory-tab', mode: 'source' } }))!
    expect(controller.context.view?.id).toBe(task)
    expect(restoreWorkbenchLayout(JSON.parse(JSON.stringify(controller.layout))).views[viewId]?.state).toEqual({ contextTabId: 'directory-tab', mode: 'source' })
    controller.focus(viewId)
    expect(controller.context.view?.id).toBe(viewId)
    expect(controller.context.values['focus.area']).toBe('context')
  })

  it('commits disposal only after replacement succeeds and releases the guard when navigation is cancelled', async () => {
    const gate = deferred<import('../WorkbenchController').ViewCloseDecision>()
    const entered = deferred<void>()
    let retained = true
    let editable = false
    const controller = new WorkbenchController(registry(), () => {
      entered.resolve()
      return gate.promise
    })
    const original = (await controller.open(resource, 'Original'))!
    const signal = new AbortController()
    const replace = controller.open({ ...resource, id: 'next' }, 'Next', { signal: signal.signal })
    await entered.promise
    signal.abort()
    gate.resolve({ commit: () => retained = false, cancel: () => editable = true })
    await replace
    expect(controller.layout.views[original]?.resource).toEqual(resource)
    expect(retained).toBe(true)
    expect(editable).toBe(true)
    expect(retained).toBe(true)
    await controller.open({ ...resource, id: 'next' }, 'Next')
    expect(retained).toBe(false)
    expect(controller.layout.views[original]).toBeUndefined()
  })

  it('keeps all dependent views and input when any close guard is cancelled', async () => {
    let discarded = false
    const controller = new WorkbenchController(registry(), async view => view.resource.id === 'blocked' ? false : { commit: () => discarded = true })
    const first = (await controller.open(resource, 'First'))!
    const second = (await controller.open({ ...resource, id: 'blocked' }, 'Blocked', { direction: 'right' }))!
    const before = JSON.stringify(controller.layout)
    expect(await controller.closeMany([first, second])).toBe(false)
    expect(JSON.stringify(controller.layout)).toBe(before)
    expect(discarded).toBe(false)
  })

  it('focuses an existing task on click and moves it on an explicit drop without duplication', async () => {
    const controller = new WorkbenchController(registry())
    const first = (await controller.open(resource, 'Example'))!
    const firstPane = controller.layout.activePane
    const second = (await controller.open({ ...resource, id: 'two' }, 'Second', { direction: 'down' }))!
    const secondPane = controller.layout.activePane
    expect(panes(controller.layout.root)).toHaveLength(2)
    expect(await controller.open(resource, 'Example', { paneId: secondPane })).toBe(first)
    expect(controller.layout.activePane).toBe(firstPane)
    expect(panes(controller.layout.root)).toHaveLength(2)
    const original = controller.layout.views[first]
    await controller.move(first, secondPane)
    expect(controller.layout.views[first]).toBe(original)
    expect(controller.layout.views[second]).toBeUndefined()
    expect(panes(controller.layout.root)).toEqual([{ kind: 'pane', id: secondPane, view: first }])
    expect(restoreWorkbenchLayout(JSON.parse(JSON.stringify(controller.layout))).views[first]).toEqual(original)
  })

  it('leaves both panes unchanged when replacing a protected destination is cancelled', async () => {
    const controller = new WorkbenchController(registry(), async () => false)
    const first = (await controller.open(resource, 'First'))!
    await controller.open({ ...resource, id: 'two' }, 'Second', { direction: 'right' })
    const before = JSON.stringify(controller.layout)
    expect(await controller.move(first, controller.layout.activePane)).toBeNull()
    expect(JSON.stringify(controller.layout)).toBe(before)
  })

  it('preserves the current view when navigation is aborted while saving its replacement', async () => {
    const saved = deferred<boolean>()
    const controller = new WorkbenchController(registry(), () => saved.promise)
    const original = (await controller.open(resource, 'Original'))!
    const before = JSON.stringify(controller.layout)
    const signal = new AbortController()
    const replacement = controller.open({ ...resource, id: 'next' }, 'Next', { signal: signal.signal })
    await Promise.resolve()
    signal.abort()
    saved.resolve(true)
    expect(await replacement).toBeNull()
    expect(JSON.stringify(controller.layout)).toBe(before)
    expect(controller.context.view?.id).toBe(original)
  })

  it('serializes close requests and collapses empty leaves', async () => {
    let confirmed = 0
    const controller = new WorkbenchController(registry(), async () => {
      confirmed++
      return true
    })
    const first = (await controller.open(resource, 'First'))!
    const second = (await controller.open({ ...resource, id: 'two' }, 'Second', { direction: 'left' }))!
    expect(await Promise.all([controller.close(first), controller.close(first)])).toEqual([true, true])
    expect(confirmed).toBe(1)
    expect(panes(controller.layout.root).map(pane => pane.view)).toEqual([second])
  })

  it('migrates old mixed tab groups into task panes and separate resources', () => {
    const view = (id: string, scheme: string) => ({ id, type: scheme, title: id, resource: { scheme, id, data: {} }, state: {} })
    const restored = restoreWorkbenchLayout({ version: 1, views: { one: view('one', 'task'), two: view('two', 'task'), file: view('file', 'file'), history: view('history', 'task-index') }, root: { kind: 'pane', id: 'original', views: ['one', 'two', 'file'], active: 'file' }, docks: { left: { pane: { kind: 'pane', id: 'dock', views: ['history'], active: 'history' } } } })
    expect(restored.version).toBe(2)
    expect(panes(restored.root).map(pane => pane.view)).toEqual(['one'])
    expect(restored.views.file?.location).toBe('context')
    expect(restored.views.history).toBeUndefined()
    expect(restoreWorkbenchLayout({ version: 20 })).toMatchObject({ version: 2, views: {} })
  })

  it('keeps context views outside task geometry and retains the last task focus', async () => {
    const contributions = registry()
    contributions.register('browser', scope => scope.view({ id: 'browser', label: 'Browser', supports: r => r.scheme === 'browser', multiple: true, location: 'context' }))
    const controller = new WorkbenchController(contributions)
    await controller.open(resource, 'Task')
    const pane = controller.layout.activePane
    const browser = (await controller.open({ scheme: 'browser', id: 'site', data: {} }, 'Site'))!
    expect(controller.layout.activePane).toBe(pane)
    expect(controller.context.view?.id).toBe(browser)
    expect(panes(controller.layout.root)).toHaveLength(1)
    expect(await controller.move(browser, pane, 'right')).toBeNull()
  })

  it('rolls back partial contributions and aborts their scopes', () => {
    const registry = new ContributionRegistry()
    let signal: AbortSignal | undefined
    expect(() => registry.register('broken', (scope) => {
      signal = scope.signal
      scope.command({ id: 'one', label: 'One', execute() {} })
      scope.command({ id: 'one', label: 'Duplicate', execute() {} })
    })).toThrow()
    expect(registry.commands.size).toBe(0)
    expect(signal?.aborted).toBe(true)
    const unregister = registry.register('fixed', scope => scope.command({ id: 'one', label: 'One', execute() {} }))
    unregister()
    unregister()
    expect(registry.commands.size).toBe(0)
  })
})

describe('working copies', () => {
  it('keeps edits made during a save and reports external conflicts without overwriting', async () => {
    let finish!: (result: { status: 'saved' | 'conflict', document: { text: string, etag: string } }) => void
    const copies = new WorkingCopyService({ read: async () => ({ text: 'disk', etag: 'a' }), save: () => new Promise(resolve => finish = resolve) })
    await copies.open(resource)
    copies.edit(resource, 'first')
    const saving = copies.save(resource)
    copies.edit(resource, 'second')
    finish({ status: 'saved', document: { text: 'first', etag: 'b' } })
    expect(await saving).toBe(false)
    expect(copies.get(resource)).toMatchObject({ text: 'second', baseText: 'first', etag: 'b' })
    const conflict = copies.save(resource)
    finish({ status: 'conflict', document: { text: 'external', etag: 'c' } })
    expect(await conflict).toBe(false)
    expect(copies.get(resource)?.text).toBe('second')
    copies.resolveConflict(resource, 'local')
    expect(copies.get(resource)).toMatchObject({ text: 'second', baseText: 'external', etag: 'c' })
  })

  it('restores unsaved content independently of the layout and detects changed disk content', async () => {
    const first = new WorkingCopyService({ read: async () => ({ text: 'base', etag: 'a' }), save: async () => {
      throw new Error('unavailable')
    } })
    await first.open(resource)
    first.edit(resource, 'valuable unsaved text')
    const restored = new WorkingCopyService({ read: async () => ({ text: 'other', etag: 'b' }), save: async () => {
      throw new Error('unavailable')
    } })
    restored.restore(first.backups())
    await restored.open(resource)
    expect(restored.get(resource)).toMatchObject({ text: 'valuable unsaved text', baseText: 'base', conflict: { text: 'other', etag: 'b' } })
    restored.release(resource)
    expect(restored.backups()).toHaveLength(1)
    expect(createLayout().views).toEqual({})
  })
})

it('backs up continuous edits without waiting for typing to stop', async () => {
  vi.useFakeTimers()
  const controller = new WorkbenchController(registry())
  const copies = new WorkingCopyService({ read: async () => ({ text: 'base', etag: 'a' }), save: async () => {
    throw new Error('unused')
  } })
  const snapshots: string[] = []
  const persistence = new WorkbenchPersistence({ read: async () => null, write: async (snapshot) => {
    snapshots.push(JSON.stringify(snapshot))
  } }, controller, copies, () => {})
  await persistence.restore()
  await controller.open(resource, 'Example')
  await copies.open(resource)
  for (let index = 0; index < 30; index++) {
    copies.edit(resource, `edit ${index}`)
    await vi.advanceTimersByTimeAsync(100)
  }
  expect(snapshots.length).toBeGreaterThan(0)
  expect(snapshots[0]).toContain('edit 19')
  await persistence.flush()
  expect(snapshots.at(-1)).toContain('edit 29')
  persistence.dispose()
})

it('restores every view after the supported maximum number of nested splits', async () => {
  const controller = new WorkbenchController(registry())
  await controller.open(resource, 'Example')
  for (let index = 1; index < 16; index++)
    await controller.open({ ...resource, id: String(index) }, String(index), { direction: 'right' })
  const restored = restoreWorkbenchLayout(JSON.parse(JSON.stringify(controller.layout)))
  expect(panes(restored.root)).toHaveLength(16)
  expect(Object.keys(restored.views)).toHaveLength(16)
})

it('selects one direction at corners and leaves the center for replacement', () => {
  const bounds = { left: 100, top: 100, width: 600, height: 400 }
  expect(resolveWorkbenchDrop({ x: 400, y: 300 }, bounds)).toBe('center')
  expect(resolveWorkbenchDrop({ x: 105, y: 110 }, bounds)).toBe('left')
  expect(resolveWorkbenchDrop({ x: 690, y: 300 }, bounds)).toBe('right')
  expect(resolveWorkbenchDrop({ x: 400, y: 105 }, bounds)).toBe('up')
  expect(resolveWorkbenchDrop({ x: 400, y: 495 }, bounds)).toBe('down')
  expect(resolveWorkbenchDrop({ x: 800, y: 500 }, bounds)).toBeNull()
})
