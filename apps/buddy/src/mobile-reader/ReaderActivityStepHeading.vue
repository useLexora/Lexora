<script setup lang="ts">
import type { ReaderWireEntry } from './readerProtocol'
import { ChevronRight20Regular, Thinking20Regular } from '@vicons/fluent'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { BuddyChatToolIcon, getChatToolRegistration } from '../modules/tasks/reader'
import { useReaderStrings } from './readerStrings'

const props = defineProps<{ step: NonNullable<ReaderWireEntry['steps']>['items'][number], language: string, open: boolean }>()
defineEmits<{ toggle: [] }>()
const labels = useReaderStrings()
const { t } = useBuddyI18n(() => props.language === 'en' ? 'en-US' : 'zh-CN')
const tool = computed(() => getChatToolRegistration(props.step))
const target = computed(() => props.step.summary || props.step.toolName)
const status = computed(() => ({ running: labels.value.running, completed: labels.value.done, failed: labels.value.failed, interrupted: labels.value.stopped })[props.step.status])
</script>

<template>
  <p v-if="step.kind === 'reasoning'" class="activity-step-heading activity-step-note">
    <Thinking20Regular class="activity-step-icon" aria-hidden="true" />
    <span>{{ t('desktop.chat.processReasoning') }}</span>
    <small v-if="step.status === 'interrupted'" class="activity-step-status">{{ status }}</small>
  </p>
  <button v-else class="activity-step-heading" type="button" :aria-expanded="open" @click="$emit('toggle')">
    <BuddyChatToolIcon :icon="tool.icon" class="activity-step-icon" aria-hidden="true" />
    <span class="activity-step-action">{{ t(tool.label) }}</span>
    <span class="activity-step-target" dir="auto">{{ target }}</span>
    <small v-if="step.status !== 'completed'" class="activity-step-status" :class="{ 'text-danger': step.status === 'failed' }">{{ status }}</small>
    <ChevronRight20Regular class="activity-step-chevron" aria-hidden="true" />
  </button>
</template>

<style scoped lang="scss">
.activity-step-heading {
  display: flex;
  align-items: center;
  width: fit-content;
  max-width: 100%;
  min-height: 44px;
  padding: 2px 4px;
  margin: 0;
  text-align: start;
  font-size: .8667em;
  line-height: 1.5;
  color: var(--reader-muted);

  > * + * { margin-inline-start: 6px; }
}
.activity-step-note { min-height: 32px; }
.activity-step-icon, .activity-step-chevron {
  flex: none;
  width: var(--buddy-chat-activity-icon-size);
  height: var(--buddy-chat-activity-icon-size);
  font-size: var(--buddy-chat-activity-icon-size);
}
.activity-step-action, .activity-step-target {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.activity-step-action { flex: 0 0 auto; max-width: 48%; }
.activity-step-target {
  font-family: var(--buddy-font-mono);
  color: var(--buddy-text-primary);
}
.activity-step-status { flex: none; white-space: nowrap; }
.activity-step-chevron { opacity: .65; }
[aria-expanded='true'] > .activity-step-chevron { transform: rotate(90deg); }
</style>
