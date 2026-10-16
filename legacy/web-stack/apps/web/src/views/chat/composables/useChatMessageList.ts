import type { MaybeRefOrGetter } from 'vue'
import type { AiModelModality, ChatMessage, ChatUploadedAsset } from '@/apis/chat'
import type {
  ChatComposerAttachment,
  ChatComposerContentJSON,
  ChatComposerSubmitPayload,
  ChatComposerUploadAvailability,
} from '@/components/chat-composer'
import { AGENT_WEB_SEARCH_SKILL_KEY } from '@haohaoxue/lexora-contracts/agent'
import { AI_MODEL_MODALITY } from '@haohaoxue/lexora-contracts/ai/constants'
import { CHAT_MESSAGE_ATTACHMENT_PLACEMENT, CHAT_MESSAGE_ATTACHMENT_TYPE } from '@haohaoxue/lexora-contracts/chat/constants'
import { FILE_SIZE_LIMITS } from '@haohaoxue/lexora-contracts/file'
import { resolveMissingChatAttachmentInputModalities } from '@haohaoxue/lexora-shared/chat'
import { isTextLikeFile, prettyBytes } from '@haohaoxue/lexora-shared/file'
import { computed, shallowRef, toValue } from 'vue'
import { useI18n } from 'vue-i18n'
import { uploadChatFile, uploadChatImage } from '@/apis/chat'
import { createEmptyChatComposerContentJSON } from '@/components/chat-composer/serialization'
import { SvgIconCategory } from '@/components/svg-icon/typing'
import { useChatMessageActions } from '@/composables/chat/useChatMessageActions'
import { useChatSkillState } from '@/composables/chat/useChatSkillState'
import { translate } from '@/i18n'
import { useWorkspaceStore } from '@/stores/workspace'
import { ElMessage } from '@/utils/element-plus'
import { useChatModelSettings } from './useChatModelSettings'
import { useChatRuntimeOverlay } from './useChatRuntimeOverlay'
import { useChatStream } from './useChatStream'

const EDIT_HIGHLIGHT_DURATION_MS = 1400

export interface UseChatMessageListOptions {
  isReadonly?: MaybeRefOrGetter<boolean>
}

