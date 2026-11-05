<script setup lang="ts">
import type { UserQuestion, UserQuestionAnswer } from '@buddy-shared/questions/userQuestionApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NCheckbox, NInput, NRadio } from 'naive-ui'
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ question: UserQuestion, answer: UserQuestionAnswer, language: BuddyLocale, disabled: boolean }>()
const emit = defineEmits<{ change: [answer: UserQuestionAnswer] }>()
const { t } = useBuddyI18n(() => props.language)
const id = useId()
const customSelected = shallowRef(false)
watch(() => props.question.id, () => {
  customSelected.value = false
})
const customInput = useTemplateRef<InstanceType<typeof NInput>>('customInput')
const isCustom = computed(() => !props.answer.selectedOptionIds.length && (customSelected.value || !!props.answer.text))
const inputTheme = {
  border: '1px solid var(--buddy-border-subtle)',
  borderRadius: 'var(--buddy-composer-control-radius)',
  fontSizeMedium: 'var(--buddy-chat-user-font-size)',
  fontSizeSmall: 'var(--buddy-chat-user-font-size)',
  lineHeightTextarea: 'var(--buddy-chat-user-line-height)',
  heightMedium: 'calc(var(--buddy-chat-user-font-size) * 1.5 + 22px)',
}
const customInputTheme = {
  ...inputTheme,
  fontSizeSmall: 'var(--buddy-chat-meta-font-size)',
  lineHeightTextarea: 'var(--buddy-chat-meta-line-height)',
  color: 'transparent',
  colorHover: 'transparent',
  colorFocus: 'transparent',
  colorDisabled: 'transparent',
  paddingSmall: '0',
  heightSmall: 'calc(var(--buddy-chat-meta-font-size) * var(--buddy-chat-meta-line-height))',
  boxShadowFocus: 'none',
}
const choiceTheme = {
  fontSizeSmall: 'var(--buddy-chat-meta-font-size)',
  labelLineHeight: 'var(--buddy-chat-meta-line-height)',
  labelPadding: '0 0 0 8px',
}
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
  <fieldset class="question-form m-0 min-w-0 border-0 p-0 disabled:opacity-60" :disabled="disabled" :aria-label="question.question">
    <div class="question-answers grid gap-3">
      <div v-if="question.options.length" class="flex min-w-0 flex-col gap-1.5">
        <component
          :is="question.kind === 'multiple' ? NCheckbox : NRadio"
          v-for="option in question.options"
          :key="option.id"
          class="question-option relative isolate m-0 min-h-9 min-w-0 w-full border-1 border-solid border-transparent rounded-control px-2.5 py-1.5"
          size="small"
          :class="{ selected: answer.selectedOptionIds.includes(option.id) }"
          :name="id"
          :value="option.id"
          :checked="answer.selectedOptionIds.includes(option.id)"
          :disabled="disabled"
          :aria-disabled="disabled || undefined"
          :theme-overrides="choiceTheme"
          @update:checked="choose(option.id, $event)"
        >
          <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="text-strong text-[length:var(--buddy-chat-user-font-size)] font-500">{{ option.label }}</span>
            <span v-if="option.recommended" class="rounded-micro bg-accent-subtle px-1.5 py-0.5 text-[length:var(--buddy-chat-caption-font-size)] text-accent-text leading-[var(--buddy-chat-caption-line-height)]">{{ t('questions.recommended') }}</span>
          </span>
          <span v-if="option.description" class="mt-0.5 block text-muted text-[length:var(--buddy-chat-meta-font-size)] leading-[var(--buddy-chat-meta-line-height)]">{{ option.description }}</span>
        </component>
        <div v-if="question.kind === 'single'" class="question-option relative isolate min-h-9 flex items-start gap-2 border-1 border-solid border-transparent rounded-control px-2.5 py-1.5" :class="{ selected: isCustom }">
          <NRadio class="shrink-0" size="small" :name="id" :checked="isCustom" :disabled="disabled" :theme-overrides="{ ...choiceTheme, labelPadding: '0' }" @update:checked="chooseCustom()">
            <span class="sr-only">{{ t('questions.custom') }}</span>
          </NRadio>
          <NInput
            ref="customInput"
            class="min-w-0 flex-1"
            type="textarea"
            size="small"
            :bordered="false"
            :theme-overrides="customInputTheme"
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
      <div v-if="question.kind !== 'single' || answer.selectedOptionIds.length" class="grid gap-2">
        <label v-if="question.options.length" :for="`${id}-details`" class="text-[length:var(--buddy-chat-caption-font-size)] text-muted leading-[var(--buddy-chat-caption-line-height)]">{{ t('questions.notes') }}</label>
        <NInput
          :theme-overrides="{ ...inputTheme, paddingMedium: '0 12px' }"
          type="textarea"
          :value="answer.text"
          :disabled="disabled"
          :autosize="{ minRows: question.kind === 'text' ? 2 : 1, maxRows: 6 }"
          :maxlength="8000"
          :placeholder="t(question.kind === 'text' ? 'questions.textPlaceholder' : question.kind === 'multiple' ? 'questions.otherPlaceholder' : 'questions.notesPlaceholder')"
          :input-props="{ 'id': `${id}-details`, 'aria-label': `${question.question} — ${t(question.kind === 'text' ? 'questions.yourAnswer' : 'questions.notes')}` }"
          @update:value="emit('change', { ...answer, text: $event })"
        />
      </div>
    </div>
  </fieldset>
</template>

<style scoped lang="scss">
.question-option {
  --question-paper-border: color-mix(in srgb, var(--buddy-text-secondary) 32%, var(--buddy-surface-raised));
  --question-paper-surface: var(--buddy-surface-raised);

  &::before,
  &::after {
    content: '';
    position: absolute;
    pointer-events: none;
    z-index: -1;
  }

  &::before {
    inset: 0;
    border: 1px solid var(--question-paper-border);
    border-radius: 180px 6px 160px 5px / 6px 120px 5px 130px;
    background: var(--question-paper-surface);
    transition: background-color 120ms, border-color 120ms;
  }

  &::after {
    inset: 2px 2px 1px 3px;
    border: 1px solid var(--question-paper-border);
    border-radius: 160px 5px 190px 6px / 5px 110px 7px 120px;
    opacity: 0.2;
    transform: rotate(-0.2deg);
  }

  &:nth-child(even)::before {
    border-radius: 6px 180px 5px 160px / 120px 6px 130px 5px;
  }

  &.selected {
    --question-paper-border: var(--buddy-accent-border);
    --question-paper-surface: var(--buddy-accent-surface-subtle);
  }

  &:has(textarea:focus-visible) {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }
}

.question-form {
  &:not(:disabled) .question-option:hover {
    --question-paper-surface: var(--buddy-state-hover);
  }

  &:not(:disabled) .question-option.selected:hover {
    --question-paper-surface: var(--buddy-accent-surface-hover);
  }

  :deep(.n-radio__label),
  :deep(.n-checkbox__label) {
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
  }

  :deep(.n-input__textarea-el) {
    font-family: var(--buddy-font-body);
  }
}

@media (prefers-reduced-motion: reduce) {
  .question-option::before {
    transition: none;
  }
}
</style>
