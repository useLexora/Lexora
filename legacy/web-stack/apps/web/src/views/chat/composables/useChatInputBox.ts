import type { MaybeRefOrGetter } from 'vue'
import { computed, onMounted, toValue } from 'vue'
import { createChatSurfaceController } from '@/composables/chat/createChatSurfaceController'
import { useWorkspaceStore } from '@/stores/workspace'
import { useChatModelSettings } from './useChatModelSettings'
import { useChatRuntimeOverlay } from './useChatRuntimeOverlay'
import { useChatSessions } from './useChatSessions'
import { useChatStream } from './useChatStream'

export interface UseChatInputBoxOptions {
  isReadonly?: MaybeRefOrGetter<boolean>
}

export function useChatInputBox(options: UseChatInputBoxOptions = {}) {
  const workspaceStore = useWorkspaceStore()
  const model = useChatModelSettings()
  const { activeSessionId } = useChatSessions()
  const { cancelRunId, isStreaming } = useChatRuntimeOverlay()
  const { cancelActiveRun, isSubmitting, sendMessage } = useChatStream()
  const isReadonly = computed(() => Boolean(toValue(options.isReadonly)))
  const workspaceId = computed(() => workspaceStore.currentWorkspace?.id ?? null)
  const surface = createChatSurfaceController({
    isReadonly,
    model,
    sessions: {
      activeSessionId,
    },
    stream: {
      isSubmitting,
      isStreaming,
      sendMessage,
    },
    workspaceId,
  })
  const { composer } = surface
  const {
    attachments,
    composerModelSelectionKind,
    composerSelectedModelRef,
    contentJSON,
    handleSend,
    handleUploadAttachmentFiles,
    handleUploadImageFiles,
    highlightAttachment,
    highlightAttachmentId,
    selectComposerModel,
    translatorSkillEnabled,
    translatorTargetLanguage,
    uploadAvailability,
    webSearchForRunEnabled,
    webSearchSkillEnabled,
  } = composer

  onMounted(() => {
    void composer.loadSkills({ silent: true })
  })

  return {
    attachments,
    cancelActiveRun,
    cancelRunId,
    composerModelSelectionKind,
    composerSelectedModelRef,
    contentJSON,
    handleSend,
    handleUploadAttachmentFiles,
    handleUploadImageFiles,
    highlightAttachment,
    highlightAttachmentId,
    isSubmitting: surface.composer.isSubmitting,
    isStreaming,
    selectComposerModel,
    translatorSkillEnabled,
    translatorTargetLanguage,
    uploadAvailability,
    webSearchForRunEnabled,
    webSearchSkillEnabled,
  }
}
