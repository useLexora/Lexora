import type {
  AgentDocumentAssistantEditIntent,
  AgentTranslatorTargetLanguage,
} from '@haohaoxue/lexora-contracts/agent'
import type { AiModelRef } from '@/apis/ai'
import type {
  ChatDisabledSkillKeys,
  ChatDocumentScope,
  ChatMessageAttachmentInput,
  ChatMessageContentJSON,
  ChatSkillInvocation,
} from '@/apis/chat'

export type ChatComposerContentJSON = ChatMessageContentJSON
export type ChatComposerAttachment = ChatMessageAttachmentInput
export type ChatComposerDocumentAttachment = Extract<ChatComposerAttachment, { type: 'document' }>
export type ChatComposerModelRef = Pick<AiModelRef, 'providerId' | 'modelId'> & Partial<Pick<AiModelRef, 'scope' | 'providerKey'>>
export type ChatComposerModelSelectionKind = 'default' | 'draft' | 'override'

export interface ChatComposerUploadItemAvailability {
  disabled: boolean
}

export interface ChatComposerUploadAvailability {
  image: ChatComposerUploadItemAvailability
  file: ChatComposerUploadItemAvailability
}

export interface ChatComposerSubmitPayload {
  content: string
  contentJSON: ChatComposerContentJSON
  attachments: ChatComposerAttachment[]
  skillInvocation?: ChatSkillInvocation | null
  disabledSkillKeys?: ChatDisabledSkillKeys
}

export interface ChatComposerProps {
  contentJSON: ChatComposerContentJSON
  attachments: ChatComposerAttachment[]
  selectedModelRef?: ChatComposerModelRef | null
  modelSelectionKind?: ChatComposerModelSelectionKind
  isSubmitting?: boolean
  isStreaming?: boolean
  disabled?: boolean
  highlightAttachmentId?: string | null
  documentPickerTeleportTo?: string
  uploadAvailability?: ChatComposerUploadAvailability
  documentAssistantEditIntent?: AgentDocumentAssistantEditIntent | null
  documentAssistantSkillEnabled?: boolean
  translatorSkillEnabled?: boolean
  translatorTargetLanguage?: AgentTranslatorTargetLanguage | null
  webSearchSkillEnabled?: boolean
  webSearchForRunEnabled?: boolean
}

export interface ChatComposerEmits {
  'update:contentJSON': [contentJSON: ChatComposerContentJSON]
  'update:attachments': [attachments: ChatComposerAttachment[]]
  'update:documentAssistantEditIntent': [intent: AgentDocumentAssistantEditIntent | null]
  'update:translatorTargetLanguage': [targetLanguage: AgentTranslatorTargetLanguage | null]
  'update:webSearchForRunEnabled': [enabled: boolean]
  'send': [payload: ChatComposerSubmitPayload]
  'stop': []
  'selectModel': [modelRef: ChatComposerModelRef | null]
  'uploadImageFiles': [files: File[]]
  'uploadAttachmentFiles': [files: File[]]
  'highlightAttachment': [attachmentId: string]
}

export interface ChatComposerToolbarProps {
  selectedModelRef?: ChatComposerModelRef | null
  modelSelectionKind?: ChatComposerModelSelectionKind
  isSubmitting?: boolean
  isStreaming?: boolean
  disabled?: boolean
  canSend?: boolean
  uploadAvailability?: ChatComposerUploadAvailability
  documentAssistantEditIntent?: AgentDocumentAssistantEditIntent | null
  documentAssistantSkillEnabled?: boolean
  translatorSkillEnabled?: boolean
  translatorTargetLanguage?: AgentTranslatorTargetLanguage | null
  webSearchSkillEnabled?: boolean
  webSearchForRunEnabled?: boolean
  skillCommandOpenSignal?: number
}

export interface ChatComposerToolbarEmits {
  'openPanelPicker': []
  'uploadImage': []
  'uploadFile': []
  'update:documentAssistantEditIntent': [intent: AgentDocumentAssistantEditIntent | null]
  'update:translatorTargetLanguage': [targetLanguage: AgentTranslatorTargetLanguage | null]
  'update:webSearchForRunEnabled': [enabled: boolean]
  'selectModel': [modelRef: ChatComposerModelRef | null]
  'send': []
  'stop': []
}

export interface ChatComposerAttachmentMenuProps {
  disabled?: boolean
  isStreaming?: boolean
  uploadAvailability?: ChatComposerUploadAvailability
}

export interface ChatComposerAttachmentMenuEmits {
  openPanelPicker: []
  uploadImage: []
  uploadFile: []
}

export interface ChatComposerWebSearchButtonProps {
  disabled?: boolean
  isStreaming?: boolean
  webSearchSkillEnabled?: boolean
  webSearchForRunEnabled?: boolean
}

export interface ChatComposerWebSearchButtonEmits {
  'update:webSearchForRunEnabled': [enabled: boolean]
}

export interface ChatComposerSkillControlsProps {
  disabled?: boolean
  isStreaming?: boolean
  documentAssistantEditIntent?: AgentDocumentAssistantEditIntent | null
  documentAssistantSkillEnabled?: boolean
  translatorSkillEnabled?: boolean
  translatorTargetLanguage?: AgentTranslatorTargetLanguage | null
  skillCommandOpenSignal?: number
}

export interface ChatComposerSkillControlsEmits {
  'update:documentAssistantEditIntent': [intent: AgentDocumentAssistantEditIntent | null]
  'update:translatorTargetLanguage': [targetLanguage: AgentTranslatorTargetLanguage | null]
}

export interface ChatComposerSubmitControlsProps {
  selectedModelRef?: ChatComposerModelRef | null
  modelSelectionKind?: ChatComposerModelSelectionKind
  isSubmitting?: boolean
  isStreaming?: boolean
  disabled?: boolean
  canSend?: boolean
}

export interface ChatComposerSubmitControlsEmits {
  selectModel: [modelRef: ChatComposerModelRef | null]
  send: []
  stop: []
}

export interface ChatComposerExposed {
  focus: () => void
}

export interface ChatComposerSerializedContent {
  content: string
  bodyTextWithoutReferences: string
  inlineAttachmentIds: string[]
}

export interface ChatReferenceAttrs {
  id: string
  attachmentId: string
  label: string
}

export interface ChatDocumentSelectionBoundary {
  blockId: string
  offset: number
  position?: number
}

export interface ChatComposerDocumentSelectionScope {
  kind: 'selection'
  field: 'body'
  blockIds: string[]
  from: ChatDocumentSelectionBoundary
  to: ChatDocumentSelectionBoundary
}

export type ChatComposerDocumentScope = ChatDocumentScope
