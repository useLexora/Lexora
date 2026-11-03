<script setup lang="ts">
import type { UserQuestionHistory } from '@buddy-shared/questions/userQuestionHistory'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChatHelp20Regular, ChevronDown16Regular, ChevronRight16Regular } from '@vicons/fluent'
import { shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ request: UserQuestionHistory, language: BuddyLocale, retryable?: boolean }>()
const emit = defineEmits<{ retry: [requestId: string] }>()
const { t } = useBuddyI18n(() => props.language)
const id = useId()
const expanded = shallowRef(props.request.entries.length === 1 && props.request.entries.every(entry => entry.question.length + entry.answer.length <= 320))
</script>

<template>
  <article class="buddy-question-history min-w-0" :data-request-id="request.id" :data-status="request.status">
    <div class="min-w-0 rounded-[10px] border-1 border-solid border-border">
      <button type="button" class="question-history-heading flex w-full min-w-0 items-center gap-2 rounded-[10px] px-3 py-2.5 text-left" :aria-expanded="expanded" :aria-controls="id" @click="expanded = !expanded">
        <DesktopIcon :component="ChatHelp20Regular" :size="18" class="shrink-0 text-muted" />
        <strong class="truncate text-sm font-500 text-fg">{{ request.buddyName }}</strong>
        <span class="text-xs text-muted">{{ t(`questions.status.${request.status}`) }}</span>
        <span v-if="request.entries.length > 1" class="text-xs text-muted">{{ t('questions.count', { count: request.entries.length }) }}</span>
        <DesktopIcon :component="expanded ? ChevronDown16Regular : ChevronRight16Regular" :size="16" class="ml-auto shrink-0 text-muted" />
      </button>
      <div v-if="expanded" :id="id" class="grid min-w-0 gap-4 px-3 pb-3">
        <section v-for="entry in request.entries" :key="entry.id" class="grid min-w-0 gap-2">
          <h3 class="m-0 whitespace-pre-wrap text-sm font-500 text-fg leading-relaxed [overflow-wrap:anywhere]">
            {{ entry.question }}
          </h3>
          <div v-if="entry.answer" class="border-l-2 border-l-solid border-l-accent-border pl-3">
            <span class="text-xs text-muted">{{ t('questions.yourAnswer') }}</span>
            <p class="m-0 mt-1 whitespace-pre-wrap text-sm text-fg leading-relaxed [overflow-wrap:anywhere]">
              {{ entry.answer }}
            </p>
          </div>
        </section>
      </div>
      <p v-else class="m-0 truncate px-3 pb-2.5 text-sm text-muted">
        {{ request.entries[0]?.question }}
      </p>
      <div v-if="request.delivery && request.delivery.state !== 'delivered'" class="flex items-center gap-2 px-3 pb-2.5 text-xs text-muted" role="status">
        <span>{{ t(request.delivery.state === 'failed' ? 'questions.deliveryFailed' : 'questions.deliveryPending') }}</span>
        <button v-if="retryable && request.delivery.state === 'failed'" type="button" class="question-history-retry text-accent-text" @click="emit('retry', request.id)">
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
  color: inherit;
  font: inherit;

  &:hover {
    background: var(--buddy-state-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-accent-solid);
    outline-offset: -2px;
  }
}
</style>
