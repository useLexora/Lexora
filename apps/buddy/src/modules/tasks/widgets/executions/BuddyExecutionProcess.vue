<script setup lang="ts">
import type { ChatTranscriptRow } from '../../model/transcript/chatTranscriptTypes'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import BuddyChatAgentTurn from '../transcript/BuddyChatAgentTurn.vue'
import BuddyChatAgentTurnFlow from '../transcript/BuddyChatAgentTurnFlow.vue'
import BuddyChatCompactionRow from '../transcript/BuddyChatCompactionRow.vue'
import BuddyChatMessageBody from '../transcript/BuddyChatMessageBody.vue'
import { useChatContent } from '../transcript/chatContentContext'

defineProps<{ rows: readonly ChatTranscriptRow[], language: BuddyLocale }>()
const content = useChatContent()
</script>

<template>
  <div class="grid grid-cols-1 min-w-0 gap-[var(--buddy-chat-gap-block)]" data-testid="execution-process">
    <template v-for="row in rows" :key="row.key">
      <BuddyChatMessageBody v-if="row.kind === 'message'" :message="row.message" :language="language" :final="!row.streaming" :turn-outputs="row.turnOutputs" :turn-changes="row.turnChanges" :write-clipboard-text="content.writeClipboardText" />
      <BuddyChatAgentTurn v-else-if="row.kind === 'agent-turn'" :turn="row.turn" :language="language" :show-identity="false" :show-outcome="row.showOutcome" />
      <BuddyChatAgentTurnFlow v-else-if="row.kind === 'activity-flow'" :nodes="row.nodes" :failure-detail-text="null" :language="language" />
      <BuddyChatCompactionRow v-else-if="row.kind === 'compaction'" :node="row.compaction" :language="language" />
    </template>
    <slot v-if="!rows.length" />
  </div>
</template>
