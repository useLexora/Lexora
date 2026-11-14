<script setup lang="ts">
import type { ReaderMessage } from './readerBridge'
import { MoreHorizontal20Regular } from '@vicons/fluent'
import { computed } from 'vue'
import DesktopIcon from '../shared/ui/icon/DesktopIcon.vue'
import { useReaderStrings } from './readerStrings'
import { useReaderCopyFeedback } from './useReaderCopyFeedback'

const props = defineProps<{ message: ReaderMessage, language?: string }>()
const emit = defineEmits<{ copy: [], more: [], followup: [] }>()
const copiedMessageId = useReaderCopyFeedback()
const copied = computed(() => copiedMessageId.value === props.message.id)
const labels = useReaderStrings()
const timestamp = computed(() => {
  const date = props.message.createdAt ? new Date(props.message.createdAt) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString(props.language === 'en' ? 'en-GB' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
})
</script>

<template>
  <div class="message-actions" :aria-label="labels.messageActions">
    <time v-if="message.role === 'user' && timestamp" class="message-time" :datetime="message.createdAt ?? undefined">{{ timestamp }}</time>
    <button v-if="message.text && message.canCopy && (!message.needsDetail || message.hasDetail)" :aria-label="copied ? labels.copied : labels.copyMessage" :class="{ 'is-copied': copied }" @click="emit('copy')">
      <DesktopIcon :name="copied ? 'messageCopied' : 'messageCopy'" :size="18" />
    </button>
    <button v-if="message.canFollowup" :aria-label="labels.branch" @click="emit('followup')">
      <DesktopIcon name="messageBranch" :size="18" />
    </button>
    <button :aria-label="labels.more" @click="emit('more')">
      <MoreHorizontal20Regular class="reader-icon" />
    </button>
    <time v-if="message.role === 'assistant' && timestamp" class="message-time" :datetime="message.createdAt ?? undefined">{{ timestamp }}</time>
  </div>
</template>
