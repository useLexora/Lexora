<script setup lang="ts">
import type { ChatAgentReasoningNode } from '../../model/transcript/chatStreamingMessage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronRight20Regular, Thinking20Regular } from '@vicons/fluent'
import { computed, useId, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { reasoningPreview } from '../../model/transcript/chatActivitySummary'
import BuddyChatDisclosure from './BuddyChatDisclosure.vue'
import BuddyChatReasoningBody from './BuddyChatReasoningBody.vue'

const props = defineProps<{
  language: BuddyLocale
  node: ChatAgentReasoningNode
  open: boolean
}>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useBuddyI18n(() => props.language)
const bodyId = useId()
const header = useTemplateRef<HTMLButtonElement>('header')
const summary = computed(() => reasoningPreview(props.node.text))
const label = computed(() => t(props.node.status === 'interrupted'
  ? 'desktop.chat.processReasoningInterrupted'
  : props.node.status === 'running' ? 'desktop.chat.processReasoningRunning' : 'desktop.chat.processReasoningDone'))

function collapse() {
  header.value?.focus({ preventScroll: true })
  header.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  emit('toggle')
}
</script>

<template>
  <div class="buddy-chat-reasoning-entry">
    <button ref="header" class="buddy-chat-reasoning-entry__header buddy-chat-activity-row" type="button" :aria-expanded="open" :aria-controls="bodyId" @click="emit('toggle')">
      <DesktopIcon :component="Thinking20Regular" class="buddy-chat-activity-row__icon" aria-hidden="true" />
      <span class="buddy-chat-reasoning-entry__label buddy-chat-activity-row__label">{{ label }}</span>
      <span v-if="!open" class="buddy-chat-reasoning-entry__summary">{{ summary }}</span>
      <DesktopIcon :component="ChevronRight20Regular" class="buddy-chat-activity-row__chevron" :class="{ 'is-open': open }" aria-hidden="true" />
    </button>
    <BuddyChatDisclosure>
      <div v-if="open" :id="bodyId" class="buddy-chat-reasoning-entry__content">
        <BuddyChatReasoningBody :text="node.text" />
        <button class="buddy-chat-reasoning-entry__collapse buddy-chat-activity-row" type="button" @click="collapse">
          {{ t('desktop.chat.activityCollapse') }}
        </button>
      </div>
    </BuddyChatDisclosure>
  </div>
</template>

<style scoped lang="scss">
@use './chatActivityRow' as activity;

@include activity.header;

.buddy-chat-reasoning-entry {
  min-width: 0;
}

.buddy-chat-reasoning-entry__content { padding-inline-start: var(--buddy-chat-activity-indent); }
.buddy-chat-reasoning-entry__label { flex: none; }
.buddy-chat-reasoning-entry__summary {
  min-width: 0;
  overflow: hidden;
  color: var(--buddy-text-muted);
  font-size: var(--buddy-chat-tool-font-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.buddy-chat-reasoning-entry__collapse { font-size: var(--buddy-chat-caption-font-size); }
</style>
