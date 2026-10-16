import type { AgentDocumentAssistantEditIntent } from '@haohaoxue/lexora-contracts/agent'
import type { Editor, EditorEvents } from '@tiptap/core'
import type { Ref } from 'vue'
import type { ActiveDocumentDetail } from '../typing'
import type { DocsSelectionLiveRange, DocsSelectionSnapshot } from '../utils/docsSelectionContext'
import type {
  ChatComposerAttachment,
  ChatComposerDocumentSelectionScope,
  ChatComposerSubmitPayload,
} from '@/components/chat-composer'
import type { TiptapEditorBlockContextRequest } from '@/components/tiptap-editor'
import { AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT } from '@haohaoxue/lexora-contracts/agent'
import {
  CHAT_MESSAGE_ATTACHMENT_PLACEMENT,
  CHAT_MESSAGE_ATTACHMENT_TYPE,
} from '@haohaoxue/lexora-contracts/chat/constants'
import { getDocumentTitlePlainText } from '@haohaoxue/lexora-shared/document'
import { TextSelection } from '@tiptap/pm/state'
import { nanoid } from 'nanoid'
import {
  getCurrentScope,
  onScopeDispose,
  watch,
} from 'vue'
import {
  clearDocumentAiAnchorPreview,
  setDocumentAiAnchorPreview,
} from '@/components/tiptap-editor/extensions/DocumentAiDraftPreview'
import { translate } from '@/i18n'
import { createDocsBlockSnapshot, createDocsSelectionSnapshot, mapDocsSelectionLiveRange, resolveDocsSelectionScope } from '../utils/docsSelectionContext'
import { useActiveDocument } from './useActiveDocument'
import { useDocsAiCandidate } from './useDocsAiCandidate'
import { useDocsChatPanel } from './useDocsChatPanel'

export interface DocsSelectionContextRequest {
  editor: Editor
  from: number
  to: number
}

interface DocsSelectionContextDocument {
  id: ActiveDocumentDetail['id']
  title: ActiveDocumentDetail['title']
}

interface DocsSelectionAnchor {
  attachmentId: string
  blockId?: string
  documentId: string
  editor: Editor
  from: number
  previewMode: 'block' | 'inline'
  to: number
}

interface DocsAutoSelectionAnchorContext {
  document: DocsSelectionContextDocument
  editor: Editor
  from: number
  previewMode: 'inline'
  snapshot: DocsSelectionSnapshot
  to: number
}

interface DocsLatestEditorSelection {
  documentId: string
  editor: Editor
  from: number
  to: number
}

interface DocsChatContextBridgePanel {
  attachments: Ref<ChatComposerAttachment[]>
  clearSelectionContexts: () => void
  documentAssistantEditIntent: Ref<AgentDocumentAssistantEditIntent | null>
  highlightAttachment: (attachmentId: string) => void
  openPanel: () => void
  registerBeforeSendHandler: (handler: (payload: ChatComposerSubmitPayload) => ChatComposerSubmitPayload) => () => boolean
  registerSendFailureHandler: (handler: (payload: ChatComposerSubmitPayload) => void) => () => boolean
  registerSubmitStartHandler: (handler: (payload: ChatComposerSubmitPayload) => void) => () => boolean
  requestComposerFocus: () => void
}

export function useDocsChatContextBridge() {
  const { currentDocument } = useActiveDocument()
  const panel = useDocsChatPanel()

  return createDocsChatContextBridgeController({
    currentDocument,
    panel,
  })
}

