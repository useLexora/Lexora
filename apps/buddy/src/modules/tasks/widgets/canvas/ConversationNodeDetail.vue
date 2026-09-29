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
  <section class="conversation-node-detail" data-testid="canvas-node-detail" :data-kind="target.kind" :data-target-id="target.kind === 'question' ? target.messageId : target.runId">
    <header class="conversation-node-detail__header">
      <DesktopIcon :component="target.kind === 'question' ? Keyboard20Regular : Wand20Regular" />
      <span>{{ t(`desktop.canvas.${target.kind}`) }}</span>
      <div class="conversation-node-detail__actions">
        <button v-if="target.kind === 'question' && !editing" type="button" :disabled="!canEdit" :aria-label="t('desktop.chat.editMessage')" :title="t('desktop.chat.editMessage')" data-testid="canvas-detail-edit" @click="emit('edit')">
          <DesktopIcon :component="Edit20Regular" />
        </button>
        <button type="button" :aria-label="t('desktop.canvas.closeDetail')" :title="t('desktop.canvas.closeDetail')" @click="emit('close')">
          <DesktopIcon :component="Dismiss20Regular" />
        </button>
      </div>
    </header>
    <div :key="target.kind === 'question' ? target.messageId : target.runId" class="conversation-node-detail__content">
      <p v-if="loading || error" class="conversation-node-detail__notice" role="status">
        {{ error ?? t('desktop.canvas.loadingDetail') }}
        <button v-if="error" type="button" @click="emit('reload')">
          {{ t('desktop.canvas.reload') }}
        </button>
      </p>
      <template v-for="row in rows" :key="row.key">
        <div v-if="row.kind === 'message'" class="conversation-node-detail__message" :data-message-id="row.message.id">
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
        <p v-else-if="row.kind === 'recovery-notice'" class="conversation-node-detail__notice" role="status">
          {{ t('desktop.chat.recoveryAttachmentsMissing', { count: row.notice.missingAttachmentCount }) }}
        </p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.conversation-node-detail { display: flex; height: 100%; min-width: 0; min-height: 0; flex-direction: column; background: var(--buddy-surface-base); }
.conversation-node-detail__header { display: flex; flex: none; height: 52px; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid var(--buddy-border-subtle); color: var(--buddy-text-secondary); font-size: 13px; }
.conversation-node-detail__actions { display: flex; margin-left: auto; gap: 4px; }
.conversation-node-detail__header button { display: grid; width: 28px; height: 28px; place-items: center; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.conversation-node-detail__header button:hover { background: var(--buddy-state-hover); }
.conversation-node-detail__header button:disabled { opacity: 0.35; cursor: default; }
.conversation-node-detail__header button:focus-visible { outline: 2px solid var(--buddy-focus-ring); }
.conversation-node-detail__content { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 16px; padding: 20px 18px 32px; overflow: auto; overscroll-behavior: contain; }
.conversation-node-detail__message { display: grid; flex: none; gap: var(--buddy-chat-gap-block); min-width: 0; }
.conversation-node-detail__notice { color: var(--buddy-text-muted); font-size: 12px; }
.conversation-node-detail__content :deep(.buddy-chat-message-content.is-user) { width: 100%; max-width: 100%; justify-items: start; }
.conversation-node-detail__content :deep(.buddy-chat-message-content.is-user .buddy-chat-message-content__text) { width: 100%; justify-self: stretch; }
.conversation-node-detail__content :deep(.buddy-chat-message-content.is-user .buddy-chat-message-content__attachment:first-child) { margin-inline-start: 0; }
.conversation-node-detail__content :deep(.buddy-chat-message-content__preview-trigger img) { object-fit: contain; }
</style>
