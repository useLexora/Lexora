import type { ComputedRef, Ref } from 'vue'
import type { ChatModelItem, ChatSessionDetail } from '@/apis/chat'
import type { ChatComposerModelRef, ChatComposerModelSelectionKind } from '@/components/chat-composer'
import type { ChatStreamController, SendChatComposerMessageInput } from '@/composables/chat/createChatStreamController'
import { createSharedComposable } from '@vueuse/core'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { createChatSurfaceController } from '@/composables/chat/createChatSurfaceController'
import { getMessageText } from '@/composables/chat/utils/chat-message-display'
import { translate } from '@/i18n'
import { ElMessageBox } from '@/utils/element-plus'
import { useActiveDocument } from './useActiveDocument'
import { useDocsAiCandidate } from './useDocsAiCandidate'
import { useDocsChatEngine } from './useDocsChatEngine'
import { useDocsContext } from './useDocsContext'

interface DocsChatPanelSessions {
  activeSession: Ref<ChatSessionDetail | null>
  activeSessionId: Ref<string | null>
  clearActiveSession: () => void
  deleteSession: (id: string, options?: { selectFallbackSession?: boolean }) => Promise<string | null>
  loadSessions?: (options?: { preserveActiveSessionId?: boolean, selectFallbackSession?: boolean }) => Promise<void>
  renameSession: (id: string, title: string) => Promise<boolean>
  replaceActiveSession: (session: ChatSessionDetail) => boolean
  selectSession: (id: string) => Promise<boolean>
}

interface DocsChatPanelStream {
  cancelActiveRun: ChatStreamController['cancelActiveRun']
  cancelRunId: ChatStreamController['cancelRunId']
  isSubmitting: ChatStreamController['isSubmitting']
  isStreaming: ChatStreamController['isStreaming']
  retryMessage: ChatStreamController['retryMessage']
  sendMessage: (input: SendChatComposerMessageInput) => Promise<boolean>
  switchBranch: ChatStreamController['switchBranch']
}

interface DocsChatPanelOverlay {
  clearTemporarySession: () => void
  renderSession: ComputedRef<ChatSessionDetail | null>
}

interface DocsChatPanelModel {
  clearNewSessionModelDraft: () => void
  composerModelSelectionKind: ComputedRef<ChatComposerModelSelectionKind>
  composerSelectedModel: ComputedRef<ChatModelItem | null>
  composerSelectedModelRef: ComputedRef<ChatComposerModelRef | null>
  isConfigured: ComputedRef<boolean>
  loadModelState?: () => Promise<void>
  selectComposerModel: (modelRef: ChatComposerModelRef | null) => Promise<boolean>
}

export const useDocsChatPanel = createSharedComposable(() => {
  const engine = useDocsChatEngine()
  const controller = createDocsChatPanelController({
    sessions: engine.sessions,
    stream: engine.stream,
    overlay: engine.overlay,
    model: engine.model,
  })
  const { currentDocument } = useActiveDocument()

  watch(
    () => currentDocument.value?.id ?? null,
    () => controller.clearSelectionContexts(),
  )

  onMounted(() => {
    void engine.model.loadModelState?.()
    void controller.loadSkills({ silent: true })
  })

  return controller
})

