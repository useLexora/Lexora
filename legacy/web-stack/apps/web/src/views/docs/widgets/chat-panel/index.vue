<script setup lang="ts">
import type { DocsChatPanelEmits, DocsChatPanelProps } from './typing'
import type { ChatComposerExposed } from '@/components/chat-composer'
import { computed, nextTick, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChatComposer } from '@/components/chat-composer'
import DocsChatHeader from '../../components/chat-header'
import DocsChatMessages from '../../components/chat-messages'
import DocsChatRenameDialog from '../../components/chat-rename-dialog'
import { useDocsChatPanel } from '../../composables/useDocsChatPanel'
import { useDocsChatSessions } from '../../composables/useDocsChatSessions'

const props = withDefaults(defineProps<DocsChatPanelProps>(), {
  isResizing: false,
})
const emits = defineEmits<DocsChatPanelEmits>()
const { t } = useI18n()
const {
  activeSessionTitle,
  attachments,
  cancelActiveRun,
  composerFocusRequestVersion,
  composerModelSelectionKind,
  composerSelectedModelRef,
  confirmDeleteActiveSession,
  contentJSON,
  copyMessage,
  documentAssistantEditIntent,
  documentAssistantSkillEnabled,
  handleSend,
  handleUploadAttachmentFiles,
  handleUploadImageFiles,
  hasActiveSession,
  highlightAttachment,
  highlightAttachmentId,
  isBusy,
  isDeleting,
  isRenaming,
  isSubmitting,
  isStreaming,
  loadHistorySessions,
  isMessageCopied,
  messages,
  openRenameDialog,
  renameDialogVisible,
  renderSessionId,
  retryAssistantMessage,
  selectComposerModel,
  selectHistorySession,
  startNewSession,
  submitRename,
  switchToBranch,
  translatorSkillEnabled,
  translatorTargetLanguage,
  uploadAvailability,
  webSearchForRunEnabled,
  webSearchSkillEnabled,
} = useDocsChatPanel()
const {
  activeSessionId,
  isLoadingSessions,
  sessions,
} = useDocsChatSessions()

const composerRef = useTemplateRef<ChatComposerExposed>('composer')
const resizeHandleValueMin = computed(() => Math.round(props.minWidthPx))
const resizeHandleValueMax = computed(() => Math.round(props.maxWidthPx))
const resizeHandleValueNow = computed(() => Math.round(props.widthPx))

watch(
  composerFocusRequestVersion,
  async () => {
    await nextTick()
    composerRef.value?.focus()
    window.setTimeout(() => composerRef.value?.focus(), 0)
  },
)
</script>

<template>
  <aside
    class="docs-chat-panel relative flex min-h-0 shrink-0 grow-0 flex-col"
    :class="{ 'is-resizing': props.isResizing }"
  >
    <div
      class="docs-chat-panel__resize-handle"
      role="separator"
      tabindex="0"
      :aria-label="t('docs.chat.resizePanel')"
      aria-orientation="vertical"
      :aria-valuemin="resizeHandleValueMin"
      :aria-valuemax="resizeHandleValueMax"
      :aria-valuenow="resizeHandleValueNow"
      data-testid="docs-chat-panel-resize-handle"
      @pointerdown="emits('resizeStart', $event)"
      @dblclick="emits('resizeReset')"
      @keydown="emits('resizeKeydown', $event)"
    />
    <div class="docs-chat-panel__picker-layer pointer-events-none absolute inset-0 z-[5]" />

    <DocsChatHeader
      :title="activeSessionTitle"
      :sessions="sessions"
      :active-session-id="activeSessionId"
      :is-loading-sessions="isLoadingSessions"
      :has-active-session="hasActiveSession"
      :is-deleting="isDeleting"
      @load-history="loadHistorySessions"
      @select-history="selectHistorySession"
      @new-session="startNewSession"
      @rename-session="openRenameDialog"
      @delete-session="confirmDeleteActiveSession"
    />

    <DocsChatMessages
      :messages="messages"
      :session-id="renderSessionId"
      :is-streaming="isBusy"
      :is-message-copied="isMessageCopied"
      @copy-message="copyMessage"
      @retry-assistant-message="retryAssistantMessage"
      @switch-branch="switchToBranch"
    />

    <div class="docs-chat-panel__composer flex-none p-3">
      <ChatComposer
        ref="composer"
        v-model:attachments="attachments"
        v-model:document-assistant-edit-intent="documentAssistantEditIntent"
        v-model:translator-target-language="translatorTargetLanguage"
        v-model:web-search-for-run-enabled="webSearchForRunEnabled"
        :content-j-s-o-n="contentJSON"
        :selected-model-ref="composerSelectedModelRef"
        :model-selection-kind="composerModelSelectionKind"
        :is-submitting="isSubmitting"
        :is-streaming="isStreaming"
        :highlight-attachment-id="highlightAttachmentId"
        :upload-availability="uploadAvailability"
        :document-assistant-skill-enabled="documentAssistantSkillEnabled"
        :translator-skill-enabled="translatorSkillEnabled"
        :web-search-skill-enabled="webSearchSkillEnabled"
        document-picker-teleport-to=".docs-chat-panel__picker-layer"
        @update:content-j-s-o-n="contentJSON = $event"
        @send="handleSend"
        @stop="cancelActiveRun"
        @select-model="selectComposerModel"
        @upload-image-files="handleUploadImageFiles"
        @upload-attachment-files="handleUploadAttachmentFiles"
        @highlight-attachment="highlightAttachment"
      />
    </div>

    <DocsChatRenameDialog
      v-model="renameDialogVisible"
      :title="activeSessionTitle"
      :loading="isRenaming"
      @confirm="submitRename"
    />
  </aside>
</template>

<style scoped lang="scss">
.docs-chat-panel {
  inline-size: var(--panel-docs-chat-width);
  min-inline-size: var(--panel-docs-chat-width);
  max-inline-size: var(--panel-docs-chat-width);
  flex-basis: var(--panel-docs-chat-width);
  border-left: 1px solid color-mix(in srgb, var(--brand-border-base) 74%, transparent);
  background: color-mix(in srgb, var(--brand-bg-surface) 94%, var(--brand-bg-base));
  transition:
    inline-size 160ms ease,
    min-inline-size 160ms ease,
    max-inline-size 160ms ease,
    flex-basis 160ms ease;

  &.is-resizing {
    transition: none;
  }
}

.docs-chat-panel__resize-handle {
  position: absolute;
  inset-block: 0;
  inset-inline-start: -0.3125rem;
  z-index: 7;
  width: 0.625rem;
  cursor: col-resize;
  touch-action: none;
  outline: none;

  &::before {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0.25rem;
    width: 1px;
    background: transparent;
    content: '';
    transition:
      background 120ms ease,
      box-shadow 120ms ease,
      width 120ms ease;
  }

  &:hover::before,
  &:focus-visible::before,
  .docs-chat-panel.is-resizing &::before {
    width: 2px;
    background: color-mix(in srgb, var(--brand-primary) 58%, var(--brand-border-base));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand-primary) 18%, transparent);
  }
}

.docs-chat-panel__composer {
  border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 70%, transparent);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--brand-bg-surface) 70%, transparent) 0%,
      var(--brand-bg-surface) 100%
    );
}
</style>
