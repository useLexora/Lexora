import type { BuddyQuoteReference } from '@buddy-shared/conversation/buddyInputMaterial'
import type { BuddyMessageQuote, BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { Editor } from '@tiptap/core'
import { BUDDY_QUOTE_COUNT_LIMIT, BUDDY_QUOTE_TOTAL_TEXT_LIMIT, buddyMessageQuoteSchema, buddyQuoteSnapshotLength } from '@buddy-shared/conversation/buddyUserContent'
import { Node } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { watchEffect } from 'vue'
import { CHAT_QUOTE_REFERENCE_NODE_NAME } from '../model/chatComposerDocument'
import { dispatchComposerEdit } from './chatComposerResourceEditing'

export const ChatComposerQuoteReference = Node.create<{
  label: (reference: BuddyQuoteReference) => string
}>({
  name: CHAT_QUOTE_REFERENCE_NODE_NAME,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ quoteId: { default: null, rendered: false }, quoteKind: { default: 'message', rendered: false } }),
  renderHTML({ node }) {
    return ['span', { 'class': 'chat-prompt-token-node', 'data-type': 'chat-quote-reference', 'contenteditable': 'false' }, this.options.label({ type: 'quote_ref', quoteId: node.attrs.quoteId, quoteKind: node.attrs.quoteKind })]
  },
  renderText({ node }) {
    return this.options.label({ type: 'quote_ref', quoteId: node.attrs.quoteId, quoteKind: node.attrs.quoteKind })
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span')
      dom.className = 'chat-prompt-token-node'
      dom.contentEditable = 'false'
      dom.dataset.type = 'chat-quote-reference'
      dom.dataset.quoteId = node.attrs.quoteId
      dom.dataset.quoteKind = node.attrs.quoteKind
      dom.setAttribute('role', 'button')
      const stop = watchEffect(() => {
        dom.textContent = this.options.label({ type: 'quote_ref', quoteId: node.attrs.quoteId, quoteKind: node.attrs.quoteKind })
      })
      return { dom, destroy: stop }
    }
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _old, state) {
        if (!transactions.some(transaction => transaction.docChanged))
          return null
        const invalid: { from: number, to: number }[] = []
        state.doc.descendants((node, position) => {
          if (node.type.name !== CHAT_QUOTE_REFERENCE_NODE_NAME)
            return
          const quotes = node.attrs.quoteKind === 'message' ? state.doc.attrs.quotes : node.attrs.quoteKind === 'resource' ? state.doc.attrs.resourceQuotes : []
          if (!quotes?.some((quote: { id: string }) => quote.id === node.attrs.quoteId))
            invalid.push({ from: position, to: position + node.nodeSize })
        })
        const transaction = state.tr
        for (const range of invalid.toReversed())
          transaction.delete(range.from, range.to)
        return transaction.docChanged ? transaction.setMeta('addToHistory', false) : null
      },
    })]
  },
})

export function insertChatComposerQuoteReference(editor: Editor, reference: BuddyQuoteReference, range?: { from: number, to: number }): boolean {
  if (editor.isDestroyed || !editor.isEditable)
    return false
  const node = editor.schema.nodes[CHAT_QUOTE_REFERENCE_NODE_NAME]!.create(reference)
  const transaction = range ? editor.state.tr.replaceWith(range.from, range.to, node) : editor.state.tr.replaceSelectionWith(node)
  return dispatchComposerEdit(editor, transaction)
}

export function removeChatComposerQuote(editor: Editor | undefined, quoteKind: BuddyQuoteReference['quoteKind'], id: string): void {
  if (!editor || editor.isDestroyed || !editor.isEditable)
    return
  const attribute = quoteKind === 'message' ? 'quotes' : 'resourceQuotes'
  const quotes = editor.state.doc.attrs[attribute] as readonly { id: string }[] | null
  const remaining = quotes?.filter(quote => quote.id !== id) ?? []
  const transaction = editor.state.tr.setDocAttribute(attribute, remaining.length ? remaining : null)
  const ranges: { from: number, to: number }[] = []
  transaction.doc.descendants((node, position) => {
    if (node.type.name === CHAT_QUOTE_REFERENCE_NODE_NAME && node.attrs.quoteKind === quoteKind && node.attrs.quoteId === id)
      ranges.push({ from: position, to: position + node.nodeSize })
  })
  for (const range of ranges.toReversed())
    transaction.delete(range.from, range.to)
  dispatchComposerEdit(editor, transaction)
}

export type ChatQuoteResult = 'added' | 'duplicate' | 'limit' | 'unavailable'

export function addChatComposerQuote(editor: Editor | undefined, quote: BuddyMessageQuote): ChatQuoteResult {
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
  dispatchComposerEdit(editor, editor.state.tr
    .setDocAttribute('quotes', [...quotes, parsed.data])
    .insert(editor.state.selection.to, editor.schema.nodes[CHAT_QUOTE_REFERENCE_NODE_NAME]!.create({ quoteId: quote.id, quoteKind: 'message' })))
  return 'added'
}
