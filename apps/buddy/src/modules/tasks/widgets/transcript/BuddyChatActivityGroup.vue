<script setup lang="ts">
import type { ChatAgentActivityGroup } from '../../model/transcript/chatAgentActivities'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronRight20Regular, ChevronUp20Regular, Thinking20Regular } from '@vicons/fluent'
import { computed, nextTick, shallowRef, useId, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { presentChatActivityLayout } from '../../model/transcript/chatActivityLayout'
import { summarizeChatActivity, summarizeChatActivityCounts } from '../../model/transcript/chatActivitySummary'
import { canExpandChatTool, isChatToolIssue } from '../../model/transcript/chatToolDisplay'
import BuddyChatActivitySpinner from './BuddyChatActivitySpinner.vue'
import BuddyChatDisclosure from './BuddyChatDisclosure.vue'
import BuddyChatReasoningRow from './BuddyChatReasoningRow.vue'
import BuddyChatShimmerText from './BuddyChatShimmerText.vue'
import BuddyChatToolDetails from './BuddyChatToolDetails.vue'
import BuddyChatToolIcon from './BuddyChatToolIcon.vue'
import BuddyChatToolRow from './BuddyChatToolRow.vue'
import { useChatContent } from './chatContentContext'

const props = defineProps<{
  group: ChatAgentActivityGroup
  language: BuddyLocale
  openEntries: ReadonlyMap<string, boolean>
}>()
const emit = defineEmits<{ toggleEntry: [id: string], openEntry: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
const actions = useChatContent()
const open = shallowRef(false)
const highlightedIssue = shallowRef<string | null>(null)
const content = useTemplateRef<HTMLDivElement>('content')
const header = useTemplateRef<HTMLButtonElement>('header')
const bodyId = useId()
const active = computed(() => props.group.status === 'running' || props.group.status === 'preparing')
const stateLabel = computed(() => props.group.status === 'running'
  ? t('desktop.chat.processToolRunning')
  : props.group.status === 'preparing'
    ? t('desktop.chat.progressPreparing')
    : props.group.status === 'interrupted' ? t('desktop.chat.processToolInterrupted') : '')
const singleTool = computed(() => props.group.nodes.length === 1 && props.group.toolCount === 1)
const layout = computed(() => presentChatActivityLayout(props.group.nodes))
const singleReasoning = computed(() => layout.value.entries.length === 1 && layout.value.entries[0]?.kind === 'reasoning')
const showBottomCollapse = computed(() => layout.value.entries.filter(entry => entry.kind !== 'tool-details').length > 8)
const issues = computed(() => props.group.nodes.filter(node => node.kind === 'tool' && isChatToolIssue(node)))
const fullSummary = computed(() => summarizeChatActivityCounts(props.group, props.language, Infinity))
const summary = computed(() => summarizeChatActivity(props.group, props.language))

function toggleEntry(id: string) {
  highlightedIssue.value = null
  if (singleTool.value || singleReasoning.value)
    open.value = props.openEntries.get(id) !== true
  emit('toggleEntry', id)
}

async function revealNextIssue() {
  const index = issues.value.findIndex(node => node.id === highlightedIssue.value)
  const node = issues.value[(index + 1) % issues.value.length]
  if (node)
    await revealActivity(node.id)
}

async function revealActivity(nodeId: string) {
  const node = props.group.nodes.find(node => node.id === nodeId)
  if (node?.kind !== 'tool')
    return
  highlightedIssue.value = node.id
  open.value = true
  emit('openEntry', node.id)
  await nextTick()
  if (!open.value || highlightedIssue.value !== node.id)
    return
  const row = [...(content.value?.querySelectorAll<HTMLElement>('[data-activity-node-id]') ?? [])]
    .find(element => element.dataset.activityNodeId === node.id)
  const target = row?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? row
  target?.focus({ preventScroll: true })
  target?.scrollIntoView({ block: 'center', behavior: 'instant' })
}

function collapseFromBottom() {
  header.value?.focus({ preventScroll: true })
  header.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  open.value = false
}
</script>

<template>
  <section
    class="buddy-chat-activity-group min-w-0"
    :data-activity-id="group.id"
    :class="{ 'is-open': open, 'is-active': active, 'is-grouped': !singleTool && !singleReasoning }"
    :data-status="group.status"
  >
    <div v-if="!singleTool && !singleReasoning" class="flex items-center gap-[6px]">
      <button ref="header" class="buddy-chat-activity-group__header buddy-chat-activity-row min-w-0" type="button" :aria-expanded="open" :aria-controls="bodyId" :aria-label="[fullSummary, stateLabel].filter(Boolean).join(' · ')" @click="open = !open">
        <BuddyChatToolIcon v-if="summary.icon !== 'reasoning'" :icon="summary.icon" class="buddy-chat-activity-row__icon" aria-hidden="true" />
        <DesktopIcon v-else :component="Thinking20Regular" class="buddy-chat-activity-row__icon" aria-hidden="true" />
        <BuddyChatShimmerText class="buddy-chat-activity-row__label" :mode="active ? 'continuous' : 'static'">
          {{ open ? fullSummary : summary.label }}
        </BuddyChatShimmerText>
        <span v-if="group.status === 'interrupted'" class="buddy-chat-activity-group__status">{{ stateLabel }}</span>
        <span class="buddy-chat-activity-group__toggle grid w-[var(--buddy-chat-activity-icon-size)] h-[var(--buddy-chat-activity-icon-size)] flex-none place-items-center" :class="{ 'is-loading': active && !open }" aria-hidden="true">
          <BuddyChatActivitySpinner v-if="active && !open" />
          <DesktopIcon :component="ChevronRight20Regular" class="buddy-chat-activity-row__chevron" :class="{ 'is-open': open }" />
        </span>
      </button>
      <span v-if="group.approvalCount" class="buddy-chat-activity-group__approval text-warning">{{ t('desktop.chat.activityApprovalCount', { count: group.approvalCount }) }}</span>
      <button v-if="group.issueCount" class="buddy-chat-activity-group__issues flex-none py-[4px] px-[6px] border-0 rounded-micro bg-transparent text-warning text-[11.5px] whitespace-nowrap cursor-pointer hover:bg-warning-surface focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]" type="button" @click="revealNextIssue">
        {{ t('desktop.chat.activityIssueCount', { count: group.issueCount }) }}
      </button>
    </div>
    <BuddyChatDisclosure>
      <div v-if="open || singleTool || singleReasoning" :id="bodyId" ref="content" class="buddy-chat-activity-group__content min-w-0">
        <template v-for="entry in layout.entries" :key="entry.id">
          <BuddyChatToolRow
            v-if="entry.kind === 'tool'"
            :node="entry" :language="language" :open="openEntries.get(entry.id) === true"
            :compact="layout.compact.get(entry.id)?.position"
            :compact-target="layout.compact.get(entry.id)?.target"
            :has-next="layout.compact.get(entry.id)?.hasNext"
            :highlighted="highlightedIssue === entry.id"
            :shimmer="singleTool"
            @toggle="toggleEntry(entry.id)"
          />
          <BuddyChatDisclosure v-else-if="entry.kind === 'tool-details'">
            <BuddyChatToolDetails
              v-if="openEntries.get(entry.node.id) && canExpandChatTool(entry.node, actions.canPreviewFile)"
              :data-tool-detail-id="entry.node.toolCallId"
              :data-action-detail-id="entry.node.invocation?.id"
              :error-code="entry.node.errorCode"
              :language="language" :presentation="entry.node.presentation"
              :status="entry.node.status" :tool-name="entry.node.toolName"
            />
          </BuddyChatDisclosure>
          <BuddyChatReasoningRow
            v-else-if="entry.kind === 'reasoning'"
            :shimmer="singleReasoning"
            :node="entry" :language="language" :open="openEntries.get(entry.id) === true"
            @toggle="toggleEntry(entry.id)"
          />
        </template>
        <button v-if="showBottomCollapse" class="buddy-chat-activity-group__collapse buddy-chat-activity-row flex mt-[4px] text-muted text-[length:var(--buddy-chat-caption-font-size)]" type="button" @click="collapseFromBottom">
          <DesktopIcon :component="ChevronUp20Regular" class="buddy-chat-activity-row__icon" aria-hidden="true" />
          {{ t('desktop.chat.activityCollapse') }}
        </button>
      </div>
    </BuddyChatDisclosure>
  </section>
</template>

<style scoped lang="scss">
@use './chatActivityRow' as activity;

@include activity.header;

.buddy-chat-activity-group {
  --buddy-shimmer-base: var(--buddy-text-secondary);
  --buddy-shimmer-duration: 3s;
}

.buddy-chat-activity-group__toggle > * { grid-area: 1 / 1; }

.buddy-chat-activity-group__toggle > .buddy-chat-activity-spinner {
  visibility: hidden;
  animation-play-state: paused;
}

.buddy-chat-activity-group__header:not(:hover, :focus-visible) .buddy-chat-activity-group__toggle.is-loading {
  .buddy-chat-activity-spinner {
    visibility: visible;
    animation-play-state: running;
  }

  .buddy-chat-activity-row__chevron { visibility: hidden; }
}

.buddy-chat-activity-group__status,
.buddy-chat-activity-group__approval {
  flex: none;
  color: var(--buddy-text-muted);
  font-size: var(--buddy-chat-tool-font-size);
  white-space: nowrap;
}

.is-grouped > .buddy-chat-activity-group__content {
  margin-block: 4px;
  padding-inline-start: var(--buddy-chat-activity-indent);
}
</style>
