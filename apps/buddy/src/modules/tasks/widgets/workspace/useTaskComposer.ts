import type { DesktopChatComposerProps } from '../composer/typing'
import type { TaskComposerHostProps } from './typing'
import type { ChatComposerSubmitPayload } from '@/modules/prompt-input'
import { computed } from 'vue'

export function useTaskComposer(props: Readonly<TaskComposerHostProps>) {
  const editorKey = computed(() => props.composer.editorKey.value)
  const bindings = computed<Omit<DesktopChatComposerProps, 'pasteTextAsAttachment'>>(() => {
    const composer = props.composer
    const execution = props.execution
    return {
      canUpdatePermissionSettings: composer.canUpdatePermissionSettings.value,
      canSend: execution.canSend.value && !execution.isMutatingBranch.value,
      composerContent: composer.composerContent.value,
      contextUsage: composer.contextUsage.value,
      draft: composer.draft.value,
      draftId: composer.draftId.value,
      resources: composer.resources.value,
      rejectedResourceIds: composer.rejectedResourceIds,
      beginImport: composer.beginImport,
      importPastedText: composer.importPastedText,
      readResourceText: composer.readResourceText,
      selectSource: composer.selectSource,
      isRunning: Boolean(execution.activeRun.value || execution.stoppingRunId.value),
      isStopping: Boolean(execution.stoppingRunId.value),
      isSelectingFiles: composer.isSelectingFiles.value,
      isSending: execution.isSending.value || execution.isMutatingBranch.value,
      isUpdatingPermissionSettings: composer.isUpdatingPermissionSettings.value,
      interaction: composer.interaction.value,
      language: props.language,
      loadContextOptions: composer.listContextOptions,
      models: composer.models.value,
      permissionMode: composer.permissionMode.value,
      providers: composer.providers.value,
      selectedEffort: composer.selectedEffort.value,
      selectedModel: composer.selectedModel.value,
      selectedModelId: composer.selectedModelId.value,
      selectedServiceTier: composer.selectedServiceTier.value,
    }
  })

  async function sendMessage(payload: ChatComposerSubmitPayload): Promise<void> {
    const execution = props.execution
    await (execution.editingMessageId.value ? execution.submitEditedMessage(payload) : execution.send(payload))
  }

  return { bindings, editorKey, sendMessage }
}
