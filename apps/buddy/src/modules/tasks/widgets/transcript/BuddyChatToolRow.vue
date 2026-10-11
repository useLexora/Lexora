<script setup lang="ts">
import type { ChatAgentToolNode } from '../../model/transcript/chatAgentTurn'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronRight20Regular } from '@vicons/fluent'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { canExpandChatTool, describeChatTool, isChatToolActive, isChatToolIssue } from '../../model/transcript/chatToolDisplay'
import BuddyChatActivitySpinner from './BuddyChatActivitySpinner.vue'
import BuddyChatShimmerText from './BuddyChatShimmerText.vue'
import BuddyChatToolIcon from './BuddyChatToolIcon.vue'
import { useChatContent } from './chatContentContext'

const props = defineProps<{
  language: BuddyLocale
  node: ChatAgentToolNode
  open?: boolean
  compact?: 'start' | 'continuation'
  compactTarget?: string
  hasNext?: boolean
  highlighted?: boolean
  shimmer?: boolean
}>()
const emit = defineEmits<{ toggle: [] }>()
const actions = useChatContent()
const display = computed(() => describeChatTool(props.node, props.language))
const canExpand = computed(() => canExpandChatTool(props.node, actions.canPreviewFile))
const active = computed(() => isChatToolActive(props.node))
const processing = computed(() => props.node.status === 'running' || props.node.status === 'preparing')
const issue = computed(() => isChatToolIssue(props.node))
</script>

<template>
  <section class="buddy-chat-tool min-w-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px] focus-visible:rounded-micro" :class="[`is-${node.status}`, compact && `is-compact-${compact}`, { 'is-selected': open, 'is-highlighted': highlighted }]" :data-activity-node-id="node.id" :data-tool-call-id="node.toolCallId" :data-action-id="node.invocation?.id" :data-action-status="node.invocation?.status" tabindex="-1">
    <button
      class="buddy-chat-tool__header buddy-chat-activity-row flex w-[calc(100%_+_8px)] items-baseline"
      :aria-expanded="canExpand ? open === true : undefined"
      :aria-label="[display.label, display.fullTarget, issue || active ? display.status : ''].filter(Boolean).join(' · ')"
      :disabled="!canExpand"
      type="button"
      @click="emit('toggle')"
    >
      <BuddyChatToolIcon v-if="compact !== 'continuation'" :icon="display.icon" class="buddy-chat-activity-row__icon" aria-hidden="true" />
      <BuddyChatShimmerText v-if="compact !== 'continuation'" class="buddy-chat-tool__title buddy-chat-activity-row__label" :mode="shimmer && processing ? 'continuous' : 'static'">
        {{ display.label }}
      </BuddyChatShimmerText>
      <span v-if="display.target" class="buddy-chat-tool__summary min-w-0 overflow-hidden text-fg text-ellipsis whitespace-nowrap">{{ compactTarget ?? display.target }}<span v-if="hasNext" class="text-muted" aria-hidden="true">,</span></span>
      <span v-if="display.context && !compact" class="buddy-chat-tool__context min-w-0 overflow-hidden text-muted text-[11.5px] text-ellipsis whitespace-nowrap">{{ display.context }}</span>
      <span v-if="issue || active || node.status === 'cancelled' || node.status === 'skipped' || node.presentation.card === 'directory-authorization' || node.presentation.card === 'system'" class="buddy-chat-tool__status flex items-center gap-[5px] max-w-[40%] text-muted text-[11px] whitespace-nowrap" :class="{ 'is-issue': issue }">
        <span class="overflow-hidden text-ellipsis">{{ display.status }}</span>
        <BuddyChatActivitySpinner v-if="processing" />
      </span>
      <DesktopIcon v-if="!compact" :component="ChevronRight20Regular" class="buddy-chat-activity-row__chevron" :class="{ 'is-open': open, 'is-hidden': !canExpand }" aria-hidden="true" />
    </button>
  </section>
</template>

<style scoped lang="scss">
@use './chatActivityRow' as activity;

@include activity.header;

.buddy-chat-tool {
  --buddy-shimmer-base: var(--buddy-text-secondary);
}

.buddy-chat-tool.is-compact-start,
.buddy-chat-tool.is-compact-continuation {
  display: inline;
}

.buddy-chat-tool.is-compact-start::before {
  display: block;
  content: '';
}

.is-compact-start .buddy-chat-tool__header,
.is-compact-continuation .buddy-chat-tool__header {
  display: inline-flex;
  width: auto;
  max-width: 100%;
  vertical-align: middle;
}

.is-compact-continuation .buddy-chat-tool__header {
  margin-inline-start: 0;
}

.is-selected:is(.is-compact-start, .is-compact-continuation) .buddy-chat-tool__header {
  background: var(--buddy-state-hover);
}

.is-highlighted .buddy-chat-tool__header {
  background: var(--buddy-status-warning-surface);
}

.buddy-chat-tool__header > :is(.buddy-chat-activity-row__icon, .buddy-chat-activity-row__chevron) {
  align-self: center;
}

.buddy-chat-tool__title {
  flex: 0 0 auto;
  max-width: 40%;
}

.buddy-chat-tool__context {
  flex: 0 2 auto;
  line-height: normal;
}

.buddy-chat-tool__status {
  flex: 0 0 auto;
  line-height: normal;
}

.buddy-chat-tool__status.is-issue {
  color: var(--buddy-status-warning-text);
}

.buddy-chat-tool.is-failed .buddy-chat-tool__status {
  color: var(--buddy-chat-danger-color);
}

.buddy-chat-tool.is-awaiting_approval .buddy-chat-tool__status {
  color: var(--buddy-status-warning-text);
}
</style>
