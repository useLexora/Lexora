<script setup lang="ts">
import type { ReaderMessage } from './readerBridge'
import type { ReaderActionInput, ReaderSend } from './readerProtocol'
import { Document20Regular } from '@vicons/fluent'
import ChatMarkdownBody from '../shared/ui/markdown/ChatMarkdownBody.vue'
import MessageAvatar from './MessageAvatar.vue'
import ReaderMessageActions from './ReaderMessageActions.vue'
import { useReaderStrings } from './readerStrings'

const props = defineProps<{
  message: ReaderMessage
  dark: boolean
  language?: string
  send: ReaderSend
}>()
const emit = defineEmits<{ interact: [] }>()
const labels = useReaderStrings()
function action(value: Extract<ReaderActionInput, { action: 'message' | 'detail' | 'followup' | 'copy' | 'resource' }>) {
  emit('interact')
  props.send(value)
}
function openActions() {
  window.getSelection()?.removeAllRanges()
  action({ action: 'message', id: props.message.id })
}
async function copy(text: string) {
  action({ action: 'copy', id: props.message.id, text })
}
</script>

<template>
  <article class="reader-message" :class="[message.role, { intermediate: message.intermediate }]" :data-message-id="message.id" @contextmenu.prevent="openActions">
    <div v-if="message.showIdentity" class="message-author">
      <MessageAvatar :role="message.role" :author-id="message.authorId" />
      <span class="author-name">{{ message.author }}</span>
      <span v-if="message.role === 'assistant' && !message.final" class="stream-status" role="status"><i /><i /><i /><span>{{ labels.replying }}</span></span>
    </div>
    <div v-if="message.resources.length" class="message-resources">
      <button v-for="resource in message.resources" :key="resource.id" class="resource-link" :disabled="!resource.available" @click="action({ action: 'resource', id: message.id, resourceId: resource.id })">
        <Document20Regular class="reader-icon resource-icon" />
        <span class="resource-info"><span>{{ resource.name }}</span><small>{{ resource.description }}</small></span>
      </button>
    </div>
    <div v-if="message.text || message.role !== 'user'" class="message-body" :data-result-run-id="message.canRegenerate ? message.runId : undefined">
      <ChatMarkdownBody v-if="message.role === 'assistant' && message.text && message.markdown" :animate="false" :content="message.text" :is-dark="dark" :final="message.final" :allow-images="false" code-overflow="scroll" :write-clipboard-text="copy" />
      <p v-else-if="message.text" class="plain-message">
        {{ message.text }}
      </p>
      <p v-if="message.interrupted" class="message-error">
        {{ labels.interrupted }}
      </p>
      <p v-if="message.truncated" class="message-meta">
        {{ labels.truncated }}
      </p>
      <p v-if="message.loading" class="message-meta">
        {{ labels.loadingSaved }}
      </p>
      <p v-if="message.error" class="message-error">
        {{ message.error }}
      </p>
      <p v-if="message.notice" class="message-meta">
        {{ message.notice }}
      </p>
      <button v-if="message.needsDetail && !message.loading && (!message.hasDetail || message.error)" @click="action({ action: 'detail', id: props.message.id })">
        {{ message.error ? labels.retry : labels.viewFull }}
      </button>
      <button v-if="message.detailResource && (message.notice || message.error)" @click="action({ action: 'resource', id: message.id, resourceId: message.detailResource })">
        {{ labels.previewSaveShare }}
      </button>
    </div>
    <ReaderMessageActions
      v-if="message.role === 'user' || (message.role === 'assistant' && message.final && message.actionsVisible)"
      :message="message" :language="language"
      @copy="action({ action: 'copy', id: message.id, text: message.text, feedback: 'message' })" @more="openActions" @followup="action({ action: 'followup', id: message.id })"
    />
  </article>
</template>
