import type { Editor } from '@tiptap/core'

export function isTriggerMenuSelection(editor: Editor) {
  const { selection } = editor.state
  const parentNode = selection.$from.parent

  return selection.empty
    && parentNode.type.name === 'paragraph'
    && parentNode.textContent.length === 0
}
