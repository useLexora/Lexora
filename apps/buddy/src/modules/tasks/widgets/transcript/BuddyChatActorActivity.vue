<script setup lang="ts">
import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Clock20Regular } from '@vicons/fluent'
import { computed } from 'vue'
import { useBuddyIdentity } from '@/modules/buddies'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { executionNeedsAttention } from '../../model/executions/executionCanvas'
import { executionLabels } from '../executions/executionLabels'
import { executionStatus } from '../executions/executionPresentation'
import BuddyChatActivityStatus from './BuddyChatActivityStatus.vue'

const props = defineProps<{ execution: LocalExecution, language: BuddyLocale, now: number, stopping?: boolean }>()
const identity = useBuddyIdentity(computed(() => props.execution.buddyId))
const isStopping = computed(() => props.stopping || props.execution.stopping)
const active = computed(() => !isStopping.value && !props.execution.waitingFor && !props.execution.progress?.retry
  && props.execution.status === 'running' && ['working', 'preparing'].includes(props.execution.phase))
const label = computed(() => `${identity.value?.name ?? props.execution.buddyName} · ${isStopping.value
  ? executionLabels(props.language).stopping
  : executionStatus(props.execution, props.language, props.now)}`)
const questions = computed(() => props.execution.questions.filter(question => question.open && question.audience === 'user'))
const replyHint = computed(() => props.language === 'en-US' ? `Reply with @${identity.value?.name ?? props.execution.buddyName} in the composer below` : `在下方输入框 @${identity.value?.name ?? props.execution.buddyName} 回复`)
</script>

<template>
  <div class="grid min-w-0 gap-2" :data-actor-activity="execution.runId">
    <BuddyChatActivityStatus :label="label" :active="active" :warning="executionNeedsAttention(execution)">
      <template #icon>
        <DesktopIcon :component="Clock20Regular" aria-hidden="true" />
      </template>
    </BuddyChatActivityStatus>
    <div v-if="questions.length" class="grid gap-2 ml-5 mb-3">
      <p v-for="question in questions" :key="question.questionId" :data-question-id="question.questionId" class="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-fg">
        {{ question.text }}
      </p>
      <span class="text-[12px] text-muted">{{ replyHint }}</span>
    </div>
  </div>
</template>
