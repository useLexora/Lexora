<script setup lang="ts">
import type { AgentDocumentAssistantEditIntent } from '@haohaoxue/lexora-contracts/agent'
import type { Editor, EditorEvents, JSONContent } from '@tiptap/core'
import type {
  ChatComposerAttachment,
  ChatComposerDocumentAttachment,
  ChatComposerDocumentSelectionScope,
  ChatComposerEmits,
  ChatComposerProps,
  ChatComposerSubmitPayload,
} from './typing'
import type { ReadableDocumentSearchResult } from '@/apis/document'
import {
  AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT,
  AGENT_DOCUMENT_ASSISTANT_SKILL_KEY,
  AGENT_TRANSLATOR_SKILL_KEY,
  AGENT_WEB_SEARCH_SKILL_KEY,
} from '@haohaoxue/lexora-contracts/agent'
import { CHAT_CONTEXT_SNAPSHOT_MAX_CONTENT_LENGTH } from '@haohaoxue/lexora-contracts/chat'
import {
  CHAT_MESSAGE_ATTACHMENT_PLACEMENT,
  CHAT_MESSAGE_ATTACHMENT_TYPE,
} from '@haohaoxue/lexora-contracts/chat/constants'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { nanoid } from 'nanoid'
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { createPlainTextChatContentJSON } from '@/composables/chat/utils/chat-message-content'
import {
  findDuplicatePanelAttachment,
  getDocumentSelectionDisplayModeFromIntent,
  orderChatComposerAttachments,
} from './attachmentOrdering'
import ChatComposerContextTags from './ChatComposerContextTags.vue'
import ChatComposerToolbar from './ChatComposerToolbar.vue'
import ChatDocumentPicker from './ChatDocumentPicker.vue'
import { CHAT_REFERENCE_NODE_NAME, createChatComposerExtensions } from './editorExtensions'
import {
  createEmptyChatComposerContentJSON,
  garbageCollectInlineAttachments,
  serializeChatComposerContent,
} from './serialization'

const props = withDefaults(defineProps<ChatComposerProps>(), {
  selectedModelRef: null,
  modelSelectionKind: 'default',
  isSubmitting: false,
  isStreaming: false,
  disabled: false,
  highlightAttachmentId: null,
  documentPickerTeleportTo: '',
  uploadAvailability: () => ({
    image: { disabled: false },
    file: { disabled: false },
  }),
  documentAssistantEditIntent: null,
  documentAssistantSkillEnabled: false,
  translatorSkillEnabled: false,
  translatorTargetLanguage: null,
  webSearchSkillEnabled: false,
  webSearchForRunEnabled: true,
})
const emits = defineEmits<ChatComposerEmits>()
const { t } = useI18n({ useScope: 'global' })

const pickerVisible = shallowRef(false)
const pickerMode = shallowRef<'panel' | 'inline'>('panel')
const skillCommandOpenSignal = shallowRef(0)
const imageInputRef = shallowRef<HTMLInputElement | null>(null)
const fileInputRef = shallowRef<HTMLInputElement | null>(null)
let pastedAttachments: ChatComposerAttachment[] = []

const serializedContent = computed(() => serializeChatComposerContent(props.contentJSON))
const isComposerLocked = computed(() => Boolean(props.disabled || props.isSubmitting))
const hasSelectedModel = computed(() => Boolean(
  props.selectedModelRef?.providerId.trim()
  && props.selectedModelRef.modelId.trim(),
))
const orderedSubmitAttachments = computed(() =>
  orderChatComposerAttachments(
    garbageCollectInlineAttachments(props.contentJSON, props.attachments),
    props.contentJSON,
  ),
)
const documentAssistantSelectionContext = computed(() => {
  const intent = props.documentAssistantEditIntent

  if (!intent) {
    return {
      canSend: false,
      selectionCount: 0,
      validSelectionCount: 0,
    }
  }

  const selectionAttachments = orderedSubmitAttachments.value.filter(isDocumentSelectionAttachment)
  const validSelectionAttachments = selectionAttachments.filter(attachment =>
    isValidDocumentAssistantSelectionAttachment(attachment, intent),
  )

  return {
    canSend: selectionAttachments.length === 1 && validSelectionAttachments.length === 1,
    selectionCount: selectionAttachments.length,
    validSelectionCount: validSelectionAttachments.length,
  }
})
const hasDocumentAssistantSelectionContext = computed(() => documentAssistantSelectionContext.value.canSend)
const canSend = computed(() =>
  !isComposerLocked.value
  && !props.isStreaming
  && hasSelectedModel.value
  && (
    props.documentAssistantEditIntent
      ? hasDocumentAssistantSelectionContext.value
      : Boolean(serializedContent.value.bodyTextWithoutReferences.trim())
  ),
)
const editorPlaceholder = computed(() =>
  props.translatorTargetLanguage
    ? t('chat.composer.translatorPlaceholder', { language: props.translatorTargetLanguage.name })
    : props.documentAssistantEditIntent
      ? t('chat.composer.documentAssistantPlaceholder')
      : t('chat.composer.inputPlaceholder'),
)
const documentSelectionDisplayMode = computed(() =>
  getDocumentSelectionDisplayModeFromIntent(props.documentAssistantEditIntent),
)

