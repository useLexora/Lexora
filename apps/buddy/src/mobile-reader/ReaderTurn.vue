<script setup lang="ts">
import type { ChatAgentTurn } from '../modules/tasks/contracts'
import type { ReaderMessage } from './readerBridge'
import type { ReaderSend } from './readerProtocol'
import { provideChatTranscriptRowState } from '../modules/tasks/reader'
import ReaderTurnContent from './ReaderTurnContent.vue'

const props = defineProps<{ turn: ChatAgentTurn, buddyId?: string, messages: ReaderMessage[], dark: boolean, language: string, send: ReaderSend }>()
defineEmits<{ interact: [] }>()
provideChatTranscriptRowState(() => `turn:${props.turn.runId}`)
</script>

<template>
  <ReaderTurnContent v-bind="props" @interact="$emit('interact')" />
</template>
