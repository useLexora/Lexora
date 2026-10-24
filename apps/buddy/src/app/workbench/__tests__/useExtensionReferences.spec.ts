// @vitest-environment jsdom
import type { ExtensionApi, ExtensionStatus, ExtensionWorkbenchEvent } from '@buddy-shared/extensions/extensionApi'
import type { TaskWorkspacePool } from '../TaskWorkspacePool'
import type { ExtensionViews } from '@/modules/extensions'
import type { ReferenceTargetChoice } from '@/shared/ui/selection/useReferenceTargetPicker'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, shallowReactive, shallowRef } from 'vue'
import { WorkbenchSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'
import { useExtensionReferences } from '../useExtensionReferences'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function fixture(withTask = true) {
  const id = crypto.randomUUID()
  const quote = { id: crypto.randomUUID(), text: 'Selected snapshot', source: { kind: 'view' as const, title: 'Office', provider: 'extension:tests.office', target: { extensionId: 'tests.office', viewId: id, viewType: 'tests.office.editor', source: null } }, locator: { version: 1, data: { documentId: 'opaque-document' } } }
  const surface = shallowReactive({ ready: true, visible: true, eligible: true, error: null, session: { id, generation: 'generation', token: 'token' }, input: { extensionId: 'tests.office', viewType: 'tests.office.editor', resource: null } })
  let identity = 'first-draft'
  let draft = createBuddyUserContent('Keep this draft')
  let targetAvailable = withTask
  const references = new WorkbenchSelectionReferences({ targets: () => targetAvailable ? [{ id: 'task-view', identity, scope: 'draft', label: 'Task', read: () => draft, write: value => draft = value }] : [] })
  const controller = { layout: { views: { 'task-view': { id: 'task-view', resource: { scheme: 'draft' } } } } } as unknown as WorkbenchController
  const views = { surfaces: new Map([[id, surface]]) } as unknown as ExtensionViews
  const flushDrafts = vi.fn(async () => true)
  const pool = { peek: () => ({ flushDrafts }) } as unknown as TaskWorkspacePool
  const writeClipboard = vi.fn(async () => {})
  const chooseTarget = vi.fn<(...args: unknown[]) => Promise<ReferenceTargetChoice | null>>(async () => ({ kind: 'view', id: 'task-view' }))
  const showTarget = vi.fn(async () => {})
  const notifySuccess = vi.fn()
  const prepareNewTaskInput = vi.fn(async (_sourceViewId: string, prepare: (viewId: string) => Promise<boolean>) => {
    targetAvailable = true
    return prepare('task-view')
  })
  const scope = effectScope()
  cleanups.push(() => scope.stop())
  const receiver = scope.run(() => useExtensionReferences({ references, controller, views, pool, writeClipboard, chooseTarget, prepareNewTaskInput, showTarget, notifySuccess, showPage: vi.fn(async () => false), installed: shallowRef<ExtensionStatus[]>([]), api: {} as ExtensionApi, persistence: {} as WorkbenchPersistence }))!
  const event: Extract<ExtensionWorkbenchEvent, { kind: 'reference' }> = { kind: 'reference', requestId: crypto.randomUUID(), viewId: id, generation: 'generation', token: 'token', material: { kind: 'quote', quote } }
  return { receiver, event, quote, surface, writeClipboard, chooseTarget, showTarget, notifySuccess, prepareNewTaskInput, flushDrafts, draft: () => draft, type: (text: string) => draft = createBuddyUserContent(text), switchTask: () => {
    identity = 'second-draft'
  } }
}

it('adds an independent page reference to the explicitly selected draft without replacing recent typing', async () => {
  const f = fixture()
  const chosen = deferred<ReferenceTargetChoice | null>()
  f.chooseTarget.mockReturnValueOnce(chosen.promise)
  const receiving = f.receiver.receive(f.event, new AbortController().signal)
  f.type('Newer draft text')
  chosen.resolve({ kind: 'view', id: 'task-view' })
  expect(await receiving).toBe(true)
  expect(f.draft().resourceQuotes).toEqual([f.quote])
  expect(f.draft().body[0]!.content).toContainEqual({ type: 'text', text: 'Newer draft text' })
  expect(f.writeClipboard).not.toHaveBeenCalled()
  expect(f.showTarget).toHaveBeenCalledWith('task-view')
})

it('does not create a task, change a draft or copy when choosing is cancelled', async () => {
  const f = fixture(false)
  f.chooseTarget.mockResolvedValueOnce(null)
  expect(await f.receiver.receive(f.event, new AbortController().signal)).toBe(false)
  expect(f.prepareNewTaskInput).not.toHaveBeenCalled()
  expect(f.writeClipboard).not.toHaveBeenCalled()
  expect(f.draft()).toEqual(createBuddyUserContent('Keep this draft'))
})

it('rejects a draft that changed identity while the target picker was open', async () => {
  const f = fixture()
  const chosen = deferred<ReferenceTargetChoice | null>()
  f.chooseTarget.mockReturnValueOnce(chosen.promise)
  const receiving = f.receiver.receive(f.event, new AbortController().signal)
  f.switchTask()
  chosen.resolve({ kind: 'view', id: 'task-view' })
  expect(await receiving).toBe(false)
  expect(f.draft()).toEqual(createBuddyUserContent('Keep this draft'))
  expect(f.showTarget).not.toHaveBeenCalled()
})

it('waits for draft persistence before navigating and keeps the operation pending meanwhile', async () => {
  const f = fixture()
  const saving = deferred<boolean>()
  f.flushDrafts.mockReturnValueOnce(saving.promise)
  const receiving = f.receiver.receive(f.event, new AbortController().signal)
  await vi.waitFor(() => expect(f.flushDrafts).toHaveBeenCalledOnce())
  expect(f.showTarget).not.toHaveBeenCalled()
  expect(await f.receiver.receive(f.event, new AbortController().signal)).toBe(false)
  expect(f.notifySuccess).not.toHaveBeenCalled()
  saving.resolve(true)
  expect(await receiving).toBe(true)
  expect(f.showTarget).toHaveBeenCalledOnce()
  expect(f.notifySuccess).toHaveBeenCalledExactlyOnceWith({ kind: 'view', title: 'Task' })
})

it('keeps the source page and recoverable draft on a persistence failure', async () => {
  const f = fixture()
  f.flushDrafts.mockResolvedValueOnce(false)
  expect(await f.receiver.receive(f.event, new AbortController().signal)).toBe(false)
  expect(f.showTarget).not.toHaveBeenCalled()
  expect(f.draft().resourceQuotes).toEqual([f.quote])
  expect(f.notifySuccess).not.toHaveBeenCalled()
})

it('rejects obsolete generations and cancels the picker when the source is revoked', async () => {
  const f = fixture()
  expect(await f.receiver.receive({ ...f.event, token: 'obsolete' }, new AbortController().signal)).toBe(false)
  expect(f.chooseTarget).not.toHaveBeenCalled()
  const chosen = deferred<ReferenceTargetChoice | null>()
  f.chooseTarget.mockReturnValueOnce(chosen.promise)
  const receiving = f.receiver.receive(f.event, new AbortController().signal)
  const signal = f.chooseTarget.mock.calls[0]![2] as AbortSignal
  f.surface.session = { ...f.surface.session, generation: 'replacement' }
  expect(signal.aborted).toBe(true)
  chosen.resolve({ kind: 'new-task' })
  expect(await receiving).toBe(false)
  expect(f.prepareNewTaskInput).not.toHaveBeenCalled()
  expect(f.draft()).toEqual(createBuddyUserContent('Keep this draft'))
})

it('does not acknowledge a source revoked while copying', async () => {
  const f = fixture()
  f.chooseTarget.mockResolvedValueOnce({ kind: 'clipboard' })
  const copying = deferred<void>()
  f.writeClipboard.mockImplementationOnce(async () => copying.promise)
  const receiving = f.receiver.receive(f.event, new AbortController().signal)
  await vi.waitFor(() => expect(f.writeClipboard).toHaveBeenCalledOnce())
  f.surface.session = { ...f.surface.session, generation: 'replacement' }
  copying.resolve()
  expect(await receiving).toBe(false)
  expect(f.draft()).toEqual(createBuddyUserContent('Keep this draft'))
  expect(f.notifySuccess).not.toHaveBeenCalled()
})
