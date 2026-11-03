<script setup lang="ts">
import { provideChatTranscriptRowState } from './chatTranscriptPresentation'

const props = defineProps<{ rowKey: string }>()
provideChatTranscriptRowState(() => props.rowKey)
</script>

<template>
  <div class="buddy-chat-virtual-row absolute left-0 top-0 w-full min-w-0" :data-virtual-row-key="rowKey">
    <slot />
  </div>
</template>
