<script setup lang="ts">
import type { ChatAgentTurnNode } from '../../model/transcript/chatStreamingMessage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronRight20Regular, PanelRight20Regular, Thinking20Regular } from '@vicons/fluent'
import { computed, shallowReactive } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { createChatAgentActivityProjector } from '../../model/transcript/chatAgentActivities'
import BuddyChatActivityGroup from './BuddyChatActivityGroup.vue'
import BuddyChatCompactionRow from './BuddyChatCompactionRow.vue'
import BuddyChatNarrationBody from './BuddyChatNarrationBody.vue'
import { useChatActivityNavigation } from './useChatActivityNavigation'

const props = defineProps<{
  active: boolean
  collapsed: boolean
  completed: boolean
  disclosureId: string
  duration: string
  failureDetailText: string | null
  language: BuddyLocale
  nodes: ReadonlyArray<ChatAgentTurnNode>
  statusLabel: string
  topToggle: boolean
}>()
const emit = defineEmits<{ toggle: [] }>()

const { t } = useBuddyI18n(() => props.language)
const rowProjector = createChatAgentActivityProjector()
const openEntries = shallowReactive(new Map<string, boolean>())
function toggleEntry(id: string) {
  openEntries.set(id, !openEntries.get(id))
}
const rows = computed(() => rowProjector.project(props.nodes))
const summary = computed(() => props.active
  ? t('desktop.chat.processReasoningRunning')
  : props.completed
    ? `${t('desktop.chat.processReasoningDone')} · ${props.duration}`
    : props.statusLabel)
const navigation = useChatActivityNavigation()
function revealActivity(nodeId: string) {
  const group = rows.value.find(row => row.kind === 'activity-group' && row.nodes.some(node => node.id === nodeId))
  if (group)
    navigation.reveal(group.id, nodeId)
}
defineExpose({ revealActivity })
</script>

<template>
  <div class="buddy-chat-agent-turn__flow">
    <button
      v-if="!topToggle && rows.length"
      class="buddy-chat-agent-turn__process-toggle buddy-chat-activity-row"
      type="button"
      :aria-expanded="!collapsed"
      :aria-controls="disclosureId"
      :disabled="active"
      @click="emit('toggle')"
    >
      <DesktopIcon :component="Thinking20Regular" class="buddy-chat-activity-row__icon" aria-hidden="true" />
      <span class="buddy-chat-activity-row__label">{{ summary }}</span>
      <DesktopIcon :component="ChevronRight20Regular" class="buddy-chat-activity-row__chevron" :class="{ 'is-open': !collapsed }" aria-hidden="true" />
    </button>
    <div v-show="!collapsed" :id="disclosureId" class="buddy-chat-agent-turn__process-content">
      <template v-for="row in rows" :key="row.id">
        <BuddyChatActivityGroup
          v-if="row.kind === 'activity-group'"
          :ref="view => navigation.register(row.id, view)"
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
        <p v-else-if="row.kind === 'panel'" class="buddy-chat-agent-turn__panel-operation" data-testid="context-panel-operation">
          <DesktopIcon :component="PanelRight20Regular" />
          <span>{{ t(row.actor === 'harness' ? 'desktop.chat.panelActorSystem' : 'desktop.chat.panelActorUser') }} · {{ t(row.action === 'open' ? 'desktop.chat.panelOpened' : 'desktop.chat.panelClosed') }}</span>
        </p>
      </template>
    </div>
    <p v-if="failureDetailText" class="buddy-chat-agent-turn__failure-detail">
      <span>{{ t('desktop.chat.failureDetail') }}</span>
      {{ failureDetailText }}
    </p>
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-agent-turn__flow {
  display: grid;
  min-width: 0;
  gap: 6px;
  margin-top: var(--buddy-chat-gap-block);
}

.buddy-chat-agent-turn__process-toggle {
  display: inline-flex;
  width: 100%;
  max-width: none;
  align-items: center;
  justify-content: flex-start;
  margin: 0;
  padding-inline: 0;
  padding-bottom: 8px;
  border: 0;
  border-bottom: 0.5px solid color-mix(in srgb, var(--buddy-border-subtle) 70%, transparent);
  border-radius: 0;
  color: var(--buddy-chat-process-color);
  text-align: start;
}

.buddy-chat-agent-turn__process-toggle:disabled {
  opacity: 1;
}

.buddy-chat-agent-turn__process-content {
  display: grid;
  min-width: 0;
  gap: 6px;
  padding-top: 6px;
}

.buddy-chat-agent-turn__failure-detail {
  margin: 0;
  color: var(--buddy-chat-meta-color);
  font-size: var(--buddy-chat-meta-font-size);
  line-height: var(--buddy-chat-meta-line-height);
  overflow-wrap: anywhere;
  white-space: pre-wrap;

  span {
    color: var(--buddy-chat-process-color);
    font-weight: 600;
  }
}

.buddy-chat-agent-turn__panel-operation {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
  color: var(--buddy-chat-process-color);
  font-size: var(--buddy-chat-meta-font-size);
  line-height: var(--buddy-chat-meta-line-height);

  svg {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
}
</style>
