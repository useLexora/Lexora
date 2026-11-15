import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { observeDesktopMonacoTheme } from '@/shared/ui/monaco/desktopMonaco'

interface EditorEntry {
  host: HTMLElement
  editor: Monaco.editor.IStandaloneCodeEditor
  dispose: () => void
}

type EditorOptions = Monaco.editor.IStandaloneEditorConstructionOptions & {
  model: Monaco.editor.ITextModel
  dimension: Monaco.editor.IDimension
}

export class TextEditorPool {
  readonly #active = new Set<EditorEntry>()
  #idle: EditorEntry | undefined
  #disposed = false

  acquire(monaco: typeof Monaco, container: HTMLElement, options: EditorOptions) {
    if (this.#disposed)
      throw new Error('FILE_EDITOR_POOL_DISPOSED')
    let entry = this.#idle
    this.#idle = undefined
    if (entry) {
      try {
        container.append(entry.host)
        const { model, dimension, ...settings } = options
        entry.editor.updateOptions(settings)
        entry.editor.layout(dimension)
        entry.editor.setModel(model)
      }
      catch (error) {
        entry.dispose()
        throw error
      }
    }
    else {
      const host = container.ownerDocument.createElement('div')
      host.style.width = '100%'
      host.style.height = '100%'
      container.append(host)
      try {
        const editor = monaco.editor.create(host, options)
        const stopTheme = observeDesktopMonacoTheme(monaco, editor)
        entry = { host, editor, dispose: () => {
          stopTheme()
          editor.dispose()
          host.remove()
        } }
      }
      catch (error) {
        host.remove()
        throw error
      }
    }
    const held = entry
    this.#active.add(held)
    let released = false
    return { editor: held.editor, release: () => {
      if (released)
        return
      released = true
      if (!this.#active.delete(held))
        return
      held.editor.setModel(null)
      held.host.remove()
      if (this.#idle)
        held.dispose()
      else
        this.#idle = held
    } }
  }

  dispose() {
    this.#disposed = true
    this.#idle?.dispose()
    this.#idle = undefined
    for (const entry of this.#active)
      entry.dispose()
    this.#active.clear()
  }
}
