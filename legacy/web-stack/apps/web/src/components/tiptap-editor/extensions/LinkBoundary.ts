import type { MarkType, Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

export const LinkBoundary = Extension.create({
  name: 'linkBoundary',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey(this.name),
        appendTransaction: (_transactions, _oldState, newState) => {
          return createLinkBoundaryExitTransaction(newState)
        },
      }),
    ]
  },
})

function createLinkBoundaryExitTransaction(state: EditorState): Transaction | null {
  const linkType = state.schema.marks.link

  // Link mark 右边界可能保留 stored mark，这里显式退出，避免后续输入继续并入链接。
  if (!linkType || !state.selection.empty || !isAtLinkRightBoundary(state, linkType)) {
    return null
  }

  const activeMarks = state.storedMarks ?? state.selection.$from.marks()

  if (!activeMarks.some(mark => mark.type === linkType)) {
    return null
  }

  return state.tr
    .setStoredMarks(activeMarks.filter(mark => mark.type !== linkType))
    .setMeta('addToHistory', false)
}

function isAtLinkRightBoundary(state: EditorState, linkType: MarkType) {
  const { $from } = state.selection

  return hasMark($from.nodeBefore, linkType) && !hasMark($from.nodeAfter, linkType)
}

function hasMark(node: ProseMirrorNode | null, markType: MarkType) {
  return node?.marks.some(mark => mark.type === markType) ?? false
}
