import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'

export interface HistorySelectionDeletedTextRecord {
  from: number
  size: number
  restorePosition: number
  text: string
}

export type HistorySelectionRestoreSide = 'start' | 'end'

interface HistorySelectionTransactionMeta {
  deletedText: HistorySelectionDeletedTextRecord
}

export const HISTORY_SELECTION_TRANSACTION_META = 'lexoraHistorySelection'

export function recordHistorySelectionDeletedText(
  transaction: Transaction,
  doc: ProseMirrorNode,
  from: number,
  to: number,
  restoreSide: HistorySelectionRestoreSide = 'end',
) {
  const deletedText = createHistorySelectionDeletedTextRecord(doc, from, to, restoreSide)

  if (!deletedText) {
    return transaction
  }

  return transaction.setMeta(HISTORY_SELECTION_TRANSACTION_META, {
    deletedText,
  } satisfies HistorySelectionTransactionMeta)
}

export function readHistorySelectionDeletedText(
  transaction: Transaction,
): HistorySelectionDeletedTextRecord | null {
  const meta = transaction.getMeta(HISTORY_SELECTION_TRANSACTION_META) as HistorySelectionTransactionMeta | undefined

  if (!meta?.deletedText) {
    return null
  }

  return meta.deletedText
}

export function mergeHistorySelectionDeletedText(
  previous: HistorySelectionDeletedTextRecord | null,
  current: HistorySelectionDeletedTextRecord,
): HistorySelectionDeletedTextRecord {
  if (!previous) {
    return current
  }

  if (current.from + current.size === previous.from) {
    return {
      from: current.from,
      size: current.size + previous.size,
      restorePosition: previous.restorePosition,
      text: current.text + previous.text,
    }
  }

  if (current.from === previous.from) {
    return {
      from: previous.from,
      size: previous.size + current.size,
      restorePosition: previous.restorePosition,
      text: previous.text + current.text,
    }
  }

  return current
}

export function createHistorySelectionDeletedTextRecord(
  document: ProseMirrorNode,
  from: number,
  to: number,
  restoreSide: HistorySelectionRestoreSide = 'end',
): HistorySelectionDeletedTextRecord | null {
  if (to <= from) {
    return null
  }

  const $from = document.resolve(from)
  const $to = document.resolve(to)

  if ($from.parent !== $to.parent || !$from.parent.isTextblock) {
    return null
  }

  const text = document.textBetween(from, to, '', '')

  if (!text) {
    return null
  }

  return {
    from,
    size: to - from,
    restorePosition: restoreSide === 'start' ? from : to,
    text,
  }
}
