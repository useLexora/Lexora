<script setup lang="ts">
import type { ChatAgentActivitySummary } from '../modules/tasks/reader'
import type { ReaderSend, ReaderWireEntry } from './readerProtocol'
import { computed } from 'vue'
import { BuddyChatActivityGroup, provideChatTranscriptRowState } from '../modules/tasks/reader'
import ReaderActivitySteps from './ReaderActivitySteps.vue'
import { useReaderStrings } from './readerStrings'

const props = defineProps<{
  group: NonNullable<ReaderWireEntry['activityGroup']>
  steps?: ReaderWireEntry['steps']
  rowId: string
  owner?: { name?: string }
  historical?: boolean
  language: string
  send: ReaderSend
}>()
provideChatTranscriptRowState(() => props.rowId)
const labels = useReaderStrings()
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
    status: !props.historical && (group.runningCount || group.runningReasoningCount) ? 'running' : group.interruptedCount || group.interruptedReasoningCount ? 'interrupted' : 'completed',
    icon: !group.toolCount ? 'reasoning' : category && !group.reasoningCount ? icons[category] : 'activity',
    counts: group.counts.map(count => ({ ...count, files: null })),
  }
})
</script>

<template>
  <div>
    <span v-if="owner" class="author-name group-owner">{{ owner.name ?? labels.rootActivity }}</span>
    <BuddyChatActivityGroup :group="summary" :language="language === 'en' ? 'en-US' : 'zh-CN'" hide-live-status>
      <template #steps>
        <ReaderActivitySteps :run-id="group.runId" :group-id="group.id" :language="language" :steps="steps" :send="send" />
      </template>
    </BuddyChatActivityGroup>
  </div>
</template>
