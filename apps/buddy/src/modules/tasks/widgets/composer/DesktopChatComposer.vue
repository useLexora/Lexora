<script setup lang="ts">
import type { BuddyMessageQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { BuddyServiceTier, BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { BuddyPermissionMode } from '@buddy-shared/permissions/permissionMode'
import type { JSONContent } from '@tiptap/core'
import type { DesktopChatComposerProps } from './typing'
import type { ChatComposerSubmitPayload, ChatPromptContextOption } from '@/modules/prompt-input'
import type { WorkbenchMenuSelection } from '@/shared/ui/contributions/workbenchUiContext'
import { EditorContent } from '@tiptap/vue-3'
import { computed, shallowRef, toRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopModelSelector } from '@/modules/models/ui'
import { createChatComposerContentFromText } from '@/modules/prompt-input'
import { DesktopChatComposerFrame, DesktopPermissionModeSelector } from '@/modules/prompt-input/ui'
import ChatContextUsage from '@/modules/tasks/widgets/composer/ChatContextUsage.vue'
import DesktopChatComposerInteractionHost from '@/modules/tasks/widgets/composer/DesktopChatComposerInteractionHost.vue'
import { useChatComposer } from '@/modules/tasks/widgets/composer/useChatComposer'
import WorkbenchMenu from '@/shared/ui/contributions/WorkbenchMenu.vue'
import WorkbenchSlot from '@/shared/ui/contributions/WorkbenchSlot.vue'
import ChatQuoteStrip from '../quotes/ChatQuoteStrip.vue'
import ChatSessionReferenceStrip from '../references/ChatSessionReferenceStrip.vue'
import ChatComposerSourceMenu from './ChatComposerSourceMenu.vue'
import ComposerResourceStrip from './ComposerResourceStrip.vue'
import ComposerTextPreview from './ComposerTextPreview.vue'
import DesktopComposerSubmitActions from './DesktopComposerSubmitActions.vue'
import DesktopComposerSuggestions from './DesktopComposerSuggestions.vue'

const props = defineProps<DesktopChatComposerProps>()

const emit = defineEmits<{
  attach: []
  retryResource: [resourceId: string]
  dismissInteraction: [id: string]
  send: [payload: ChatComposerSubmitPayload]
  stop: []
  updateContent: [content: string, value: JSONContent]
  updateEffort: [value: BuddyThinkingLevel | null]
  updatePermissionMode: [value: BuddyPermissionMode]
  updateModel: [value: string]
  updateServiceTier: [value: BuddyServiceTier | null]
}>()
defineSlots<{
  leadingContext?: () => unknown
}>()

const { t } = useBuddyI18n(() => props.language)
const resourceStrip = useTemplateRef('resourceStrip')
const {
  activeSuggestionIndex,
  activeTrigger,
  attachFiles,
  canSubmit,
  isLocalCommand,
  closeSuggestions,
  editor,
  isLoadingContext,
  contextLoadFailed,
  contextOptions,
  deepSearch,
  setDeepSearch,
  navigateDirectory,
  leaveSessions,
  sessionScope,
  loadContextOptions,
  modelInputIssue,
  resourceStripResources,
  pastedText,
  quotes,
  sessionReferences,
  addQuote,
  removeQuote,
  removeSessionReference,
  removeResource,
  selectPanelSource: selectPanelResource,
  selectSuggestion,
  submit,
  sourceOptions,
  suggestions,
} = useChatComposer({
  pasteTextAsAttachment: toRef(props, 'pasteTextAsAttachment'),
  canSend: toRef(props, 'canSend'),
  composerContent: toRef(props, 'composerContent'),
  draft: toRef(props, 'draft'),
  draftId: toRef(props, 'draftId'),
  resources: toRef(props, 'resources'),
  selectedModel: toRef(props, 'selectedModel'),
  selectedEffort: toRef(props, 'selectedEffort'),
  selectedServiceTier: toRef(props, 'selectedServiceTier'),
  rejectedResourceIds: () => props.rejectedResourceIds,
  isRunning: toRef(props, 'isRunning'),
  isSending: toRef(props, 'isSending'),
  language: toRef(props, 'language'),
  loadContextOptions: (query, deepSearch, scope) => props.loadContextOptions(query, deepSearch, scope),
  beginImport: (files, origin) => props.beginImport(files, origin),
  importPastedText: text => props.importPastedText(text),
  readResourceText: id => props.readResourceText(id),
  selectSource: source => props.selectSource(source),
  onSend: payload => emit('send', payload),
  onUpdateContent: (content, value) => emit('updateContent', content, value),
  onLocateResource: resourceId => resourceStrip.value?.highlightResource(resourceId),
})

const queuesSubmission = computed(() => !isLocalCommand.value && (props.isRunning || props.hasQueuedMessages))
const modelSelectorRef = useTemplateRef<InstanceType<typeof DesktopModelSelector>>('modelSelectorRef')

defineExpose({
  focus: () => editor.value?.commands.focus(),
  inputElement: computed(() => editor.value?.view.dom ?? null),
  openModelSelector: () => modelSelectorRef.value?.open('model'),
  restoreFocus: () => {
    if (editor.value?.isEditable)
      editor.value.view.focus()
  },
  quote: (quote: BuddyMessageQuote) => addQuote(quote),
})

const sourceMenuOpen = shallowRef(false)
const suggestionOptions = computed(() => suggestions.value.map(({ option }) => option))
const chooserVisible = computed(() => !sourceMenuOpen.value && Boolean(
  activeTrigger.value && (activeTrigger.value.kind === 'mention' || activeTrigger.value.kind === 'skill' || suggestions.value.length || isLoadingContext.value),
))
const modelInputIssueMessage = computed(() => {
  if (modelInputIssue.value === 'reasoning_unsupported')
    return t('desktop.chat.modelReasoningUnsupported', { value: props.selectedEffort ?? '' })
  if (modelInputIssue.value === 'service_tier_unsupported')
    return t('desktop.chat.modelServiceTierUnsupported', { value: props.selectedServiceTier ?? '' })
  return ''
})

function handleFileDragover(event: DragEvent) {
  if (event.dataTransfer?.types.includes('Files'))
    event.preventDefault()
}

function handleFileDrop(event: DragEvent) {
  const files = [...(event.dataTransfer?.files ?? [])]
  if (!files.length)
    return

  event.preventDefault()
  attachFiles(files, 'panel')
}

async function selectConversationFile(option: ChatPromptContextOption) {
  if (await selectPanelResource(option))
    sourceMenuOpen.value = false
}
function captureDraft(): WorkbenchMenuSelection {
  const current = editor.value
  if (!current || !current.isEditable || current.isDestroyed)
    return {}
  const draftId = props.draftId
  const { doc, selection } = current.state
  return {
    content: current.getText(),
    apply(result) {
      if (editor.value !== current || current.isDestroyed || !current.isEditable || props.isSending || props.draftId !== draftId || !current.state.doc.eq(doc))
        return
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.insertText !== 'string' || !result.insertText || result.insertText.length > 131072)
        return
      const content = createChatComposerContentFromText(result.insertText).content ?? []
      current.chain().focus().insertContentAt({ from: selection.from, to: selection.to }, content).run()
    },
  }
}
</script>

<template>
  <DesktopChatComposerFrame
    class="desktop-chat-composer-wrap"
    single-line-toolbar
    @dragover="handleFileDragover"
    @drop="handleFileDrop"
  >
    <template #attachments>
      <WorkbenchSlot target="composer.accessory" class="desktop-chat-composer__accessory max-h-[min(240px,30vh)] overflow-auto" />
      <ChatSessionReferenceStrip :references="sessionReferences" :language="language" :disabled="isSending" removable @remove="removeSessionReference" />
      <ChatQuoteStrip :quotes="quotes" :language="language" :disabled="isSending" removable @remove="removeQuote" />
      <ComposerResourceStrip
        ref="resourceStrip"
        :resources="resourceStripResources"
        :language="language"
        :disabled="isSending"
        @remove="removeResource"
        @retry="emit('retryResource', $event)"
        @preview-text="pastedText.open"
      />
    </template>

    <template #overlay>
      <DesktopChatComposerInteractionHost
        :chooser-visible="chooserVisible"
        :interaction="interaction"
        :language="language"
        @dismiss="emit('dismissInteraction', $event)"
      >
        <template #chooser>
          <DesktopComposerSuggestions
            v-model:active-index="activeSuggestionIndex" :language="language" :trigger="activeTrigger"
            :context-options="contextOptions" :suggestion-options="suggestionOptions" :loading="isLoadingContext"
            :context-load-failed="contextLoadFailed" :deep-search="deepSearch" :session-scope="sessionScope" :can-manage-skills="Boolean(manageSkills)"
            @leave-sessions="leaveSessions" @deep-search-change="setDeepSearch" @navigate="navigateDirectory"
            @select="selectSuggestion" @manage-skills="manageSkills?.()"
          />
        </template>
      </DesktopChatComposerInteractionHost>
    </template>

    <template #editor>
      <EditorContent v-if="editor" :editor="editor" />
    </template>

    <template #leading>
      <WorkbenchMenu target="composer.actions" :disabled="isSending" :capture="captureDraft" />
      <ChatComposerSourceMenu
        v-model:show="sourceMenuOpen"
        :disabled="isSelectingFiles || isSending"
        :language="language"
        :loading="isLoadingContext"
        :options="sourceOptions"
        @attach="emit('attach')"
        @query="loadContextOptions"
        @select="selectConversationFile"
        @update:show="show => show && closeSuggestions()"
      />

      <slot name="leadingContext" />

      <div
        class="desktop-chat-composer__permission-mode inline-flex min-w-0 flex-none items-center"
        data-testid="composer-permission-mode"
      >
        <DesktopPermissionModeSelector
          :can-update="canUpdatePermissionSettings"
          :is-updating="isUpdatingPermissionSettings"
          :language="language"
          :permission-mode="permissionMode"
          @update-permission-mode="emit('updatePermissionMode', $event)"
        />
      </div>
    </template>

    <template #actions>
      <div
        class="desktop-chat-composer__context-usage inline-flex min-w-0 flex-none items-center empty:hidden"
        data-testid="composer-context-usage"
      >
        <ChatContextUsage
          :is-running="isRunning"
          :language="language"
          :usage="contextUsage"
        />
      </div>

      <div
        class="desktop-chat-composer__model-selector inline-flex min-w-0 flex-none items-center"
        data-testid="composer-model-selector"
      >
        <DesktopModelSelector
          ref="modelSelectorRef"
          :disabled="isSending"
          :language="language"
          :models="models"
          :providers="providers"
          :selected-effort="selectedEffort"
          :selected-model="selectedModel"
          :selected-model-id="selectedModelId"
          :selected-service-tier="selectedServiceTier"
          @update-effort="emit('updateEffort', $event)"
          @update-model="emit('updateModel', $event)"
          @update-service-tier="emit('updateServiceTier', $event)"
        />
      </div>

      <DesktopComposerSubmitActions
        :language="language"
        :can-submit="canSubmit"
        :queues-submission="queuesSubmission"
        :is-running="isRunning"
        :is-stopping="isStopping"
        :is-sending="isSending"
        :is-local-command="isLocalCommand"
        :issue-message="modelInputIssueMessage"
        @submit="submit"
        @stop="emit('stop')"
      />
    </template>

    <template #footer>
      <WorkbenchSlot target="composer.footer" class="desktop-chat-composer__footer mt-[0.45rem]">
        <p class="desktop-chat-composer__disclaimer m-0 text-[0.68rem] text-muted text-center">
          {{ t('desktop.chat.disclaimer') }}
        </p>
      </WorkbenchSlot>
    </template>
  </DesktopChatComposerFrame>
  <ComposerTextPreview
    :preview="pastedText.preview.value"
    :language="language"
    :disabled="isSending"
    @close="pastedText.close"
    @retry="pastedText.retry"
    @restore="pastedText.restore"
  />
</template>

<style scoped lang="scss">
.desktop-chat-composer {
  &__context-usage {
    @container desktop-chat-composer (max-width: 36rem) {
      display: none;
    }
  }

  &__permission-mode {
    @container desktop-chat-composer (max-width: 33rem) {
      :deep(.desktop-permission-mode-selector__trigger) {
        width: var(--buddy-composer-control-height);
        min-width: var(--buddy-composer-control-height);
        max-width: var(--buddy-composer-control-height);
        padding: 0;
      }

      :deep(.desktop-permission-mode-selector__trigger-label) {
        display: none;
      }

      :deep(.n-button__content) {
        gap: 0;
      }

      :deep(.n-button__icon) {
        margin: 0;
      }
    }

    @container desktop-chat-composer (max-width: 24rem) {
      display: none;
    }
  }

  &__model-selector {
    :deep(.desktop-model-selector) {
      min-width: 0;
    }

    @container desktop-chat-composer (max-width: 27rem) {
      margin-right: 0.15rem;

      :deep(.desktop-model-selector__trigger) {
        width: var(--buddy-composer-control-height);
        min-width: var(--buddy-composer-control-height);
        max-width: var(--buddy-composer-control-height);
        justify-content: center;
        gap: 0;
        padding: 0;
      }

      :deep(.desktop-model-selector__compact-icon) {
        display: inline-flex;
      }

      :deep(.desktop-model-selector__model),
      :deep(.desktop-model-selector__separator),
      :deep(.desktop-model-selector__effort),
      :deep(.desktop-model-selector__flash) {
        display: none;
      }
    }

    @container desktop-chat-composer (max-width: 18.5rem) {
      display: none;
    }
  }

}
</style>