const editor = useEditor({
  content: props.contentJSON as JSONContent,
  extensions: createChatComposerExtensions({
    getAttachments: () => props.attachments,
    getPlaceholder: () => editorPlaceholder.value,
    cloneInlineAttachment: cloneInlineAttachmentForPaste,
  }),
  editable: !isComposerLocked.value,
  editorProps: {
    attributes: {
      class: 'chat-composer__prosemirror',
    },
    handleKeyDown: (_, event) => handleEditorKeyDown(event),
    handleTextInput: (_, from, to, text) => handleEditorTextInput(from, to, text),
    handlePaste: (_, event) => handleEditorPaste(event),
  },
  onUpdate: handleEditorUpdate,
})

watch(
  () => props.contentJSON,
  (contentJSON) => {
    if (!editor.value || isSameContent(editor.value, contentJSON as JSONContent)) {
      return
    }

    editor.value.commands.setContent(contentJSON as JSONContent, {
      emitUpdate: false,
    })
  },
)

watch(
  () => props.isSubmitting,
  (isSubmitting, wasSubmitting) => {
    if (!isSubmitting || wasSubmitting) {
      return
    }

    clearEditorContent()
  },
)

watch(
  isComposerLocked,
  locked => editor.value?.setEditable(!locked, false),
)

watch(
  () => props.translatorTargetLanguage,
  () => refreshEditorPlaceholder(),
)

watch(
  () => props.documentAssistantEditIntent,
  () => refreshEditorPlaceholder(),
)

onBeforeUnmount(() => {
  editor.value?.destroy()
})

defineExpose({
  focus: () => {
    editor.value?.chain().focus('end').run()
    editor.value?.view.dom.focus()
  },
})

function handleEditorUpdate(options: EditorEvents['update']) {
  const contentJSON = options.editor.getJSON() as ChatComposerProps['contentJSON']
  emits('update:contentJSON', contentJSON)

  const nextAttachments = garbageCollectInlineAttachments(contentJSON, props.attachments)
  if (nextAttachments.length !== props.attachments.length) {
    emits('update:attachments', nextAttachments)
  }
}

function handleEditorKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && (props.translatorTargetLanguage || props.documentAssistantEditIntent)) {
    event.preventDefault()
    emits('update:translatorTargetLanguage', null)
    emits('update:documentAssistantEditIntent', null)
    return true
  }

  if (!isSendKeydown(event)) {
    return false
  }

  event.preventDefault()
  if (canSend.value) {
    emitSend()
  }
  return true
}

function isSendKeydown(event: KeyboardEvent) {
  return event.key === 'Enter'
    && !event.isComposing
    && !event.shiftKey
    && !event.altKey
}

function handleEditorTextInput(from: number, to: number, text: string) {
  if (props.disabled) {
    return false
  }

  if (text === '/') {
    if (!shouldOpenSkillCommandMenu(from, to)) {
      return false
    }

    openSkillCommandMenu()
    return true
  }

  if (text !== '@') {
    return false
  }

  openInlinePicker()
  return false
}

function handleEditorPaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (!files.length) {
    return false
  }

  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (text) {
    editor.value?.commands.insertContent(text)
  }
  emitUploadFiles(files)
  return true
}

function openPanelPicker() {
  pickerMode.value = 'panel'
  pickerVisible.value = true
}

