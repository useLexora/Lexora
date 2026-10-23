<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { ChatAgentTurnNode } from '../../model/transcript/chatAgentTurn'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronDown16Regular, ChevronRight16Regular } from '@vicons/fluent'
import { NButton, NSpin } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useExecutionTree } from '../../state/runs/chatExecutionContext'
import { useExecutionDetail } from '../../state/runs/useExecutionDetail'
import BuddyExecutionInputs from '../executions/BuddyExecutionInputs.vue'
import { executionLabels } from '../executions/executionLabels'
import BuddyChatAgentTurnFlow from './BuddyChatAgentTurnFlow.vue'
import BuddyChatTokenUsage from './BuddyChatTokenUsage.vue'
import BuddyChatTurnChanges from './BuddyChatTurnChanges.vue'
import BuddyChatTurnOutputs from './BuddyChatTurnOutputs.vue'

const props = defineProps<{ runId: string, language: BuddyLocale }>()
const emit = defineEmits<{ openArtifact: [artifact: LocalArtifact], openChanges: [id: string] }>()
const expanded = shallowRef(false)
const tree = useExecutionTree()
const target = computed(() => {
  const record = tree?.groups.value.byRun.get(props.runId)
  return record && tree ? tree.target(record) : null
})
const state = useExecutionDetail(target, expanded)
const labels = computed(() => executionLabels(props.language))
const nodes = computed(() => state.rows.value.flatMap<ChatAgentTurnNode>(row => row.kind === 'agent-turn' ? row.turn.nodes.filter(node => node.kind !== 'text') : row.kind === 'activity-flow' ? row.nodes : []))
</script>

<template>
  <div class="grid min-w-0 gap-2" data-testid="actor-process" :data-execution-id="runId">
    <NButton quaternary size="tiny" class="justify-self-start text-muted" :aria-expanded="expanded" @click="expanded = !expanded">
      <template #icon>
        <DesktopIcon :component="expanded ? ChevronDown16Regular : ChevronRight16Regular" :size="16" />
      </template>
      {{ labels.process }}
    </NButton>
    <div v-if="expanded" class="grid min-w-0 gap-3 border-l-1 border-l-solid border-l-border pl-3">
      <NSpin v-if="state.loading.value" :size="16" />
      <p v-if="state.failed.value" role="alert" class="m-0 text-danger text-[12px]">
        {{ labels.loadFailed }} <NButton text @click="state.refresh">
          {{ labels.reload }}
        </NButton>
      </p>
      <BuddyChatAgentTurnFlow v-if="nodes.length" :nodes="nodes" :language="language" :failure-detail-text="null" />
      <BuddyChatTokenUsage v-if="state.detail.value?.usage" :usage="state.detail.value.usage" :language="language" />
      <template v-if="state.detail.value">
        <BuddyChatTurnOutputs v-if="state.detail.value.artifacts.length" :artifacts="state.detail.value.artifacts" :language="language" @open-artifact="emit('openArtifact', $event)" />
        <BuddyChatTurnChanges v-if="state.detail.value.changes" :change-set="state.detail.value.changes" :language="language" @open-changes="emit('openChanges', $event)" />
        <BuddyExecutionInputs :inputs="state.detail.value.inputs" :language="language" />
      </template>
      <p v-if="state.detail.value?.execution.cleanup === 'degraded'" role="alert" class="text-warning text-[12px]">
        {{ labels.cleanup }}
      </p>
    </div>
  </div>
</template>
