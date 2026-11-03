<script setup lang="ts">
import type { UserQuestionHistory } from '@buddy-shared/questions/userQuestionHistory'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChatHelp20Regular, CheckmarkCircle20Regular, ChevronDown16Regular, ChevronRight16Regular } from '@vicons/fluent'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ request: UserQuestionHistory, language: BuddyLocale, retryable?: boolean }>()
const emit = defineEmits<{ retry: [requestId: string] }>()
const { t } = useBuddyI18n(() => props.language)
const id = useId()
const expanded = shallowRef(props.request.entries.length === 1 && props.request.entries.every(entry => entry.question.length + entry.answer.length <= 320))
const preview = computed(() => props.request.entries.map(entry => entry.answer).filter(Boolean).join('；') || props.request.entries[0]?.question)
</script>

<template>
  <article class="buddy-question-history min-w-0" :data-request-id="request.id" :data-status="request.status">
    <div class="min-w-0 rounded-[10px] border-1 border-solid border-border">
      <button type="button" class="question-history-heading flex w-full min-w-0 items-start gap-2.5 rounded-[10px] px-4 py-3 text-left" :aria-expanded="expanded" :aria-controls="id" @click="expanded = !expanded">
        <DesktopIcon :component="request.status === 'answered' ? CheckmarkCircle20Regular : ChatHelp20Regular" :size="18" class="mt-0.5 shrink-0 text-muted" />
        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--buddy-chat-meta-font-size)] leading-[var(--buddy-chat-meta-line-height)]">
            <strong class="max-w-full truncate font-500 text-fg">{{ request.buddyName }}</strong>
            <span class="text-muted">{{ t(`questions.status.${request.status}`) }}</span>
            <span v-if="request.entries.length > 1" class="text-[length:var(--buddy-chat-caption-font-size)] text-muted">{{ t('questions.count', { count: request.entries.length }) }}</span>
          </span>
          <span v-if="!expanded" class="mt-1 block truncate text-[length:var(--buddy-chat-meta-font-size)] text-muted leading-[var(--buddy-chat-process-line-height)]">{{ preview }}</span>
        </span>
        <DesktopIcon :component="expanded ? ChevronDown16Regular : ChevronRight16Regular" :size="16" class="shrink-0 self-center text-muted" />
      </button>
      <div v-if="expanded" :id="id" class="grid min-w-0 gap-5 px-4 pb-4 pt-1">
        <template v-for="(entry, index) in request.entries" :key="entry.id">
          <hr v-if="index" class="m-0 w-full border-0 border-t-1 border-t-solid border-t-border">
          <section class="grid min-w-0 gap-2.5">
            <h3 class="m-0 flex items-start justify-between gap-3 text-[length:var(--buddy-chat-final-font-size)] font-600 text-fg leading-[var(--buddy-chat-final-line-height)] [overflow-wrap:anywhere]">
              <span class="min-w-0 whitespace-pre-wrap">{{ entry.question }}</span>
              <span v-if="request.entries.length > 1" class="shrink-0 whitespace-nowrap text-[length:var(--buddy-chat-caption-font-size)] font-normal text-muted">{{ t('questions.position', { current: index + 1, total: request.entries.length }) }}</span>
            </h3>
            <div v-if="entry.answer" class="border-l-2 border-l-solid border-l-accent-border pl-3">
              <span class="text-[length:var(--buddy-chat-caption-font-size)] text-muted">{{ t('questions.yourAnswer') }}</span>
              <p class="m-0 mt-1 whitespace-pre-wrap text-[length:var(--buddy-chat-user-font-size)] text-fg leading-[var(--buddy-chat-user-line-height)] [font-family:var(--buddy-font-body)] [overflow-wrap:anywhere]">
                {{ entry.answer }}
              </p>
            </div>
          </section>
        </template>
      </div>
      <div v-if="request.delivery && request.delivery.state !== 'delivered'" class="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs text-muted" role="status">
        <span>{{ t(request.delivery.state === 'failed' ? 'questions.deliveryFailed' : 'questions.deliveryPending') }}</span>
        <button v-if="retryable && request.delivery.state === 'failed'" type="button" class="question-history-retry rounded-icon text-accent-text" @click="emit('retry', request.id)">
          {{ t('questions.retry') }}
        </button>
      </div>
    </div>
  </article>
</template>

<style scoped lang="scss">
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
