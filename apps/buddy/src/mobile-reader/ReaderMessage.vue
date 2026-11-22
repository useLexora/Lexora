<script setup lang="ts">
import type { ReaderMessage } from './readerBridge'
import type { ReaderActionInput, ReaderOutput, ReaderSend } from './readerProtocol'
import { Document20Regular } from '@vicons/fluent'
import ChatMarkdownBody from '../shared/ui/markdown/ChatMarkdownBody.vue'
import MessageAvatar from './MessageAvatar.vue'
import ReaderArtifacts from './ReaderArtifacts.vue'
import ReaderLiveBody from './ReaderLiveBody.vue'
import ReaderMessageActions from './ReaderMessageActions.vue'
import ReaderMessagePhoto from './ReaderMessagePhoto.vue'
import { useReaderStrings } from './readerStrings'

const props = defineProps<{
  message: ReaderMessage
  replying?: boolean
  output?: ReaderOutput
  dark: boolean
  language?: string
  send: ReaderSend
}>()
const emit = defineEmits<{ interact: [] }>()
const labels = useReaderStrings()
function action(value: Extract<ReaderActionInput, { action: 'message' | 'detail' | 'copy' | 'resource' | 'edit' | 'branch' }>) {
  emit('interact')
  props.send(value)
}
function openActions(event: MouseEvent) {
  if (props.message.returnToComposer !== undefined || props.message.intermediate || (props.message.role === 'assistant' && !props.message.actionsVisible))
    return
  const selection = window.getSelection()
  if (event.type === 'contextmenu' && props.message.role === 'assistant' && selection && !selection.isCollapsed)
    return
  event.preventDefault()
  selection?.removeAllRanges()
  const rect = event.type === 'contextmenu'
    ? { x: event.clientX, y: event.clientY, width: 0, height: 0 }
    : (event.currentTarget as HTMLElement).getBoundingClientRect()
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  action({ action: 'message', id: props.message.id, ...(event.type === 'contextmenu' ? { contextual: true } : {}), anchor: { x: clamp(rect.x / innerWidth), y: clamp(rect.y / innerHeight), width: clamp(rect.width / innerWidth), height: clamp(rect.height / innerHeight) } })
}
async function copy(text: string) {
  action({ action: 'copy', id: props.message.id, text })
}
</script>

<template>
  <article class="reader-message" :class="[message.role, { intermediate: message.intermediate }]" :data-message-id="message.id" @contextmenu="openActions">
    <div v-if="message.showIdentity || replying" class="message-author">
      <MessageAvatar :role="message.role" :author-id="message.authorId" />
      <span class="author-name">{{ message.author }}</span>
      <span v-if="replying" class="stream-status" role="status"><i /><i /><i /><span>{{ labels.replying }}</span></span>
    </div>
    <div v-if="message.role === 'assistant' && message.commentary" class="reader-narration" @contextmenu.stop>
      <ReaderLiveBody :message="{ id: message.id, text: message.commentary.text, textRange: message.commentary.range }" :send="send" @interact="emit('interact')" />
    </div>
    <div v-if="message.resources.length" class="message-resources">
      <template v-for="resource in message.resources" :key="resource.id">
        <ReaderMessagePhoto
          v-if="message.role === 'user' && resource.photo" :key="resource.photo.revision"
          :resource="resource" :photo="resource.photo"
          @load="(revision, retry) => send({ action: 'photo-thumbnail', id: message.id, resourceId: resource.id, revision, ...(retry ? { retry: true } : {}) })"
          @open="revision => action({ action: 'resource', id: message.id, resourceId: resource.id, revision })"
        />
        <button v-else class="resource-link" :disabled="!resource.available" @click="action({ action: 'resource', id: message.id, resourceId: resource.id })">
          <Document20Regular class="reader-icon resource-icon" />
          <span class="resource-info"><span>{{ resource.name }}</span><small>{{ resource.description }}</small></span>
        </button>
      </template>
    </div>
    <div v-if="message.text || message.role !== 'user'" class="message-body" :data-result-run-id="message.canRegenerate ? message.runId : undefined">
      <ReaderLiveBody v-if="message.role === 'assistant' && message.textRange && message.textRange.start > 0" :message="message" :send="send" @interact="emit('interact')" />
      <ChatMarkdownBody v-else-if="message.role === 'assistant' && message.text && message.markdown" :animate="false" :content="message.text" :is-dark="dark" :final="message.final" :allow-images="false" code-overflow="scroll" :write-clipboard-text="copy" />
      <p v-else-if="message.text" class="plain-message">
        {{ message.text }}
      </p>
      <p v-if="message.interrupted" class="message-error">
        {{ labels.interrupted }}
      </p>
      <p v-if="message.truncated" class="message-meta">
        {{ message.sourceTruncated ? labels.sourceTruncated : labels.truncated }}
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
        {{ message.error ? labels.retry : message.sourceTruncated ? labels.viewSaved : labels.viewFull }}
      </button>
      <button v-if="message.detailResource && (message.notice || message.error)" @click="action({ action: 'resource', id: message.id, resourceId: message.detailResource })">
        {{ labels.previewSaveShare }}
      </button>
    </div>
    <ReaderArtifacts v-if="message.runId" :run-id="message.runId" :output="output" :send="send" @interact="emit('interact')" />
    <ReaderMessageActions
      v-if="message.actionsVisible && (message.role === 'user' || (message.role === 'assistant' && message.final))"
      :message="message" :language="language"
      @copy="action({ action: 'copy', id: message.id, text: message.text, feedback: 'message' })" @more="openActions" @edit="action({ action: 'edit', id: message.id })" @branch="branchId => action({ action: 'branch', branchId })"
    />
  </article>
</template>
