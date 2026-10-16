import type { ComputedRef } from 'vue'
import type { SendChatComposerMessageInput } from './createChatStreamController'
import type { AiModelModality, ChatModelItem, ChatUploadedAsset } from '@/apis/chat'
import type {
  ChatComposerAttachment,
  ChatComposerContentJSON,
  ChatComposerModelRef,
  ChatComposerModelSelectionKind,
  ChatComposerSubmitPayload,
  ChatComposerUploadAvailability,
} from '@/components/chat-composer'
import { AI_MODEL_MODALITY } from '@haohaoxue/lexora-contracts/ai/constants'
import { CHAT_MESSAGE_ATTACHMENT_PLACEMENT, CHAT_MESSAGE_ATTACHMENT_TYPE } from '@haohaoxue/lexora-contracts/chat/constants'
import { FILE_SIZE_LIMITS } from '@haohaoxue/lexora-contracts/file'
import { resolveMissingChatAttachmentInputModalities } from '@haohaoxue/lexora-shared/chat'
import { isTextLikeFile, prettyBytes } from '@haohaoxue/lexora-shared/file'
import { computed, shallowRef } from 'vue'
import { uploadChatFile, uploadChatImage } from '@/apis/chat'
import { createEmptyChatComposerContentJSON } from '@/components/chat-composer/serialization'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'

const HIGHLIGHT_DURATION_MS = 1400

export type ChatComposerBeforeSendHandler = (payload: ChatComposerSubmitPayload) => ChatComposerSubmitPayload
export type ChatComposerAfterSendHandler = (payload: ChatComposerSubmitPayload) => void
export type ChatComposerSendFailureHandler = (payload: ChatComposerSubmitPayload) => void
export type ChatComposerSubmitStartHandler = (payload: ChatComposerSubmitPayload) => void

export interface ChatComposerHostModel {
  composerSelectedModelRef: ComputedRef<ChatComposerModelRef | null>
  composerSelectedModel: ComputedRef<ChatModelItem | null>
  composerModelSelectionKind?: ComputedRef<ChatComposerModelSelectionKind>
  shouldPersistComposerModelRef?: ComputedRef<boolean>
  clearNewSessionModelDraft: () => void
}

export type ChatComposerHostState = ReturnType<typeof createChatComposerHostState>

