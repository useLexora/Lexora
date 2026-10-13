<script setup lang="ts">
import type { LocalExecutionDetail } from '@buddy-shared/executions/executionPresentationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { executionLabels } from './executionLabels'

const props = defineProps<{ inputs: LocalExecutionDetail['inputs'], language: BuddyLocale }>()
const labels = computed(() => executionLabels(props.language))
</script>

<template>
  <section v-if="inputs.length" class="grid min-w-0 gap-3 border-t-1 border-t-solid border-t-border pt-3" data-testid="execution-inputs">
    <div v-for="input in inputs" :key="input.messageId" class="grid min-w-0 gap-1">
      <span class="text-[11px]" :class="input.state === 'undelivered' ? 'text-warning' : 'text-muted'" role="status">{{ input.kind === 'answer' ? labels.reply : labels.actorSupplement }} · {{ labels[input.state] }}</span>
      <p class="m-0 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-fg text-[13px]">
        {{ input.text }}
      </p>
    </div>
  </section>
</template>
