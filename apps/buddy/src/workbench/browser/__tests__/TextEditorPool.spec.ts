// @vitest-environment jsdom
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { describe, expect, it, vi } from 'vitest'
import { TextEditorPool } from '../TextEditorPool'

vi.mock('@/shared/ui/monaco/desktopMonaco', () => ({ observeDesktopMonacoTheme: () => () => {} }))

class Editor {
  model: Monaco.editor.ITextModel | null
  disposed = false
  constructor(readonly host: HTMLElement, options: Monaco.editor.IStandaloneEditorConstructionOptions) {
    this.model = options.model ?? null
    host.append(document.createElement('textarea'))
  }

  updateOptions() {}
  layout() {}
  setModel(model: Monaco.editor.ITextModel | null) { this.model = model }
  dispose() { this.disposed = true }
}
const monaco = { editor: { create: (host: HTMLElement, options: Monaco.editor.IStandaloneEditorConstructionOptions) => new Editor(host, options) } } as unknown as typeof Monaco
const options = (text: string) => ({ model: { getValue: () => text } as Monaco.editor.ITextModel, dimension: { width: 400, height: 300 } })

describe('text editor leases', () => {
  it('reuses a detached widget without sharing live editors or accepting stale releases', () => {
    const pool = new TextEditorPool()
    try {
      const firstHost = document.createElement('div')
      const secondHost = document.createElement('div')
      const a = options('first')
      const b = options('second')
      const first = pool.acquire(monaco, firstHost, a)
      const simultaneous = pool.acquire(monaco, secondHost, b)
      expect(first.editor).not.toBe(simultaneous.editor)
      first.release()
      expect(firstHost.childElementCount).toBe(0)
      expect((first.editor as unknown as Editor).model).toBeNull()
      const replacement = pool.acquire(monaco, firstHost, b)
      expect(replacement.editor).toBe(first.editor)
      expect((replacement.editor as unknown as Editor).model).toBe(b.model)
      first.release()
      expect((replacement.editor as unknown as Editor).model).toBe(b.model)
      expect(firstHost.childElementCount).toBe(1)
      expect((simultaneous.editor as unknown as Editor).disposed).toBe(false)
      replacement.release()
      simultaneous.release()
      expect((simultaneous.editor as unknown as Editor).disposed).toBe(true)
      expect((replacement.editor as unknown as Editor).disposed).toBe(false)
      expect(secondHost.childElementCount).toBe(0)
    }
    finally { pool.dispose() }
  })

  it('disposes both idle and active widgets and rejects acquisition after shutdown', () => {
    const pool = new TextEditorPool()
    const first = pool.acquire(monaco, document.createElement('div'), options('first'))
    const second = pool.acquire(monaco, document.createElement('div'), options('second'))
    first.release()
    pool.dispose()
    second.release()
    pool.dispose()
    expect((first.editor as unknown as Editor).disposed).toBe(true)
    expect((second.editor as unknown as Editor).disposed).toBe(true)
    expect(() => pool.acquire(monaco, document.createElement('div'), options('late'))).toThrow('FILE_EDITOR_POOL_DISPOSED')
  })
})