export function createChatComposerHostState(options: {
  workspaceId: ComputedRef<string | null | undefined>
  model: ChatComposerHostModel
  sendMessage: (input: SendChatComposerMessageInput) => Promise<boolean>
}) {
  const contentJSON = shallowRef<ChatComposerContentJSON>(createEmptyChatComposerContentJSON())
  const attachments = shallowRef<ChatComposerAttachment[]>([])
  const highlightAttachmentId = shallowRef<string | null>(null)
  const beforeSendHandlers = new Set<ChatComposerBeforeSendHandler>()
  const afterSendHandlers = new Set<ChatComposerAfterSendHandler>()
  const sendFailureHandlers = new Set<ChatComposerSendFailureHandler>()
  const submitStartHandlers = new Set<ChatComposerSubmitStartHandler>()
  const uploadAvailability = computed<ChatComposerUploadAvailability>(() => {
    const selectedModel = options.model.composerSelectedModel.value
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
  let highlightTimer: ReturnType<typeof setTimeout> | null = null

  function resetComposer() {
    contentJSON.value = createEmptyChatComposerContentJSON()
    attachments.value = []
    highlightAttachmentId.value = null
  }

  function registerBeforeSendHandler(handler: ChatComposerBeforeSendHandler) {
    beforeSendHandlers.add(handler)

    return () => beforeSendHandlers.delete(handler)
  }

  function registerAfterSendHandler(handler: ChatComposerAfterSendHandler) {
    afterSendHandlers.add(handler)

    return () => afterSendHandlers.delete(handler)
  }

  function registerSendFailureHandler(handler: ChatComposerSendFailureHandler) {
    sendFailureHandlers.add(handler)

    return () => sendFailureHandlers.delete(handler)
  }

  function registerSubmitStartHandler(handler: ChatComposerSubmitStartHandler) {
    submitStartHandlers.add(handler)

    return () => submitStartHandlers.delete(handler)
  }

  function applyBeforeSendHandlers(payload: ChatComposerSubmitPayload) {
    let nextPayload = payload

    for (const handler of beforeSendHandlers) {
      nextPayload = handler(nextPayload)
    }

    return nextPayload
  }

  function notifyAfterSendHandlers(payload: ChatComposerSubmitPayload) {
    for (const handler of afterSendHandlers) {
      handler(payload)
    }
  }

  function notifySendFailureHandlers(payload: ChatComposerSubmitPayload) {
    for (const handler of sendFailureHandlers) {
      handler(payload)
    }
  }

  function notifySubmitStartHandlers(payload: ChatComposerSubmitPayload) {
    for (const handler of submitStartHandlers) {
      handler(payload)
    }
  }

  async function handleSend(payload: ChatComposerSubmitPayload) {
    const modelRef = normalizeSelectedModelRef(options.model.composerSelectedModelRef.value)
    if (!modelRef) {
      ElMessage.warning(translate('chat.composer.selectModel'))
      return false
    }

    const nextPayload = applyBeforeSendHandlers(payload)
    const unsupportedMessage = resolveUnsupportedAttachmentMessage(nextPayload.attachments)
    if (unsupportedMessage) {
      ElMessage.warning(unsupportedMessage)
      return false
    }

    const submittedPayload = cloneSubmitPayload(nextPayload)
    notifySubmitStartHandlers(nextPayload)
    resetComposer()

    const sent = await options.sendMessage({
      ...nextPayload,
      modelRef: shouldPersistComposerModel(options.model) ? modelRef : undefined,
    })
    if (!sent) {
      notifySendFailureHandlers(nextPayload)
      restoreComposer(submittedPayload)
      return false
    }

    notifyAfterSendHandlers(nextPayload)
    resetComposer()
    options.model.clearNewSessionModelDraft()
    return true
  }

  function restoreComposer(payload: ChatComposerSubmitPayload) {
    contentJSON.value = payload.contentJSON
    attachments.value = payload.attachments
  }

  async function handleUploadImageFiles(files: File[]) {
    return handleUploadFiles('image', files)
  }

  async function handleUploadAttachmentFiles(files: File[]) {
    return handleUploadFiles('file', files)
  }

  async function handleUploadFiles(type: 'image' | 'file', files: File[]) {
    const workspaceId = options.workspaceId.value?.trim()
    if (!workspaceId) {
      ElMessage.warning(translate('chat.errors.missingWorkspace'))
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
    const oversizedFile = selectedFiles.find(file => file.size > limit)
    if (oversizedFile) {
      ElMessage.warning(type === 'image'
        ? translate('chat.composer.imageTooLarge', { size: prettyBytes(limit) })
        : translate('chat.composer.fileTooLarge', { size: prettyBytes(limit) }))
      return false
    }

    try {
      const uploadedAssets = await Promise.all(selectedFiles.map(file =>
        type === 'image' ? uploadChatImage(workspaceId, file) : uploadChatFile(workspaceId, file),
      ))
      attachments.value = [
        ...attachments.value,
        ...uploadedAssets.map(createUploadedAttachment),
      ]
      return true
    }
    catch (error) {
      ElMessage.error(error instanceof Error && error.message ? error.message : translate('chat.composer.uploadFailed'))
      return false
    }
  }

  function resolveUnsupportedAttachmentMessage(nextAttachments: ChatComposerAttachment[]) {
    const selectedModel = options.model.composerSelectedModel.value
    if (!selectedModel) {
      return hasUploadedAttachment(nextAttachments) ? translate('chat.composer.selectModel') : null
    }

    const missingModalities = resolveMissingChatAttachmentInputModalities({
      attachments: nextAttachments,
      inputModalities: selectedModel.inputModalities,
    })

    if (missingModalities.length === 0) {
      return null
    }

    return formatModelUnsupportedModalitiesMessage(selectedModel.modelName, missingModalities)
  }

  function resolveUnsupportedUploadMessage(type: 'image' | 'file', files: File[]) {
    const selectedModel = options.model.composerSelectedModel.value
    if (!selectedModel) {
      return translate('chat.composer.selectModel')
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

    return formatModelUnsupportedModalitiesMessage(selectedModel.modelName, [...missingModalities])
  }

  function highlightAttachment(attachmentId: string) {
    highlightAttachmentId.value = attachmentId
    if (highlightTimer) {
      clearTimeout(highlightTimer)
    }
    highlightTimer = setTimeout(() => {
      if (highlightAttachmentId.value === attachmentId) {
        highlightAttachmentId.value = null
      }
    }, HIGHLIGHT_DURATION_MS)
  }

  return {
    attachments,
    contentJSON,
    handleUploadAttachmentFiles,
    handleUploadImageFiles,
    handleSend,
    highlightAttachment,
    highlightAttachmentId,
    registerAfterSendHandler,
    registerBeforeSendHandler,
    registerSendFailureHandler,
    registerSubmitStartHandler,
    resetComposer,
    uploadAvailability,
  }
}

function shouldPersistComposerModel(model: ChatComposerHostModel) {
  const explicitValue = model.shouldPersistComposerModelRef?.value
  if (explicitValue !== undefined) {
    return explicitValue
  }

  const selectionKind = model.composerModelSelectionKind?.value
  return selectionKind === 'draft' || selectionKind === 'override'
}

function cloneSubmitPayload(payload: ChatComposerSubmitPayload): ChatComposerSubmitPayload {
  return JSON.parse(JSON.stringify(payload)) as ChatComposerSubmitPayload
}

function normalizeSelectedModelRef(modelRef: ChatComposerModelRef | null) {
  const providerId = modelRef?.providerId.trim() ?? ''
  const modelId = modelRef?.modelId.trim() ?? ''

  if (!providerId || !modelId) {
    return null
  }

  return {
    providerId,
    modelId,
  }
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

function isModelMissingInputModality(model: ChatModelItem | null, modality: AiModelModality) {
  return !model || !hasModelInputModality(model, modality)
}

function hasModelInputModality(model: ChatModelItem, modality: AiModelModality) {
  return model.inputModalities.includes(modality)
}

function hasUploadedAttachment(attachments: ChatComposerAttachment[]) {
  return attachments.some(attachment =>
    attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.IMAGE
    || attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.FILE,
  )
}

function formatModelUnsupportedModalitiesMessage(modelName: string, modalities: AiModelModality[]) {
  return translate('chat.composer.modelUnsupportedAttachments', {
    model: modelName,
    modalities: modalities.map(formatInputModality).join('、'),
  })
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
