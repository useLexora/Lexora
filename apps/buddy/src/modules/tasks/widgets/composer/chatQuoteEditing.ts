import type { BuddyMessageQuote, BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { Editor } from '@tiptap/core'
import { BUDDY_QUOTE_COUNT_LIMIT, BUDDY_QUOTE_TOTAL_TEXT_LIMIT, buddyMessageQuoteSchema, buddyQuoteSnapshotLength } from '@buddy-shared/conversation/buddyUserContent'
import { closeHistory } from '@tiptap/pm/history'

export type ChatQuoteResult = 'added' | 'duplicate' | 'limit' | 'unavailable'

export function addChatQuote(editor: Editor | undefined, quote: BuddyMessageQuote): ChatQuoteResult {
  if (!editor || editor.isDestroyed || !editor.isEditable)
    return 'unavailable'
  const parsed = buddyMessageQuoteSchema.safeParse(quote)
  if (!parsed.success)
    return 'limit'
  const quotes: readonly BuddyMessageQuote[] = editor.state.doc.attrs.quotes ?? []
  if (quotes.some(item => item.source.conversationId === quote.source.conversationId
    && item.source.messageId === quote.source.messageId && item.text === quote.text
    && (item.textOffset === undefined || quote.textOffset === undefined || item.textOffset === quote.textOffset))) {
    return 'duplicate'
  }
  const resourceQuotes: readonly BuddyResourceQuote[] = editor.state.doc.attrs.resourceQuotes ?? []
  if (quotes.length + resourceQuotes.length >= BUDDY_QUOTE_COUNT_LIMIT
    || [...quotes, ...resourceQuotes, quote].reduce((total, item) => total + buddyQuoteSnapshotLength(item), 0) > BUDDY_QUOTE_TOTAL_TEXT_LIMIT) {
    return 'limit'
  }
  editor.view.dispatch(closeHistory(editor.state.tr).setDocAttribute('quotes', [...quotes, parsed.data]))
  editor.view.dispatch(closeHistory(editor.state.tr))
  return 'added'
}

export function removeChatQuote(editor: Editor | undefined, id: string): void {
  if (!editor || editor.isDestroyed || !editor.isEditable)
    return
  const quotes: readonly BuddyMessageQuote[] = editor.state.doc.attrs.quotes ?? []
  const next = quotes.filter(quote => quote.id !== id)
  if (next.length === quotes.length)
    return
  editor.view.dispatch(closeHistory(editor.state.tr).setDocAttribute('quotes', next.length ? next : null))
  editor.view.dispatch(closeHistory(editor.state.tr))
}
