<script setup lang="ts">
import type { ChatAgentReasoningNode } from '../../model/transcript/chatStreamingMessage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronRight20Regular, Thinking20Regular } from '@vicons/fluent'
import { computed, useId, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyChatActivitySpinner from './BuddyChatActivitySpinner.vue'
import BuddyChatDisclosure from './BuddyChatDisclosure.vue'
import BuddyChatReasoningBody from './BuddyChatReasoningBody.vue'
import BuddyChatShimmerText from './BuddyChatShimmerText.vue'

const props = defineProps<{
  language: BuddyLocale
  node: ChatAgentReasoningNode
  open: boolean
  shimmer?: boolean
}>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useBuddyI18n(() => props.language)
const bodyId = useId()
const header = useTemplateRef<HTMLButtonElement>('header')
const hasContent = computed(() => !!props.node.text.trim())
const active = computed(() => props.node.status === 'running')
const label = computed(() => t(props.node.status === 'interrupted'
  ? 'desktop.chat.processReasoningInterrupted'
  : props.node.status === 'running' ? 'desktop.chat.processReasoningRunning' : 'desktop.chat.processReasoning'))

function collapse() {
  header.value?.focus({ preventScroll: true })
  header.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  emit('toggle')
}
</script>

<template>
  <div class="buddy-chat-reasoning-entry min-w-0">
    <button ref="header" class="buddy-chat-reasoning-entry__header buddy-chat-activity-row" type="button" :disabled="!hasContent" :aria-expanded="hasContent ? open : undefined" :aria-controls="hasContent ? bodyId : undefined" @click="emit('toggle')">
      <DesktopIcon :component="Thinking20Regular" class="buddy-chat-activity-row__icon" aria-hidden="true" />
      <BuddyChatShimmerText class="buddy-chat-reasoning-entry__label buddy-chat-activity-row__label" :mode="active && shimmer !== false ? 'continuous' : 'static'">
        {{ label }}
      </BuddyChatShimmerText>
      <BuddyChatActivitySpinner v-if="active" />
      <DesktopIcon v-if="hasContent" :component="ChevronRight20Regular" class="buddy-chat-activity-row__chevron" :class="{ 'is-open': open }" aria-hidden="true" />
    </button>
    <BuddyChatDisclosure>
      <div v-if="open && hasContent" :id="bodyId" class="buddy-chat-reasoning-entry__content">
        <BuddyChatReasoningBody :text="node.text" />
        <button class="buddy-chat-reasoning-entry__collapse buddy-chat-activity-row text-[length:var(--buddy-chat-caption-font-size)]" type="button" @click="collapse">
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
  --buddy-shimmer-base: var(--buddy-text-secondary);
}

.buddy-chat-reasoning-entry__content { padding-inline-start: var(--buddy-chat-activity-indent); }
.buddy-chat-reasoning-entry__label { flex: none; }
</style>
