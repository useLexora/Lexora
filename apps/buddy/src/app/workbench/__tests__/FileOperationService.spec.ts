import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { SpaceFileMutation, SpaceFileOperation, SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { ResourceRef } from '@/workbench/common/workbench'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { absolute, FileOperationService } from '../FileOperationService'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
function space(id: string, root: string): LocalSpace {
  const timestamp = '2026-01-01T00:00:00.000Z'
  return { id, name: id, icon: 'folder', iconColor: 'default', activeRunCount: 0, additionalDirectories: [], createdAt: timestamp, updatedAt: timestamp, revokedAt: null, memoryScope: 'space_only', primaryDirectory: { id: `directory-${id}`, spaceId: id, canonicalRoot: root, root, revision: 1, revokedAt: null, createdAt: timestamp, updatedAt: timestamp, accessGrantedAt: timestamp, resourcesTrustedAt: timestamp } }
}
const target = (spaceId: string, path: string): SpaceFileTarget => ({ spaceId, directoryId: `directory-${spaceId}`, revision: 1, path })
function resource(spaceId: string, path: string): ResourceRef {
  const data = target(spaceId, path)
  return { scheme: 'file', id: JSON.stringify([data.directoryId, data.revision, path]), data }
}
function fixture(confirm: boolean, root = '/shared') {
  const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  const spaces = [space('one', root), space('two', '/shared'), space('other', '/other')]
  const disk = new Map([['/shared/a.txt', 'original']])
  const physical = (value: SpaceFileTarget) => absolute(spaces.find(space => space.id === value.spaceId)!.primaryDirectory!.canonicalRoot, value.path)
  const copies = new WorkingCopyService({
    read: async (value) => {
      const text = disk.get(physical(value.data as unknown as SpaceFileTarget))!
      return { text, etag: text }
    },
    save: async (value, document) => {
      const path = physical(value.data as unknown as SpaceFileTarget)
      const current = disk.get(path)!
      if (current !== document.etag)
        return { status: 'conflict', document: { text: current, etag: current } }
      disk.set(path, document.text)
      return { status: 'saved', document: { text: document.text, etag: document.text } }
    },
  })
  const registry = new ContributionRegistry()
  registry.register('files', scope => scope.view({ id: 'text', renderer: 'text', label: 'Text', locations: ['main'], supports: value => value.scheme === 'file', multiple: true }))
  const controller = new WorkbenchController(registry)
  const operations = new FileOperationService({
    api: { mutateFile: async (input) => {
      const source = physical(input)
      const action = input.action
      const destination = action.kind === 'rename' ? physical({ ...input, path: action.destination }) : action.kind === 'move' ? physical(action.destination) : null
      if (!destination || !disk.has(source) || disk.has(destination))
        throw new Error('FILE_CONFLICT')
      disk.set(destination, disk.get(source)!)
      disk.delete(source)
      return { operationId: input.operationId, kind: action.kind, path: input.path, destination, temporaryPath: null, status: 'applied', error: null, createdAt: 1, updatedAt: 1, restorable: false } satisfies SpaceFileOperation
    } },
    spaces: () => spaces,
    writeClipboardText,
    copies,
    controller,
    flush: async () => {},
    confirmSave: async () => confirm,
    updateSelection: () => {},
  })
  cleanup.push(async () => {
    await operations.dispose()
    await controller.dispose()
    await copies.dispose()
    registry.dispose()
  })
  const rename = (): SpaceFileMutation => ({ ...target('one', 'a.txt'), operationId: crypto.randomUUID(), action: { kind: 'rename', destination: 'renamed.txt' } })
  return { disk, copies, controller, operations, rename, writeClipboardText }
}

describe('copy file paths to the system clipboard', () => {
  it.each([
    ['D:\\项目\\工作区', '资料/合同 草稿.docx', 'D:\\项目\\工作区\\资料\\合同 草稿.docx'],
    ['D:/workspace/', 'notes.txt', 'D:\\workspace\\notes.txt'],
    ['\\\\server\\share', '资料/notes.txt', '\\\\server\\share\\资料\\notes.txt'],
    ['/home/user/workspace/', '资料/notes.txt', '/home/user/workspace/资料/notes.txt'],
  ])('copies the absolute path under %s', async (root, path, expected) => {
    const { operations, writeClipboardText, disk } = fixture(true, root)
    await operations.copyPath(target('one', path))
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith(expected)
    expect([...disk]).toEqual([['/shared/a.txt', 'original']])
  })

  it('does not copy a path from a stale directory binding', async () => {
    const { operations, writeClipboardText } = fixture(true)
    await expect(operations.copyPath({ ...target('one', 'a.txt'), revision: 2 })).rejects.toThrow('FILE_PERMISSION_REVOKED')
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('propagates clipboard write failures', async () => {
    const { operations, writeClipboardText } = fixture(true)
    writeClipboardText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    await expect(operations.copyPath(target('one', 'a.txt'))).rejects.toThrow('clipboard unavailable')
  })

  it('does not write after disposal', async () => {
    const { operations, writeClipboardText } = fixture(true)
    await operations.dispose()
    await expect(operations.copyPath(target('one', 'a.txt'))).rejects.toThrow('FILE_OPERATIONS_STOPPED')
    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})

describe('file operations protect all physical aliases before disk mutation', () => {
  it('retains dirty copies in every Space when saving is declined', async () => {
    const { disk, copies, operations, rename } = fixture(false)
    const first = resource('one', 'a.txt')
    const second = resource('two', 'a.txt')
    await copies.open(first)
    await copies.open(second)
    copies.edit(first, 'first draft')
    copies.edit(second, 'second draft')
    expect(await operations.execute(rename())).toBeNull()
    expect([...disk]).toEqual([['/shared/a.txt', 'original']])
    expect(copies.get(first)).toMatchObject({ text: 'first draft', dirty: true, blocked: false })
    expect(copies.get(second)).toMatchObject({ text: 'second draft', dirty: true, blocked: false })
  })

  it('renames views in both Spaces while preserving working-copy incarnations and view state', async () => {
    const { disk, copies, controller, operations, rename } = fixture(true)
    const resources = [resource('one', 'a.txt'), resource('two', 'a.txt')]
    const identities = []
    const views = []
    for (const value of resources) {
      identities.push((await copies.open(value)).incarnation)
      views.push((await controller.open(value, 'a.txt', { direction: 'right', state: { mode: 'source' } }))!)
    }
    expect((await operations.execute(rename()))?.status).toBe('applied')
    expect([...disk]).toEqual([['/shared/renamed.txt', 'original']])
    for (const [index, id] of views.entries()) {
      const view = controller.layout.views[id]!
      expect(view).toMatchObject({ title: 'renamed.txt', state: { mode: 'source' }, resource: { data: { spaceId: index ? 'two' : 'one', path: 'renamed.txt' } } })
      expect(copies.get(view.resource)).toMatchObject({ incarnation: identities[index], blocked: false, text: 'original' })
      expect(copies.get(resources[index]!)).toBeUndefined()
    }
  })

  it('stops a cross-root move that would merge independent editor histories', async () => {
    const { disk, copies, operations } = fixture(true)
    await copies.open(resource('one', 'a.txt'))
    await copies.open(resource('two', 'a.txt'))
    await expect(operations.execute({ ...target('one', 'a.txt'), operationId: crypto.randomUUID(), action: { kind: 'move', destination: target('other', 'a.txt') } })).rejects.toThrow('FILE_VIEW_CONFLICT')
    expect([...disk]).toEqual([['/shared/a.txt', 'original']])
    expect([...copies.copies.values()].every(copy => !copy.blocked)).toBe(true)
  })
})
