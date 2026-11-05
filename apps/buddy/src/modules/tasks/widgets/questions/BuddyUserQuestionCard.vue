<script setup lang="ts">
import type { UserQuestionAnswer } from '@buddy-shared/questions/userQuestionApi'
import type { UserQuestionFormDefinition } from '../../state/runs/userQuestionInteraction'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { validateUserQuestionResponse } from '@buddy-shared/questions/userQuestionApi'
import { ChatHelp20Regular, ChevronDown16Regular, ChevronLeft16Regular, ChevronRight16Regular } from '@vicons/fluent'
import { NButton, NTooltip } from 'naive-ui'
import { computed, useId, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { BuddyAvatar, useBuddyIdentity } from '@/modules/buddies'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useChatBuddyId } from '../transcript/chatBuddyIdentity'
import BuddyQuestionForm from './BuddyQuestionForm.vue'
import BuddyQuestionPrompt from './BuddyQuestionPrompt.vue'

const props = defineProps<{
  request: UserQuestionFormDefinition
  showAuthor?: boolean
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
const buddyId = useChatBuddyId(() => props.request.runId, '')
const buddy = useBuddyIdentity(buddyId)
const buddyName = computed(() => buddy.value?.name ?? props.request.buddyName)
const buttonTheme = {
  borderRadiusSmall: 'var(--buddy-radius-micro)',
  fontSizeSmall: 'var(--buddy-chat-meta-font-size)',
}
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
  <article class="buddy-user-question-card flex min-h-0 min-w-0 flex-col border-1 border-solid border-border rounded-control bg-raised font-sans" :data-request-id="request.id" :data-buddy-id="buddyId || undefined" data-status="pending" :aria-busy="busy">
    <header class="flex min-w-0 shrink-0 gap-2.5 px-4" :class="expanded ? 'items-start pb-2 pt-3' : 'items-center py-2'">
      <NTooltip v-if="buddyId" placement="top-start">
        <template #trigger>
          <BuddyAvatar :buddy-id="buddyId" :src="buddy?.avatar" :alt="buddyName" class="size-7" />
        </template>
        {{ buddyName }}
      </NTooltip>
      <DesktopIcon v-else :component="ChatHelp20Regular" :size="24" class="shrink-0 text-muted" :aria-label="buddyName" />
      <strong v-if="expanded && (showAuthor || !buddyId)" class="max-w-24 truncate pt-1 text-[length:var(--buddy-chat-caption-font-size)] font-500 text-muted">{{ buddyName }}</strong>
      <BuddyQuestionPrompt v-if="expanded && activeField" :id="`${id}-prompt`" :key="activeField.question.id" class="question-prompt max-h-[min(18cqh,10rem)] min-w-0 flex-1 overflow-y-auto overscroll-contain" tabindex="0" prominent :content="activeField.question.question" :language="language" :position="activeIndex + 1" :total="fields.length" :multiple="activeField.question.kind === 'multiple'">
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
      </BuddyQuestionPrompt>
      <button v-else type="button" class="question-preview min-w-0 flex flex-1 items-center gap-2 self-center text-left text-[length:var(--buddy-chat-meta-font-size)]" @click="emit('toggle')">
        <strong class="max-w-24 truncate font-500">{{ buddyName }}</strong>
        <span class="min-w-0 flex-1 truncate text-muted">{{ activeField?.question.question }}</span>
        <span v-if="fields.length > 1" class="shrink-0 text-muted">{{ t('questions.count', { count: fields.length }) }}</span>
      </button>
      <NButton :id="`${id}-heading`" class="question-heading buddy-icon-button shrink-0" size="tiny" quaternary :aria-expanded="expanded" :aria-controls="id" :aria-label="`${t(expanded ? 'desktop.chat.collapseUserMessage' : 'desktop.chat.expandUserMessage')} — ${buddyName}`" @click="emit('toggle')">
        <DesktopIcon :component="expanded ? ChevronDown16Regular : ChevronRight16Regular" :size="16" aria-hidden="true" />
      </NButton>
      <slot name="navigation" />
    </header>
    <template v-if="expanded">
      <div :id="id" ref="body" class="question-body min-h-0 min-w-0 flex-auto overflow-y-auto overscroll-contain px-4 pb-3 pt-1" role="region" tabindex="0" :aria-labelledby="`${id}-prompt`">
        <BuddyQuestionForm v-if="activeField" :question="activeField.question" :answer="activeField.answer" :language="language" :disabled="busy || !ready" @change="emit('change', $event)" />
      </div>
      <footer class="question-actions shrink-0 px-4 pb-3">
        <p v-if="error" role="alert" class="m-0 mb-2 text-sm text-danger">
          {{ t('questions.submitFailed') }}
        </p>
        <div class="flex items-center justify-end gap-2">
          <NButton size="small" quaternary :theme-overrides="buttonTheme" :disabled="busy || !ready" @click="emit('resolve', false)">
            {{ t('questions.decline') }}
          </NButton>
          <NButton size="small" type="primary" :theme-overrides="buttonTheme" :loading="busy" :disabled="!canSubmit" @click="emit('resolve', true)">
            {{ t('questions.submit') }}
          </NButton>
        </div>
      </footer>
    </template>
  </article>
</template>

<style scoped lang="scss">
.question-body:focus-visible,
.question-prompt:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: -2px;
}

.question-preview {
  cursor: pointer;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }
}
</style>
