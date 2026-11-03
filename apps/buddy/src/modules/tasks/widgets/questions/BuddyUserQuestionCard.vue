<script setup lang="ts">
import type { UserQuestionAnswer } from '@buddy-shared/questions/userQuestionApi'
import type { UserQuestionFormDefinition } from '../../state/runs/userQuestionInteraction'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { validateUserQuestionResponse } from '@buddy-shared/questions/userQuestionApi'
import { ChatHelp20Regular, ChevronDown16Regular, ChevronLeft16Regular, ChevronRight16Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed, useId, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyQuestionForm from './BuddyQuestionForm.vue'

const props = defineProps<{
  request: UserQuestionFormDefinition
  answers: UserQuestionAnswer[]
  questionId?: string
  language: BuddyLocale
  expanded: boolean
  busy: boolean
  error: boolean
  ready: boolean
}>()
const emit = defineEmits<{ toggle: [], change: [answer: UserQuestionAnswer], selectQuestion: [questionId: string], resolve: [answer: boolean] }>()
const { t } = useBuddyI18n(() => props.language)
const id = useId()
const fields = computed(() => props.request.questions.map(question => ({
  question,
  answer: props.answers.find(answer => answer.questionId === question.id) ?? { questionId: question.id, selectedOptionIds: [], text: '' },
})))
const activeIndex = computed(() => Math.max(0, fields.value.findIndex(field => field.question.id === props.questionId)))
const activeField = computed(() => fields.value[activeIndex.value])
const body = useTemplateRef<HTMLElement>('body')
watch(() => activeField.value?.question.id, () => {
  body.value?.scrollTo({ top: 0 })
}, { flush: 'post' })
function navigateQuestion(offset: number) {
  const field = fields.value[activeIndex.value + offset]
  if (field && !props.busy && props.ready)
    emit('selectQuestion', field.question.id)
}
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
  <article class="buddy-user-question-card flex min-h-0 min-w-0 flex-col border-1 border-solid border-border rounded-control bg-raised" :data-request-id="request.id" data-status="pending" :aria-busy="busy">
    <header class="flex shrink-0 items-center">
      <button :id="`${id}-heading`" type="button" class="question-heading flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-control px-3 py-1.5 text-left text-[length:var(--buddy-chat-meta-font-size)] leading-[var(--buddy-chat-meta-line-height)]" :aria-expanded="expanded" :aria-controls="id" @click="emit('toggle')">
        <DesktopIcon :component="ChatHelp20Regular" :size="16" class="shrink-0 text-muted" aria-hidden="true" />
        <strong class="max-w-[25%] truncate text-[length:var(--buddy-chat-meta-font-size)] font-500 text-fg">{{ request.buddyName }}</strong>
        <span class="shrink-0 text-muted">{{ t('questions.status.pending') }}</span>
        <span class="min-w-0 flex-1 truncate text-[length:var(--buddy-chat-meta-font-size)] text-muted">{{ expanded ? '' : activeField?.question.question }}</span>
        <span v-if="!expanded && request.questions.length > 1" class="shrink-0 text-[length:var(--buddy-chat-caption-font-size)] text-muted">{{ t('questions.count', { count: request.questions.length }) }}</span>
        <DesktopIcon :component="expanded ? ChevronDown16Regular : ChevronRight16Regular" :size="16" class="shrink-0 text-muted" aria-hidden="true" />
      </button>
      <slot name="navigation" />
    </header>
    <template v-if="expanded">
      <div :id="id" ref="body" class="question-body grid min-h-0 min-w-0 flex-auto gap-4 overflow-y-auto overscroll-contain px-3 pt-2" role="region" tabindex="0" :aria-labelledby="`${id}-heading`">
        <BuddyQuestionForm v-if="activeField" :question="activeField.question" :answer="activeField.answer" :language="language" :disabled="busy || !ready" :position="activeIndex + 1" :total="fields.length" @change="emit('change', $event)">
          <template #navigation>
            <div v-if="fields.length > 1" class="flex shrink-0 items-center gap-1">
              <NButton class="buddy-icon-button" size="tiny" quaternary :disabled="busy || !ready || activeIndex === 0" :aria-label="t('questions.previousQuestion')" @click="navigateQuestion(-1)">
                <DesktopIcon :component="ChevronLeft16Regular" :size="16" aria-hidden="true" />
              </NButton>
              <span class="min-w-8 text-center tabular-nums" aria-live="polite" aria-atomic="true">{{ activeIndex + 1 }} / {{ fields.length }}</span>
              <NButton class="buddy-icon-button" size="tiny" quaternary :disabled="busy || !ready || activeIndex === fields.length - 1" :aria-label="t('questions.nextQuestion')" @click="navigateQuestion(1)">
                <DesktopIcon :component="ChevronRight16Regular" :size="16" aria-hidden="true" />
              </NButton>
            </div>
          </template>
        </BuddyQuestionForm>
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
.question-body:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: -2px;
}

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
