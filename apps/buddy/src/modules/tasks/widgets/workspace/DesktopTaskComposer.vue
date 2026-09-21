<script setup lang="ts">
import type { BuddyMessageQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { TaskComposerHostProps } from './typing'
import type { ChatComposerSubmitPayload } from '@/modules/prompt-input'
import { useTemplateRef } from 'vue'
import { useRouter } from 'vue-router'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import ChatMessageQueue from '../composer/ChatMessageQueue.vue'
import DesktopChatComposer from '../composer/DesktopChatComposer.vue'
import { useComposerSubmissionFocus } from './useComposerSubmissionFocus'
import { useTaskComposer } from './useTaskComposer'

const props = defineProps<TaskComposerHostProps>()
defineSlots<{ leadingContext?: () => unknown }>()
const router = useRouter()
const composerRef = useTemplateRef<InstanceType<typeof DesktopChatComposer>>('composerRef')
defineExpose({
  focus: () => composerRef.value?.focus(),
  openModelSelector: () => composerRef.value?.openModelSelector(),
  quote: (quote: BuddyMessageQuote) => composerRef.value?.quote(quote) ?? 'unavailable',
})

const { bindings, editorKey, sendMessage } = useTaskComposer(props)
const { withSubmissionFocus } = useComposerSubmissionFocus({
  draftId: () => props.composer.draftId.value,
  ready: () => props.focusReady && !bindings.value.isSending,
  inputElement: () => composerRef.value?.inputElement,
  restoreFocus: () => composerRef.value?.restoreFocus(),
})

async function handleSend(payload: ChatComposerSubmitPayload) {
  await withSubmissionFocus(() => sendMessage(payload))
}
</script>

<template>
  <ChatMessageQueue
    :items="execution.queuedMessages.value"
    :pending="execution.pendingQueueActions.value"
    :language="language"
    @cancel="execution.cancelQueuedMessage"
    @steer="execution.steerQueuedMessage"
  />
  <DesktopChatComposer
    ref="composerRef"
    :key="editorKey"
    v-bind="bindings"
    :manage-skills="() => { void router.push(desktopRouteLocations.skills(skillScopeId ?? null)) }"
    :has-queued-messages="execution.queuedMessages.value.length > 0"
    @attach="composer.selectAttachments"
    @retry-resource="composer.retryResource"
    @dismiss-interaction="composer.dismissInteraction"
    @send="handleSend"
    @stop="execution.cancelActiveRun"
    @update-content="composer.updateComposerContent"
    @update-effort="composer.setSelectedEffort"
    @update-permission-mode="composer.setPermissionMode"
    @update-model="composer.selectModel"
    @update-service-tier="composer.setSelectedServiceTier"
  >
    <template #leadingContext>
      <slot name="leadingContext" />
    </template>
  </DesktopChatComposer>
</template>
