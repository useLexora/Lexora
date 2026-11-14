<script setup lang="ts">
import type { DesktopTerminalShell } from '../modules/tasks/contracts'
import { computed } from 'vue'
import { projectDesktopTerminalTranscript } from '../modules/tasks/reader'

const props = defineProps<{ command: string, output: string | null, shell: DesktopTerminalShell }>()
const transcript = computed(() => projectDesktopTerminalTranscript(props))
</script>

<template>
  <pre class="reader-terminal"><code>{{ transcript.text }}</code></pre>
</template>

<style scoped>
.reader-terminal { margin: 0; padding: 10px; max-height: 16rem; overflow: auto; font: 12px/1.65 monospace; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--buddy-chat-code-color); background: var(--buddy-terminal-background); }
</style>
