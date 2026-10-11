<script setup lang="ts">
import type { ChatAgentTurnNode } from '../../model/transcript/chatStreamingMessage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { PanelRight20Regular } from '@vicons/fluent'
import { computed, shallowReactive } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { createChatAgentActivityProjector } from '../../model/transcript/chatAgentActivities'
import BuddyChatActivityGroup from './BuddyChatActivityGroup.vue'
import BuddyChatCompactionRow from './BuddyChatCompactionRow.vue'
import BuddyChatNarrationBody from './BuddyChatNarrationBody.vue'

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
      <p v-else-if="row.kind === 'panel'" class="buddy-chat-agent-turn__panel-operation flex items-center gap-[6px] my-[4px] mx-0 text-[length:var(--buddy-chat-meta-font-size)] leading-[var(--buddy-chat-meta-line-height)]" data-testid="context-panel-operation">
        <DesktopIcon :component="PanelRight20Regular" />
        <span>{{ t(row.actor === 'harness' ? 'desktop.chat.panelActorSystem' : 'desktop.chat.panelActorUser') }} · {{ t(row.action === 'open' ? 'desktop.chat.panelOpened' : 'desktop.chat.panelClosed') }}</span>
      </p>
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

.buddy-chat-agent-turn__panel-operation {
  color: var(--buddy-chat-process-color);

  svg {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
}
</style>
