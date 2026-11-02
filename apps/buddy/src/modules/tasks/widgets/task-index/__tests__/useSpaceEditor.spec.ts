import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { TaskSpaceInput } from '../../../state/task-index/typing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { deferred } from '../../../../../../__tests__/deferred'
import { useSpaceEditor } from '../useSpaceEditor'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function space(id: string): LocalSpace {
  return { id, name: id, icon: 'folder', iconColor: 'default', activeRunCount: 0, additionalDirectories: [], createdAt: '2026-09-08T00:00:00.000Z', memoryScope: 'space_only', primaryDirectory: null, revokedAt: null, updatedAt: '2026-09-08T00:00:00.000Z' }
}
function fixture() {
  const scope = effectScope()
  scopes.push(scope)
  const show = shallowRef(true)
  const target = shallowRef<LocalSpace | null>(space('first'))
  const save = vi.fn<(input: TaskSpaceInput) => Promise<boolean>>().mockResolvedValue(true)
  const selectDirectory = vi.fn<(source?: { wsl: string }) => Promise<string | null>>().mockResolvedValue(null)
  const editor = scope.run(() => useSpaceEditor({ show: () => show.value, space: () => target.value, selectDirectory, save, onSaved: () => {
    show.value = false
  } }))!
  return { editor, save, scope, selectDirectory, show, target }
}

