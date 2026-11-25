<script setup lang="ts">
import type { ChatAgentTurn } from '../modules/tasks/contracts'
import type { ReaderMessage as Message, ReaderTurnOwner } from './readerBridge'
import type { ReaderOutput, ReaderSend } from './readerProtocol'
import { computed, provide } from 'vue'
import { BuddyChatActivityGroup, BuddyChatCompactionRow, BuddyChatPanelGroup, createChatAgentActivityProjector, useChatTranscriptValue, useProvideChatContent } from '../modules/tasks/reader'
import ChatMarkdownBody from '../shared/ui/markdown/ChatMarkdownBody.vue'
import MessageAvatar from './MessageAvatar.vue'
import ReaderArtifacts from './ReaderArtifacts.vue'
import ReaderBranchNavigation from './ReaderBranchNavigation.vue'
import ReaderMessage from './ReaderMessage.vue'
import { useReaderStrings } from './readerStrings'
import ReaderTerminal from './ReaderTerminal.vue'
import { readerToolImageHostKey } from './readerToolImages'
import ReaderToolImages from './ReaderToolImages.vue'
import { useReaderTurnBranch } from './useReaderBranches'

const props = defineProps<{ turn: ChatAgentTurn, liveOwner?: ReaderTurnOwner, messages: Message[], dark: boolean, language: string, output?: ReaderOutput, send: ReaderSend }>()
const emit = defineEmits<{ interact: [] }>()
const locale = computed(() => props.language === 'en' ? 'en-US' : 'zh-CN')
const labels = useReaderStrings()
const navigator = useReaderTurnBranch(() => props.turn.runId)
const emptyResultStatus = computed(() => {
  switch (props.turn.status) {
    case 'cancelled': return labels.value.stopped
    case 'failed': return labels.value.failed
    case 'completed': return labels.value.noReply
    default: return ''
  }
})
const projector = createChatAgentActivityProjector()
const rows = computed(() => projector.project(props.turn.nodes))
const openEntries = useChatTranscriptValue('agent-turn:open-entries', new Map<string, boolean>())
const owner = computed(() => {
  const replies = props.messages.filter(message => message.role === 'assistant' && message.runId === props.turn.runId)
  if (!replies.length)
    return props.liveOwner
  const saved = replies.find(message => message.authorId && message.author.trim())
  return saved ? { id: saved.authorId, name: saved.author } : undefined
})
const results = computed(() => {
  const narrationIds = new Set([...props.turn.processMessageIds, ...props.turn.nodes.flatMap(node => node.kind === 'text' ? [node.messageId] : [])])
  return props.messages.filter(message => message.role === 'assistant' && (message.id === props.turn.finalMessageId || !narrationIds.has(message.id)))
})
function toggle(id: string, open = !openEntries.value.get(id)) {
  emit('interact')
  openEntries.value = new Map(openEntries.value).set(id, open)
}
async function copy(text: string) {
  const message = props.messages.find(message => message.role === 'assistant' || message.role === 'tool')
  props.send({ action: 'copy', id: message?.id ?? '', runId: props.turn.runId, text })
}
provide(readerToolImageHostKey, { runId: computed(() => props.turn.runId), send: action => props.send(action) })
useProvideChatContent({ terminalRenderer: ReaderTerminal, toolImageRenderer: ReaderToolImages, canPreviewFile: () => false, previewFile: () => {}, openWebLink: href => props.send({ action: 'link', href }), writeClipboardText: copy })
</script>

<template>
  <article class="reader-turn" :data-run-id="turn.runId" @click="emit('interact')">
    <div class="message-author">
      <MessageAvatar role="assistant" :author-id="owner?.id ?? null" />
      <span class="author-name">{{ owner?.name || labels.assistant }}</span>
    </div>
    <div class="reader-turn-flow">
      <template v-for="row in rows" :key="row.id">
        <BuddyChatActivityGroup v-if="row.kind === 'activity-group'" :group="row" :language="locale" hide-live-status :open-entries="openEntries" @toggle-entry="toggle" @open-entry="id => toggle(id, true)" />
        <BuddyChatPanelGroup v-else-if="row.kind === 'panel-group'" :group="row" :language="locale" />
        <BuddyChatCompactionRow v-else-if="row.kind === 'compaction'" :node="row" :language="locale" />
        <div v-else-if="row.kind === 'text'" class="reader-narration">
          <ChatMarkdownBody :animate="false" :content="row.text" :final="turn.status !== 'running'" :is-dark="dark" :allow-images="false" :write-clipboard-text="copy" />
        </div>
      </template>
    </div>
    <ReaderMessage v-for="(message, index) in results" :key="message.id" :message="{ ...message, showIdentity: false }" :output="index === results.length - 1 ? output : undefined" :dark="dark" :language="language" :send="send" @interact="emit('interact')" />
    <template v-if="!results.length">
      <p v-if="emptyResultStatus" class="reader-turn-status" role="status">
        {{ emptyResultStatus }}
      </p>
      <ReaderArtifacts :run-id="turn.runId" :output="output" :send="send" @interact="emit('interact')" />
      <ReaderBranchNavigation v-if="navigator" :navigator="navigator" @branch="send({ action: 'branch', branchId: $event })" />
    </template>
  </article>
</template>

<style scoped lang="scss">
.reader-turn-status {
  margin: 4px 0;
  color: var(--reader-muted);
  font-size: 13px;
}

.reader-turn {
  :deep(.buddy-chat-activity-row:not(.buddy-chat-activity-group__header)) {
    display: flex;
    width: fit-content;
    max-width: 100%;
    min-height: var(--buddy-chat-activity-row-height);
    padding: 2px 4px;
    line-height: 20px;
  }

  :deep(.buddy-chat-activity-group__content) {
    margin-block: 0;
  }

  :deep(.buddy-chat-tool-details) {
    max-width: 100%;
    margin: 0 0 4px;
  }

  :deep(.buddy-chat-image-tool-details__section > header) {
    min-height: 0;
    padding: 3px 8px;
    line-height: 18px;
  }

  :deep(.buddy-chat-image-tool-details__section > p) {
    padding: 6px 8px 4px;
    line-height: 1.45;
  }

  :deep(.buddy-chat-image-tool-details__section > small) {
    padding: 0 8px 6px;
    font-size: 11px;
    line-height: 1.45;
  }
}
</style>