export function createDocsChatPanelController(options: {
  sessions: DocsChatPanelSessions
  stream: DocsChatPanelStream
  overlay?: DocsChatPanelOverlay
  model: DocsChatPanelModel
}) {
  const { currentWorkspaceId } = useDocsContext()
  const docsAiCandidate = useDocsAiCandidate()
  const surface = createChatSurfaceController({
    workspaceId: currentWorkspaceId,
    model: options.model,
    sessions: {
      activeSessionId: options.sessions.activeSessionId,
    },
    stream: {
      isSubmitting: options.stream.isSubmitting,
      isStreaming: options.stream.isStreaming,
      retryMessage: options.stream.retryMessage,
      sendMessage: options.stream.sendMessage,
      switchBranch: options.stream.switchBranch,
    },
  })
  const { composer, messages: surfaceMessages } = surface
  const {
    attachments,
    composerModelSelectionKind,
    composerSelectedModelRef,
    contentJSON,
    documentAssistantEditIntent,
    documentAssistantSkillEnabled,
    handleSend,
    handleUploadAttachmentFiles,
    handleUploadImageFiles,
    highlightAttachment,
    highlightAttachmentId,
    isConfigured,
    isSubmitting,
    loadSkills,
    registerAfterSendHandler,
    registerBeforeSendHandler,
    registerSendFailureHandler,
    registerSubmitStartHandler,
    resetComposer,
    resetNewSessionComposerState,
    selectComposerModel,
    translatorSkillEnabled,
    translatorTargetLanguage,
    uploadAvailability,
    webSearchForRunEnabled,
    webSearchSkillEnabled,
  } = composer
  const {
    copyMessage,
    isMessageCopied,
    retryAssistantMessage,
    switchToBranch,
  } = surfaceMessages.actions
  const isOpen = shallowRef(false)
  const composerFocusRequestVersion = shallowRef(0)
  const renameDialogVisible = shallowRef(false)
  const renameDraft = shallowRef('')
  const isRenaming = shallowRef(false)
  const isDeleting = shallowRef(false)

  const renderSession = computed(() =>
    options.overlay?.renderSession.value ?? options.sessions.activeSession.value,
  )
  const messages = computed(() => renderSession.value?.messages ?? [])
  const renderSessionId = computed(() => renderSession.value?.id ?? null)
  const hasActiveSession = computed(() => Boolean(options.sessions.activeSession.value))
  const activeSessionTitle = computed(() => options.sessions.activeSession.value?.title ?? translate('docs.chat.titleFallback'))
  const documentAiCandidateSyncKey = computed(() =>
    messages.value
      .map(message => `${message.id}:${message.role}:${message.status}:${message.role === 'assistant' ? getMessageText(message).length : ''}`)
      .join('|'),
  )

  watch(
    documentAiCandidateSyncKey,
    () => docsAiCandidate.syncFromMessages(messages.value),
    { immediate: true },
  )

  function openPanel() {
    isOpen.value = true
  }

  function togglePanel() {
    isOpen.value = !isOpen.value
  }

  async function loadHistorySessions() {
    await options.sessions.loadSessions?.({
      preserveActiveSessionId: true,
      selectFallbackSession: false,
    })
  }

  async function selectHistorySession(sessionId: string) {
    const selected = await options.sessions.selectSession(sessionId)
    if (!selected) {
      return false
    }

    resetComposer()
    options.model.clearNewSessionModelDraft()
    return true
  }

  function startNewSession() {
    options.overlay?.clearTemporarySession()
    options.sessions.clearActiveSession()
    resetNewSessionComposerState()
  }

  function clearSelectionContexts() {
    const nextAttachments = attachments.value.filter(attachment =>
      attachment.type !== 'document' || attachment.scope.kind !== 'selection',
    )
    if (nextAttachments.length !== attachments.value.length) {
      attachments.value = nextAttachments
    }

    if (highlightAttachmentId.value && !nextAttachments.some(attachment => attachment.id === highlightAttachmentId.value)) {
      highlightAttachmentId.value = null
    }
  }

  function requestComposerFocus() {
    composerFocusRequestVersion.value += 1
  }

  function openRenameDialog() {
    const session = options.sessions.activeSession.value
    if (!session) {
      return
    }

    renameDraft.value = session.title
    renameDialogVisible.value = true
  }

  async function submitRename(title: string) {
    const session = options.sessions.activeSession.value
    const nextTitle = title.trim()

    if (!session || !nextTitle || isRenaming.value) {
      return false
    }

    isRenaming.value = true
    try {
      const renamed = await options.sessions.renameSession(session.id, nextTitle)
      if (renamed) {
        renameDialogVisible.value = false
      }
      return renamed
    }
    finally {
      isRenaming.value = false
    }
  }

  async function confirmDeleteActiveSession() {
    if (!options.sessions.activeSession.value || isDeleting.value) {
      return false
    }

    try {
      await ElMessageBox.confirm(
        translate('docs.chat.deleteConfirm'),
        translate('docs.chat.deleteTitle'),
        {
          type: 'warning',
          confirmButtonText: translate('docs.chat.delete'),
          cancelButtonText: translate('docs.common.cancel'),
        },
      )
    }
    catch {
      return false
    }

    return deleteActiveSession()
  }

  async function deleteActiveSession() {
    const session = options.sessions.activeSession.value
    if (!session || isDeleting.value) {
      return false
    }

    isDeleting.value = true
    try {
      await options.sessions.deleteSession(session.id, {
        selectFallbackSession: false,
      })
      options.overlay?.clearTemporarySession()
      resetNewSessionComposerState()
      return true
    }
    finally {
      isDeleting.value = false
    }
  }

  return {
    activeSessionTitle,
    attachments,
    cancelActiveRun: options.stream.cancelActiveRun,
    cancelRunId: options.stream.cancelRunId,
    clearSelectionContexts,
    composerFocusRequestVersion,
    composerModelSelectionKind,
    composerSelectedModelRef,
    confirmDeleteActiveSession,
    contentJSON,
    documentAssistantEditIntent,
    documentAssistantSkillEnabled,
    copyMessage,
    deleteActiveSession,
    handleSend,
    handleUploadAttachmentFiles,
    handleUploadImageFiles,
    hasActiveSession,
    highlightAttachment,
    highlightAttachmentId,
    isBusy: surfaceMessages.isBusy,
    isConfigured,
    isDeleting,
    isMessageCopied,
    isOpen,
    isRenaming,
    isSubmitting,
    isStreaming: surfaceMessages.isStreaming,
    loadHistorySessions,
    loadSkills,
    messages,
    openPanel,
    openRenameDialog,
    renameDialogVisible,
    renameDraft,
    registerAfterSendHandler,
    registerBeforeSendHandler,
    registerSendFailureHandler,
    registerSubmitStartHandler,
    renderSessionId,
    resetComposer,
    retryAssistantMessage,
    requestComposerFocus,
    selectComposerModel,
    selectHistorySession,
    startNewSession,
    submitRename,
    switchToBranch,
    togglePanel,
    translatorSkillEnabled,
    translatorTargetLanguage,
    uploadAvailability,
    webSearchForRunEnabled,
    webSearchSkillEnabled,
  }
}
