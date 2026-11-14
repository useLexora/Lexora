<script setup lang="ts">
import type { ReaderMessage } from './readerBridge'
import type { ReaderActionInput, ReaderSend } from './readerProtocol'
import { ChevronRight20Regular, Code20Regular, Copy20Regular, Document20Regular, Edit20Regular, Search20Regular, Toolbox20Regular } from '@vicons/fluent'
import { computed, watch } from 'vue'
import { useReaderStrings } from './readerStrings'

const props = defineProps<{
  message: ReaderMessage
  expanded: boolean
  language: string
  send: ReaderSend
}>()
const emit = defineEmits<{ interact: [], toggle: [] }>()
const labels = useReaderStrings()
const icon = computed(() => {
  switch (props.message.toolName) {
    case 'bash': case 'shell': case 'exec_command': case 'powershell': return Code20Regular
    case 'read': return Document20Regular
    case 'write': case 'edit': return Edit20Regular
    case 'grep': case 'find': case 'search': case 'lexora_tool_search': return Search20Regular
    default: return Toolbox20Regular
  }
})
const outputReady = computed(() => !props.message.needsDetail || props.message.hasDetail)
function action(value: Extract<ReaderActionInput, { action: 'message' | 'detail' | 'followup' | 'copy' | 'resource' }>) {
  emit('interact')
  props.send(value)
}
watch(() => props.expanded, (open) => {
  if (open && props.message.needsDetail && !props.message.hasDetail && !props.message.loading && !props.message.error)
    action({ action: 'detail', id: props.message.id })
}, { immediate: true })
</script>

<template>
  <article class="reader-tool" :class="{ expanded, failed: message.toolError }" :data-message-id="message.id">
    <button class="tool-call-header" :aria-expanded="expanded" @click="emit('interact'); emit('toggle')">
      <component :is="icon" class="reader-icon tool-call-icon" />
      <span class="tool-call-heading">
        <span class="tool-call-title">{{ message.toolTitle }}<span v-if="message.toolName" class="tool-call-name">{{ message.toolName }}</span></span>
        <span v-if="message.toolSummary" class="tool-call-summary">{{ message.toolSummary }}</span>
      </span>
      <span class="tool-call-status">{{ message.toolError ? labels.failed : labels.done }}</span>
      <ChevronRight20Regular class="reader-icon tool-call-chevron" />
    </button>
    <div v-if="expanded" class="tool-call-detail">
      <div v-if="outputReady && message.text" class="tool-output-toolbar">
        <span>{{ labels.callDetails }}</span>
        <button v-if="message.canCopy" :aria-label="labels.copyDetails" @click="action({ action: 'copy', id: message.id, text: message.text })">
          <Copy20Regular class="reader-icon" />
        </button>
      </div>
      <pre v-if="outputReady && message.text" class="tool-output">{{ message.text }}</pre>
      <p v-if="message.loading" class="message-meta" role="status">
        {{ labels.loadingOutput }}
      </p>
      <p v-else-if="message.error" class="message-error">
        {{ message.error }}
      </p>
      <p v-else-if="!message.needsDetail && !message.text" class="message-meta">
        {{ labels.noOutput }}
      </p>
      <p v-if="message.notice" class="message-meta">
        {{ message.notice }}
      </p>
      <button v-if="message.needsDetail && !message.loading && (!message.hasDetail || message.error)" class="tool-detail-action" @click="action({ action: 'detail', id: props.message.id })">
        {{ message.error ? labels.retry : labels.viewOutput }}
      </button>
      <button v-if="message.detailResource && (message.notice || message.error)" class="tool-detail-action" @click="action({ action: 'resource', id: message.id, resourceId: message.detailResource })">
        {{ labels.openFull }}
      </button>
      <button v-for="resource in message.resources" :key="resource.id" class="resource-link" :disabled="!resource.available" @click="action({ action: 'resource', id: message.id, resourceId: resource.id })">
        {{ resource.name }}
      </button>
    </div>
  </article>
</template>
