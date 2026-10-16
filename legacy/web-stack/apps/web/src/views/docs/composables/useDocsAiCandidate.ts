import type { AgentDocumentAssistantEditIntent } from '@haohaoxue/lexora-contracts/agent'
import type { Editor, EditorEvents, JSONContent } from '@tiptap/core'
import type { DocumentAiCandidateInsertContent } from '../utils/documentAiCandidate'
import type { ChatMessage } from '@/apis/chat'
import {
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT,
  AGENT_DOCUMENT_ASSISTANT_SKILL_KEY,
} from '@haohaoxue/lexora-contracts/agent'
import { CHAT_MESSAGE_STATUS } from '@haohaoxue/lexora-contracts/chat/constants'
import { createSharedComposable } from '@vueuse/core'
import { shallowRef } from 'vue'
import { getMessageText } from '@/composables/chat/utils/chat-message-display'
import { mapDocsSelectionLiveRange } from '../utils/docsSelectionContext'
import { serializeDocsSelectionSnapshotToMarkdownLike } from '../utils/docsSelectionSnapshotSerializer'
import {
  createDocumentAiCandidateContent,
  normalizeDocumentAssistantCandidateTextForIntent,
} from '../utils/documentAiCandidate'

type DocsAiCandidateUserMessage = Extract<ChatMessage, { role: 'user' }>
type DocsAiCandidateUserAttachment = DocsAiCandidateUserMessage['metadata']['attachments'][number]

export interface DocsAiCandidateSelectionSource {
  attachmentId: string
  documentId: string
  editor: Editor
  from: number
  previewMode: 'block' | 'inline'
  to: number
  originalContent: JSONContent[]
  stale?: boolean
}

export interface DocsAiCandidate {
  id: string
  assistantMessageId: string
  attachmentId: string
  documentId: string
  intent: AgentDocumentAssistantEditIntent
  previewMode: 'block' | 'inline'
  from: number
  to: number
  originalContent: JSONContent[]
  candidateContent: JSONContent[]
  insertContent: DocumentAiCandidateInsertContent
}