export function createDocsChatContextBridgeController(options: {
  currentDocument: Ref<DocsSelectionContextDocument | null>
  panel: DocsChatContextBridgePanel
  createAttachmentId?: () => string
}) {
  const anchors = new Map<string, DocsSelectionAnchor>()
  const docsAiCandidate = useDocsAiCandidate()
  const editorTransactionHandlers = new Map<Editor, (event: EditorEvents['transaction']) => void>()
  const createAttachmentId = options.createAttachmentId ?? (() => `att_${nanoid(10)}`)
  let latestEditorSelection: DocsLatestEditorSelection | null = null
  let latestEditorSelectionVersion = 0
  let autoAnchorAttachmentId: string | null = null
  let autoAnchorSelectionVersion: number | null = null
  let activeAnchorPreviewEditor: Editor | null = null
  let anchorContextMutationDepth = 0
  const unregisterSubmitStart = options.panel.registerSubmitStartHandler(markSelectionSourcesSent)
  const unregisterSendFailure = options.panel.registerSendFailureHandler(clearPendingSelectionSources)
  const unregisterBeforeSend = options.panel.registerBeforeSendHandler(refreshSelectionSnapshotsForSend)
  const stopDocumentAssistantIntentWatch = watch(
    () => options.panel.documentAssistantEditIntent.value,
    () => syncDocumentAssistantAnchorContext(),
    { flush: 'sync' },
  )
  const stopDocumentWatch = watch(
    () => options.currentDocument.value?.id ?? null,
    () => clearAllSelectionContexts(),
  )
  const stopAttachmentWatch = watch(
    () => options.panel.attachments.value
      .filter(attachment => attachment.type === 'document' && attachment.scope.kind === 'selection')
      .map(attachment => attachment.id)
      .join('\n'),
    () => {
      pruneDetachedSelectionAnchors()
      syncDocumentAssistantAnchorContext()
    },
    { flush: 'sync' },
  )

  if (getCurrentScope()) {
    onScopeDispose(dispose)
  }

  function handleAddSelectionContext(request: DocsSelectionContextRequest) {
    pruneDetachedSelectionAnchors()

    const document = options.currentDocument.value
    const range = resolveRequestTextSelectionRange(request)

    if (!document || !range) {
      return false
    }

    const snapshot = createDocsSelectionSnapshot(request.editor, range, {
      intent: options.panel.documentAssistantEditIntent.value,
    })

    if (!snapshot) {
      return false
    }

    const duplicateAnchor = findDuplicateAnchor({
      editor: request.editor,
      documentId: document.id,
      from: range.from,
      to: range.to,
    })

    if (duplicateAnchor) {
      options.panel.openPanel()
      options.panel.highlightAttachment(duplicateAnchor.attachmentId)
      options.panel.requestComposerFocus()
      collapseEditorSelection(request.editor, range.to)
      return false
    }

    const attachment: ChatComposerAttachment = {
      id: createAttachmentId(),
      type: CHAT_MESSAGE_ATTACHMENT_TYPE.DOCUMENT,
      placement: CHAT_MESSAGE_ATTACHMENT_PLACEMENT.PANEL,
      documentId: document.id,
      title: resolveDocumentTitle(document),
      scope: snapshot.scope,
      snapshot: snapshot.snapshot,
      size: snapshot.size,
    }

    anchors.set(attachment.id, {
      attachmentId: attachment.id,
      documentId: document.id,
      editor: request.editor,
      from: range.from,
      previewMode: 'inline',
      to: range.to,
    })
    docsAiCandidate.rememberSelectionSource({
      attachmentId: attachment.id,
      documentId: document.id,
      editor: request.editor,
      from: range.from,
      previewMode: 'inline',
      to: range.to,
    })
    ensureEditorTransactionHandler(request.editor)
    options.panel.attachments.value = [
      ...options.panel.attachments.value,
      attachment,
    ]
    collapseEditorSelection(request.editor, range.to)
    options.panel.openPanel()
    options.panel.requestComposerFocus()
    syncDocumentAssistantAnchorContext()
    return true
  }

  function handleRewriteBlockContext(request: TiptapEditorBlockContextRequest) {
    pruneDetachedSelectionAnchors()

    const document = options.currentDocument.value
    if (!document) {
      return false
    }

    const snapshot = createDocsBlockSnapshot(request.editor, {
      blockId: request.blockId,
      from: request.from,
      to: request.to,
    })

    if (!snapshot) {
      return false
    }

    const attachmentId = createAttachmentId()
    const attachment: ChatComposerAttachment = {
      id: attachmentId,
      type: CHAT_MESSAGE_ATTACHMENT_TYPE.DOCUMENT,
      placement: CHAT_MESSAGE_ATTACHMENT_PLACEMENT.PANEL,
      documentId: document.id,
      title: resolveDocumentTitle(document),
      scope: snapshot.scope,
      snapshot: snapshot.snapshot,
      size: snapshot.size,
    }

    runWithAnchorContextMutation(() => {
      clearSelectionAnchorContexts()
      autoAnchorAttachmentId = attachmentId
      autoAnchorSelectionVersion = latestEditorSelectionVersion
      anchors.set(attachmentId, {
        attachmentId,
        blockId: request.blockId,
        documentId: document.id,
        editor: request.editor,
        from: request.from,
        previewMode: 'block',
        to: request.to,
      })
      docsAiCandidate.rememberSelectionSource({
        attachmentId,
        documentId: document.id,
        editor: request.editor,
        from: request.from,
        previewMode: 'block',
        to: request.to,
      })
      ensureEditorTransactionHandler(request.editor)
      options.panel.attachments.value = [
        ...options.panel.attachments.value,
        attachment,
      ]
      options.panel.documentAssistantEditIntent.value = AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.REWRITE_SELECTION
    })
    options.panel.openPanel()
    options.panel.requestComposerFocus()
    syncDocumentAssistantAnchorContext()
    return true
  }

  function handleEditorSelectionChange(request: DocsSelectionContextRequest) {
    const document = options.currentDocument.value
    const range = resolveRequestTextSelectionRange(request, { allowCollapsed: true })

    if (!document || !range) {
      return
    }

    latestEditorSelection = {
      documentId: document.id,
      editor: request.editor,
      from: range.from,
      to: range.to,
    }
    latestEditorSelectionVersion += 1

    syncDocumentAssistantAnchorContext()
  }

  function refreshSelectionSnapshotsForSend(payload: ChatComposerSubmitPayload): ChatComposerSubmitPayload {
    ensureAutoDocumentAssistantAnchorContext()

    const nextPanelAttachments = refreshSelectionAttachments(options.panel.attachments.value)
    const nextPanelAttachmentById = new Map(nextPanelAttachments.map(attachment => [attachment.id, attachment]))

    if (nextPanelAttachments !== options.panel.attachments.value) {
      options.panel.attachments.value = nextPanelAttachments
    }

    const nextPayloadAttachments = payload.attachments.flatMap((attachment) => {
      if (attachment.type !== 'document' || attachment.scope.kind !== 'selection') {
        return [attachment]
      }

      const nextAttachment = nextPanelAttachmentById.get(attachment.id)

      return nextAttachment ? [nextAttachment] : []
    })

    return {
      ...payload,
      attachments: nextPayloadAttachments,
    }
  }

  function refreshSelectionAttachments(attachments: ChatComposerAttachment[]) {
    let changed = false
    const nextAttachments: ChatComposerAttachment[] = []

    for (const attachment of attachments) {
      if (attachment.type !== 'document' || attachment.scope.kind !== 'selection') {
        nextAttachments.push(attachment)
        continue
      }

      const anchor = anchors.get(attachment.id)

      if (!anchor) {
        changed = true
        continue
      }

      const sourceRange = resolveAnchorSourceRangeForIntent(anchor, options.panel.documentAssistantEditIntent.value)
      const sourcePreviewMode = resolveAnchorPreviewModeForIntent(anchor, options.panel.documentAssistantEditIntent.value)
      const snapshot = sourcePreviewMode === 'block'
        ? createDocsBlockSnapshot(anchor.editor, {
            blockId: anchor.blockId ?? attachment.scope.blockIds[0] ?? '',
            from: sourceRange.from,
            to: sourceRange.to,
          })
        : createDocsSelectionSnapshot(anchor.editor, {
            from: sourceRange.from,
            to: sourceRange.to,
          }, {
            intent: options.panel.documentAssistantEditIntent.value,
          })

      if (!snapshot) {
        removeSelectionAnchor(attachment.id)
        changed = true
        continue
      }

      const nextAttachment = {
        ...attachment,
        scope: snapshot.scope,
        snapshot: snapshot.snapshot,
        size: snapshot.size,
      }

      docsAiCandidate.rememberSelectionSource({
        attachmentId: attachment.id,
        documentId: attachment.documentId,
        editor: anchor.editor,
        from: sourceRange.from,
        previewMode: sourcePreviewMode,
        to: sourceRange.to,
      })

      if (isSameSelectionAttachmentContext(attachment, nextAttachment)) {
        nextAttachments.push(attachment)
      }
      else {
        changed = true
        nextAttachments.push(nextAttachment)
      }
    }

    return changed ? nextAttachments : attachments
  }

  function markSelectionSourcesSent(payload: ChatComposerSubmitPayload) {
    for (const attachment of payload.attachments) {
      if (attachment.type === 'document' && attachment.scope.kind === 'selection') {
        docsAiCandidate.markSelectionSourcePending(attachment.id)
      }
    }
  }

  function clearPendingSelectionSources(payload: ChatComposerSubmitPayload) {
    for (const attachment of payload.attachments) {
      if (attachment.type === 'document' && attachment.scope.kind === 'selection') {
        docsAiCandidate.clearSelectionSourcePending(attachment.id)
      }
    }
  }

  function syncDocumentAssistantAnchorContext() {
    if (anchorContextMutationDepth > 0) {
      return
    }

    ensureAutoDocumentAssistantAnchorContext()
    syncSelectionAttachmentsForCurrentIntent()

    const previewAnchor = resolveDocumentAssistantPreviewAnchor()
    if (!previewAnchor) {
      clearActiveAnchorPreview()
      return
    }

    if (activeAnchorPreviewEditor && activeAnchorPreviewEditor !== previewAnchor.editor) {
      clearDocumentAiAnchorPreview(activeAnchorPreviewEditor)
    }

    setDocumentAiAnchorPreview(previewAnchor.editor, {
      id: previewAnchor.attachmentId,
      from: previewAnchor.from,
      mode: previewAnchor.previewMode,
      to: previewAnchor.to,
    })
    activeAnchorPreviewEditor = previewAnchor.editor
  }

  function syncSelectionAttachmentsForCurrentIntent() {
    const nextAttachments = refreshSelectionAttachments(options.panel.attachments.value)

    if (nextAttachments === options.panel.attachments.value) {
      return
    }

    runWithAnchorContextMutation(() => {
      options.panel.attachments.value = nextAttachments
    })
  }

  function ensureAutoDocumentAssistantAnchorContext() {
    const intent = options.panel.documentAssistantEditIntent.value

    if (!intent) {
      removeAutoAnchorContext()
      return
    }

    if (findSelectionAnchor(anchor => anchor.attachmentId !== autoAnchorAttachmentId)) {
      removeAutoAnchorContext()
      return
    }

    const autoAnchor = autoAnchorAttachmentId ? anchors.get(autoAnchorAttachmentId) : null

    if (
      autoAnchor?.previewMode === 'block'
      && autoAnchorSelectionVersion === latestEditorSelectionVersion
    ) {
      return
    }

    const nextContext = resolveLatestEditorSelectionAnchorContext(intent)

    if (!nextContext) {
      removeAutoAnchorContext()
      return
    }

    upsertAutoSelectionAnchorContext(nextContext)
  }

  function resolveLatestEditorSelectionAnchorContext(
    intent: AgentDocumentAssistantEditIntent,
  ): DocsAutoSelectionAnchorContext | null {
    const selection = latestEditorSelection
    const document = options.currentDocument.value

    if (!selection || !document || selection.documentId !== document.id) {
      return null
    }

    if (intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.REWRITE_SELECTION && selection.to <= selection.from) {
      return null
    }

    const range = intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR
      ? {
          from: selection.to,
          to: selection.to,
        }
      : {
          from: selection.from,
          to: selection.to,
        }
    const snapshot = createDocsSelectionSnapshot(selection.editor, range, { intent })

    if (!snapshot) {
      return null
    }

    return {
      document,
      editor: selection.editor,
      from: range.from,
      previewMode: 'inline',
      snapshot,
      to: range.to,
    }
  }

  function upsertAutoSelectionAnchorContext(context: DocsAutoSelectionAnchorContext) {
    const attachmentId = autoAnchorAttachmentId ?? createAttachmentId()
    const previousAnchor = anchors.get(attachmentId)

    autoAnchorAttachmentId = attachmentId
    autoAnchorSelectionVersion = latestEditorSelectionVersion
    anchors.set(attachmentId, {
      attachmentId,
      documentId: context.document.id,
      editor: context.editor,
      from: context.from,
      previewMode: context.previewMode,
      to: context.to,
    })
    docsAiCandidate.rememberSelectionSource({
      attachmentId,
      documentId: context.document.id,
      editor: context.editor,
      from: context.from,
      previewMode: context.previewMode,
      to: context.to,
    })
    ensureEditorTransactionHandler(context.editor)

    const nextAttachment: ChatComposerAttachment = {
      id: attachmentId,
      type: CHAT_MESSAGE_ATTACHMENT_TYPE.DOCUMENT,
      placement: CHAT_MESSAGE_ATTACHMENT_PLACEMENT.PANEL,
      documentId: context.document.id,
      title: resolveDocumentTitle(context.document),
      scope: context.snapshot.scope,
      snapshot: context.snapshot.snapshot,
      size: context.snapshot.size,
    }
    const currentAttachments = options.panel.attachments.value
    const currentIndex = currentAttachments.findIndex(attachment => attachment.id === attachmentId)

    options.panel.attachments.value = currentIndex >= 0
      ? currentAttachments.map(attachment => attachment.id === attachmentId ? nextAttachment : attachment)
      : [...currentAttachments, nextAttachment]

    if (previousAnchor && previousAnchor.editor !== context.editor) {
      cleanupEditorTransactionHandler(previousAnchor.editor)
    }
  }

  function resolveDocumentAssistantPreviewAnchor() {
    const intent = options.panel.documentAssistantEditIntent.value

    if (!intent) {
      return null
    }

    const selectionAnchor = resolveSelectionAnchor()

    if (selectionAnchor) {
      if (intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR) {
        return {
          ...selectionAnchor,
          from: selectionAnchor.to,
          previewMode: 'inline' as const,
          to: selectionAnchor.to,
        }
      }

      return selectionAnchor.to > selectionAnchor.from ? selectionAnchor : null
    }

    if (intent !== AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR) {
      return null
    }

    const document = options.currentDocument.value
    if (!document || latestEditorSelection?.documentId !== document.id) {
      return null
    }

    return {
      attachmentId: 'latest-document-ai-anchor',
      documentId: document.id,
      editor: latestEditorSelection.editor,
      from: latestEditorSelection.from,
      previewMode: 'inline' as const,
      to: latestEditorSelection.to,
    }
  }

  function resolveSelectionAnchor() {
    const autoAnchor = autoAnchorAttachmentId ? anchors.get(autoAnchorAttachmentId) : null

    if (
      autoAnchor
      && isSelectionAnchorActive(autoAnchor)
    ) {
      return autoAnchor
    }

    return findSelectionAnchor()
  }

  function ensureEditorTransactionHandler(editor: Editor) {
    if (editorTransactionHandlers.has(editor)) {
      return
    }

    const handler = (event: EditorEvents['transaction']) => {
      mapEditorAnchors(editor, event.transaction)
    }

    editor.on('transaction', handler)
    editorTransactionHandlers.set(editor, handler)
  }

  function mapEditorAnchors(editor: Editor, transaction: EditorEvents['transaction']['transaction']) {
    if (!transaction.docChanged) {
      return
    }

    const removedAttachmentIds: string[] = []
    const mappedRanges = new Map<string, DocsSelectionLiveRange>()

    for (const anchor of anchors.values()) {
      if (anchor.editor !== editor) {
        continue
      }

      const mappedRange = mapDocsSelectionLiveRange({
        from: anchor.from,
        to: anchor.to,
      }, transaction)

      if (!mappedRange) {
        removedAttachmentIds.push(anchor.attachmentId)
        continue
      }

      anchor.from = mappedRange.from
      anchor.to = mappedRange.to
      const sourceRange = resolveAnchorSourceRangeForIntent(anchor, options.panel.documentAssistantEditIntent.value)
      mappedRanges.set(anchor.attachmentId, sourceRange)
      docsAiCandidate.updateSelectionSourceRange({
        attachmentId: anchor.attachmentId,
        from: sourceRange.from,
        to: sourceRange.to,
      })
    }

    syncMappedAttachmentPositions(mappedRanges, editor.state.doc)

    if (!removedAttachmentIds.length) {
      return
    }

    options.panel.attachments.value = options.panel.attachments.value.filter(attachment =>
      !removedAttachmentIds.includes(attachment.id),
    )

    for (const attachmentId of removedAttachmentIds) {
      removeSelectionAnchor(attachmentId)
    }
  }

  function syncMappedAttachmentPositions(mappedRanges: Map<string, DocsSelectionLiveRange>, doc: Editor['state']['doc']) {
    if (!mappedRanges.size) {
      return
    }

    let changed = false
    const nextAttachments = options.panel.attachments.value.map((attachment) => {
      if (!isSelectionDocumentAttachment(attachment)) {
        return attachment
      }

      const mappedRange = mappedRanges.get(attachment.id)

      if (!mappedRange) {
        return attachment
      }

      const nextScope = resolveDocsSelectionScope(doc, mappedRange.from, mappedRange.to) ?? {
        ...attachment.scope,
        from: {
          ...attachment.scope.from,
          position: mappedRange.from,
        },
        to: {
          ...attachment.scope.to,
          position: mappedRange.to,
        },
      }

      if (isSameSelectionScopeSnapshot(attachment.scope, nextScope)) {
        return attachment
      }

      changed = true

      return {
        ...attachment,
        scope: nextScope,
      }
    })

    if (changed) {
      options.panel.attachments.value = nextAttachments
    }
  }

  function isSameSelectionScopeSnapshot(
    left: ChatComposerDocumentSelectionScope,
    right: ChatComposerDocumentSelectionScope,
  ) {
    return left.field === right.field
      && left.from.blockId === right.from.blockId
      && left.from.offset === right.from.offset
      && left.from.position === right.from.position
      && left.to.blockId === right.to.blockId
      && left.to.offset === right.to.offset
      && left.to.position === right.to.position
      && left.blockIds.length === right.blockIds.length
      && left.blockIds.every((blockId, index) => blockId === right.blockIds[index])
  }

  function isSameSelectionAttachmentContext(
    left: ChatComposerAttachment,
    right: ChatComposerAttachment,
  ) {
    if (
      left.type !== 'document'
      || right.type !== 'document'
      || left.scope.kind !== 'selection'
      || right.scope.kind !== 'selection'
    ) {
      return false
    }

    return left.snapshot === right.snapshot
      && left.size === right.size
      && isSameSelectionScopeSnapshot(left.scope, right.scope)
  }

  function resolveAnchorSourceRangeForIntent(
    anchor: DocsSelectionAnchor,
    intent: AgentDocumentAssistantEditIntent | null,
  ): DocsSelectionLiveRange {
    if (intent !== AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR) {
      return {
        from: anchor.from,
        to: anchor.to,
      }
    }

    return {
      from: anchor.to,
      to: anchor.to,
    }
  }

  function resolveAnchorPreviewModeForIntent(
    anchor: DocsSelectionAnchor,
    intent: AgentDocumentAssistantEditIntent | null,
  ): DocsSelectionAnchor['previewMode'] {
    return intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR
      ? 'inline'
      : anchor.previewMode
  }

  function clearAllSelectionContexts() {
    anchors.clear()
    autoAnchorAttachmentId = null
    autoAnchorSelectionVersion = null
    latestEditorSelection = null
    latestEditorSelectionVersion = 0
    clearActiveAnchorPreview()
    docsAiCandidate.clearSelectionSources()
    for (const [editor, handler] of editorTransactionHandlers) {
      editor.off('transaction', handler)
    }
    editorTransactionHandlers.clear()
    options.panel.clearSelectionContexts()
  }

  function clearSelectionAnchorContexts() {
    const attachmentIds = [...anchors.keys()]
    options.panel.clearSelectionContexts()

    for (const attachmentId of attachmentIds) {
      removeSelectionAnchor(attachmentId)
    }

    autoAnchorAttachmentId = null
    autoAnchorSelectionVersion = null
    clearActiveAnchorPreview()
  }

  function runWithAnchorContextMutation(callback: () => void) {
    anchorContextMutationDepth += 1
    try {
      callback()
    }
    finally {
      anchorContextMutationDepth -= 1
    }
  }

  function dispose() {
    stopDocumentWatch()
    stopAttachmentWatch()
    stopDocumentAssistantIntentWatch()
    unregisterSubmitStart()
    unregisterSendFailure()
    unregisterBeforeSend()
    clearAllSelectionContexts()
  }

  return {
    dispose,
    handleAddSelectionContext,
    handleEditorSelectionChange,
    handleRewriteBlockContext,
  }

  function findDuplicateAnchor(input: {
    documentId: string
    editor: Editor
    from: number
    to: number
  }) {
    for (const anchor of anchors.values()) {
      if (
        anchor.documentId === input.documentId
        && anchor.editor === input.editor
        && anchor.from === input.from
        && anchor.to === input.to
      ) {
        return anchor
      }
    }

    return null
  }

  function cleanupEditorTransactionHandler(editor: Editor) {
    for (const anchor of anchors.values()) {
      if (anchor.editor === editor) {
        return
      }
    }

    const handler = editorTransactionHandlers.get(editor)

    if (!handler) {
      return
    }

    editor.off('transaction', handler)
    editorTransactionHandlers.delete(editor)
  }

  function findSelectionAnchor(predicate?: (anchor: DocsSelectionAnchor) => boolean) {
    const activeSelectionAttachmentIds = new Set(
      options.panel.attachments.value
        .filter(isSelectionDocumentAttachment)
        .map(attachment => attachment.id),
    )

    for (const anchor of anchors.values()) {
      if (!activeSelectionAttachmentIds.has(anchor.attachmentId)) {
        continue
      }

      if (!predicate || predicate(anchor)) {
        return anchor
      }
    }

    return null
  }

  function isSelectionAnchorActive(anchor: DocsSelectionAnchor) {
    return options.panel.attachments.value.some(attachment =>
      attachment.id === anchor.attachmentId
      && isSelectionDocumentAttachment(attachment),
    )
  }

  function removeAutoAnchorContext() {
    const attachmentId = autoAnchorAttachmentId
    if (!attachmentId) {
      return
    }

    options.panel.attachments.value = options.panel.attachments.value.filter(attachment => attachment.id !== attachmentId)
    removeSelectionAnchor(attachmentId, {
      forgetSource: !docsAiCandidate.isSelectionSourcePending(attachmentId),
    })
    autoAnchorAttachmentId = null
  }

  function removeSelectionAnchor(
    attachmentId: string,
    params: {
      forgetSource?: boolean
    } = {},
  ) {
    const anchor = anchors.get(attachmentId)
    anchors.delete(attachmentId)

    if (autoAnchorAttachmentId === attachmentId) {
      autoAnchorAttachmentId = null
      autoAnchorSelectionVersion = null
    }

    if (params.forgetSource !== false) {
      docsAiCandidate.forgetSelectionSource(attachmentId)
    }

    if (!anchor) {
      return
    }

    cleanupEditorTransactionHandler(anchor.editor)
  }

  function clearActiveAnchorPreview() {
    if (!activeAnchorPreviewEditor) {
      return
    }

    clearDocumentAiAnchorPreview(activeAnchorPreviewEditor)
    activeAnchorPreviewEditor = null
  }

  function pruneDetachedSelectionAnchors() {
    const activeSelectionAttachmentIds = new Set(
      options.panel.attachments.value
        .filter(attachment => attachment.type === 'document' && attachment.scope.kind === 'selection')
        .map(attachment => attachment.id),
    )

    for (const [attachmentId] of anchors) {
      if (activeSelectionAttachmentIds.has(attachmentId)) {
        continue
      }

      removeSelectionAnchor(attachmentId, {
        forgetSource: !docsAiCandidate.isSelectionSourcePending(attachmentId),
      })
    }
  }
}

function resolveRequestTextSelectionRange(
  request: DocsSelectionContextRequest,
  options: {
    allowCollapsed?: boolean
  } = {},
) {
  const selection = request.editor.state.selection

  if (!isTextSelection(selection) || (!options.allowCollapsed && selection.empty)) {
    return null
  }

  const from = Math.min(request.from, request.to)
  const to = Math.max(request.from, request.to)

  if (options.allowCollapsed ? from > to : from >= to) {
    return null
  }

  return {
    from,
    to,
  }
}

function isSelectionDocumentAttachment(
  attachment: ChatComposerAttachment,
): attachment is Extract<ChatComposerAttachment, { type: 'document' }> & { scope: { kind: 'selection' } } {
  return attachment.type === 'document' && attachment.scope.kind === 'selection'
}

function isTextSelection(selection: unknown): selection is TextSelection {
  return selection instanceof TextSelection
}

function resolveDocumentTitle(document: DocsSelectionContextDocument) {
  return getDocumentTitlePlainText(document.title) || translate('docs.common.noTitle')
}

function collapseEditorSelection(editor: Editor, position: number) {
  editor.commands.setTextSelection(position)
}