function openInlinePicker() {
  pickerMode.value = 'inline'
  pickerVisible.value = true
}

function openSkillCommandMenu() {
  skillCommandOpenSignal.value += 1
}

function closePicker() {
  pickerVisible.value = false
}

function openImageUpload() {
  if (isComposerLocked.value || props.isStreaming || props.uploadAvailability.image.disabled) {
    return
  }
  imageInputRef.value?.click()
}

function openFileUpload() {
  if (isComposerLocked.value || props.isStreaming || props.uploadAvailability.file.disabled) {
    return
  }
  fileInputRef.value?.click()
}

function handleImageInputChange(event: Event) {
  if (props.uploadAvailability.image.disabled) {
    resetFileInput(event)
    return
  }

  emitUploadFiles(Array.from((event.target as HTMLInputElement).files ?? []).filter(isImageFile))
  resetFileInput(event)
}

function handleFileInputChange(event: Event) {
  if (props.uploadAvailability.file.disabled) {
    resetFileInput(event)
    return
  }

  emitUploadFiles(Array.from((event.target as HTMLInputElement).files ?? []))
  resetFileInput(event)
}

function handlePickDocument(document: ReadableDocumentSearchResult) {
  if (pickerMode.value === 'inline') {
    addInlineDocumentReference(document)
  }
  else {
    addPanelDocumentContext(document)
  }

  closePicker()
}

function addPanelDocumentContext(document: ReadableDocumentSearchResult) {
  const attachment = createDocumentAttachment(document, CHAT_MESSAGE_ATTACHMENT_PLACEMENT.PANEL)
  const duplicate = findDuplicatePanelAttachment(props.attachments, attachment)

  if (duplicate) {
    emits('highlightAttachment', duplicate.id)
    return
  }

  emits('update:attachments', [...props.attachments, attachment])
}

function addInlineDocumentReference(document: ReadableDocumentSearchResult) {
  const attachment = createDocumentAttachment(document, CHAT_MESSAGE_ATTACHMENT_PLACEMENT.INLINE)
  emits('update:attachments', [...props.attachments, attachment])
  insertInlineReference(attachment, createReferenceNodeId())
}

function removePanelAttachment(attachmentId: string) {
  emits('update:attachments', props.attachments.filter(attachment => attachment.id !== attachmentId))
}

function emitUploadFiles(files: File[]) {
  const imageFiles = files.filter(isImageFile)
  const attachmentFiles = files.filter(file => !isImageFile(file))

  if (imageFiles.length > 0) {
    emits('uploadImageFiles', imageFiles)
  }
  if (attachmentFiles.length > 0) {
    emits('uploadAttachmentFiles', attachmentFiles)
  }
}

function emitSend() {
  if (!canSend.value) {
    return
  }

  const content = serializedContent.value.content.trim() || getDefaultDocumentAssistantPrompt()
  const payload: ChatComposerSubmitPayload = {
    content,
    contentJSON: serializedContent.value.bodyTextWithoutReferences.trim()
      ? props.contentJSON
      : createPlainTextChatContentJSON(content),
    attachments: orderedSubmitAttachments.value,
    skillInvocation: props.translatorTargetLanguage
      ? {
          skillKey: AGENT_TRANSLATOR_SKILL_KEY,
          targetLanguage: props.translatorTargetLanguage,
        }
      : props.documentAssistantEditIntent
        ? {
            skillKey: AGENT_DOCUMENT_ASSISTANT_SKILL_KEY,
            intent: props.documentAssistantEditIntent,
          }
        : null,
    disabledSkillKeys: props.webSearchSkillEnabled && !props.webSearchForRunEnabled
      ? [AGENT_WEB_SEARCH_SKILL_KEY]
      : [],
  }
  emits('send', payload)
}

function shouldOpenSkillCommandMenu(from: number, to: number) {
  const currentEditor = editor.value
  if (
    !currentEditor
    || props.isSubmitting
    || props.isStreaming
    || props.translatorTargetLanguage
    || props.documentAssistantEditIntent
    || from !== to
  ) {
    return false
  }

  const doc = currentEditor.state.doc
  const textBeforeCursor = doc.textBetween(0, from, '', '')
  const textAfterCursor = doc.textBetween(to, doc.content.size, '', '')

  return !textBeforeCursor.trim() && !textAfterCursor.trim()
}

