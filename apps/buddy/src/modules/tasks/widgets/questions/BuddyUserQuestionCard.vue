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
  <article class="buddy-user-question-card flex min-w-0 flex-col border-1 border-solid border-border rounded-[10px] bg-raised" :data-request-id="request.id" data-status="pending" :aria-busy="busy">
    <header class="flex shrink-0 items-center">
      <button type="button" class="question-heading flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left" :aria-expanded="expanded" :aria-controls="id" @click="emit('toggle')">
        <DesktopIcon :component="ChatHelp20Regular" :size="18" class="shrink-0 text-muted" />
        <strong class="max-w-[25%] shrink-0 truncate text-sm font-600 text-strong">{{ request.buddyName }}</strong>
        <span class="shrink-0 text-xs text-accent-text">{{ t('questions.status.pending') }}</span>
        <span v-if="!expanded" class="min-w-0 flex-1 truncate text-sm text-muted">{{ request.questions[0]?.question }}</span>
        <span v-else class="flex-1" />
        <DesktopIcon :component="expanded ? ChevronDown16Regular : ChevronRight16Regular" :size="16" class="shrink-0 text-muted" />
      </button>
      <slot name="navigation" />
    </header>
    <template v-if="expanded">
      <div :id="id" class="question-body grid gap-5 px-3 pb-1">
        <BuddyQuestionForm v-for="field in fields" :key="field.question.id" :question="field.question" :answer="field.answer" :language="language" :disabled="busy || !ready" @change="emit('change', $event)" />
      </div>
      <footer class="question-actions shrink-0 px-3 pb-3 pt-2">
        <p v-if="error" role="alert" class="m-0 mb-2 text-sm text-danger">
          {{ t('questions.submitFailed') }}
        </p>
        <div class="flex items-center justify-between gap-2">
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
