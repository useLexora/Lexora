<script setup lang="ts">
import type { UserQuestionAnswer } from '@buddy-shared/questions/userQuestionApi'
import type { UserQuestionFormDefinition } from '../../state/runs/userQuestionInteraction'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { validateUserQuestionResponse } from '@buddy-shared/questions/userQuestionApi'
import { ChatHelp20Regular, ChevronDown16Regular, ChevronRight16Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyQuestionForm from './BuddyQuestionForm.vue'

const props = defineProps<{
  request: UserQuestionFormDefinition
  answers: UserQuestionAnswer[]
  language: BuddyLocale
  expanded: boolean
  busy: boolean
  error: boolean
  ready: boolean
}>()
const emit = defineEmits<{ toggle: [], change: [answer: UserQuestionAnswer], resolve: [answer: boolean] }>()
const { t } = useBuddyI18n(() => props.language)
const id = useId()
const fields = computed(() => props.request.questions.map(question => ({
  question,
  answer: props.answers.find(answer => answer.questionId === question.id) ?? { questionId: question.id, selectedOptionIds: [], text: '' },
})))
const canSubmit = computed(() => {
  if (props.busy || !props.ready)
    return false
  try {
    validateUserQuestionResponse(props.request.questions, { answers: props.answers })
    return true
  }
  catch { return false }
})
</script>

<template>
  <article class="buddy-user-question-card flex min-w-0 flex-col border-1 border-solid border-border rounded-control bg-raised" :data-request-id="request.id" data-status="pending" :aria-busy="busy">
    <header class="flex shrink-0 items-center">
      <button type="button" class="question-heading flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-control px-3 py-1.5 text-left text-[length:var(--buddy-chat-meta-font-size)] leading-[var(--buddy-chat-meta-line-height)]" :aria-expanded="expanded" :aria-controls="id" @click="emit('toggle')">
        <DesktopIcon :component="ChatHelp20Regular" :size="16" class="shrink-0 text-muted" aria-hidden="true" />
        <strong class="max-w-[25%] truncate text-[length:var(--buddy-chat-meta-font-size)] font-500 text-fg">{{ request.buddyName }}</strong>
        <span class="shrink-0 text-muted">{{ t('questions.status.pending') }}</span>
        <span class="min-w-0 flex-1 truncate text-[length:var(--buddy-chat-meta-font-size)] text-muted">{{ expanded ? '' : request.questions[0]?.question }}</span>
        <span v-if="request.questions.length > 1" class="shrink-0 text-[length:var(--buddy-chat-caption-font-size)] text-muted">{{ t('questions.count', { count: request.questions.length }) }}</span>
        <DesktopIcon :component="expanded ? ChevronDown16Regular : ChevronRight16Regular" :size="16" class="shrink-0 text-muted" aria-hidden="true" />
      </button>
      <slot name="navigation" />
    </header>
    <template v-if="expanded">
      <div :id="id" class="question-body grid min-w-0 gap-4 px-3 pt-2">
        <template v-for="(field, index) in fields" :key="field.question.id">
          <hr v-if="index" class="m-0 w-full border-0 border-t-1 border-t-solid border-t-border">
          <BuddyQuestionForm :question="field.question" :answer="field.answer" :language="language" :disabled="busy || !ready" :position="index + 1" :total="fields.length" @change="emit('change', $event)" />
        </template>
      </div>
      <footer class="question-actions mt-2 shrink-0 px-3 pb-2">
        <p v-if="error" role="alert" class="m-0 mb-2 text-sm text-danger">
          {{ t('questions.submitFailed') }}
        </p>
        <div class="flex items-center justify-end gap-2">
          <NButton size="small" quaternary :disabled="busy || !ready" @click="emit('resolve', false)">
            {{ t('questions.decline') }}
          </NButton>
          <NButton size="small" type="primary" :loading="busy" :disabled="!canSubmit" @click="emit('resolve', true)">
            {{ t('questions.submit') }}
          </NButton>
        </div>
      </footer>
    </template>
  </article>
</template>

<style scoped lang="scss">
.question-heading {
  cursor: pointer;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;

  &[aria-expanded='false']:hover {
    background: var(--buddy-state-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }
}
</style>