export function useChatMessageList(options: UseChatMessageListOptions = {}) {
  const { t } = useI18n({ useScope: 'global' })
  const workspaceStore = useWorkspaceStore()
  const {
    composerModelSelectionKind,
    composerSelectedModel,
    composerSelectedModelRef,
    isConfigured,
    selectComposerModel,
  } = useChatModelSettings()
  const { renderSession } = useChatRuntimeOverlay()
  const {
    editAndSendMessage,
    isSubmitting,
    isStreaming,
    retryMessage,
    switchBranch,
  } = useChatStream()
  const { webSearchSkillEnabled } = useChatSkillState()
  const editingMessageId = shallowRef<string | null>(null)
  const editingContentJSON = shallowRef<ChatComposerContentJSON>(createEmptyChatComposerContentJSON())
  const editingAttachments = shallowRef<ChatComposerAttachment[]>([])
  const editingHighlightAttachmentId = shallowRef<string | null>(null)
  const editingWebSearchForRunEnabled = shallowRef(true)
  const isReadonly = computed(() => Boolean(toValue(options.isReadonly)))
  const isBusy = computed(() => isSubmitting.value || isStreaming.value)
  const workspaceId = computed(() => workspaceStore.currentWorkspace?.id ?? null)
  let editingHighlightTimer: ReturnType<typeof setTimeout> | null = null
  const messageActions = useChatMessageActions({
    isReadonly,
    isStreaming: isBusy,
    retryMessage,
    switchBranch,
  })

  const messages = computed<ChatMessage[]>(() => renderSession.value?.messages ?? [])
  const listKey = computed(() => renderSession.value?.id ?? null)
  const assistantName = computed(() => renderSession.value?.agentProfile?.name?.trim() || t('chat.messageList.assistantName'))
  const emptyIconStateClass = computed(() => isConfigured.value ? 'configured' : 'idle')
  const emptyIcon = computed(() => isConfigured.value
    ? {
        category: SvgIconCategory.NAV,
        icon: 'chat-active',
      }
    : {
        category: SvgIconCategory.AI,
        icon: 'ai-spark',
      })
  const uploadAvailability = computed<ChatComposerUploadAvailability>(() => {
    const selectedModel = composerSelectedModel.value
    const imageDisabled = isModelMissingInputModality(selectedModel, AI_MODEL_MODALITY.IMAGE)
    const fileDisabled = selectedModel
      ? !hasModelInputModality(selectedModel, AI_MODEL_MODALITY.TEXT) && !hasModelInputModality(selectedModel, AI_MODEL_MODALITY.FILE)
      : true

    return {
      image: {
        disabled: imageDisabled,
      },
      file: {
        disabled: fileDisabled,
      },
    }
  })

  function getMessageRoleClass(role: ChatMessage['role']) {
    return role === 'user' ? 'user' : 'assistant'
  }

  function startEditMessage(message: ChatMessage) {
    if (message.role !== 'user' || isBusy.value || isReadonly.value) {
      return
    }

    editingMessageId.value = message.id
    editingContentJSON.value = cloneContentJSON(message.metadata.contentJSON)
    editingAttachments.value = message.metadata.attachments.map(attachment => ({ ...attachment }))
    editingHighlightAttachmentId.value = null
    editingWebSearchForRunEnabled.value = !message.metadata.disabledSkillKeys.includes(AGENT_WEB_SEARCH_SKILL_KEY)
  }

  function cancelEditMessage() {
    editingMessageId.value = null
    editingContentJSON.value = createEmptyChatComposerContentJSON()
    editingAttachments.value = []
    editingHighlightAttachmentId.value = null
    editingWebSearchForRunEnabled.value = true
  }

  async function submitEditMessage(message: ChatMessage, payload: ChatComposerSubmitPayload) {
    if (message.role !== 'user' || isReadonly.value) {
      return
    }

    const unsupportedMessage = resolveUnsupportedAttachmentMessage(payload.attachments)
    if (unsupportedMessage) {
      ElMessage.warning(unsupportedMessage)
      return
    }

    const nextPayload = webSearchSkillEnabled.value
      ? payload
      : {
          ...payload,
          disabledSkillKeys: message.metadata.disabledSkillKeys,
        }

    if (await editAndSendMessage(message.id, nextPayload)) {
      cancelEditMessage()
    }
  }

  function highlightEditingAttachment(attachmentId: string) {
    editingHighlightAttachmentId.value = attachmentId
    if (editingHighlightTimer) {
      clearTimeout(editingHighlightTimer)
    }
    editingHighlightTimer = setTimeout(() => {
      if (editingHighlightAttachmentId.value === attachmentId) {
        editingHighlightAttachmentId.value = null
      }
    }, EDIT_HIGHLIGHT_DURATION_MS)
  }

  async function handleEditUploadImageFiles(files: File[]) {
    return handleEditUploadFiles('image', files)
  }

  async function handleEditUploadAttachmentFiles(files: File[]) {
    return handleEditUploadFiles('file', files)
  }

  async function handleEditUploadFiles(type: 'image' | 'file', files: File[]) {
    const currentWorkspaceId = workspaceId.value?.trim()
    if (!currentWorkspaceId) {
      ElMessage.warning(t('chat.errors.missingWorkspace'))
      return false
    }

    const selectedFiles = files.filter(Boolean)
    if (selectedFiles.length === 0) {
      return false
    }

    const unsupportedMessage = resolveUnsupportedUploadMessage(type, selectedFiles)
    if (unsupportedMessage) {
      ElMessage.warning(unsupportedMessage)
      return false
    }

    const limit = type === 'image'
      ? FILE_SIZE_LIMITS.CHAT_IMAGE_ATTACHMENT
      : FILE_SIZE_LIMITS.CHAT_FILE_ATTACHMENT
    if (selectedFiles.some(file => file.size > limit)) {
      ElMessage.warning(type === 'image'
        ? t('chat.composer.imageTooLarge', { size: prettyBytes(limit) })
        : t('chat.composer.fileTooLarge', { size: prettyBytes(limit) }))
      return false
    }

    try {
      const uploadedAssets = await Promise.all(selectedFiles.map(file =>
        type === 'image' ? uploadChatImage(currentWorkspaceId, file) : uploadChatFile(currentWorkspaceId, file),
      ))
      editingAttachments.value = [
        ...editingAttachments.value,
        ...uploadedAssets.map(createUploadedAttachment),
      ]
      return true
    }
    catch (error) {
      ElMessage.error(error instanceof Error && error.message ? error.message : t('chat.composer.uploadFailed'))
      return false
    }
  }

  function resolveUnsupportedAttachmentMessage(nextAttachments: ChatComposerAttachment[]) {
    const selectedModel = composerSelectedModel.value
    if (!selectedModel) {
      return hasUploadedAttachment(nextAttachments) ? t('chat.composer.selectModel') : null
    }

    const missingModalities = resolveMissingChatAttachmentInputModalities({
      attachments: nextAttachments,
      inputModalities: selectedModel.inputModalities,
    })

    if (missingModalities.length === 0) {
      return null
    }

    return t('chat.composer.modelUnsupportedAttachments', {
      model: selectedModel.modelName,
      modalities: missingModalities.map(formatInputModality).join('、'),
    })
  }

  function resolveUnsupportedUploadMessage(type: 'image' | 'file', files: File[]) {
    const selectedModel = composerSelectedModel.value
    if (!selectedModel) {
      return t('chat.composer.selectModel')
    }

    const missingModalities = new Set<AiModelModality>()
    if (type === 'image' && isModelMissingInputModality(selectedModel, AI_MODEL_MODALITY.IMAGE)) {
      missingModalities.add(AI_MODEL_MODALITY.IMAGE)
    }

    if (type === 'file') {
      for (const file of files) {
        const requiredModality = isTextLikeFile({
          fileName: file.name,
          mimeType: file.type,
        })
          ? AI_MODEL_MODALITY.TEXT
          : AI_MODEL_MODALITY.FILE

        if (isModelMissingInputModality(selectedModel, requiredModality)) {
          missingModalities.add(requiredModality)
        }
      }
    }

    if (missingModalities.size === 0) {
      return null
    }

    return t('chat.composer.modelUnsupportedAttachments', {
      model: selectedModel.modelName,
      modalities: [...missingModalities].map(formatInputModality).join('、'),
    })
  }

  function isEditingMessage(message: ChatMessage) {
    return editingMessageId.value === message.id
  }

  return {
    assistantName,
    cancelEditMessage,
    composerModelSelectionKind,
    composerSelectedModelRef,
    copyMessage: messageActions.copyMessage,
    editingAttachments,
    editingContentJSON,
    editingHighlightAttachmentId,
    editingWebSearchForRunEnabled,
    emptyIcon,
    emptyIconStateClass,
    getMessageRoleClass,
    handleEditUploadAttachmentFiles,
    handleEditUploadImageFiles,
    highlightEditingAttachment,
    isEditingMessage,
    isBusy,
    isMessageCopied: messageActions.isMessageCopied,
    isConfigured,
    isStreaming,
    listKey,
    messages,
    retryAssistantMessage: messageActions.retryAssistantMessage,
    selectComposerModel,
    startEditMessage,
    submitEditMessage,
    switchToBranch: messageActions.switchToBranch,
    uploadAvailability,
    webSearchSkillEnabled,
  }
}

