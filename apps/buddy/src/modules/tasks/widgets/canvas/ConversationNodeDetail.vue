<script setup lang="ts">
import type { ConversationNodeDetailRequest } from '@buddy-shared/conversation/conversationTree'
import type { ChatTranscriptRow } from '../../model/transcript/chatTranscriptProjection'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Dismiss20Regular, Edit20Regular, Keyboard20Regular, Wand20Regular } from '@vicons/fluent'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyChatAgentTurn from '../transcript/BuddyChatAgentTurn.vue'
import BuddyChatAgentTurnFlow from '../transcript/BuddyChatAgentTurnFlow.vue'
import BuddyChatCompactionRow from '../transcript/BuddyChatCompactionRow.vue'
import BuddyChatMessageBody from '../transcript/BuddyChatMessageBody.vue'
import BuddyChatRunActivity from '../transcript/BuddyChatRunActivity.vue'
import BuddyChatTokenUsage from '../transcript/BuddyChatTokenUsage.vue'
import { useChatContent } from '../transcript/chatContentContext'

const props = defineProps<{
  target: ConversationNodeDetailRequest
  rows: readonly ChatTranscriptRow[]
  language: BuddyLocale
  stoppingRunId?: string | null
  loading: boolean
  error: string | null
  canEdit: boolean
  editing: boolean
}>()
const emit = defineEmits<{ close: [], reload: [], edit: [], openArtifact: [id: string], openChanges: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
const { writeClipboardText } = useChatContent()
</script>

<template>
  <section class="conversation-node-detail flex h-full min-w-0 min-h-0 flex-col bg-surface" data-testid="canvas-node-detail" :data-kind="target.kind" :data-target-id="target.kind === 'question' ? target.messageId : target.runId">
    <header class="conversation-node-detail__header flex flex-none h-[52px] items-center gap-[8px] py-0 px-[16px] border-b-1 border-b-solid border-b-border text-muted text-[13px]">
      <DesktopIcon :component="target.kind === 'question' ? Keyboard20Regular : Wand20Regular" />
      <span>{{ t(`desktop.canvas.${target.kind}`) }}</span>
      <div class="flex ml-auto gap-[4px]">
        <button v-if="target.kind === 'question' && !editing" type="button" :disabled="!canEdit" :aria-label="t('desktop.chat.editMessage')" :title="t('desktop.chat.editMessage')" data-testid="canvas-detail-edit" @click="emit('edit')">
          <DesktopIcon :component="Edit20Regular" />
        </button>
        <button type="button" :aria-label="t('desktop.canvas.closeDetail')" :title="t('desktop.canvas.closeDetail')" @click="emit('close')">
          <DesktopIcon :component="Dismiss20Regular" />
        </button>
      </div>
    </header>
    <div :key="target.kind === 'question' ? target.messageId : target.runId" class="conversation-node-detail__content flex flex-1 min-h-0 flex-col gap-[16px] pt-[20px] pr-[18px] pb-[32px] pl-[18px] overflow-auto">
      <p v-if="loading || error" class="text-muted text-[12px]" role="status">
        {{ error ?? t('desktop.canvas.loadingDetail') }}
        <button v-if="error" type="button" @click="emit('reload')">
          {{ t('desktop.canvas.reload') }}
        </button>
      </p>
      <template v-for="row in rows" :key="row.key">
        <div v-if="row.kind === 'message'" class="grid flex-none gap-[var(--buddy-chat-gap-block)] min-w-0" :data-message-id="row.message.id">
          <BuddyChatMessageBody
            :message="row.message" :language="language" :final="!row.streaming" :result-run-id="row.resultRunId"
            :turn-outputs="row.turnOutputs" :turn-changes="row.turnChanges" :write-clipboard-text="writeClipboardText"
            @open-artifact="emit('openArtifact', $event)" @open-changes="emit('openChanges', $event)"
          />
          <BuddyChatTokenUsage v-if="row.turnUsage && !row.streaming" :usage="row.turnUsage" :language="language" />
        </div>
        <template v-else-if="row.kind === 'agent-turn'">
          <BuddyChatAgentTurn :turn="row.turn" :show-identity="row.showIdentity" :show-outcome="row.showOutcome" :language="language" />
          <BuddyChatTokenUsage v-if="row.ownsResultActions && row.turn.usage" :usage="row.turn.usage" :language="language" />
        </template>
        <BuddyChatRunActivity v-else-if="row.kind === 'activity'" :turn="row.turn" :language="language" :stopping="stoppingRunId === row.turn.runId" />
        <BuddyChatAgentTurnFlow v-else-if="row.kind === 'activity-flow'" :nodes="row.nodes" :failure-detail-text="null" :language="language" />
        <BuddyChatCompactionRow v-else-if="row.kind === 'compaction'" :node="row.compaction" :language="language" />
        <p v-else-if="row.kind === 'recovery-notice'" class="text-muted text-[12px]" role="status">
          {{ t('desktop.chat.recoveryAttachmentsMissing', { count: row.notice.missingAttachmentCount }) }}
        </p>
      </template>
    </div>
  </section>
</template>

<style scoped lang="scss">
.conversation-node-detail__header button { display: grid; width: 28px; height: 28px; place-items: center; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.conversation-node-detail__header button:hover { background: var(--buddy-state-hover); }
.conversation-node-detail__header button:disabled { opacity: 0.35; cursor: default; }
.conversation-node-detail__header button:focus-visible { outline: 2px solid var(--buddy-focus-ring); }
.conversation-node-detail__content { overscroll-behavior: contain; }

.conversation-node-detail__content :deep(.buddy-chat-message-content.is-user) { width: 100%; max-width: 100%; justify-items: start; }
.conversation-node-detail__content :deep(.buddy-chat-message-content.is-user .buddy-chat-message-content__text) { width: 100%; justify-self: stretch; }
.conversation-node-detail__content :deep(.buddy-chat-message-content.is-user .buddy-chat-message-content__attachment:first-child) { margin-inline-start: 0; }
.conversation-node-detail__content :deep(.buddy-chat-message-content__preview-trigger img) { object-fit: contain; }
</style>
