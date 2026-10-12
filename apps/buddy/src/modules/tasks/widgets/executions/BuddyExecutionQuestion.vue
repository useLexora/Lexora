<script setup lang="ts">
import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { MAX_BUDDY_MESSAGE_TEXT_LENGTH } from '@buddy-shared/conversation/buddyMessageContent'
import { NButton, NInput } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { executionLabels } from './executionLabels'

const props = defineProps<{
  question: LocalExecution['questions'][number]
  language: BuddyLocale
  enabled: boolean
  reply: (questionId: string, text: string) => Promise<void>
}>()
const labels = computed(() => executionLabels(props.language))
const text = shallowRef('')
const sending = shallowRef(false)
const failed = shallowRef(false)
async function submit() {
  if (!props.enabled || !props.question.open || props.question.audience !== 'user' || !text.value.trim() || sending.value)
    return
  sending.value = true
  failed.value = false
  try {
    await props.reply(props.question.questionId, text.value.trim())
    text.value = ''
  }
  catch {
    failed.value = true
  }
  finally {
    sending.value = false
  }
}
</script>

<template>
  <section class="grid grid-cols-1 gap-2 min-w-0" :data-question-id="question.questionId">
    <p class="m-0 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-fg">
      {{ question.text }}
    </p>
    <form v-if="question.open && question.audience === 'user'" class="grid grid-cols-1 min-w-0 gap-2" @submit.prevent="submit">
      <NInput v-model:value="text" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" :maxlength="MAX_BUDDY_MESSAGE_TEXT_LENGTH" :placeholder="labels.answerPlaceholder" :aria-label="labels.answerPlaceholder" :disabled="!enabled || sending" />
      <NButton class="justify-self-end" size="small" :loading="sending" :disabled="!enabled || !text.trim()" attr-type="submit">
        {{ labels.reply }}
      </NButton>
    </form>
    <span v-else class="text-muted text-[12px]">{{ question.open ? labels.waitingCaller : question.answered ? labels.answered : labels.questionClosed }}</span>
    <p v-if="failed" role="alert" class="m-0 text-danger text-[12px]">
      {{ labels.actionFailed }}
    </p>
  </section>
</template>
