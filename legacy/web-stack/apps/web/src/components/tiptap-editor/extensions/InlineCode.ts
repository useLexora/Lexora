import type { MarkType } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import { Mark, markInputRule, markPasteRule, mergeAttributes } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'

interface InlineCodeOptions {
  HTMLAttributes: Record<string, unknown>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    code: {
      setCode: () => ReturnType
      toggleCode: () => ReturnType
      unsetCode: () => ReturnType
    }
  }
}

const INPUT_REGEX = /(?<!`)`([^`]+)`$/
const PASTE_REGEX = /(?<!`)`([^`]+)`(?!`)/g

export const InlineCode = Mark.create<InlineCodeOptions>({
  name: 'code',

  addOptions() {
    return {
      HTMLAttributes: {},
    }
  },

  excludes: '_',

  code: true,

  exitable: true,

  parseHTML() {
    return [
      { tag: 'span.inline-code' },
      { tag: 'code' },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: 'inline-code',
      }),
      0,
    ]
  },

  addCommands() {
    return {
      setCode: () => ({ commands }) => commands.setMark(this.name),
      toggleCode: () => ({ commands }) => commands.toggleMark(this.name),
      unsetCode: () => ({ commands }) => commands.unsetMark(this.name),
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-e': () => this.editor.commands.toggleCode(),
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _, newState) => {
          const hasDocumentChange = transactions.some(transaction => transaction.docChanged)

          if (!hasDocumentChange || !newState.selection.empty || !hasStoredCodeMark(newState.storedMarks, this.type)) {
            return null
          }

          if (hasCodeMarkAroundSelection(newState, this.type)) {
            return null
          }

          return newState.tr.removeStoredMark(this.type)
        },
      }),
    ]
  },

  addInputRules() {
    return [
      markInputRule({
        find: INPUT_REGEX,
        type: this.type,
      }),
    ]
  },

  addPasteRules() {
    return [
      markPasteRule({
        find: PASTE_REGEX,
        type: this.type,
      }),
    ]
  },
})

function hasStoredCodeMark(storedMarks: readonly { type: MarkType }[] | null | undefined, codeType: MarkType) {
  return storedMarks?.some(mark => mark.type === codeType) ?? false
}

function hasCodeMarkAroundSelection(state: EditorState, codeType: MarkType) {
  const { $from } = state.selection

  return [$from.nodeBefore, $from.nodeAfter].some(node => node?.marks.some(mark => mark.type === codeType))
}
