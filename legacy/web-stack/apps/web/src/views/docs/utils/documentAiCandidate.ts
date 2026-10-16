import type { AgentDocumentAssistantEditIntent } from '@haohaoxue/lexora-contracts/agent'
import type { Editor, JSONContent } from '@tiptap/core'
import {
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT,
  AGENT_DOCUMENT_ASSISTANT_REFUSAL_PREFIX,
} from '@haohaoxue/lexora-contracts/agent'
import {
  createMarkdownInsertContent,
  hasMarkdownInsertBlockSyntax,
} from '@/components/tiptap-editor/content/markdownContent'

export type DocumentAiCandidateInsertContent = string | JSONContent[]

export interface DocumentAiCandidateContent {
  insertContent: DocumentAiCandidateInsertContent
  previewContent: JSONContent[]
}

export interface NormalizeDocumentAssistantCandidateTextInput {
  anchorPrefix: string
  anchorSuffix: string
  intent: AgentDocumentAssistantEditIntent
  text: string
}

export function createDocumentAiCandidateContent(
  editor: Editor,
  markdownText: string,
  previewMode: 'block' | 'inline',
): DocumentAiCandidateContent {
  const text = markdownText.trim()
  const previewContent = createMarkdownInsertContent(editor, text)
  const insertContent = previewMode === 'inline' && shouldInsertAsInlineContent(text)
    ? unwrapSingleParagraphInlineContent(previewContent) ?? text
    : previewContent

  return {
    insertContent,
    previewContent,
  }
}

export function normalizeDocumentAssistantCandidateTextForIntent(input: NormalizeDocumentAssistantCandidateTextInput) {
  const text = input.text.trim()

  if (!text || isDocumentAssistantRefusalText(text)) {
    return ''
  }

  if (input.intent !== AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR) {
    return text
  }

  const withoutPrefix = stripExistingBoundaryText({
    boundaryLine: input.anchorPrefix,
    side: 'start',
    text,
  })

  return stripExistingBoundaryText({
    boundaryLine: input.anchorSuffix,
    side: 'end',
    text: withoutPrefix,
  })
}

export function isDocumentAssistantRefusalText(text: string) {
  return text.trimStart().startsWith(AGENT_DOCUMENT_ASSISTANT_REFUSAL_PREFIX)
}

function shouldInsertAsInlineContent(text: string) {
  return !/[\r\n]/.test(text) && !hasMarkdownInsertBlockSyntax(text)
}

function unwrapSingleParagraphInlineContent(content: JSONContent[]) {
  const node = content[0]

  if (content.length !== 1 || node?.type !== 'paragraph') {
    return null
  }

  return node.content?.length ? node.content : null
}

function stripExistingBoundaryText(input: {
  boundaryLine: string
  side: 'end' | 'start'
  text: string
}) {
  const boundaryLine = input.boundaryLine.trim()

  if (boundaryLine.length < 4) {
    return input.text
  }

  const lines = input.text.split(/\r?\n/)

  if (input.side === 'start') {
    const textStartOffset = input.text.length - input.text.trimStart().length

    if (input.text.slice(textStartOffset).startsWith(boundaryLine)) {
      return input.text
        .slice(textStartOffset + boundaryLine.length)
        .trimStart()
    }

    const firstContentLineIndex = lines.findIndex(line => line.trim().length > 0)

    return firstContentLineIndex >= 0 && lines[firstContentLineIndex]?.trim() === boundaryLine
      ? lines.slice(firstContentLineIndex + 1).join('\n').trimStart()
      : input.text
  }

  const trimmedEndText = input.text.trimEnd()

  if (trimmedEndText.endsWith(boundaryLine)) {
    return trimmedEndText
      .slice(0, -boundaryLine.length)
      .trimEnd()
  }

  const lastContentLineIndex = findLastContentLineIndex(lines)

  return lastContentLineIndex >= 0 && lines[lastContentLineIndex]?.trim() === boundaryLine
    ? lines.slice(0, lastContentLineIndex).join('\n').trimEnd()
    : input.text
}

function findLastContentLineIndex(lines: string[]) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim()) {
      return index
    }
  }

  return -1
}
