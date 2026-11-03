<script setup lang="ts">
import type { UserQuestion, UserQuestionAnswer } from '@buddy-shared/questions/userQuestionApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NInput } from 'naive-ui'
import { computed, shallowRef, useId, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ question: UserQuestion, answer: UserQuestionAnswer, language: BuddyLocale, disabled: boolean }>()
const emit = defineEmits<{ change: [answer: UserQuestionAnswer] }>()
const { t } = useBuddyI18n(() => props.language)
const id = useId()
const customSelected = shallowRef(false)
const customInput = useTemplateRef<InstanceType<typeof NInput>>('customInput')
const isCustom = computed(() => !props.answer.selectedOptionIds.length && (customSelected.value || !!props.answer.text))
function updateCustom(text: string) {
  customSelected.value = true
  emit('change', { ...props.answer, selectedOptionIds: [], text })
}
function chooseCustom() {
  updateCustom(props.answer.text)
  customInput.value?.focus()
}
function choose(optionId: string, checked: boolean) {
  customSelected.value = false
  const selectedOptionIds = props.question.kind === 'single'
    ? [optionId]
    : checked ? [...props.answer.selectedOptionIds, optionId] : props.answer.selectedOptionIds.filter(value => value !== optionId)
  emit('change', { ...props.answer, selectedOptionIds })
}
</script>

<template>
  <fieldset class="question-form m-0 min-w-0 border-0 p-0" :disabled="disabled">
    <legend :id="id" class="mb-2.5 w-full p-0 text-fg text-sm font-600 leading-relaxed [overflow-wrap:anywhere]">
      {{ question.question }}
      <span v-if="question.kind === 'multiple'" class="ml-2 whitespace-nowrap text-muted text-xs font-normal">{{ t('questions.multiple') }}</span>
    </legend>
    <div v-if="question.options.length" class="flex flex-col gap-2">
      <label v-for="option in question.options" :key="option.id" class="question-option flex items-start gap-2.5 rounded-md border-1 border-solid border-border px-3 py-2" :class="{ selected: answer.selectedOptionIds.includes(option.id) }">
        <input
          class="mt-1 shrink-0"
          :type="question.kind === 'multiple' ? 'checkbox' : 'radio'"
          :name="id"
          :checked="answer.selectedOptionIds.includes(option.id)"
          @change="choose(option.id, ($event.target as HTMLInputElement).checked)"
        >
        <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <span class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span class="text-fg text-sm font-500">{{ option.label }}</span>
            <span v-if="option.recommended" class="text-accent-text text-xs">{{ t('questions.recommended') }}</span>
          </span>
          <span v-if="option.description" class="mt-1 block text-muted text-[13px] leading-relaxed">{{ option.description }}</span>
        </span>
      </label>
      <div v-if="question.kind === 'single'" class="question-option flex items-start gap-2.5 rounded-md border-1 border-solid border-border px-3 py-2" :class="{ selected: isCustom }">
        <input type="radio" class="mt-1 shrink-0" :name="id" :aria-label="t('questions.custom')" :checked="isCustom" @change="chooseCustom()">
        <NInput
          ref="customInput"
          class="min-w-0 flex-1"
          type="textarea"
          size="small"
          :bordered="false"
          :theme-overrides="{ color: 'transparent', colorFocus: 'transparent', paddingSmall: '0', boxShadowFocus: 'none' }"
          :value="isCustom ? answer.text : ''"
          :disabled="disabled"
          :autosize="{ minRows: 1, maxRows: 6 }"
          :maxlength="8000"
          :placeholder="t('questions.customPlaceholder')"
          :input-props="{ 'aria-label': `${question.question} — ${t('questions.custom')}` }"
          @update:value="updateCustom"
        />
      </div>
    </div>
    <NInput
      v-if="question.kind !== 'single' || answer.selectedOptionIds.length"
      :class="{ 'mt-3': question.options.length }"
      type="textarea"
      :value="answer.text"
      :disabled="disabled"
      :autosize="{ minRows: question.kind === 'text' ? 2 : 1, maxRows: 6 }"
      :maxlength="8000"
      :placeholder="t(question.kind === 'text' ? 'questions.textPlaceholder' : question.kind === 'multiple' ? 'questions.otherPlaceholder' : 'questions.notesPlaceholder')"
      :input-props="{ 'aria-label': `${question.question} — ${t(question.kind === 'text' ? 'questions.yourAnswer' : 'questions.notes')}` }"
      @update:value="emit('change', { ...answer, text: $event })"
    />
  </fieldset>
</template>

<style scoped lang="scss">
.question-option {
  cursor: pointer;
  transition: background-color 120ms, border-color 120ms;

  input {
    accent-color: var(--buddy-accent-solid);
  }

  &:hover {
    background: var(--buddy-surface-raised);
  }

  &:focus-within {
    outline: 2px solid var(--buddy-accent-solid);
    outline-offset: 2px;
  }

  &.selected {
    border-color: var(--buddy-accent-solid);
    background: var(--buddy-accent-surface-subtle);
  }
}
.question-form:disabled .question-option {
  cursor: default;
}
</style>
