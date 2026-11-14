<script setup lang="ts">
import type { ChatAgentTurn } from '../modules/tasks/contracts'
import type { ReaderMessage as Message } from './readerBridge'
import type { ReaderSend } from './readerProtocol'
import { computed } from 'vue'
import { BuddyChatActivityGroup, BuddyChatCompactionRow, BuddyChatPanelGroup, BuddyChatRunActivity, createChatAgentActivityProjector, useChatTranscriptValue, useProvideChatContent } from '../modules/tasks/reader'
import ChatMarkdownBody from '../shared/ui/markdown/ChatMarkdownBody.vue'
import MessageAvatar from './MessageAvatar.vue'
import ReaderMessage from './ReaderMessage.vue'
import ReaderTerminal from './ReaderTerminal.vue'

const props = defineProps<{ turn: ChatAgentTurn, buddyId?: string, messages: Message[], dark: boolean, language: string, send: ReaderSend }>()
const emit = defineEmits<{ interact: [] }>()
const locale = computed(() => props.language === 'en' ? 'en-US' : 'zh-CN')
const projector = createChatAgentActivityProjector()
const rows = computed(() => projector.project(props.turn.nodes))
const openEntries = useChatTranscriptValue('agent-turn:open-entries', new Map<string, boolean>())
const author = computed(() => props.messages.find(message => message.role === 'assistant'))
const results = computed(() => {
  const narrationIds = new Set([...props.turn.processMessageIds, ...props.turn.nodes.flatMap(node => node.kind === 'text' ? [node.messageId] : [])])
  return props.messages.filter(message => message.role === 'assistant' && !narrationIds.has(message.id))
})
function toggle(id: string, open = !openEntries.value.get(id)) {
  emit('interact')
  openEntries.value = new Map(openEntries.value).set(id, open)
}
async function copy(text: string) {
  const message = props.messages.find(message => message.role === 'assistant' || message.role === 'tool')
  props.send({ action: 'copy', id: message?.id ?? '', runId: props.turn.runId, text })
}
useProvideChatContent({ terminalRenderer: ReaderTerminal, canPreviewFile: () => false, previewFile: () => {}, openWebLink: href => props.send({ action: 'link', href }), writeClipboardText: copy })
</script>

<template>
  <article class="reader-turn" :data-run-id="turn.runId" @click="emit('interact')">
    <div class="message-author">
      <MessageAvatar role="assistant" :author-id="author?.authorId ?? buddyId ?? null" />
      <span class="author-name">{{ author?.author ?? 'Lexora' }}</span>
    </div>
    <div class="reader-turn-flow">
      <template v-for="row in rows" :key="row.id">
        <BuddyChatActivityGroup v-if="row.kind === 'activity-group'" :group="row" :language="locale" :open-entries="openEntries" @toggle-entry="toggle" @open-entry="id => toggle(id, true)" />
        <BuddyChatPanelGroup v-else-if="row.kind === 'panel-group'" :group="row" :language="locale" />
        <BuddyChatCompactionRow v-else-if="row.kind === 'compaction'" :node="row" :language="locale" />
        <div v-else-if="row.kind === 'text'" class="reader-narration">
          <ChatMarkdownBody :animate="false" :content="row.text" :final="turn.status !== 'running'" :is-dark="dark" :allow-images="false" :write-clipboard-text="copy" />
        </div>
      </template>
    </div>
    <BuddyChatRunActivity v-if="turn.status === 'running' || turn.status === 'queued'" :turn="turn" :language="locale" />
    <ReaderMessage v-for="message in results" :key="message.id" :message="{ ...message, showIdentity: false }" :dark="dark" :language="language" :send="send" @interact="emit('interact')" />
  </article>
</template>
