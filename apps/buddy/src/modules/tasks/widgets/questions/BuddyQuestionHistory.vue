<script setup lang="ts">
import type { UserQuestionHistory } from '@buddy-shared/questions/userQuestionHistory'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChatHelp20Regular, CheckmarkCircle20Regular, ChevronDown16Regular, ChevronRight16Regular } from '@vicons/fluent'
import { computed, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useChatTranscriptValue } from '../transcript/chatTranscriptPresentation'
import BuddyQuestionPrompt from './BuddyQuestionPrompt.vue'

const props = defineProps<{ request: UserQuestionHistory, language: BuddyLocale, retryable?: boolean }>()
const emit = defineEmits<{ retry: [requestId: string] }>()
const { t } = useBuddyI18n(() => props.language)
const id = useId()
const expanded = useChatTranscriptValue(() => `question-history:${props.request.id}:expanded`, props.request.entries.length === 1 && props.request.entries.every(entry => entry.question.length + entry.answer.length <= 320))
const preview = computed(() => props.request.entries
  .map(entry => entry.answer.split('\n').map(line => line.trim()).filter(Boolean).join(' · '))
  .filter(Boolean)
  .join('；') || props.request.entries[0]?.question)
</script>

<template>
  <article class="buddy-question-history min-w-0" :data-request-id="request.id" :data-status="request.status">
    <div class="question-history-frame min-w-0 rounded-control border-1 border-solid border-border">
      <button type="button" class="question-history-heading grid min-h-8 w-full min-w-0 items-center gap-x-3 gap-y-1 rounded-control px-3 py-1.5 text-left" :aria-expanded="expanded" :aria-controls="id" @click="expanded = !expanded">
        <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[length:var(--buddy-chat-meta-font-size)] leading-[var(--buddy-chat-meta-line-height)] [grid-area:identity]">
          <DesktopIcon :component="request.status === 'answered' ? CheckmarkCircle20Regular : ChatHelp20Regular" :size="16" class="shrink-0 text-muted" aria-hidden="true" />
          <strong class="max-w-[calc(100%_-_24px)] min-w-0 truncate font-500 text-fg">{{ request.buddyName }}</strong>
          <span class="max-w-full text-muted">{{ t(`questions.status.${request.status}`) }}</span>
          <span v-if="request.entries.length > 1" class="shrink-0 whitespace-nowrap text-[length:var(--buddy-chat-caption-font-size)] text-muted">{{ t('questions.count', { count: request.entries.length }) }}</span>
        </span>
        <span v-if="!expanded" class="question-history-preview min-w-0 truncate border-l-1 border-l-solid border-l-border pl-3 text-[length:var(--buddy-chat-meta-font-size)] text-fg leading-[var(--buddy-chat-meta-line-height)] [grid-area:preview]">{{ preview }}</span>
        <DesktopIcon :component="expanded ? ChevronDown16Regular : ChevronRight16Regular" :size="16" class="text-muted [grid-area:toggle]" aria-hidden="true" />
      </button>
      <div v-if="expanded" :id="id" class="grid min-w-0 gap-5 px-3 pb-3 pt-2">
        <template v-for="(entry, index) in request.entries" :key="entry.id">
          <hr v-if="index" class="m-0 w-full border-0 border-t-1 border-t-solid border-t-border">
          <section class="grid min-w-0 gap-2.5">
            <BuddyQuestionPrompt :content="entry.question" :language="language" :position="index + 1" :total="request.entries.length" />
            <div v-if="entry.answer" class="border-l-2 border-l-solid border-l-accent-border pl-3">
              <span class="text-[length:var(--buddy-chat-caption-font-size)] text-muted">{{ t('questions.yourAnswer') }}</span>
              <p class="m-0 mt-1 whitespace-pre-wrap text-[length:var(--buddy-chat-user-font-size)] text-fg leading-[var(--buddy-chat-user-line-height)] [font-family:var(--buddy-font-body)] [overflow-wrap:anywhere]">
                {{ entry.answer }}
              </p>
            </div>
          </section>
        </template>
      </div>
      <div v-if="request.delivery && request.delivery.state !== 'delivered'" class="flex flex-wrap items-center gap-2 px-3 pb-3 text-xs text-muted" role="status">
        <span>{{ t(request.delivery.state === 'failed' ? 'questions.deliveryFailed' : 'questions.deliveryPending') }}</span>
        <button v-if="retryable && request.delivery.state === 'failed'" type="button" class="question-history-retry rounded-icon text-accent-text" @click="emit('retry', request.id)">
          {{ t('questions.retry') }}
        </button>
      </div>
    </div>
  </article>
</template>

<style scoped lang="scss">
.question-history-frame {
  container-type: inline-size;
}

.question-history-heading {
  grid-template-areas: 'identity preview toggle';
  grid-template-columns: fit-content(45%) minmax(0, 1fr) auto;

  &[aria-expanded='true'] {
    grid-template-areas: 'identity toggle';
    grid-template-columns: minmax(0, 1fr) auto;
  }
}

@container (max-width: 24rem) {
  .question-history-heading[aria-expanded='false'] {
    grid-template-areas: 'identity toggle' 'preview preview';
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 2px;
  }

  .question-history-preview {
    border-left: 0;
    padding-left: 0;
  }
}

.question-history-heading,
.question-history-retry {
  cursor: pointer;
  border: 0;
  background: transparent;
  font: inherit;

  &:hover {
    background: var(--buddy-state-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }
}
</style>
