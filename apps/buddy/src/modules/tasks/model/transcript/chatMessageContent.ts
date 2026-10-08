import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'

import { readBuddyInterruptedMessageContent } from '@buddy-shared/conversation/buddyMessageContent'
import { buddyUserContentToText, getBuddyUserContentResourceIds, readBuddyUserMessageContent } from '@buddy-shared/conversation/buddyUserContent'
import { getChatImageLabels } from '../attachments/chatAttachmentView'

export interface ChatMessageInterruption {
  truncated: boolean
}

export interface PresentedArtifactReference {
  artifactId: string
  name: string
  path: string
}

export function getChatMessageInterruption(
  message: LocalMessage,
): ChatMessageInterruption | null {
  if (message.role !== 'assistant')
    return null
  const content = readBuddyInterruptedMessageContent(message.content)
  return content ? { truncated: content.truncated } : null
}

export function getChatMessageText(message: LocalMessage): string {
  const structured = getChatMessageUserContent(message)
  if (structured) {
    const imageLabels = getChatMessageImageLabels(message)
    const attachmentNames = new Map(
      message.attachments.map(attachment => [attachment.attachmentId, attachment.name]),
    )
    const resourceLabels = new Map(
      structured.resourceSnapshots.map(snapshot => [
        snapshot.resourceId,
        snapshot.localReference?.name ?? attachmentNames.get(snapshot.attachmentId ?? '') ?? 'file',
      ]),
    )
    return buddyUserContentToText(
      structured.userContent,
      resourceId => imageLabels.get(resourceId) ?? `@${resourceLabels.get(resourceId) ?? 'file'}`,
    )
  }
  if (typeof message.content === 'string')
    return message.content
  if (!message.content || typeof message.content !== 'object' || Array.isArray(message.content))
    return ''
  const text = (message.content as Record<string, unknown>).text
  return typeof text === 'string' ? text : ''
}

export function getChatMessageUserContent(message: LocalMessage) {
  if (message.role !== 'user')
    return null
  return readBuddyUserMessageContent(message.content)
}

export function getChatMessageImageLabels(message: LocalMessage): Map<string, string> {
  const structured = getChatMessageUserContent(message)
  if (!structured)
    return getChatImageLabels(message.attachments.map(attachment => ({ ...attachment, resourceId: attachment.attachmentId })))
  const attachmentsById = new Map(message.attachments.map(attachment => [attachment.attachmentId, attachment]))
  const snapshotsById = new Map(structured.resourceSnapshots.map(snapshot => [snapshot.resourceId, snapshot.attachmentId]))
  return getChatImageLabels(getBuddyUserContentResourceIds(structured.userContent).flatMap((resourceId) => {
    const attachmentId = snapshotsById.get(resourceId)
    const attachment = attachmentId ? attachmentsById.get(attachmentId) : undefined
    return attachment ? [{ resourceId, kind: attachment.kind, nameSource: attachment.nameSource }] : []
  }))
}

export function getChatMessageDisplayText(
  message: LocalMessage,
  presentedArtifacts: ReadonlyArray<PresentedArtifactReference | string> = [],
): string {
  const text = getChatMessageText(message)
  if (message.role !== 'assistant')
    return text

  const artifactIds = [...new Set(presentedArtifacts.flatMap(artifact => (
    typeof artifact === 'string' ? [artifact] : [artifact.artifactId]
  )).filter(Boolean))]
  const artifactPaths = presentedArtifacts.flatMap(artifact => (
    typeof artifact === 'string' ? [] : [artifact.name, artifact.path]
  ))
  const withoutPresentedLinks = artifactIds.length > 0
    ? text.replace(new RegExp(
        `^[\\t ]*\\[[^\\]\\n]+\\]\\(artifact:(?:${artifactIds.map(escapeRegExp).join('|')})\\)[\\t ]*(?:\\r?\\n|$)`,
        'gim',
      ), '')
    : text
  return stripPresentedFileLinks(withoutPresentedLinks, artifactPaths)
    .replace(/\[([^\]\n]+)\]\(artifact:[^\s)]+\)/gi, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

function stripPresentedFileLinks(text: string, artifactPaths: readonly string[]): string {
  if (artifactPaths.length === 0)
    return text
  const normalizedPaths = new Set(artifactPaths.map(normalizeLinkPath).filter(Boolean))
  return text.replace(
    /^[\t ]*\[[^\]\n]+\]\(([^\s)]+)\)[\t ]*(?:\r?\n|$)/gm,
    (line, target: string) => {
      if (/^https?:/i.test(target))
        return line
      const normalizedTarget = normalizeLinkPath(target)
      const matchesArtifact = [...normalizedPaths].some(path => (
        normalizedTarget === path || normalizedTarget.endsWith(`/${path}`)
      ))
      return matchesArtifact ? '' : line
    },
  )
}

function normalizeLinkPath(value: string): string {
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  }
  catch {}
  return decoded
    .replace(/^file:\/\//i, '')
    .replaceAll('\\', '/')
    .replace(/[?#].*$/, '')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
}

export function isVisibleChatMessage(message: LocalMessage): boolean {
  return message.role !== 'tool'
    && (getChatMessageText(message).trim().length > 0 || message.attachments.length > 0 || Boolean(getChatMessageUserContent(message)?.userContent.quotes?.length) || Boolean(getChatMessageUserContent(message)?.userContent.resourceQuotes?.length) || Boolean(getChatMessageUserContent(message)?.userContent.sessionReferences?.length))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