describe('space editing session', () => {
  it('asks for a WSL directory only when the WSL entry is used', async () => {
    const f = fixture()
    const root = String.raw`\\wsl.localhost\Ubuntu-24.04\home\user\project`
    f.selectDirectory.mockResolvedValueOnce(root)
    await f.editor.selectPrimaryDirectory({ wsl: 'Ubuntu-24.04' })
    expect(f.selectDirectory).toHaveBeenLastCalledWith({ wsl: 'Ubuntu-24.04' })
    expect(f.editor.form.primaryDirectory).toEqual({ id: null, root })
    f.selectDirectory.mockResolvedValueOnce('/other')
    await f.editor.selectAdditionalDirectory()
    expect(f.selectDirectory).toHaveBeenLastCalledWith(undefined)
  })

  it('shows existing additional directories and submits only explicit removals and selected additions', async () => {
    const f = fixture()
    const timestamp = '2026-09-08T00:00:00.000Z'
    const directory = { id: 'extra', root: '/extra', canonicalRoot: '/extra', revision: 1, accessGrantedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, revokedAt: null, spaceId: 'first' }
    f.show.value = false
    f.target.value = { ...space('first'), additionalDirectories: [directory] }
    f.show.value = true
    expect(f.editor.form.additionalDirectories).toEqual([{ id: 'extra', root: '/extra' }])
    f.editor.removeAdditionalDirectory(0)
    f.selectDirectory.mockResolvedValueOnce('/selected')
    await f.editor.selectAdditionalDirectory()
    f.target.value = { ...f.target.value, additionalDirectories: [directory, { ...directory, id: 'concurrent', root: '/concurrent' }] }
    await f.editor.save()
    expect(f.save.mock.calls[0]?.[0]).toMatchObject({ additionalDirectoryChanges: { add: ['/selected'], remove: ['extra'] }, primaryDirectory: null })
    expect(f.target.value.additionalDirectories).toHaveLength(2)
  })

  it('does not add duplicate roots, late directory results, or change bindings during active runs', async () => {
    const f = fixture()
    f.selectDirectory.mockResolvedValue('/selected')
    await f.editor.selectAdditionalDirectory()
    await f.editor.selectAdditionalDirectory()
    expect(f.editor.form.additionalDirectories).toEqual([{ id: null, root: '/selected' }])
    const pending = deferred<string | null>()
    f.selectDirectory.mockReturnValueOnce(pending.promise)
    const selecting = f.editor.selectAdditionalDirectory()
    f.target.value = { ...space('first'), activeRunCount: 1 }
    pending.resolve('/late')
    await selecting
    f.editor.removeAdditionalDirectory(0)
    expect(f.editor.form.additionalDirectories).toEqual([{ id: null, root: '/selected' }])
    expect(f.editor.canSave.value).toBe(false)
  })

  it('uses the selected folder name for a new space when the name is blank', async () => {
    const f = fixture()
    f.target.value = null
    f.selectDirectory.mockResolvedValueOnce('C:\\work\\my-project\\')

    await f.editor.selectPrimaryDirectory()

    expect(f.editor.form.name).toBe('my-project')
    expect(f.editor.form.primaryDirectory?.root).toBe('C:\\work\\my-project\\')
    expect(f.editor.canSave.value).toBe(true)
  })

  it('keeps a manually entered new space name when selecting a folder', async () => {
    const f = fixture()
    f.target.value = null
    f.editor.form.name = 'My workspace'
    f.selectDirectory.mockResolvedValueOnce('/work/my-project')

    await f.editor.selectPrimaryDirectory()

    expect(f.editor.form.name).toBe('My workspace')
  })

  it('preserves local input across a refresh of the same Space', () => {
    const f = fixture()
    f.editor.form.name = 'unsaved'
    f.editor.form.icon = 'code'
    f.editor.form.iconColor = 'blue'
    f.target.value = { ...space('first'), name: 'server updated' }
    expect(f.editor.form.name).toBe('unsaved')
    expect(f.editor.form).toMatchObject({ icon: 'code', iconColor: 'blue' })
    expect(f.target.value).toMatchObject({ icon: 'folder', iconColor: 'default' })
    f.show.value = false
    f.show.value = true
    expect(f.editor.form).toMatchObject({ icon: 'folder', iconColor: 'default' })
    f.target.value = { ...space('second'), icon: 'book', iconColor: 'green' }
    expect(f.editor.form).toMatchObject({ icon: 'book', iconColor: 'green' })
    expect(f.editor.form.name).toBe('second')
    f.editor.form.name = 'second draft'
    f.show.value = false
    f.show.value = true
    expect(f.editor.form.name).toBe('second')
  })

  it.each(['reopen', 'replace', 'dispose'] as const)('rejects a directory result after %s', async (change) => {
    const f = fixture()
    const selected = deferred<string | null>()
    f.selectDirectory.mockReturnValueOnce(selected.promise)
    const selecting = f.editor.selectPrimaryDirectory()
    expect(f.editor.selectingDirectory.value).toBe(true)
    if (change === 'reopen') {
      f.show.value = false
      f.show.value = true
    }
    else if (change === 'replace') {
      f.target.value = space('second')
    }
    else {
      f.scope.stop()
    }
    selected.resolve('/workspace/old')
    await selecting
    expect(f.editor.form.primaryDirectory).toBeNull()
  })

  it('retains input on save failure and closes only after a successful retry', async () => {
    const f = fixture()
    const result = deferred<boolean>()
    f.save.mockReturnValueOnce(result.promise)
    f.editor.form.name = 'local'
    f.editor.form.icon = 'code'
    f.editor.form.iconColor = 'blue'
    const saving = f.editor.save()
    await f.editor.save()
    expect(f.show.value).toBe(true)
    expect(f.editor.canSave.value).toBe(false)
    expect(f.save.mock.calls.map(([input]) => input.name)).toEqual(['local'])
    result.resolve(false)
    await saving
    expect(f.show.value).toBe(true)
    expect(f.editor.form.name).toBe('local')
    expect(f.editor.form).toMatchObject({ icon: 'code', iconColor: 'blue' })
    expect(f.save.mock.calls[0]?.[0]).toMatchObject({ icon: 'code', iconColor: 'blue' })
    expect(f.editor.failed.value).toBe(true)
    await f.editor.save()
    expect(f.show.value).toBe(false)
  })

  it('does not close a new editing session when an old save succeeds', async () => {
    const f = fixture()
    const result = deferred<boolean>()
    f.save.mockReturnValueOnce(result.promise)
    const saving = f.editor.save()
    f.show.value = false
    f.show.value = true
    f.editor.form.name = 'new session'
    result.resolve(true)
    await saving
    expect(f.show.value).toBe(true)
    expect(f.editor.form.name).toBe('new session')
    expect(f.editor.saving.value).toBe(false)
  })

  it('submits a detached value and retains edits made after submission', async () => {
    const f = fixture()
    const result = deferred<boolean>()
    f.save.mockReturnValueOnce(result.promise)
    f.editor.form.primaryDirectory = { id: null, root: '/workspace/first' }
    const saving = f.editor.save()
    f.editor.form.primaryDirectory.root = '/workspace/next'
    result.resolve(true)
    await saving
    expect(f.save.mock.calls[0]?.[0].primaryDirectory?.root).toBe('/workspace/first')
    expect(f.editor.form.primaryDirectory.root).toBe('/workspace/next')
    expect(f.show.value).toBe(true)
  })

  it('blocks directory changes if a run becomes active during directory selection', async () => {
    const f = fixture()
    const selected = deferred<string | null>()
    f.selectDirectory.mockReturnValueOnce(selected.promise)
    const selecting = f.editor.selectPrimaryDirectory()
    f.target.value = { ...space('first'), activeRunCount: 1 }
    selected.resolve('/workspace/blocked')
    await selecting
    expect(f.editor.form.primaryDirectory).toBeNull()
    f.editor.form.primaryDirectory = { id: null, root: '/workspace/blocked' }
    expect(f.editor.canSave.value).toBe(false)
  })
})
