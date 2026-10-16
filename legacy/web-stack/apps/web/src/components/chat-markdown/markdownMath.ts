import type MarkdownIt from 'markdown-it'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import katex from 'katex'
import { escapeHtml } from './markdownCodeHighlight'

export function markdownMathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'chat_math_inline', parseInlineMath)
  md.block.ruler.after('blockquote', 'chat_math_block', parseBlockMath, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })

  md.renderer.rules.chat_math_inline = (tokens, index) => renderMath(tokens[index]?.content ?? '', false)
  md.renderer.rules.chat_math_block = (tokens, index) => `<div class="chat-markdown__math-block">${renderMath(tokens[index]?.content ?? '', true)}</div>\n`
}

interface InlineMathMarker {
  contentStart: number
  closeLength: number
  type: 'dollar' | 'paren'
}

function parseInlineMath(state: StateInline, silent: boolean): boolean {
  const marker = getInlineMathMarker(state.src, state.pos)

  if (!marker) {
    return false
  }

  const end = findInlineMathEnd(state.src, marker)
  if (end < 0) {
    return false
  }

  const content = state.src.slice(marker.contentStart, end)
  if (!content.trim()) {
    return false
  }

  if (!silent) {
    const token = state.push('chat_math_inline', 'math', 0)
    token.content = content
  }

  state.pos = end + marker.closeLength
  return true
}

function getInlineMathMarker(source: string, position: number): InlineMathMarker | null {
  if (source.charCodeAt(position) === 0x24) {
    return {
      contentStart: position + 1,
      closeLength: 1,
      type: 'dollar',
    }
  }

  if (source.startsWith('\\(', position)) {
    return {
      contentStart: position + 2,
      closeLength: 2,
      type: 'paren',
    }
  }

  return null
}

function findInlineMathEnd(source: string, marker: InlineMathMarker): number {
  if (marker.type === 'dollar') {
    return findClosingDollar(source, marker.contentStart)
  }

  return findClosingParen(source, marker.contentStart)
}

function parseBlockMath(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  const firstLine = state.src.slice(start, max)

  if (!firstLine.startsWith('$$')) {
    return false
  }

  const inlineClose = firstLine.slice(2).lastIndexOf('$$')
  if (inlineClose >= 0) {
    if (!silent) {
      const token = state.push('chat_math_block', 'math', 0)
      token.block = true
      token.content = firstLine.slice(2, inlineClose + 2).trim()
      token.map = [startLine, startLine + 1]
    }
    state.line = startLine + 1
    return true
  }

  let nextLine = startLine + 1
  while (nextLine < endLine) {
    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine]
    const lineEnd = state.eMarks[nextLine]
    const line = state.src.slice(lineStart, lineEnd)

    if (line.trimEnd().endsWith('$$')) {
      if (!silent) {
        const token = state.push('chat_math_block', 'math', 0)
        token.block = true
        token.content = state.getLines(startLine + 1, nextLine, state.blkIndent, false)
        token.content += line.trimEnd().slice(0, -2)
        token.content = token.content.trim()
        token.map = [startLine, nextLine + 1]
      }

      state.line = nextLine + 1
      return true
    }

    nextLine += 1
  }

  return false
}

function findClosingDollar(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    if (source[index] !== '$' || source[index - 1] === '\\') {
      continue
    }

    return index
  }

  return -1
}

function findClosingParen(source: string, start: number): number {
  for (let index = start; index < source.length - 1; index += 1) {
    if (source[index] !== '\\' || source[index + 1] !== ')') {
      continue
    }

    return index
  }

  return -1
}

function renderMath(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: true,
    })
  }
  catch {
    return `<code class="chat-markdown__math-fallback">${escapeHtml(latex)}</code>`
  }
}
