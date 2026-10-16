import type {
  AgentDocumentAssistantEditIntent,
} from '@haohaoxue/lexora-contracts/agent'
import type {
  ChatComposerAttachment,
  ChatComposerContentJSON,
  ChatComposerDocumentAttachment,
  ChatComposerDocumentScope,
  ChatComposerDocumentSelectionScope,
} from './typing'
import {
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT,
} from '@haohaoxue/lexora-contracts/agent'
import {
  CHAT_MESSAGE_ATTACHMENT_PLACEMENT,
  CHAT_MESSAGE_ATTACHMENT_TYPE,
} from '@haohaoxue/lexora-contracts/chat/constants'
import { translate } from '@/i18n'
import { serializeChatComposerContent } from './serialization'

export type DocumentSelectionDisplayMode = 'selection' | 'continue' | 'rewrite'

export interface AttachmentDisplayLabelOptions {
  documentSelectionDisplayMode?: DocumentSelectionDisplayMode | null
}

export function orderChatComposerAttachments(
  attachments: ChatComposerAttachment[],
  contentJSON: ChatComposerContentJSON,
): ChatComposerAttachment[] {
  const panelAttachments = attachments.filter(attachment =>
    attachment.placement === CHAT_MESSAGE_ATTACHMENT_PLACEMENT.PANEL,
  )
  const attachmentsById = new Map(attachments.map(attachment => [attachment.id, attachment]))
  const orderedInlineAttachments = serializeChatComposerContent(contentJSON)
    .inlineAttachmentIds
    .flatMap((attachmentId) => {
      const attachment = attachmentsById.get(attachmentId)
      return attachment?.placement === CHAT_MESSAGE_ATTACHMENT_PLACEMENT.INLINE ? [attachment] : []
    })

  return [
    ...panelAttachments,
    ...orderedInlineAttachments,
  ]
}

export function getPanelAttachments(attachments: ChatComposerAttachment[]): ChatComposerAttachment[] {
  return attachments.filter(attachment => attachment.placement === CHAT_MESSAGE_ATTACHMENT_PLACEMENT.PANEL)
}

export function findDuplicatePanelAttachment(
  attachments: ChatComposerAttachment[],
  candidate: Pick<ChatComposerDocumentAttachment, 'type' | 'placement' | 'documentId' | 'scope'>,
): ChatComposerAttachment | null {
  return attachments.find(attachment =>
    attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.DOCUMENT
    && attachment.type === candidate.type
    && attachment.placement === CHAT_MESSAGE_ATTACHMENT_PLACEMENT.PANEL
    && candidate.placement === CHAT_MESSAGE_ATTACHMENT_PLACEMENT.PANEL
    && attachment.documentId === candidate.documentId
    && isSameDocumentScope(attachment.scope, candidate.scope),
  ) ?? null
}

export function getAttachmentDisplayLabel(
  attachment: ChatComposerAttachment,
  options: AttachmentDisplayLabelOptions = {},
): string {
  if (attachment.type !== CHAT_MESSAGE_ATTACHMENT_TYPE.DOCUMENT) {
    return attachment.fileName
  }

  if (!isDocumentSelectionAttachment(attachment)) {
    return attachment.title
  }

  return getDocumentSelectionAttachmentLabel(attachment, options)
}

export function getDocumentSelectionDisplayModeFromIntent(
  intent: AgentDocumentAssistantEditIntent | null | undefined,
): DocumentSelectionDisplayMode | null {
  if (!intent) {
    return null
  }

  return intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR
    ? 'continue'
    : 'rewrite'
}

export function isSameDocumentScope(left: ChatComposerDocumentScope, right: ChatComposerDocumentScope): boolean {
  if (left.kind !== right.kind) {
    return false
  }

  if (left.kind === 'full' || right.kind === 'full') {
    return left.kind === right.kind
  }

  return left.field === right.field
    && left.from.blockId === right.from.blockId
    && left.from.offset === right.from.offset
    && left.to.blockId === right.to.blockId
    && left.to.offset === right.to.offset
    && left.blockIds.length === right.blockIds.length
    && left.blockIds.every((blockId, index) => blockId === right.blockIds[index])
}

function getDocumentSelectionAttachmentLabel(
  attachment: ChatComposerDocumentAttachment & { scope: ChatComposerDocumentSelectionScope },
  options: AttachmentDisplayLabelOptions,
) {
  const location = formatDocumentSelectionLocation(attachment.scope)
  const labelKey = getDocumentSelectionLabelKey(options.documentSelectionDisplayMode)

  return translate(labelKey, {
    location,
    title: attachment.title,
  })
}

function isDocumentSelectionAttachment(
  attachment: ChatComposerDocumentAttachment,
): attachment is ChatComposerDocumentAttachment & { scope: ChatComposerDocumentSelectionScope } {
  return attachment.scope.kind === 'selection'
}

function formatDocumentSelectionLocation(scope: ChatComposerDocumentSelectionScope) {
  const from = formatDocumentSelectionBoundary(scope.from)
  const to = formatDocumentSelectionBoundary(scope.to)

  if (from === to) {
    return from
  }

  return `${from}-${to}`
}

function getDocumentSelectionLabelKey(mode: DocumentSelectionDisplayMode | null | undefined) {
  if (mode === 'continue') {
    return 'chat.composer.documentAssistantContinueContext'
  }

  if (mode === 'rewrite') {
    return 'chat.composer.documentAssistantRewriteContext'
  }

  return 'chat.composer.currentSelectionContext'
}

function getSelectionBoundaryPosition(boundary: ChatComposerDocumentSelectionScope['from']) {
  return boundary.position ?? boundary.offset
}

function formatDocumentSelectionBoundary(boundary: ChatComposerDocumentSelectionScope['from']) {
  return `${boundary.blockId}#${getSelectionBoundaryPosition(boundary)}`
}
