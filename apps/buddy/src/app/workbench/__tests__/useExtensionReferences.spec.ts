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
function fixture(withTask = true, withSecondTask = false) {
  const id = crypto.randomUUID()
  const quote = { id: crypto.randomUUID(), text: 'Selected snapshot', source: { kind: 'view' as const, title: 'Office', provider: 'extension:tests.office', target: { extensionId: 'tests.office', viewId: id, viewType: 'tests.office.editor', source: null } }, locator: { version: 1, data: { documentId: 'opaque-document' } } }
  const surface = shallowReactive({ ready: true, visible: true, eligible: true, error: null, session: { id, generation: 'generation', token: 'token' }, input: { extensionId: 'tests.office', viewType: 'tests.office.editor', resource: null } })
  let identity = 'first-draft'
  let draft = createBuddyUserContent('Keep this draft')
  let targetAvailable = withTask
  let secondDraft = createBuddyUserContent('Second draft')
  const references = new WorkbenchSelectionReferences({ targets: () => [...(targetAvailable ? [{ id: 'task-view', identity, scope: 'draft', label: '分屏 1 · Task', pane: { index: 1, title: 'Task' }, read: () => draft, write: (value: typeof draft) => draft = value }] : []), ...(withSecondTask ? [{ id: 'second-view', identity: 'second-input', scope: 'second', label: '分屏 2 · Second task', pane: { index: 2, title: 'Second task' }, read: () => secondDraft, write: (value: typeof secondDraft) => secondDraft = value }] : [])] })
  const controller = { layout: { views: { 'task-view': { id: 'task-view', resource: { scheme: 'draft' } }, 'second-view': { id: 'second-view', resource: { scheme: 'draft' } } } } } as unknown as WorkbenchController
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
  return { receiver, event, quote, surface, writeClipboard, chooseTarget, showTarget, notifySuccess, prepareNewTaskInput, flushDrafts, secondDraft: () => secondDraft, draft: () => draft, type: (text: string) => draft = createBuddyUserContent(text), switchTask: () => {
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

it.each(['reference', 'reference-commit'] as const)('waits for %s draft persistence before navigating and keeps the operation pending meanwhile', async (kind) => {
  const f = fixture()
  const signal = new AbortController().signal
  let event: Extract<ExtensionWorkbenchEvent, { kind: 'reference' | 'reference-commit' }> = f.event
  if (kind === 'reference-commit') {
    const capture = await f.receiver.receive({ ...f.event, kind: 'reference-capture' }, signal)
    if (!capture || typeof capture !== 'object')
      throw new Error('capture unavailable')
    event = { ...f.event, kind, id: capture.id, choice: { kind: 'view', id: 'task-view' } }
  }
  const saving = deferred<boolean>()
  f.flushDrafts.mockReturnValueOnce(saving.promise)
  const receiving = f.receiver.receive(event, signal)
  await vi.waitFor(() => expect(f.flushDrafts).toHaveBeenCalledOnce())
  expect(f.showTarget).not.toHaveBeenCalled()
  expect(await f.receiver.receive(f.event, new AbortController().signal)).toBe(false)
  expect(await f.receiver.receive({ ...f.event, kind: 'reference-capture' }, new AbortController().signal)).toBeNull()
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

it('captures a target once and commits without a picker, preserving newer draft typing', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const capture = await f.receiver.receive({ ...f.event, kind: 'reference-capture' }, signal)
  expect(capture).toMatchObject({ defaultId: 'task-view', clipboard: true, targets: [{ id: 'task-view', label: '分屏 1 · Task' }] })
  if (!capture || typeof capture !== 'object')
    throw new Error('capture unavailable')
  f.type('Typed while choosing')
  const commit = { ...f.event, kind: 'reference-commit' as const, id: capture.id, choice: { kind: 'view' as const, id: 'task-view' } }
  expect(await f.receiver.receive(commit, signal)).toBe(true)
  expect(f.draft().resourceQuotes).toEqual([f.quote])
  expect(f.draft().body[0]!.content).toContainEqual({ type: 'text', text: 'Typed while choosing' })
  expect(f.chooseTarget).not.toHaveBeenCalled()
  expect(await f.receiver.receive(commit, signal)).toBe(false)
})

it.each(['draft', 'hidden', 'released', 'replaced'] as const)('invalidates captured reference on %s without changing another draft', async (reason) => {
  const f = fixture()
  const signal = new AbortController().signal
  const capture = await f.receiver.receive({ ...f.event, kind: 'reference-capture' }, signal)
  if (!capture || typeof capture !== 'object')
    throw new Error('capture unavailable')
  if (reason === 'draft')
    f.switchTask()
  if (reason === 'hidden') {
    f.surface.visible = false
    f.surface.visible = true
  }
  if (reason === 'released')
    expect(await f.receiver.receive({ ...f.event, kind: 'reference-release', id: capture.id }, signal)).toBe(true)
  if (reason === 'replaced')
    await f.receiver.receive({ ...f.event, kind: 'reference-capture' }, signal)
  expect(await f.receiver.receive({ ...f.event, kind: 'reference-commit', id: capture.id, choice: { kind: 'view', id: 'task-view' } }, signal)).toBe(false)
  expect(f.draft()).toEqual(createBuddyUserContent('Keep this draft'))
  expect(f.notifySuccess).not.toHaveBeenCalled()
})

it.each(['new-task', 'clipboard'] as const)('allows %s from a capture with no existing task', async (kind) => {
  const f = fixture(false)
  const signal = new AbortController().signal
  const capture = await f.receiver.receive({ ...f.event, kind: 'reference-capture' }, signal)
  expect(capture).toMatchObject({ defaultId: null, targets: [], clipboard: true })
  if (!capture || typeof capture !== 'object')
    throw new Error('capture unavailable')
  expect(await f.receiver.receive({ ...f.event, kind: 'reference-commit', id: capture.id, choice: { kind } }, signal)).toBe(true)
  expect(f.notifySuccess).toHaveBeenCalledExactlyOnceWith({ kind })
  expect(f.chooseTarget).not.toHaveBeenCalled()
})

it('requires an explicit choice with two tasks and adds only to the captured target', async () => {
  const f = fixture(true, true)
  const signal = new AbortController().signal
  const capture = await f.receiver.receive({ ...f.event, kind: 'reference-capture' }, signal)
  expect(capture).toMatchObject({ defaultId: null, targets: [{ id: 'task-view', label: '分屏 1 · Task' }, { id: 'second-view', label: '分屏 2 · Second task' }] })
  if (!capture || typeof capture !== 'object')
    throw new Error('capture unavailable')
  f.type('Keep newer first draft')
  expect(await f.receiver.receive({ ...f.event, kind: 'reference-commit', id: capture.id, choice: { kind: 'view', id: 'second-view' } }, signal)).toBe(true)
  expect(f.draft()).toEqual(createBuddyUserContent('Keep newer first draft'))
  expect(f.secondDraft().resourceQuotes).toEqual([f.quote])
  expect(f.secondDraft().body[0]!.content).toContainEqual({ type: 'text', text: 'Second draft' })
})
