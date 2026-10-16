import type { ChatMessageContentJSON } from '@haohaoxue/lexora-contracts'

export interface ChatMessageSerializedContent {
  content: string
  bodyTextWithoutReferences: string
  inlineAttachmentIds: string[]
}

interface ProseMirrorJsonNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: ProseMirrorJsonNode[]
}

export function serializeChatMessageContentJSON(contentJSON: ChatMessageContentJSON): ChatMessageSerializedContent {
  const paragraphs = contentJSON.content ?? []
  const inlineAttachmentIds: string[] = []
  const contentLines: string[] = []
  const bodyLinesWithoutReferences: string[] = []

  for (const paragraph of paragraphs) {
    const serialized = serializeInlineNodes(paragraph.content ?? [])
    contentLines.push(serialized.content)
    bodyLinesWithoutReferences.push(serialized.bodyTextWithoutReferences)
    inlineAttachmentIds.push(...serialized.inlineAttachmentIds)
  }

  return {
    content: trimTrailingLineBreaks(contentLines.join('\n')),
    bodyTextWithoutReferences: trimTrailingLineBreaks(bodyLinesWithoutReferences.join('\n')),
    inlineAttachmentIds,
  }
}

function serializeInlineNodes(nodes: ProseMirrorJsonNode[]): ChatMessageSerializedContent {
  const inlineAttachmentIds: string[] = []
  let content = ''
  let bodyTextWithoutReferences = ''

  for (const node of nodes) {
    if (node.type === 'text') {
      const text = node.text ?? ''
      content += text
      bodyTextWithoutReferences += text
      continue
    }

    if (node.type === 'hardBreak') {
      content += '\n'
      bodyTextWithoutReferences += '\n'
      continue
    }

    if (node.type === 'chatReference') {
      const label = readStringAttr(node, 'label')
      const attachmentId = readStringAttr(node, 'attachmentId')
      if (attachmentId) {
        inlineAttachmentIds.push(attachmentId)
      }
      content += label ? `@${label}` : '@'
    }
  }

  return {
    content,
    bodyTextWithoutReferences,
    inlineAttachmentIds,
  }
}

function readStringAttr(node: ProseMirrorJsonNode, key: string) {
  const value = node.attrs?.[key]
  return typeof value === 'string' ? value : ''
}

function trimTrailingLineBreaks(value: string) {
  return value.replace(/\n+$/u, '')
}
