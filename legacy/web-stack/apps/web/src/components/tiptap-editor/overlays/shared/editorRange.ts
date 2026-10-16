import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

export interface EditorDocumentRange {
  from: number
  to: number
}

export function selectEditorRange(editor: Editor, range: EditorDocumentRange) {
  const view = editor.view

  if (editor.isDestroyed || !view || range.to <= range.from || range.to > editor.state.doc.content.size) {
    return
  }

  view.dispatch(editor.state.tr
    .setSelection(TextSelection.create(editor.state.doc, range.from, range.to))
    .scrollIntoView()
    .setMeta('addToHistory', false))
}
