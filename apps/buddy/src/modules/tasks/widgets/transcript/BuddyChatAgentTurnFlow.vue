<script setup lang="ts">
import type { ChatAgentTurnNode } from '../../model/transcript/chatStreamingMessage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, shallowReactive } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { createChatAgentActivityProjector } from '../../model/transcript/chatAgentActivities'
import BuddyChatActivityGroup from './BuddyChatActivityGroup.vue'
import BuddyChatCompactionRow from './BuddyChatCompactionRow.vue'
import BuddyChatNarrationBody from './BuddyChatNarrationBody.vue'
import BuddyChatPanelGroup from './BuddyChatPanelGroup.vue'

const props = defineProps<{
  failureDetailText: string | null
  language: BuddyLocale
  nodes: ReadonlyArray<ChatAgentTurnNode>
}>()

const { t } = useBuddyI18n(() => props.language)
const rowProjector = createChatAgentActivityProjector()
const openEntries = shallowReactive(new Map<string, boolean>())
function toggleEntry(id: string) {
  openEntries.set(id, !openEntries.get(id))
}
const rows = computed(() => rowProjector.project(props.nodes))
</script>

<template>
  <div class="grid min-w-0 gap-[6px] mt-[var(--buddy-chat-gap-block)]">
    <template v-for="row in rows" :key="row.id">
      <BuddyChatActivityGroup
        v-if="row.kind === 'activity-group'"
        :group="row"
        :language="language"
        :open-entries="openEntries"
        @toggle-entry="toggleEntry"
        @open-entry="openEntries.set($event, true)"
      />
      <BuddyChatCompactionRow
        v-else-if="row.kind === 'compaction' && row.status !== 'running'"
        :language="language"
        :node="row"
      />
      <BuddyChatNarrationBody
        v-else-if="row.kind === 'text'"
        :language="language"
        :text="row.text"
      />
      <BuddyChatPanelGroup v-else-if="row.kind === 'panel-group'" :group="row" :language="language" />
    </template>
    <p v-if="failureDetailText" class="buddy-chat-agent-turn__failure-detail m-0 text-[length:var(--buddy-chat-meta-font-size)] leading-[var(--buddy-chat-meta-line-height)] [overflow-wrap:anywhere] whitespace-pre-wrap">
      <span>{{ t('desktop.chat.failureDetail') }}</span>
      {{ failureDetailText }}
    </p>
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-agent-turn__failure-detail {
  color: var(--buddy-chat-meta-color);

  span {
    color: var(--buddy-chat-process-color);
    font-weight: 600;
  }
}
</style>
