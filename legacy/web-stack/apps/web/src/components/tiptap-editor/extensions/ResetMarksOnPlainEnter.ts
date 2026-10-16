import { Extension } from '@tiptap/core'

const EMPTY_STORED_MARKS: [] = []
const EXCLUDED_NODE_NAMES = new Set([
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'codeBlock',
])

function hasExcludedAncestor(nodeNames: string[]) {
  return nodeNames.some(name => EXCLUDED_NODE_NAMES.has(name))
}

function getAncestorNodeNames(depth: number, getNodeName: (depth: number) => string) {
  return Array.from({ length: depth + 1 }, (_, index) => getNodeName(index))
}

export const ResetMarksOnPlainEnter = Extension.create({
  name: 'resetMarksOnPlainEnter',
  priority: 1_000,
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { editor } = this
        const { state, view } = editor

        if (!state.selection.empty) {
          return false
        }

        const { $from } = state.selection
        const ancestorNodeNames = getAncestorNodeNames(
          $from.depth,
          depth => $from.node(depth).type.name,
        )

        if (hasExcludedAncestor(ancestorNodeNames)) {
          return false
        }

        const handled = editor.commands.first(({ commands }) => [
          () => commands.newlineInCode(),
          () => commands.createParagraphNear(),
          () => commands.liftEmptyBlock(),
          () => commands.splitBlock({ keepMarks: false }),
        ])

        if (!handled || !editor.state.selection.empty) {
          return handled
        }

        const transaction = editor.state.tr.setStoredMarks(EMPTY_STORED_MARKS)

        if (transaction.storedMarksSet) {
          view.dispatch(transaction)
        }

        return true
      },
    }
  },
})
