<script setup lang="ts">
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { ChatTranscriptTurnOutputs } from '../../model/transcript/chatTranscriptProjection'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { getChatMessageInterruption } from '../../model/transcript/chatMessageContent'
import BuddyChatMessageContent from './BuddyChatMessageContent.vue'
import BuddyChatTurnChanges from './BuddyChatTurnChanges.vue'
import BuddyChatTurnOutputs from './BuddyChatTurnOutputs.vue'

const props = defineProps<{
  message: LocalMessage
  language: BuddyLocale
  final: boolean
  resultRunId?: string
  turnOutputs: ChatTranscriptTurnOutputs | null
  turnChanges?: LocalChangeSetSummary | null
  writeClipboardText: (text: string) => Promise<void>
}>()
const emit = defineEmits<{ openArtifact: [id: string], openChanges: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
const interruptionLabel = computed(() => {
  const interruption = getChatMessageInterruption(props.message)
  return interruption ? t(interruption.truncated ? 'desktop.chat.messageInterruptedTruncated' : 'desktop.chat.messageInterrupted') : null
})
</script>

<template>
  <BuddyChatMessageContent
    class="buddy-chat-message__body" :final="final" :hidden-artifacts="turnOutputs?.artifacts ?? []" :data-task-result-run-id="final ? resultRunId : undefined"
    :language="language" :message="message" :write-clipboard-text="writeClipboardText"
  />
  <BuddyChatTurnOutputs v-if="turnOutputs?.artifacts.length" class="buddy-chat-message__outputs" :data-task-result-run-id="final ? resultRunId : undefined" :artifacts="turnOutputs.artifacts" :language="language" @open-artifact="emit('openArtifact', $event)" />
  <BuddyChatTurnChanges v-if="turnChanges" class="buddy-chat-message__changes" :data-task-result-run-id="final ? resultRunId : undefined" :change-set="turnChanges" :language="language" @open-changes="emit('openChanges', $event)" />
  <small v-if="interruptionLabel" class="buddy-chat-message__interruption max-w-[min(42rem,_92%)] text-muted text-[0.75rem] leading-[1.5]" role="status">{{ interruptionLabel }}</small>
</template>
