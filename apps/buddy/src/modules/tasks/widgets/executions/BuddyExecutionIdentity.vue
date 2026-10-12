<script setup lang="ts">
import type { LocalExecution } from '@buddy-shared/executions/executionPresentationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { executionDisplayName } from '../../model/executions/executionDisplayName'
import { useExecutionTree } from '../../state/runs/chatExecutionContext'
import { executionLabels } from './executionLabels'

const props = defineProps<{ execution: LocalExecution, language: BuddyLocale }>()
const tree = useExecutionTree()
const labels = computed(() => executionLabels(props.language))
const caller = computed(() => tree?.records.value.find(record => record.runId === props.execution.parentRunId))
</script>

<template>
  <p class="m-0 text-muted text-[12px] break-words" data-testid="execution-identity">
    {{ labels.executor }}{{ executionDisplayName(execution) }}<template v-if="caller">
      · {{ labels.caller }}{{ executionDisplayName(caller) }}
    </template>
  </p>
</template>
