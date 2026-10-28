<script setup lang="ts">
import type { LocalExecutionInputReceipt } from '@buddy-shared/executions/executionInputReceipt'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import BuddyChatUserBubble from './BuddyChatUserBubble.vue'

const props = defineProps<{ input: LocalExecutionInputReceipt, language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <article
    class="buddy-chat-execution-input grid min-w-0 pb-[var(--buddy-chat-gap-turn)]"
    :data-execution-input-id="input.messageId"
    :data-run-id="input.runId"
    :data-root-run-id="input.rootRunId"
  >
    <div class="grid w-fit max-w-[min(42rem,_92%)] min-w-0 justify-self-end gap-2">
      <BuddyChatUserBubble class="buddy-chat-execution-input__bubble" :language="language">
        <p class="m-0 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {{ input.text }}
        </p>
      </BuddyChatUserBubble>
      <p
        v-if="input.state === 'undelivered'"
        class="m-0 justify-self-end text-[length:var(--buddy-chat-meta-font-size)] leading-[var(--buddy-chat-meta-line-height)] text-warning"
        role="status"
      >
        {{ t('desktop.chat.executionInputUndelivered') }}
      </p>
    </div>
  </article>
</template>

<style scoped lang="scss">
.buddy-chat-execution-input__bubble {
  min-width: 0;
  max-width: 100%;
  border-radius: 0.9rem;
  background: var(--buddy-user-message-surface);
  color: var(--buddy-text-primary);
  padding: 0.75rem 0.95rem;
  font-family: var(--buddy-font-body);
  font-size: var(--buddy-chat-user-font-size);
  line-height: var(--buddy-chat-final-line-height);
}
</style>
