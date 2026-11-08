import type { Token, Tokens } from 'marked'
import type { ChatTranscriptDisplayRow } from '../../model/transcript/chatMessageTime'
import { lexer } from 'marked'
import { getChatMessageDisplayText, getChatMessageUserContent } from '../../model/transcript/chatMessageContent'

export interface ChatTranscriptEstimateLayout {
  width: number
  fontSize: number
  lineHeight: number
  codeFontSize: number
  rem: number
}

export function readChatTranscriptEstimateLayout(element: HTMLElement, width: number): ChatTranscriptEstimateLayout {
  const style = getComputedStyle(element)
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  function pixels(property: string, fallback: number) {
    const value = style.getPropertyValue(property).trim()
    return (Number.parseFloat(value) || fallback) * (value.endsWith('rem') ? rem : 1)
  }
  return {
    width: Math.max(80, Math.min(width - pixels('--buddy-chat-inline-gutter', 16) * 2, pixels('--buddy-chat-reading-width', 800))),
    fontSize: pixels('--buddy-chat-final-font-size', 14),
    lineHeight: pixels('--buddy-chat-final-line-height', 24),
    codeFontSize: pixels('--buddy-chat-code-font-size', 12),
    rem,
  }
}

export function createChatTranscriptEstimator() {
  const cache = new WeakMap<ChatTranscriptDisplayRow, { layout: ChatTranscriptEstimateLayout, height: number, text: string, tokens: Token[] }>()
  return (row: ChatTranscriptDisplayRow, layout: ChatTranscriptEstimateLayout): number => {
    const cached = cache.get(row)
    if (cached?.layout === layout)
      return cached.height
    const text = cached?.text ?? (row.kind === 'message' ? getChatMessageDisplayText(row.message, row.turnOutputs?.artifacts) : '')
    const tokens = cached?.tokens ?? (row.kind === 'message' && row.message.role !== 'user' ? lexer(text) : [])
    const height = estimateRow(row, layout, text, tokens)
    cache.set(row, { layout, height, text, tokens })
    return height
  }
}

function estimateRow(row: ChatTranscriptDisplayRow, layout: ChatTranscriptEstimateLayout, text: string, tokens: Token[]): number {
  if (row.kind === 'day-divider')
    return 52
  if (row.kind !== 'message')
    return row.kind === 'activity' || row.kind === 'compaction' ? 64 : 160

  const { message } = row
  const { width, fontSize, lineHeight, rem } = layout
  const structured = getChatMessageUserContent(message)
  const materials = message.attachments.length || structured?.resourceSnapshots.length
    || structured?.userContent.quotes?.length || structured?.userContent.resourceQuotes?.length || structured?.userContent.sessionReferences?.length
  const mediaHeight = materials ? (message.attachments.some(item => item.kind === 'image') ? 190 : 76) : 0
  if (message.role === 'user') {
    const lines = wrappedLines(text, Math.min(42 * rem, width * 0.92) - 1.9 * rem, fontSize)
    const body = Math.min(5, lines) * lineHeight + (lines > 5 ? 30 : 0)
    return 32 + mediaHeight + (text ? body + 1.5 * rem : 0)
  }
  const identity = row.showIdentity === false ? 0 : 44
  const spacing = row.streaming || row.isIntermediate ? 8 : 32
  const result = row.turnUsage || row.turnResult ? 36 : 0
  return Math.max(lineHeight, markdownHeight(tokens, layout)) + identity + spacing + result + mediaHeight
    + (row.turnOutputs?.artifacts.length ? 76 : 0) + (row.turnChanges ? 48 : 0)
}

function wrappedLines(text: string, width: number, fontSize: number): number {
  if (!text)
    return 0
  const capacity = Math.max(1, width / fontSize)
  return text.split('\n').reduce((total, line) => {
    let units = 0
    for (const character of line)
      units += character.codePointAt(0)! > 0x2FF ? 1 : character === '\t' ? 2 : 0.52
    return total + Math.max(1, Math.ceil(units / capacity))
  }, 0)
}

function inlineText(tokens: Token[] | undefined, fallback: string): string {
  return tokens?.map((token) => {
    if (token.type === 'br')
      return '\n'
    if ('tokens' in token)
      return inlineText(token.tokens, 'text' in token ? token.text : '')
    return 'text' in token ? token.text : token.raw
  }).join('') ?? fallback
}

function markdownHeight(tokens: Token[], layout: ChatTranscriptEstimateLayout): number {
  const { width, fontSize, lineHeight, codeFontSize, rem } = layout
  return tokens.reduce((height, token) => {
    switch (token.type) {
      case 'space':
        return height
      case 'heading': {
        const heading = token as Tokens.Heading
        const size = fontSize * ([22, 19, 16, 14, 14, 14][heading.depth - 1]! / 14)
        return height + wrappedLines(inlineText(heading.tokens, heading.text), width, size) * size * 1.35 + rem * 1.25
      }
      case 'code':
        return height + token.text.split('\n').length * codeFontSize * 1.6 + rem * 4
      case 'list':
        return height + (token as Tokens.List).items.reduce((sum, item) => sum + markdownHeight(item.tokens, { ...layout, width: Math.max(80, width - fontSize * 2.25) }), 0) + rem * 0.75
      case 'blockquote':
        return height + markdownHeight((token as Tokens.Blockquote).tokens, { ...layout, width: Math.max(80, width - rem * 1.5) }) + rem
      case 'table': {
        const table = token as Tokens.Table
        const cellWidth = Math.max(40, width / table.header.length - rem)
        return height + [table.header, ...table.rows].reduce((sum, cells) => sum + Math.max(1, ...cells.map(cell => wrappedLines(inlineText(cell.tokens, cell.text), cellWidth, fontSize))) * lineHeight + rem * 0.75, 0) + rem * 1.25
      }
      case 'hr':
        return height + rem * 2 + 1
      default: {
        const text = inlineText('tokens' in token ? token.tokens : undefined, 'text' in token ? token.text : token.raw)
        return height + wrappedLines(text, width, fontSize) * lineHeight + rem * 0.75
      }
    }
  }, 0)
}
