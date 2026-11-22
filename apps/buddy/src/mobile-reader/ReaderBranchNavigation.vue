<script setup lang="ts">
import type { ChatMessageBranchNavigator } from '../modules/tasks/reader'
import DesktopIcon from '../shared/ui/icon/DesktopIcon.vue'
import { useReaderStrings } from './readerStrings'

defineProps<{ navigator: ChatMessageBranchNavigator }>()
const emit = defineEmits<{ branch: [id: string] }>()
const labels = useReaderStrings()
</script>

<template>
  <div class="message-branches" role="group" :aria-label="`${labels.branches} ${navigator.index}/${navigator.count}`">
    <button :disabled="!navigator.previousBranchId" :aria-label="labels.previousBranch" @click="navigator.previousBranchId && emit('branch', navigator.previousBranchId)">
      <DesktopIcon name="messageBranchPrevious" :size="14" />
    </button>
    <span>{{ navigator.index }}/{{ navigator.count }}</span>
    <button :disabled="!navigator.nextBranchId" :aria-label="labels.nextBranch" @click="navigator.nextBranchId && emit('branch', navigator.nextBranchId)">
      <DesktopIcon name="messageBranchNext" :size="14" />
    </button>
  </div>
</template>

<style scoped lang="scss">
.message-branches {
  display: inline-flex;
  align-items: center;
  margin-right: 6px;
  color: var(--reader-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.message-branches span {
  min-width: 24px;
  text-align: center;
}
.message-branches button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  flex: 0 0 44px;
  min-height: 44px;
  padding: 6px;
  color: inherit;
  border-radius: 6px;
}
.message-branches button:active {
  background: var(--reader-user);
}
</style>
