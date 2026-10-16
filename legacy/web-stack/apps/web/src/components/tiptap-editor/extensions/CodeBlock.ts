import type { Editor } from '@tiptap/core'
import {
  TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE,
  TIPTAP_CODE_BLOCK_TAB_SIZES,
} from '@haohaoxue/lexora-contracts/tiptap/document-body'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import CodeBlockNodeView from './code-block/CodeBlockNodeView.vue'
import { CODE_BLOCK_DEFAULT_LANGUAGE } from './code-block/languages'
import { codeBlockLowlight } from './code-block/lowlight'

export const CodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      name: {
        default: undefined,
        parseHTML: element => normalizeCodeBlockName(element.getAttribute('data-name')),
        renderHTML: (attributes) => {
          const name = normalizeCodeBlockName(attributes.name)

          return name ? { 'data-name': name } : {}
        },
      },
      collapsed: {
        default: undefined,
        parseHTML: element => element.getAttribute('data-collapsed') === 'true' ? true : undefined,
        renderHTML: attributes => attributes.collapsed === true
          ? { 'data-collapsed': 'true' }
          : {},
      },
      tabSize: {
        default: undefined,
        parseHTML: element => normalizeCodeBlockTabSizeAttribute(element.getAttribute('data-tab-size')),
        renderHTML: (attributes) => {
          const tabSize = normalizeCodeBlockTabSizeAttribute(attributes.tabSize)

          return tabSize === undefined ? {} : { 'data-tab-size': String(tabSize) }
        },
      },
    }
  },

  addNodeView() {
    return VueNodeViewRenderer(CodeBlockNodeView)
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      'Tab': () => insertCodeBlockTab(this.editor),
      'Shift-Tab': () => stopCodeBlockTab(this.editor),
    }
  },
}).configure({
  defaultLanguage: CODE_BLOCK_DEFAULT_LANGUAGE,
  lowlight: codeBlockLowlight,
})

function normalizeCodeBlockName(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.replace(/\s+/g, ' ').trim()

  return normalized || undefined
}

function insertCodeBlockTab(editor: Editor) {
  const tabSize = resolveActiveCodeBlockTabSize(editor)

  if (!tabSize) {
    return false
  }

  return editor.commands.command(({ state, tr, dispatch }) => {
    if (dispatch) {
      dispatch(tr.insertText(' '.repeat(tabSize), state.selection.from, state.selection.to).scrollIntoView())
    }

    return true
  })
}

function stopCodeBlockTab(editor: Editor) {
  return resolveActiveCodeBlockTabSize(editor) !== null
}

function resolveActiveCodeBlockTabSize(editor: Editor) {
  const { selection } = editor.state

  if (selection.$from.parent.type.name !== 'codeBlock' || selection.$to.parent.type.name !== 'codeBlock') {
    return null
  }

  return normalizeCodeBlockTabSize(selection.$from.parent.attrs.tabSize)
}

function normalizeCodeBlockTabSizeAttribute(value: unknown) {
  const tabSize = normalizeCodeBlockTabSize(value)

  return tabSize === TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE ? undefined : tabSize
}

function normalizeCodeBlockTabSize(value: unknown) {
  const numberValue = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE

  return TIPTAP_CODE_BLOCK_TAB_SIZES.includes(numberValue as typeof TIPTAP_CODE_BLOCK_TAB_SIZES[number])
    ? numberValue
    : TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE
}
