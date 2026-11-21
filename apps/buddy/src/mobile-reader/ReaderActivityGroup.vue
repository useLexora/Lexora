<script setup lang="ts">
import type { ChatAgentActivitySummary } from '../modules/tasks/reader'
import type { ReaderSend, ReaderWireEntry } from './readerProtocol'
import { computed } from 'vue'
import { BuddyChatActivityGroup, provideChatTranscriptRowState } from '../modules/tasks/reader'
import ReaderActivitySteps from './ReaderActivitySteps.vue'

const props = defineProps<{
  group: NonNullable<ReaderWireEntry['activityGroup']>
  steps?: ReaderWireEntry['steps']
  rowId: string
  language: string
  send: ReaderSend
}>()
provideChatTranscriptRowState(() => props.rowId)
const icons = { command: 'terminal', read: 'file', edit: 'edit', create: 'create', other: 'tool' } as const
const summary = computed<ChatAgentActivitySummary>(() => {
  const group = props.group
  const category = group.counts.length === 1 ? group.counts[0]?.category : undefined
  return {
    id: group.id,
    kind: 'activity-group',
    toolCount: group.toolCount,
    issueCount: group.failedCount,
    approvalCount: 0,
    reasoningCount: group.reasoningCount,
    status: group.runningCount || group.runningReasoningCount ? 'running' : group.interruptedCount || group.interruptedReasoningCount ? 'interrupted' : 'completed',
    icon: !group.toolCount ? 'reasoning' : category && !group.reasoningCount ? icons[category] : 'activity',
    counts: group.counts.map(count => ({ ...count, files: null })),
  }
})
</script>

<template>
  <BuddyChatActivityGroup :group="summary" :language="language === 'en' ? 'en-US' : 'zh-CN'" :active-label="group.activeToolName">
    <template #steps>
      <ReaderActivitySteps :run-id="group.runId" :group-id="group.id" :steps="steps" :send="send" />
    </template>
  </BuddyChatActivityGroup>
</template>
