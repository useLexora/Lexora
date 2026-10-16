import type { JSONContent } from '@tiptap/core'
import { TIPTAP_BODY_BLOCK_ID_ATTRIBUTE } from '@haohaoxue/lexora-contracts/tiptap/constants'
import { normalizeCodeBlockLanguage } from '../extensions/code-block/languages'

export interface TextInsertContentOptions {
  firstBlockId?: string
  markdownBlocks?: boolean
}

interface FenceLine {
  char: '`' | '~'
  length: number
  language: string
}

export function createTextInsertContent(
  text: string,
  options: TextInsertContentOptions = {},
): JSONContent[] {
  const normalizedText = normalizeTextInsertNewlines(text)
  const content = options.markdownBlocks
    ? createMarkdownTextInsertContent(normalizedText)
    : createPlainTextInsertContent(normalizedText)

  return applyFirstBlockId(content, options.firstBlockId)
}

export function hasTextInsertMarkdownBlockContent(text: string): boolean {
  return findNextCompleteFence(splitPlainTextParagraphLines(text), 0) !== null
}

export function splitPlainTextParagraphLines(text: string): string[] {
  return normalizeTextInsertNewlines(text).split('\n')
}

function createMarkdownTextInsertContent(text: string): JSONContent[] {
  const lines = text.split('\n')
  const content: JSONContent[] = []
  let lineIndex = 0

  while (lineIndex < lines.length) {
    const fencedBlock = findNextCompleteFence(lines, lineIndex)

    if (!fencedBlock) {
      content.push(...createPlainTextInsertContent(lines.slice(lineIndex).join('\n')))
      break
    }

    if (fencedBlock.start > lineIndex) {
      content.push(...createPlainTextInsertContent(lines.slice(lineIndex, fencedBlock.start).join('\n')))
    }

    content.push(createCodeBlockInsertContent(fencedBlock.language, lines.slice(fencedBlock.start + 1, fencedBlock.end).join('\n')))
    lineIndex = fencedBlock.end + 1
  }

  return content
}

function createPlainTextInsertContent(text: string): JSONContent[] {
  return text.split('\n').map(createParagraphInsertContent)
}

function createParagraphInsertContent(line: string): JSONContent {
  return line.length
    ? {
        type: 'paragraph',
        content: [{ type: 'text', text: line }],
      }
    : {
        type: 'paragraph',
      }
}

function createCodeBlockInsertContent(language: string, body: string): JSONContent {
  return {
    type: 'codeBlock',
    attrs: {
      language,
    },
    content: body.length
      ? [{ type: 'text', text: body }]
      : undefined,
  }
}

function findNextCompleteFence(lines: readonly string[], startIndex: number) {
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    const openFence = parseOpeningFenceLine(lines[lineIndex])

    if (!openFence) {
      continue
    }

    const closingIndex = findClosingFenceLine(lines, lineIndex + 1, openFence)

    if (closingIndex === -1) {
      return null
    }

    return {
      start: lineIndex,
      end: closingIndex,
      language: openFence.language,
    }
  }

  return null
}

function parseOpeningFenceLine(line: string): FenceLine | null {
  const markerStart = countLeadingSpaces(line)

  if (markerStart > 3) {
    return null
  }

  const markerChar = line[markerStart]

  if (markerChar !== '`' && markerChar !== '~') {
    return null
  }

  const markerLength = countRepeatedChars(line, markerStart, markerChar)

  if (markerLength < 3) {
    return null
  }

  return {
    char: markerChar,
    length: markerLength,
    language: normalizeCodeBlockLanguage(readFirstInfoStringWord(line.slice(markerStart + markerLength))),
  }
}

function countLeadingSpaces(line: string) {
  let count = 0

  while (count < line.length && line[count] === ' ') {
    count += 1
  }

  return count
}

function countRepeatedChars(line: string, startIndex: number, char: '`' | '~') {
  let count = 0

  while (line[startIndex + count] === char) {
    count += 1
  }

  return count
}

function readFirstInfoStringWord(info: string) {
  return info.trimStart().split(/\s+/, 1)[0] ?? ''
}

function findClosingFenceLine(lines: readonly string[], startIndex: number, openFence: FenceLine) {
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    if (isClosingFenceLine(lines[lineIndex], openFence)) {
      return lineIndex
    }
  }

  return -1
}

function isClosingFenceLine(line: string, openFence: FenceLine) {
  const trimmed = line.trim()

  if (!trimmed || trimmed[0] !== openFence.char) {
    return false
  }

  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== openFence.char) {
      return false
    }
  }

  return trimmed.length >= openFence.length
}

function applyFirstBlockId(content: JSONContent[], firstBlockId?: string): JSONContent[] {
  if (!firstBlockId || !content[0]) {
    return content
  }

  return [
    {
      ...content[0],
      attrs: {
        ...(content[0].attrs ?? {}),
        [TIPTAP_BODY_BLOCK_ID_ATTRIBUTE]: firstBlockId,
      },
    },
    ...content.slice(1),
  ]
}

function normalizeTextInsertNewlines(text: string) {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
}