function cloneContentJSON(contentJSON: ChatComposerContentJSON): ChatComposerContentJSON {
  return JSON.parse(JSON.stringify(contentJSON)) as ChatComposerContentJSON
}

function createUploadedAttachment(asset: ChatUploadedAsset): ChatComposerAttachment {
  return {
    id: `att_${asset.id}`,
    type: asset.type,
    placement: CHAT_MESSAGE_ATTACHMENT_PLACEMENT.PANEL,
    assetId: asset.id,
    title: asset.fileName,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
  }
}

function isModelMissingInputModality(model: { inputModalities: AiModelModality[] } | null, modality: AiModelModality) {
  return !model || !hasModelInputModality(model, modality)
}

function hasModelInputModality(model: { inputModalities: AiModelModality[] }, modality: AiModelModality) {
  return model.inputModalities.includes(modality)
}

function hasUploadedAttachment(attachments: ChatComposerAttachment[]) {
  return attachments.some(attachment =>
    attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.IMAGE
    || attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.FILE,
  )
}

function formatInputModality(modality: AiModelModality) {
  if (modality === AI_MODEL_MODALITY.TEXT) {
    return translate('chat.composer.textModality')
  }
  if (modality === AI_MODEL_MODALITY.IMAGE) {
    return translate('chat.composer.imageModality')
  }
  if (modality === AI_MODEL_MODALITY.FILE) {
    return translate('chat.composer.fileModality')
  }

  return modality
}
