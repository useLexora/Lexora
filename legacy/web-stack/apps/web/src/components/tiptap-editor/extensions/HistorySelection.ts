import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { HistorySelectionDeletedTextRecord } from '../commands/historySelection'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import {
  createHistorySelectionDeletedTextRecord,
  mergeHistorySelectionDeletedText,
  readHistorySelectionDeletedText,
} from '../commands/historySelection'

interface HistorySelectionState {
  deletedText: HistorySelectionDeletedTextRecord | null
}

interface HistoryTransactionMeta {
  redo?: boolean
}

const historySelectionPluginKey = new PluginKey<HistorySelectionState>('lexora-history-selection')

export const HistorySelection = Extension.create({
  name: 'HistorySelection',

  addProseMirrorPlugins() {
    let pendingCutDeletedText: HistorySelectionDeletedTextRecord | null = null

    return [
      new Plugin<HistorySelectionState>({
        key: historySelectionPluginKey,
        props: {
          handleDOMEvents: {
            cut: (view) => {
              pendingCutDeletedText = createHistorySelectionDeletedTextRecord(
                view.state.doc,
                view.state.selection.from,
                view.state.selection.to,
              )

              return false
            },
          },
        },
        state: {
          init: () => ({
            deletedText: null,
          }),
          apply: (transaction, pluginState, oldState, newState) => {
            if (!transaction.docChanged) {
              return pluginState
            }

            if (isHistoryRestoreTransaction(transaction)) {
              const restoredTextCursorPosition = pluginState.deletedText
                ? resolveRestoredTextCursorPosition(newState, pluginState.deletedText)
                : null

              return {
                deletedText: pluginState.deletedText && restoredTextCursorPosition === null
                  ? pluginState.deletedText
                  : null,
              }
            }

            const deletedText = readHistorySelectionDeletedText(transaction) ?? pendingCutDeletedText

            if (pendingCutDeletedText) {
              pendingCutDeletedText = null
            }

            if (deletedText) {
              return {
                deletedText: mergeHistorySelectionDeletedText(pluginState.deletedText, deletedText),
              }
            }

            if (pluginState.deletedText && oldState.doc.textContent === newState.doc.textContent) {
              return pluginState
            }

            return { deletedText: null }
          },
        },
        appendTransaction: (transactions, oldState, newState) => {
          const deletedText = historySelectionPluginKey.getState(oldState)?.deletedText

          if (!deletedText || !transactions.some(transaction => transaction.docChanged)) {
            return null
          }

          if (!transactions.some(isHistoryRestoreTransaction)) {
            return null
          }

          const cursorPosition = resolveRestoredTextCursorPosition(newState, deletedText)

          if (cursorPosition === null || newState.selection.from === cursorPosition) {
            return null
          }

          return newState.tr
            .setSelection(TextSelection.create(newState.doc, cursorPosition))
            .scrollIntoView()
            .setMeta('addToHistory', false)
        },
      }),
    ]
  },
})

function resolveRestoredTextCursorPosition(
  state: EditorState,
  deletedText: HistorySelectionDeletedTextRecord,
) {
  const from = deletedText.from
  const to = from + deletedText.size

  if (to > state.doc.content.size) {
    return null
  }

  if (state.doc.textBetween(from, to, '', '') !== deletedText.text) {
    return null
  }

  if (deletedText.restorePosition < from || deletedText.restorePosition > to) {
    return null
  }

  const $restore = state.doc.resolve(deletedText.restorePosition)

  if (!$restore.parent.isTextblock) {
    return null
  }

  return deletedText.restorePosition
}

function isHistoryRestoreTransaction(transaction: Transaction) {
  const historyMeta = transaction.getMeta('history$') as HistoryTransactionMeta | undefined

  return typeof historyMeta === 'object'
    && historyMeta !== null
    && historyMeta.redo === false
}
