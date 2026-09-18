import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { ResourceRef } from '../common/workbench'
import type { WorkingCopyService } from '../services/WorkingCopyService'
import { loadDesktopMonaco } from '@/shared/ui/monaco/desktopMonaco'
import { resourceKey } from '../common/workbench'

const languages: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'javascript', css: 'css', html: 'html', vue: 'html', md: 'markdown', py: 'python', rs: 'rust', sh: 'shell', yml: 'yaml', yaml: 'yaml', xml: 'xml', ps1: 'powershell' }
export class TextModelPool {
  readonly #copies: WorkingCopyService
  readonly #models = new Map<string, { model: Monaco.editor.ITextModel, users: number, stop: () => void }>()
  #disposed = false

  constructor(copies: WorkingCopyService) {
    this.#copies = copies
  }

  async acquire(resource: ResourceRef) {
    const [monaco, copy] = await Promise.all([loadDesktopMonaco(), this.#copies.open(resource)])
    if (this.#disposed || (copy.error && !copy.etag))
      throw new Error('FILE_MODEL_UNAVAILABLE')
    const key = resourceKey(resource)
    let entry = this.#models.get(key)
    if (!entry) {
      const path = typeof resource.data.path === 'string' ? resource.data.path : resource.id
      const model = monaco.editor.createModel(copy.text, languages[path.split('.').at(-1) ?? ''] ?? 'plaintext', monaco.Uri.parse(`lexora-file:/${encodeURIComponent(key)}`))
      const changed = model.onDidChangeContent(() => this.#copies.edit(resource, model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true)))
      const stop = this.#copies.subscribe(() => {
        const current = this.#copies.get(resource)
        if (current && current.text !== model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true))
          model.setValue(current.text)
      })
      entry = { model, users: 0, stop: () => {
        stop()
        changed.dispose()
        model.dispose()
      } }
      this.#models.set(key, entry)
    }
    entry.users++
    const held = entry
    let released = false
    return { monaco, model: held.model, release: () => {
      if (released)
        return
      released = true
      held.users--
      if (!held.users) {
        held.stop()
        this.#models.delete(key)
      }
    } }
  }

  dispose(): void {
    this.#disposed = true
    for (const entry of this.#models.values())
      entry.stop()
    this.#models.clear()
  }
}
