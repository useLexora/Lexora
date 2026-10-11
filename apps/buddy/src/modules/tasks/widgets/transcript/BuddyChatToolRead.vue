<script setup lang="ts">
import { computed } from 'vue'
import { presentChatToolRead } from '../../model/transcript/chatToolText'

const props = defineProps<{ output: string, lineStart: number, native: boolean }>()
const content = computed(() => presentChatToolRead(props.output, props.lineStart, props.native))
</script>

<template>
  <div class="buddy-chat-tool-read">
    <div class="flex max-h-60 overflow-auto pt-[4px] pr-0 pb-[8px] pl-0">
      <pre v-if="content.numbers" class="buddy-chat-tool-read__numbers sticky left-0 flex-none py-0 px-[12px] bg-subtle text-muted text-right select-none" aria-hidden="true">{{ content.numbers }}</pre>
      <pre class="buddy-chat-tool-read__content flex-1 pt-0 pr-[12px] pb-0 pl-0 first:pl-[12px] first:whitespace-pre-wrap first:[overflow-wrap:anywhere]"><code>{{ content.content }}</code></pre>
    </div>
    <p v-if="content.notice" class="m-0 pt-[5px] pr-[10px] pb-[8px] pl-[10px] text-muted text-[length:var(--buddy-chat-caption-font-size)] [overflow-wrap:anywhere]">
      {{ content.notice }}
    </p>
  </div>
</template>

<style scoped lang="scss">
pre {
  margin: 0;
  font-family: var(--buddy-font-mono);
  font-size: var(--buddy-chat-code-font-size);
  line-height: var(--buddy-chat-code-line-height);
  tab-size: 2;
}

.buddy-chat-tool-read__numbers {
  min-width: 3ch;
}

.buddy-chat-tool-read__content {
  color: var(--buddy-chat-code-color);
}
</style>