export const useDocsAiCandidate = createSharedComposable(() => {
  const CONSUMED_ASSISTANT_MESSAGE_LIMIT = 200
  const activeCandidate = shallowRef<DocsAiCandidate | null>(null)
  const selectionSourceByAttachmentId = new Map<string, DocsAiCandidateSelectionSource>()
  const consumedAssistantMessageIds = new Set<string>()
  const pendingSelectionSourceAttachmentIds = new Set<string>()
  const pendingSelectionSourceTransactionHandlers = new Map<Editor, (event: EditorEvents['transaction']) => void>()

  function rememberSelectionSource(input: Omit<DocsAiCandidateSelectionSource, 'originalContent' | 'stale'>) {
    const originalContent = readEditorSliceContent(input.editor, input.from, input.to)

    if (input.to > input.from && !originalContent.length) {
      return
    }

    selectionSourceByAttachmentId.set(input.attachmentId, {
      ...input,
      originalContent,
      stale: false,
    })

    if (pendingSelectionSourceAttachmentIds.has(input.attachmentId)) {
      ensurePendingSelectionSourceTracker(input.editor)
    }
  }

  function updateSelectionSourceRange(input: {
    attachmentId: string
    from: number
    to: number
  }) {
    const source = selectionSourceByAttachmentId.get(input.attachmentId)

    if (!source) {
      return
    }

    source.from = input.from
    source.to = input.to
    source.stale = false

    if (activeCandidate.value?.attachmentId === input.attachmentId) {
      if (
        activeCandidate.value.from === input.from
        && activeCandidate.value.to === input.to
      ) {
        return
      }

      activeCandidate.value = {
        ...activeCandidate.value,
        from: input.from,
        to: input.to,
      }
    }
  }

  function forgetSelectionSource(attachmentId: string) {
    const source = selectionSourceByAttachmentId.get(attachmentId)
    selectionSourceByAttachmentId.delete(attachmentId)
    pendingSelectionSourceAttachmentIds.delete(attachmentId)

    if (activeCandidate.value?.attachmentId === attachmentId) {
      activeCandidate.value = null
    }

    if (source) {
      cleanupPendingSelectionSourceTracker(source.editor)
    }
  }

  function clearSelectionSources() {
    selectionSourceByAttachmentId.clear()
    pendingSelectionSourceAttachmentIds.clear()
    consumedAssistantMessageIds.clear()
    cleanupPendingSelectionSourceTrackers()
    activeCandidate.value = null
  }

  function markSelectionSourcePending(attachmentId: string) {
    const source = selectionSourceByAttachmentId.get(attachmentId)

    if (source) {
      pendingSelectionSourceAttachmentIds.add(attachmentId)
      ensurePendingSelectionSourceTracker(source.editor)
    }
  }

  function clearSelectionSourcePending(attachmentId: string) {
    pendingSelectionSourceAttachmentIds.delete(attachmentId)

    const source = selectionSourceByAttachmentId.get(attachmentId)
    if (source) {
      cleanupPendingSelectionSourceTracker(source.editor)
    }
  }

  function isSelectionSourcePending(attachmentId: string) {
    return pendingSelectionSourceAttachmentIds.has(attachmentId)
  }

  function syncFromMessages(messages: readonly ChatMessage[]) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const assistantMessage = messages[index]

      if (
        !assistantMessage
        || assistantMessage.role !== 'assistant'
        || !isTerminalAssistantStatus(assistantMessage.status)
        || consumedAssistantMessageIds.has(assistantMessage.id)
        || activeCandidate.value?.assistantMessageId === assistantMessage.id
      ) {
        continue
      }

      const userMessage = findPreviousDocumentAssistantUserMessage(messages, index)
      const intent = userMessage?.metadata.skillInvocation?.skillKey === AGENT_DOCUMENT_ASSISTANT_SKILL_KEY
        ? userMessage.metadata.skillInvocation.intent
        : null
      const attachment = userMessage?.metadata.attachments.find(isSelectionDocumentAttachment)

      if (!userMessage || !intent || !attachment) {
        continue
      }

      const source = selectionSourceByAttachmentId.get(attachment.id)

      if (!source) {
        continue
      }

      if (assistantMessage.status !== CHAT_MESSAGE_STATUS.COMPLETED) {
        consumeAssistantMessage(assistantMessage.id)
        forgetSelectionSource(attachment.id)
        continue
      }

      const replacementText = normalizeCandidateTextForIntent({
        intent,
        source,
        text: getMessageText(assistantMessage),
      })

      if (!replacementText) {
        consumeAssistantMessage(assistantMessage.id)
        forgetSelectionSource(attachment.id)
        continue
      }

      if (!isSourceContentCurrent(source, intent)) {
        consumeAssistantMessage(assistantMessage.id)
        forgetSelectionSource(attachment.id)
        continue
      }

      const originalContent = readEditorSliceContent(source.editor, source.from, source.to)
      const sourceContent = originalContent.length ? originalContent : normalizeJsonContentArray(source.originalContent)
      const candidateContent = createDocumentAiCandidateContent(source.editor, replacementText, source.previewMode)

      if (!candidateContent.previewContent.length) {
        consumeAssistantMessage(assistantMessage.id)
        forgetSelectionSource(attachment.id)
        continue
      }

      activeCandidate.value = {
        id: `${assistantMessage.id}:${attachment.id}`,
        assistantMessageId: assistantMessage.id,
        attachmentId: attachment.id,
        documentId: attachment.documentId,
        intent,
        previewMode: source.previewMode,
        from: source.from,
        to: source.to,
        originalContent: sourceContent,
        candidateContent: candidateContent.previewContent,
        insertContent: candidateContent.insertContent,
      }
      return
    }
  }

  function acceptCandidate(candidateId: string) {
    const candidate = activeCandidate.value

    if (!candidate || candidate.id !== candidateId) {
      return false
    }

    const source = selectionSourceByAttachmentId.get(candidate.attachmentId)

    if (!source) {
      return false
    }

    if (!isSourceContentCurrent(source, candidate.intent)) {
      consumeAssistantMessage(candidate.assistantMessageId)
      forgetSelectionSource(candidate.attachmentId)
      return false
    }

    const targetRange = candidate.intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR
      ? source.to
      : { from: source.from, to: source.to }
    const accepted = source.editor
      .chain()
      .focus()
      .insertContentAt(targetRange, candidate.insertContent)
      .run()

    if (!accepted) {
      return false
    }

    consumeAssistantMessage(candidate.assistantMessageId)
    forgetSelectionSource(candidate.attachmentId)
    return accepted
  }

  function rejectCandidate(candidateId: string) {
    const candidate = activeCandidate.value

    if (!candidate || candidate.id !== candidateId) {
      return false
    }

    consumeAssistantMessage(candidate.assistantMessageId)
    forgetSelectionSource(candidate.attachmentId)
    return true
  }

  function ensurePendingSelectionSourceTracker(editor: Editor) {
    if (pendingSelectionSourceTransactionHandlers.has(editor)) {
      return
    }

    const handler = (event: EditorEvents['transaction']) => {
      mapPendingSelectionSources(editor, event.transaction)
    }

    editor.on('transaction', handler)
    pendingSelectionSourceTransactionHandlers.set(editor, handler)
  }

  function cleanupPendingSelectionSourceTracker(editor: Editor) {
    for (const attachmentId of pendingSelectionSourceAttachmentIds) {
      const source = selectionSourceByAttachmentId.get(attachmentId)

      if (source?.editor === editor) {
        return
      }
    }

    const handler = pendingSelectionSourceTransactionHandlers.get(editor)

    if (!handler) {
      return
    }

    editor.off('transaction', handler)
    pendingSelectionSourceTransactionHandlers.delete(editor)
  }

  function cleanupPendingSelectionSourceTrackers() {
    for (const [editor, handler] of pendingSelectionSourceTransactionHandlers) {
      editor.off('transaction', handler)
    }

    pendingSelectionSourceTransactionHandlers.clear()
  }

  function mapPendingSelectionSources(editor: Editor, transaction: EditorEvents['transaction']['transaction']) {
    if (!transaction.docChanged) {
      return
    }

    const staleAttachmentIds: string[] = []

    for (const attachmentId of pendingSelectionSourceAttachmentIds) {
      const source = selectionSourceByAttachmentId.get(attachmentId)

      if (!source || source.editor !== editor) {
        continue
      }

      const mappedRange = mapDocsSelectionLiveRange({
        from: source.from,
        to: source.to,
      }, transaction)

      if (!mappedRange) {
        source.stale = true
        staleAttachmentIds.push(attachmentId)
        continue
      }

      source.from = mappedRange.from
      source.to = mappedRange.to

      if (activeCandidate.value?.attachmentId === attachmentId) {
        activeCandidate.value = {
          ...activeCandidate.value,
          from: mappedRange.from,
          to: mappedRange.to,
        }
      }
    }

    for (const attachmentId of staleAttachmentIds) {
      pendingSelectionSourceAttachmentIds.delete(attachmentId)

      if (activeCandidate.value?.attachmentId === attachmentId) {
        activeCandidate.value = null
      }
    }

    if (staleAttachmentIds.length) {
      cleanupPendingSelectionSourceTracker(editor)
    }
  }

  function isSourceContentCurrent(
    source: DocsAiCandidateSelectionSource,
    intent: AgentDocumentAssistantEditIntent,
  ) {
    if (source.stale) {
      return false
    }

    if (intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR) {
      return true
    }

    const currentContent = readEditorSliceContent(source.editor, source.from, source.to)
    return isSameJsonContent(currentContent, source.originalContent)
  }

  function consumeAssistantMessage(messageId: string) {
    consumedAssistantMessageIds.add(messageId)

    if (consumedAssistantMessageIds.size <= CONSUMED_ASSISTANT_MESSAGE_LIMIT) {
      return
    }

    const oldestMessageId = consumedAssistantMessageIds.values().next().value

    if (oldestMessageId) {
      consumedAssistantMessageIds.delete(oldestMessageId)
    }
  }

  return {
    acceptCandidate,
    activeCandidate,
    clearSelectionSources,
    clearSelectionSourcePending,
    forgetSelectionSource,
    isSelectionSourcePending,
    markSelectionSourcePending,
    rememberSelectionSource,
    rejectCandidate,
    syncFromMessages,
    updateSelectionSourceRange,
  }
})

