import type { Editor } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

interface PanelSelectionRange {
  from: number
  to: number
}

type PanelSelectionMeta
  = | {
    range: PanelSelectionRange
    type: 'set'
  }
  | {
    type: 'clear'
  }

const PANEL_SELECTION_CLASS = 'tiptap-panel-selection'
const panelSelectionHighlightPluginKey = new PluginKey<PanelSelectionRange | null>('panelSelectionHighlight')

export const PanelSelectionHighlight = Extension.create({
  name: 'panelSelectionHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<PanelSelectionRange | null>({
        key: panelSelectionHighlightPluginKey,
        state: {
          init: () => null,
          apply(transaction, value) {
            const meta = transaction.getMeta(panelSelectionHighlightPluginKey) as PanelSelectionMeta | undefined

            if (meta?.type === 'clear') {
              return null
            }

            if (meta?.type === 'set') {
              return normalizeRange(meta.range)
            }

            if (!value || !transaction.docChanged) {
              return value
            }

            return normalizeRange({
              from: transaction.mapping.map(value.from, -1),
              to: transaction.mapping.map(value.to, 1),
            })
          },
        },
        props: {
          decorations(state) {
            const range = panelSelectionHighlightPluginKey.getState(state)

            if (!range) {
              return null
            }

            const documentSize = state.doc.content.size
            const from = clampPosition(range.from, documentSize)
            const to = clampPosition(range.to, documentSize)

            if (to <= from) {
              return null
            }

            return DecorationSet.create(state.doc, [
              Decoration.inline(from, to, {
                class: PANEL_SELECTION_CLASS,
              }),
            ])
          },
        },
      }),
    ]
  },
})

export function setPanelSelectionHighlight(editor: Editor, range: PanelSelectionRange) {
  if (!canDispatchEditorTransaction(editor)) {
    return
  }

  if (range.to <= range.from) {
    clearPanelSelectionHighlight(editor)
    return
  }

  editor.view.dispatch(editor.state.tr
    .setMeta(panelSelectionHighlightPluginKey, {
      range,
      type: 'set',
    } satisfies PanelSelectionMeta)
    .setMeta('addToHistory', false))
}

export function clearPanelSelectionHighlight(editor: Editor) {
  if (!canDispatchEditorTransaction(editor)) {
    return
  }

  editor.view.dispatch(editor.state.tr
    .setMeta(panelSelectionHighlightPluginKey, {
      type: 'clear',
    } satisfies PanelSelectionMeta)
    .setMeta('addToHistory', false))
}

function canDispatchEditorTransaction(editor: Editor): boolean {
  return !editor.isDestroyed
    && typeof editor.view?.dispatch === 'function'
    && typeof editor.state?.tr?.setMeta === 'function'
}

function normalizeRange(range: PanelSelectionRange): PanelSelectionRange | null {
  return range.to > range.from
    ? range
    : null
}

function clampPosition(position: number, documentSize: number) {
  return Math.max(0, Math.min(position, documentSize))
}
