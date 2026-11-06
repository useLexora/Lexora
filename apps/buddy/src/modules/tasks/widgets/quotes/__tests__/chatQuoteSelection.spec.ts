// @vitest-environment jsdom
import type { BuddyMessageQuote } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it } from 'vitest'
import { inputMaterialLabel } from '../../../model/materials/inputMaterialView'
import { readChatQuoteSelection } from '../chatQuoteSelection'

const root = document.createElement('div')
afterEach(() => {
  window.getSelection()?.removeAllRanges()
  root.replaceChildren()
  root.remove()
})

function message(text: string, author?: BuddyMessageQuote['source']['author']) {
  document.body.append(root)
  const host = document.createElement('div')
  host.dataset.quoteSource = JSON.stringify({ conversationId: 'conversation-1', branchId: 'branch-1', messageId: 'message-1', role: 'assistant', runId: 'run-1', author })
  const body = document.createElement('pre')
  body.className = 'buddy-chat-message-content__text'
  body.textContent = text
  host.append(body)
  root.append(host)
  return body
}

function select(start: Node, end = start) {
  const range = document.createRange()
  range.setStart(start, 0)
  range.setEnd(end, end.textContent!.length)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

describe('chat quote selection', () => {
  it('captures an immutable snapshot of a single message, preserving indentation and trailing newlines', () => {
    const body = message('    enabled: true\n\n')
    const result = readChatQuoteSelection(root, select(body.firstChild!))!
    expect(result.quote.text).toBe('    enabled: true\n\n')
    body.textContent = 'streamed replacement'
    expect(result.quote.text).toBe('    enabled: true\n\n')
    expect(result.quote.source.messageId).toBe('message-1')
  })

  it.each([{ buddyId: 'default', name: 'Lexora' }, { buddyId: 'reviewer', name: '审查员' }])('preserves the selected author and shares their label across quote surfaces: $name', (author) => {
    const body = message('Original reply', author)
    const { quote } = readChatQuoteSelection(root, select(body.firstChild!))!
    body.parentElement!.dataset.quoteSource = '{}'
    expect(quote.source.author).toEqual(author)
    const material = { kind: 'message_quote' as const, id: quote.id, quote }
    expect(inputMaterialLabel(material, 'zh-CN')).toBe(`引用 · ${author.name}`)
    expect(inputMaterialLabel(material, 'en-US')).toBe(`Quote · ${author.name}`)
    expect(inputMaterialLabel({ ...material, quote: { ...quote, source: { ...quote.source, author: undefined } } }, 'zh-CN')).toBe('引用 · 伙伴的回答')
    expect(inputMaterialLabel({ ...material, quote: { ...quote, source: { ...quote.source, role: 'user' } } }, 'zh-CN')).toBe('引用 · 你的消息')
  })

  it('rejects cross-message, empty, excluded and outside selections', () => {
    const first = message('First')
    const second = message('Second')
    expect(readChatQuoteSelection(root, select(first.firstChild!, second.firstChild!))).toBeNull()
    const button = document.createElement('button')
    button.textContent = 'Copy'
    first.append(button)
    expect(readChatQuoteSelection(root, select(button.firstChild!))).toBeNull()
    expect(readChatQuoteSelection(document.createElement('div'), select(first.firstChild!))).toBeNull()
    window.getSelection()!.removeAllRanges()
    expect(readChatQuoteSelection(root, window.getSelection())).toBeNull()
  })
})