function findPreviousDocumentAssistantUserMessage(messages: readonly ChatMessage[], beforeIndex: number) {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]

    if (message?.role !== 'user') {
      continue
    }

    if (message.metadata.skillInvocation?.skillKey === AGENT_DOCUMENT_ASSISTANT_SKILL_KEY) {
      return message
    }

    return null
  }

  return null
}

function isSelectionDocumentAttachment(
  attachment: DocsAiCandidateUserAttachment,
): attachment is Extract<DocsAiCandidateUserAttachment, { type: 'document' }> & { scope: { kind: 'selection' } } {
  return attachment.type === 'document' && attachment.scope.kind === 'selection'
}

function isTerminalAssistantStatus(status: ChatMessage['status']) {
  return status === CHAT_MESSAGE_STATUS.COMPLETED
    || status === CHAT_MESSAGE_STATUS.FAILED
    || status === CHAT_MESSAGE_STATUS.CANCELLED
}

function readEditorSliceContent(editor: Editor, from: number, to: number) {
  try {
    return normalizeJsonContentArray(editor.state.doc.slice(from, to).content.toJSON())
  }
  catch {
    return []
  }
}

function normalizeJsonContentArray(content: unknown): JSONContent[] {
  return Array.isArray(content) ? content as JSONContent[] : []
}

function normalizeCandidateTextForIntent(input: {
  intent: AgentDocumentAssistantEditIntent
  source: DocsAiCandidateSelectionSource
  text: string
}) {
  return normalizeDocumentAssistantCandidateTextForIntent({
    anchorPrefix: readAnchorPrefixMarkdown(input.source.editor, input.source.from),
    anchorSuffix: readAnchorSuffixMarkdown(input.source.editor, input.source.to),
    intent: input.intent,
    text: input.text,
  })
}

function readAnchorPrefixMarkdown(editor: Editor, position: number) {
  const prefixContent = readEditorSliceContent(editor, 0, position)
  const lines = serializeDocsSelectionSnapshotToMarkdownLike(prefixContent)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  return lines.at(-1) ?? ''
}

function readAnchorSuffixMarkdown(editor: Editor, position: number) {
  const suffixContent = readEditorSliceContent(editor, position, editor.state.doc.content.size)
  const lines = serializeDocsSelectionSnapshotToMarkdownLike(suffixContent)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  return lines.at(0) ?? ''
}

function isSameJsonContent(left: JSONContent[], right: JSONContent[]) {
  return JSON.stringify(left) === JSON.stringify(right)
}
