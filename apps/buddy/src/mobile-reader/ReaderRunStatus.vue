<script setup lang="ts">
import type { ReaderEntry } from './readerBridge'
import type { ReaderOutput, ReaderSend } from './readerProtocol'
import { provideChatTranscriptRowState } from '../modules/tasks/reader'
import ReaderArtifacts from './ReaderArtifacts.vue'
import ReaderBranchNavigation from './ReaderBranchNavigation.vue'
import { useReaderStrings } from './readerStrings'
import { useReaderTurnBranch } from './useReaderBranches'

const props = defineProps<{ status: NonNullable<ReaderEntry['runStatus']>, rowId: string, output?: ReaderOutput, send: ReaderSend }>()
defineEmits<{ interact: [] }>()
provideChatTranscriptRowState(() => props.rowId)
const labels = useReaderStrings()
const navigator = useReaderTurnBranch(() => props.status.run.id)
const statuses = { failed: 'failed', cancelled: 'stopped', completed: 'noReply', queued: 'queued', running: 'running' } as const
</script>

<template>
  <p class="message-meta" role="status">
    {{ labels[statuses[status.run.status]] }}
  </p>
  <template v-if="!status.hasReply">
    <ReaderArtifacts :run-id="status.run.id" :output="output" :send="send" @interact="$emit('interact')" />
    <ReaderBranchNavigation v-if="navigator" :navigator="navigator" @branch="send({ action: 'branch', branchId: $event })" />
  </template>
</template>
