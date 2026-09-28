import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { ResourceRef } from '../common/workbench'
import type { WorkingCopyService } from '../services/WorkingCopyService'
import { filterEvent } from '@buddy-shared/events/Emitter'
import { loadDesktopMonaco } from '@/shared/ui/monaco/desktopMonaco'
import { resourceKey } from '../common/workbench'

const languages: Record<string, string> = { md: 'markdown', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', html: 'html', css: 'css', scss: 'scss', yaml: 'yaml', yml: 'yaml', py: 'python', rs: 'rust', sh: 'shell', sql: 'sql', xml: 'xml', vue: 'html' }
interface ModelEntry {
  model: Monaco.editor.ITextModel
  incarnation: string
  users: number
  stop: () => void
}

export class TextModelPool {
  readonly #copies: WorkingCopyService
  readonly #models = new Map<string, ModelEntry>()
  #disposed = false

  constructor(copies: WorkingCopyService) {
    this.#copies = copies
  }

  async acquire(resource: ResourceRef) {
    const [monaco, opened] = await Promise.all([loadDesktopMonaco(), this.#copies.open(resource)])
    const copy = this.#copies.get(resource)
    if (this.#disposed || !copy || copy.incarnation !== opened.incarnation || copy.loading || (copy.error && !copy.etag))
      throw new Error('FILE_MODEL_UNAVAILABLE')
    const key = resourceKey(resource)
    let entry = this.#models.get(key)
    if (entry && entry.incarnation !== copy.incarnation) {
      entry.stop()
      this.#models.delete(key)
      entry = undefined
    }
    if (!entry) {
      const path = typeof copy.resource.data.path === 'string' ? copy.resource.data.path : copy.resource.id
      const model = monaco.editor.createModel(copy.text, languages[path.split('.').at(-1) ?? ''] ?? 'plaintext', monaco.Uri.parse(`lexora-file:/${encodeURIComponent(key)}/${copy.incarnation}`))
      let version = copy.contentVersion
      let reflecting: string | undefined
      let stopped = false
      const changed = model.onDidChangeContent(() => {
        const text = model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true)
        if (text !== reflecting && this.#copies.get(copy.resource)?.incarnation === copy.incarnation)
          this.#copies.edit(copy.resource, text)
      })
      const content = filterEvent(this.#copies.onDidChangeContent, event => event.copy.key === key && event.copy.incarnation === copy.incarnation)((event) => {
        const current = this.#copies.get(copy.resource)
        if (!current || current.incarnation !== event.copy.incarnation || current.contentVersion <= version)
          return
        version = current.contentVersion
        if (current.text === model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true))
          return
        const previous = reflecting
        reflecting = current.text
        try {
          model.setValue(current.text)
        }
        finally {
          reflecting = previous
        }
      })
      const subscriptions = [content.dispose, () => changed.dispose()]
      const held: ModelEntry = {
        model,
        incarnation: copy.incarnation,
        users: 0,
        stop: () => {
          if (stopped)
            return
          stopped = true
          subscriptions.forEach(dispose => dispose())
          model.dispose()
        },
      }
      subscriptions.push(filterEvent(this.#copies.onDidRelease, event => event.copy.key === key && event.copy.incarnation === copy.incarnation)(() => {
        held.stop()
        if (this.#models.get(key) === held)
          this.#models.delete(key)
      }).dispose)
      entry = held
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
        if (this.#models.get(key) === held)
          this.#models.delete(key)
      }
    } }
  }

  dispose(): void {
    this.#disposed = true
    for (const entry of this.#models.values()) entry.stop()
    this.#models.clear()
  }
}
