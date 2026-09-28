import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkingCopyService } from '../../services/WorkingCopyService'
import { TextModelPool } from '../TextModelPool'

const load = vi.hoisted(() => vi.fn())
vi.mock('@/shared/ui/monaco/desktopMonaco', () => ({ loadDesktopMonaco: load }))

class TextModel {
  readonly listeners = new Set<() => void>()
  text: string
  disposed = false
  reflections = 0
  constructor(text: string) { this.text = text }
  getValue() { return this.text }
  onDidChangeContent(listener: () => void) {
    this.listeners.add(listener)
    const listeners = this.listeners
    return {
      disposed: false,
      dispose() {
        if (this.disposed)
          return
        this.disposed = true
        listeners.delete(listener)
      },
    }
  }

  setValue(text: string) {
    this.reflections++
    this.edit(text)
  }

  edit(text: string) {
    this.text = text
    for (const listener of [...this.listeners]) listener()
  }

  dispose() { this.disposed = true }
}
function monaco() {
  const models: TextModel[] = []
  return {
    models,
    Uri: { parse: (value: string) => value },
    editor: {
      EndOfLinePreference: { TextDefined: 0 },
      createModel: (text: string) => {
        const model = new TextModel(text)
        models.push(model)
        return model
      },
    },
  }
}
const resource = { scheme: 'file', id: 'document', data: { path: 'document.md' } }
const disposals: Array<() => Promise<void>> = []
function setup() {
  const runtime = monaco()
  load.mockResolvedValue(runtime)
  const copies = new WorkingCopyService({ read: async () => ({ text: 'disk', etag: 'a' }), save: async (_, document) => ({ status: 'saved', document: { ...document, etag: 'b' } }) })
  const pool = new TextModelPool(copies)
  disposals.push(async () => {
    pool.dispose()
    await copies.dispose()
  })
  return { runtime, copies, pool }
}
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
  load.mockReset()
})

describe('resource scoped text models', () => {
  it('shares one model, ignores other resources and preserves new input during reflection', async () => {
    const { runtime, copies, pool } = setup()
    const first = await pool.acquire(resource)
    const second = await pool.acquire(resource)
    expect(first.model).toBe(second.model)
    const model = runtime.models[0]!
    await copies.open({ ...resource, id: 'other' })
    copies.edit({ ...resource, id: 'other' }, 'unrelated')
    expect(model.text).toBe('disk')
    expect(model.reflections).toBe(0)
    model.onDidChangeContent(() => {
      if (model.text === 'reflected')
        model.edit('new user input')
    })
    copies.edit(resource, 'reflected')
    expect(copies.get(resource)?.text).toBe('new user input')
    expect(model.text).toBe('new user input')
    expect(copies.get(resource)?.contentVersion).toBe(3)
    first.release()
    first.release()
    expect(model.disposed).toBe(false)
    second.release()
    expect(model.disposed).toBe(true)
  })

  it('uses the latest version when earlier listeners commit reentrant changes', async () => {
    const { runtime, copies, pool } = setup()
    copies.onDidChangeContent((event) => {
      if (event.copy.text === 'first')
        copies.edit(resource, 'second')
    })
    const lease = await pool.acquire(resource)
    copies.edit(resource, 'first')
    expect(runtime.models[0]?.text).toBe('second')
    expect(runtime.models[0]?.reflections).toBe(1)
    lease.release()
  })

  it('does not let an old lease release the replacement incarnation', async () => {
    const { runtime, copies, pool } = setup()
    const old = await pool.acquire(resource)
    const incarnation = copies.get(resource)?.incarnation
    expect(copies.release(resource)).toBe(true)
    const current = await pool.acquire(resource)
    expect(copies.get(resource)?.incarnation).not.toBe(incarnation)
    old.release()
    expect(runtime.models[0]?.disposed).toBe(true)
    expect(runtime.models[1]?.disposed).toBe(false)
    runtime.models[1]!.edit('current')
    expect(copies.get(resource)?.text).toBe('current')
    current.release()
  })

  it('creates no model when initialization finishes after pool disposal', async () => {
    const { runtime, pool } = setup()
    const loading = deferred<ReturnType<typeof monaco>>()
    load.mockReturnValue(loading.promise)
    const pending = pool.acquire(resource)
    pool.dispose()
    loading.resolve(runtime)
    await expect(pending).rejects.toThrow('FILE_MODEL_UNAVAILABLE')
    expect(runtime.models).toEqual([])
  })
})