function refreshEditorPlaceholder() {
  const currentEditor = editor.value
  if (!currentEditor) {
    return
  }

  currentEditor.view.dispatch(currentEditor.state.tr)
}

function clearEditorContent() {
  const currentEditor = editor.value
  if (!currentEditor) {
    return
  }

  currentEditor.commands.setContent(createEmptyChatComposerContentJSON() as JSONContent, {
    emitUpdate: false,
  })
}

function insertInlineReference(attachment: ChatComposerDocumentAttachment, nodeId: string) {
  const currentEditor = editor.value
  if (!currentEditor) {
    return
  }

  const cursorPosition = currentEditor.state.selection.from
  const shouldDeleteTrigger = cursorPosition > 1 && currentEditor.state.doc.textBetween(cursorPosition - 1, cursorPosition) === '@'
  const chain = currentEditor.chain().focus()

  if (shouldDeleteTrigger) {
    chain.deleteRange({
      from: cursorPosition - 1,
      to: cursorPosition,
    })
  }

  chain
    .insertContent({
      type: CHAT_REFERENCE_NODE_NAME,
      attrs: {
        id: nodeId,
        attachmentId: attachment.id,
        label: attachment.title,
      },
    })
    .insertContent(' ')
    .run()
}

function cloneInlineAttachmentForPaste(attachment: ChatComposerAttachment) {
  if (attachment.type !== CHAT_MESSAGE_ATTACHMENT_TYPE.DOCUMENT) {
    throw new Error('chatReference 只能复制文档附件')
  }

  const clonedAttachment: ChatComposerDocumentAttachment = {
    ...attachment,
    id: createAttachmentId(),
    placement: CHAT_MESSAGE_ATTACHMENT_PLACEMENT.INLINE,
  }

  if (!pastedAttachments.length) {
    queueMicrotask(() => {
      pastedAttachments = []
    })
  }

  pastedAttachments.push(clonedAttachment)
  emits('update:attachments', [
    ...props.attachments,
    ...pastedAttachments,
  ])

  return {
    nodeId: createReferenceNodeId(),
    attachment: clonedAttachment,
  }
}

function createDocumentAttachment(
  document: ReadableDocumentSearchResult,
  placement: ChatComposerDocumentAttachment['placement'],
): ChatComposerDocumentAttachment {
  return {
    id: createAttachmentId(),
    type: CHAT_MESSAGE_ATTACHMENT_TYPE.DOCUMENT,
    placement,
    documentId: document.id,
    title: document.title,
    scope: {
      kind: 'full',
    },
    size: 0,
  }
}

function createAttachmentId() {
  return `att_${nanoid(10)}`
}

function createReferenceNodeId() {
  return `ref_${nanoid(10)}`
}

function getDefaultDocumentAssistantPrompt() {
  if (props.documentAssistantEditIntent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR) {
    return t('chat.composer.documentAssistantContinuePrompt')
  }

  return t('chat.composer.documentAssistantRewritePrompt')
}

function isValidDocumentAssistantSelectionAttachment(
  attachment: ChatComposerAttachment,
  intent: AgentDocumentAssistantEditIntent,
) {
  if (!isDocumentSelectionAttachment(attachment)) {
    return false
  }

  if (
    typeof attachment.snapshot !== 'string'
    || attachment.snapshot.length > CHAT_CONTEXT_SNAPSHOT_MAX_CONTENT_LENGTH
  ) {
    return false
  }

  if (intent === AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR) {
    return true
  }

  return !isCollapsedDocumentSelectionScope(attachment.scope) && Boolean(attachment.snapshot.trim())
}

function isDocumentSelectionAttachment(
  attachment: ChatComposerAttachment,
): attachment is ChatComposerDocumentAttachment & { scope: ChatComposerDocumentSelectionScope } {
  return attachment.type === CHAT_MESSAGE_ATTACHMENT_TYPE.DOCUMENT
    && attachment.scope.kind === 'selection'
}

function isCollapsedDocumentSelectionScope(scope: ChatComposerDocumentSelectionScope) {
  return scope.from.blockId === scope.to.blockId
    && scope.from.offset === scope.to.offset
}

function isImageFile(file: File) {
  return file.type.startsWith('image/')
}

function resetFileInput(event: Event) {
  const input = event.target as HTMLInputElement
  input.value = ''
}

