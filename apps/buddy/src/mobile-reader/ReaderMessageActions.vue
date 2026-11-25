<script setup lang="ts">
import type { ReaderMessage } from './readerBridge'
import { MoreHorizontal20Regular } from '@vicons/fluent'
import { computed } from 'vue'
import DesktopIcon from '../shared/ui/icon/DesktopIcon.vue'
import ReaderBranchNavigation from './ReaderBranchNavigation.vue'
import { useReaderStrings } from './readerStrings'
import { useReaderBranch } from './useReaderBranches'
import { useReaderCopyFeedback } from './useReaderCopyFeedback'

const props = defineProps<{ message: ReaderMessage, language?: string }>()
const emit = defineEmits<{ copy: [], more: [event: MouseEvent], edit: [], branch: [id: string] }>()
const copiedMessageId = useReaderCopyFeedback()
const copied = computed(() => copiedMessageId.value === props.message.id)
const labels = useReaderStrings()
const navigator = useReaderBranch(() => props.message)
const timestamp = computed(() => {
  const date = props.message.createdAt ? new Date(props.message.createdAt) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString(props.language === 'en' ? 'en-GB' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
})
</script>

<template>
  <div class="message-actions" :aria-label="labels.messageActions">
    <ReaderBranchNavigation v-if="message.returnToComposer === undefined && navigator" :navigator="navigator" @branch="emit('branch', $event)" />
    <time v-if="message.role === 'user' && timestamp" class="message-time" :datetime="message.createdAt ?? undefined">{{ timestamp }}</time>
    <button v-if="message.text && message.canCopy && (!message.needsDetail || message.hasDetail)" :aria-label="copied ? labels.copied : labels.copyMessage" :class="{ 'is-copied': copied }" @click="emit('copy')">
      <DesktopIcon :name="copied ? 'messageCopied' : 'messageCopy'" :size="15" />
    </button>
    <button v-if="message.returnToComposer" class="return-to-composer" @click="emit('edit')">
      {{ labels.returnToComposer }}
    </button>
    <button v-else-if="message.returnToComposer === undefined && message.canEdit" :aria-label="labels.edit" @click="emit('edit')">
      <DesktopIcon name="edit" :size="15" />
    </button>
    <button v-if="message.returnToComposer === undefined && (message.canRegenerate || message.canFollowup)" :aria-label="labels.more" @click="emit('more', $event)">
      <MoreHorizontal20Regular class="reader-icon" />
    </button>

    <time v-if="message.role === 'assistant' && timestamp" class="message-time" :datetime="message.createdAt ?? undefined">{{ timestamp }}</time>
  </div>
</template>

<style scoped lang="scss">
.message-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  min-height: 44px;
  column-gap: 2px;
  margin-top: 4px;
  color: var(--reader-muted);
}
.user .message-actions {
  order: 2;
  justify-content: flex-end;
  width: 100%;
}
.message-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 32px;
  min-height: 44px;
  padding: 6px;
  color: inherit;
  border-radius: 6px;
}
.message-actions .return-to-composer {
  width: auto;
  flex-basis: auto;
  padding-inline: 8px;
  font: inherit;
}
.message-actions button:active {
  background: var(--reader-user);
}
.message-actions .is-copied {
  color: var(--buddy-status-success-text);
}
.message-actions .reader-icon {
  width: 15px;
  height: 15px;
}
.message-actions .message-time {
  padding-inline: 4px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
</style>
