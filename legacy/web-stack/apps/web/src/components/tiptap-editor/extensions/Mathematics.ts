import type { Editor } from '@tiptap/core'
import { InputRule } from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { NodeSelection } from '@tiptap/pm/state'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import BlockMathNodeView from './mathematics/BlockMathNodeView.vue'
import InlineMathNodeView from './mathematics/InlineMathNodeView.vue'
import { isMathNodeName } from './mathematics/mathNodeSelection'

export const InlineMathematics = InlineMath.extend({
  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteSelectedMathNode(this.editor, this.name),
      Delete: () => deleteSelectedMathNode(this.editor, this.name),
    }
  },

  addInputRules() {
    return [
      new InputRule({
        find: /(^|[\s([{])(\$([^$\n]+)\$)$/,
        handler: ({ state, range, match }) => {
          const latex = match[3]?.trim()

          if (!latex) {
            return
          }

          state.tr.replaceWith(
            range.from + match[1].length,
            range.to,
            this.type.create({ latex }),
          ).scrollIntoView()
        },
      }),
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(InlineMathNodeView)
  },
})

export const BlockMathematics = BlockMath.extend({
  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteSelectedMathNode(this.editor, this.name),
      Delete: () => deleteSelectedMathNode(this.editor, this.name),
    }
  },

  addCommands() {
    return {
      ...this.parent?.(),
      insertBlockMath:
        options =>
          ({ commands, editor }) => {
            const { pos } = options

            return commands.insertContentAt(pos ?? editor.state.selection.from, {
              type: this.name,
              attrs: {
                latex: options.latex ?? '',
              },
            })
          },
    }
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$([^$]+)\$\$$/,
        handler: ({ state, range, match }) => {
          const latex = match[1]?.trim()

          if (!latex) {
            return
          }

          state.tr.replaceWith(range.from, range.to, this.type.create({ latex })).scrollIntoView()
        },
      }),
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(BlockMathNodeView)
  },
})

function deleteSelectedMathNode(editor: Editor, nodeName: string) {
  const { selection } = editor.state

  if (
    !(selection instanceof NodeSelection)
    || selection.node.type.name !== nodeName
    || !isMathNodeName(selection.node.type.name)
  ) {
    return false
  }

  editor.view.dispatch(editor.state.tr.deleteSelection().scrollIntoView())
  return true
}