function isSameContent(currentEditor: Editor, contentJSON: JSONContent) {
  return JSON.stringify(currentEditor.getJSON()) === JSON.stringify(contentJSON)
}
</script>

<template>
  <section class="chat-composer">
    <div class="chat-composer__surface">
      <ChatComposerContextTags
        :attachments="props.attachments"
        :document-selection-display-mode="documentSelectionDisplayMode"
        :highlight-attachment-id="props.highlightAttachmentId"
        @remove="removePanelAttachment"
      />

      <div class="chat-composer__editor">
        <EditorContent v-if="editor" :editor="editor" />
      </div>

      <ChatComposerToolbar
        :selected-model-ref="props.selectedModelRef"
        :model-selection-kind="props.modelSelectionKind"
        :is-submitting="props.isSubmitting"
        :is-streaming="props.isStreaming"
        :disabled="props.disabled"
        :can-send="canSend"
        :upload-availability="props.uploadAvailability"
        :document-assistant-edit-intent="props.documentAssistantEditIntent"
        :document-assistant-skill-enabled="props.documentAssistantSkillEnabled"
        :translator-skill-enabled="props.translatorSkillEnabled"
        :translator-target-language="props.translatorTargetLanguage"
        :web-search-skill-enabled="props.webSearchSkillEnabled"
        :web-search-for-run-enabled="props.webSearchForRunEnabled"
        :skill-command-open-signal="skillCommandOpenSignal"
        @open-panel-picker="openPanelPicker"
        @upload-image="openImageUpload"
        @upload-file="openFileUpload"
        @update:document-assistant-edit-intent="emits('update:documentAssistantEditIntent', $event)"
        @update:translator-target-language="emits('update:translatorTargetLanguage', $event)"
        @update:web-search-for-run-enabled="emits('update:webSearchForRunEnabled', $event)"
        @select-model="emits('selectModel', $event)"
        @send="emitSend"
        @stop="emits('stop')"
      />

      <input
        ref="imageInputRef"
        class="chat-composer__file-input"
        type="file"
        accept="image/*"
        multiple
        tabindex="-1"
        aria-hidden="true"
        @change="handleImageInputChange"
      >
      <input
        ref="fileInputRef"
        class="chat-composer__file-input"
        type="file"
        multiple
        tabindex="-1"
        aria-hidden="true"
        @change="handleFileInputChange"
      >

      <Teleport
        defer
        :to="props.documentPickerTeleportTo || 'body'"
        :disabled="!props.documentPickerTeleportTo"
      >
        <ChatDocumentPicker
          :visible="pickerVisible"
          @close="closePicker"
          @select="handlePickDocument"
        />
      </Teleport>
    </div>
  </section>
</template>

<style scoped lang="scss">
.chat-composer {
  width: 100%;

  .chat-composer__surface {
    position: relative;
    overflow: visible;
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 80%, transparent);
    border-radius: 0.5rem;
    background: var(--brand-bg-surface);
    box-shadow: var(--brand-shadow-hairline);
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease;

    &:focus-within {
      border-color: color-mix(in srgb, var(--brand-primary) 32%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand-primary) 12%, transparent);
    }
  }

  .chat-composer__editor {
    max-height: min(40vh, 320px);
    overflow-y: auto;
    padding: 0.5rem 0.625rem 0.125rem;
  }

  .chat-composer__file-input {
    display: none;
  }

  :deep(.chat-composer__prosemirror) {
    min-height: 3rem;
    outline: none;
    color: var(--brand-text-primary);
    font-size: 0.875rem;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
  }

  :deep(.chat-composer__prosemirror p) {
    margin: 0;
  }

  :deep(.chat-composer__prosemirror p + p) {
    margin-top: 0.25rem;
  }

  :deep(.chat-composer__prosemirror p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    float: left;
    height: 0;
    color: var(--brand-text-placeholder);
    pointer-events: none;
  }

  :deep(.chat-reference-node) {
    display: inline-flex;
    align-items: center;
    max-width: 12rem;
    margin-inline: 0.125rem;
    padding: 0.125rem 0.375rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--brand-primary) 8%, var(--brand-bg-surface));
    color: var(--brand-primary);
    font-size: 0.85em;
    font-weight: 600;
    line-height: 1.45;
    vertical-align: 0.02em;
    white-space: nowrap;
  }
}
</style>
