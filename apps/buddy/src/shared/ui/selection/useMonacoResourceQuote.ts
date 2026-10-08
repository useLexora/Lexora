import type { BuddyResourceQuote, BuddyTextQuote } from '@buddy-shared/conversation/buddyUserContent'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { SelectionReferenceEditSource } from './workbenchSelectionReferences'

/** Freeze selection and restore the source editor only when an editing action is chosen. */
export function registerMonacoResourceQuote(editor: Monaco.editor.IStandaloneCodeEditor, options: {
  source: () => BuddyTextQuote['source']
  prepare: (quote: BuddyResourceQuote, x: number, y: number, isEditable?: boolean, editSource?: SelectionReferenceEditSource) => (() => void) | null
  editable?: () => boolean
}): Monaco.IDisposable {
  return editor.onContextMenu((event) => {
    const range = editor.getSelection()
    const model = editor.getModel()
    const text = range && model?.getValueInRange(range)
    const show = range && text?.trim()
      ? options.prepare({ id: crypto.randomUUID(), text, source: options.source(), range: {
          startLineNumber: range.startLineNumber,
          startColumn: range.startColumn,
          endLineNumber: range.endLineNumber,
          endColumn: range.endColumn,
        } }, event.event.posx, event.event.posy, options.editable?.() ?? false, {
          restore: () => {
            if (editor.getModel() !== model || model?.getValueInRange(range) !== text)
              return false
            editor.focus()
            editor.setSelection(range)
            return true
          },
          executeLocal: (command) => {
            if (command === 'undo' || command === 'redo') {
              editor.trigger('selection-menu', command, null)
              return true
            }
            if (command === 'selectAll' && model) {
              editor.setSelection(model.getFullModelRange())
              return true
            }
            return false
          },
        })
      : null
    if (show) {
      event.event.preventDefault?.()
      show()
    }
  })
}
