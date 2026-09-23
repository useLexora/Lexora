<script setup lang="ts">
import type { LocalConversationTreeNode } from '@buddy-shared/conversation/conversationTree'
import type { BuddyChatMessageListHandle } from '../transcript/chatMessageViewport'
import type { ChatWorkspaceEmits, ChatWorkspaceProps } from './typing'
import { readBuddyUserMessageContent } from '@buddy-shared/conversation/buddyUserContent'
import { computed, defineAsyncComponent, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopRuntimePane from '@/platform/runtime/DesktopRuntimePane.vue'
import { useConversationNodeDetail } from '../../state/conversations/useConversationNodeDetail'
import ConversationNodeDetail from '../canvas/ConversationNodeDetail.vue'
import { useConversationDetailResize } from '../canvas/useConversationDetailResize'
import { useChatQuoteNavigation } from '../quotes/useChatQuoteNavigation'
import { useTaskResultRead } from '../task-index/useTaskResultRead'
import DesktopChatTranscript from '../transcript/DesktopChatTranscript.vue'
import DesktopChatWelcome from '../welcome/DesktopChatWelcome.vue'
import ChatSelectionQuoteMenu from './ChatSelectionQuoteMenu.vue'
import DesktopTaskComposer from './DesktopTaskComposer.vue'
import DesktopTaskNotices from './DesktopTaskNotices.vue'
import { useChatWorkspace } from './useChatWorkspace'

const props = defineProps<ChatWorkspaceProps>()
const emit = defineEmits<ChatWorkspaceEmits>()
defineSlots<{
  composerLeadingContext?: () => unknown
}>()
const DesktopConversationCanvas = defineAsyncComponent(() => import('../canvas/DesktopConversationCanvas.vue'))
const composerRef = useTemplateRef<InstanceType<typeof DesktopTaskComposer>>('composerRef')
const canvasRef = useTemplateRef<InstanceType<typeof DesktopConversationCanvas>>('canvasRef')
const canvasVisited = shallowRef(false)
const nodeDetail = useConversationNodeDetail({
  load: input => props.workspace.context.getNodeDetail(input),
  conversationId: computed(() => props.workspace.session.activeConversationId.value),
  language: computed(() => props.workspace.language.value),
  runs: computed(() => props.workspace.transcript.runs.value),
  runEventBuckets: computed(() => props.workspace.transcript.runEventBuckets.value),
  runOutputs: computed(() => props.workspace.transcript.runOutputs.value),
  changeSets: computed(() => props.workspace.transcript.changeSets.value),
})
const detailVisible = computed(() => props.viewMode === 'canvas' && nodeDetail.visible.value)
const selectedNodeId = computed(() => {
  const target = detailVisible.value ? nodeDetail.target.value : null
  return props.workspace.tree.data.value?.nodes.find(node => target?.kind === 'question'
    ? node.kind === 'question' && node.messageId === target.messageId
    : target?.kind === 'answer' && node.kind === 'answer' && node.attempts.some(attempt => attempt.runId === target.runId))?.id ?? null
})
const pageRef = useTemplateRef<HTMLElement>('pageRef')
const detailResize = useConversationDetailResize(pageRef, detailVisible)
const editingQuestion = computed(() => nodeDetail.target.value?.kind === 'question'
  && props.workspace.execution.editingMessageId.value === nodeDetail.target.value.messageId)
const composerVisible = computed(() => !detailVisible.value || nodeDetail.target.value?.kind === 'answer' || editingQuestion.value)
const followup = computed(() => {
  const target = props.workspace.composer.target.value
  return target.kind === 'message_followup'
    ? props.workspace.tree.data.value?.nodes.find(node => node.messageId === target.assistantMessageId) ?? null
    : null
})
const { t } = useBuddyI18n(() => props.workspace.language.value)
watch(() => props.viewMode, (value) => {
  if (value === 'canvas')
    canvasVisited.value = true
  else nodeDetail.close()
}, { immediate: true })
const messageList = useTemplateRef<BuddyChatMessageListHandle>('messageList')
const { isEmpty, isLoading, language, transcriptBindings, viewport, welcomeVariant } = useChatWorkspace(props, messageList)
useTaskResultRead({
  root: pageRef,
  conversationId: computed(() => props.workspace.session.activeConversationId.value),
  marks: () => props.workspace.marks,
  disabled: computed(() => isLoading.value || props.workspace.status.isClosing.value || props.workspace.status.runtimeState.value.status !== 'ready'),
})

async function focusComposer() {
  if (!composerVisible.value)
    nodeDetail.close()
  await nextTick()
  composerRef.value?.focus()
}

async function openModelSelector() {
  if (!composerVisible.value)
    nodeDetail.close()
  await nextTick()
  composerRef.value?.openModelSelector()
}

const quoteContextKey = computed(() => [props.workspace.session.activeConversationId.value, props.workspace.session.activeBranchId.value, props.workspace.composer.editorKey.value].join(':'))
const quoteOwnerKey = computed(() => [quoteContextKey.value, props.viewMode, nodeDetail.visible.value, nodeDetail.target.value?.kind === 'question' ? nodeDetail.target.value.messageId : nodeDetail.target.value?.runId].join(':'))
const quoteDisabled = computed(() => isLoading.value || props.workspace.execution.isSending.value || props.workspace.execution.isMutatingBranch.value)
const quoteNavigation = useChatQuoteNavigation({
  root: pageRef,
  ownerKey: quoteContextKey,
  surfaceKey: quoteOwnerKey,
  language: () => props.workspace.language.value,
  conversationId: () => props.workspace.session.activeConversationId.value,
  viewMode: () => props.viewMode,
  revealMessage: id => viewport.revealMessage(id),
  loadQuote: async (messageId, quoteId) => {
    const conversationId = props.workspace.session.activeConversationId.value
    if (!conversationId)
      return null
    const detail = await props.workspace.context.getNodeDetail({ conversationId, kind: 'question', messageId })
    const item = detail.items.find(item => item.kind === 'message' && item.id === messageId)
    return item?.kind === 'message' ? readBuddyUserMessageContent(item.content)?.userContent.quotes?.find(quote => quote.id === quoteId) ?? null : null
  },
  openSource: async (source) => {
    const node = props.workspace.tree.data.value?.nodes.find(node => source.role === 'user'
      ? node.messageId === source.messageId
      : node.kind === 'answer' && node.attempts.some(attempt => attempt.runId === source.runId))
    if (!node)
      return 'unavailable'
    emit('showCanvas')
    const current = nodeDetail.target.value
    const alreadyOpen = nodeDetail.visible.value && !nodeDetail.loading.value && !nodeDetail.error.value && (source.role === 'user'
      ? current?.kind === 'question' && current.messageId === source.messageId
      : current?.kind === 'answer' && current.runId === source.runId)
    const ready = alreadyOpen ? undefined : nodeDetail.open(source.role === 'assistant' ? { ...node, runId: source.runId } : node)
    const target = nodeDetail.target.value
    await ready
    await nextTick()
    if (nodeDetail.target.value !== target || !nodeDetail.visible.value || props.viewMode !== 'canvas')
      return 'cancelled'
    canvasRef.value?.focusNode(node.id)
    return nodeDetail.error.value ? 'unavailable' : 'opened'
  },
})

async function editNode(node: LocalConversationTreeNode) {
  if (node.kind !== 'question' || !node.messageId)
    return
  nodeDetail.open(node)
  if (await props.workspace.execution.editUserMessage(node.messageId, node.active ? undefined : node.branchId)) {
    await nextTick()
    composerRef.value?.focus()
  }
}

watch(() => props.workspace.execution.editingMessageId.value, (next, previous) => {
  if (!next && previous && props.workspace.execution.activeRun.value
    && nodeDetail.target.value?.kind === 'question' && nodeDetail.target.value.messageId === previous) {
    nodeDetail.close()
  }
}, { flush: 'post' })

function editDetail() {
  const target = nodeDetail.target.value
  const node = target?.kind === 'question' && props.workspace.tree.data.value?.nodes.find(node => node.messageId === target.messageId)
  if (node)
    void editNode(node)
}

function openDetailArtifact(id: string) {
  const artifact = nodeDetail.data.value?.outputs.flatMap(output => output.artifacts).find(artifact => artifact.artifactId === id)
  nodeDetail.close()
  if (artifact)
    emit('openNodeArtifact', artifact)
  else emit('openArtifact', id)
}

function openDetailChanges(id: string) {
  const changes = nodeDetail.data.value?.changeSets.find(changes => changes.changeSetId === id)
  nodeDetail.close()
  if (changes)
    emit('openNodeChanges', changes)
  else emit('openChanges', id)
}
</script>

<template>
  <DesktopRuntimePane :loading="isLoading" :language="language">
    <section ref="pageRef" class="desktop-chat-page" :class="{ 'is-loading': isLoading, 'is-empty': isEmpty && viewMode !== 'canvas', 'has-node-detail': detailVisible, 'is-question-preview': !composerVisible, 'is-resizing-detail': detailResize.dragging.value }" :style="{ '--conversation-detail-width': `${detailResize.width.value}px` }" :data-view-mode="viewMode">
      <main class="desktop-chat-page__content">
        <DesktopConversationCanvas
          v-if="canvasVisited"
          v-show="viewMode === 'canvas'"
          ref="canvasRef"
          :active="viewMode === 'canvas'"
          :workspace="workspace"
          :selected-node-id="selectedNodeId"
          @focus-composer="focusComposer"
          @open-node="nodeDetail.open"
          @open-quote="quoteNavigation.locateStored"
          @edit-node="editNode"
          @open-node-artifact="nodeDetail.close(); emit('openNodeArtifact', $event)"
        />
        <DesktopChatWelcome
          v-if="viewMode !== 'canvas' && isEmpty && !isLoading && welcomeVariant"
          :language="language"
          :variant="welcomeVariant"
        />

        <DesktopChatTranscript
          v-else-if="viewMode !== 'canvas' && transcriptBindings"
          ref="messageList"
          v-bind="transcriptBindings"
          class="desktop-chat-page__messages"
          @activate-branch="workspace.transcript.activateBranch"
          @content-resize="viewport.handleContentResize"
          @edit-user-message="workspace.execution.editUserMessage"
          @open-artifact="emit('openArtifact', $event)"
          @open-changes="emit('openChanges', $event)"
          @reader-layout-intent="viewport.handleReaderLayoutIntent"
          @regenerate-assistant="workspace.execution.regenerateAssistant"
          @return-to-latest="viewport.returnToLatest"
          @select-outline-message="viewport.revealOutlineMessage"
          @scroll="(metrics, options) => viewport.handleScroll(metrics, options)"
        />
      </main>

      <div
        v-if="detailVisible" class="desktop-chat-page__detail-resizer" role="separator" tabindex="0" aria-orientation="vertical"
        :aria-label="t('desktop.canvas.resizeDetail')" :aria-valuenow="Math.round(detailResize.width.value)"
        :aria-valuemin="Math.round(detailResize.minimum.value)" :aria-valuemax="Math.round(detailResize.maximum.value)"
        data-testid="canvas-detail-resizer" @pointerdown="detailResize.begin" @keydown="detailResize.keydown"
      />
      <aside v-if="detailVisible && nodeDetail.target.value" class="desktop-chat-page__node-detail" data-testid="canvas-detail-pane">
        <ConversationNodeDetail
          :target="nodeDetail.target.value" :rows="nodeDetail.rows.value" :language="language"
          :loading="nodeDetail.loading.value" :error="nodeDetail.error.value"
          :can-edit="workspace.execution.canMutateBranch.value" :editing="editingQuestion"
          @close="nodeDetail.close" @reload="nodeDetail.refresh"
          @edit="editDetail"
          @open-artifact="openDetailArtifact" @open-changes="openDetailChanges"
        />
      </aside>

      <footer v-show="composerVisible" class="desktop-chat-page__composer-dock" :data-composer-placement="composerVisible ? detailVisible ? 'detail' : 'bottom' : 'hidden'">
        <div class="desktop-chat-page__composer-stack">
          <DesktopTaskNotices
            :execution="workspace.execution"
            :language="language"
            :restoration="workspace.restoration"
            :status="workspace.status"
            @open-settings="emit('openSettings', $event)"
            @select-model="openModelSelector"
          />
          <div v-if="followup" class="desktop-chat-page__followup" data-testid="canvas-followup-context">
            <span>{{ t('desktop.canvas.composerTarget') }}<strong>{{ followup.text }}</strong></span>
            <button type="button" :disabled="workspace.execution.isSending.value" @click="workspace.execution.cancelFollowup">
              {{ t('desktop.canvas.cancelFollowup') }}
            </button>
          </div>
          <DesktopTaskComposer
            ref="composerRef"
            :composer="workspace.composer"
            :skill-scope-id="workspace.session.spaceId.value"
            :focus-ready="composerVisible && !isLoading && workspace.status.runtimeState.value.status === 'ready'"
            :execution="workspace.execution"
            :language="language"
          >
            <template #leadingContext>
              <slot name="composerLeadingContext" />
            </template>
          </DesktopTaskComposer>
        </div>
      </footer>
      <ChatSelectionQuoteMenu
        :root="pageRef" :language="language" :owner-key="quoteOwnerKey" :disabled="quoteDisabled"
        :add-quote="quote => composerRef?.quote(quote) ?? 'unavailable'" @accepted="focusComposer"
      />
      <div v-if="detailResize.dragging.value" class="desktop-chat-page__resize-shield" />
    </section>
  </DesktopRuntimePane>
</template>

<style scoped lang="scss">
.desktop-chat-page :deep(::highlight(buddy-message-quote)) {
  background-color: var(--buddy-accent-solid);
  color: var(--buddy-text-on-accent);
  text-decoration: underline;
}

.desktop-chat-page {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  flex: 1;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas: 'content' 'composer';
  background: var(--buddy-surface-base);
  container: desktop-chat-page / inline-size;
}

.desktop-chat-page__content {
  grid-area: content;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.desktop-chat-page.is-loading {
  visibility: hidden;
}

.desktop-chat-page.is-empty {
  display: grid;
  grid-template-rows: auto auto;
  align-content: center;
  padding-block: 1.5rem 3.5rem;

  .desktop-chat-page__content {
    flex: none;
    overflow: visible;
  }

  .desktop-chat-page__composer-dock {
    padding-top: 1.75rem;
    padding-bottom: 0;
  }
}

.desktop-chat-page__messages {
  min-height: 0;
  flex: 1;
}

.desktop-chat-page__composer-dock {
  grid-area: composer;
  position: relative;
  z-index: 2;
  flex: none;
  background: var(--buddy-surface-base);
  padding: 0 var(--buddy-chat-inline-gutter) 1rem;
}

.desktop-chat-page.has-node-detail {
  grid-template-columns: minmax(0, 1fr) var(--conversation-detail-width);
  grid-template-areas: 'content detail' 'content composer';
}

.desktop-chat-page.is-question-preview { grid-template-rows: minmax(0, 1fr); grid-template-areas: 'content detail'; }
.desktop-chat-page__detail-resizer { position: relative; grid-column: 2; grid-row: 1 / -1; justify-self: start; width: 1px; z-index: 4; cursor: col-resize; touch-action: none; }
.desktop-chat-page__detail-resizer::before { position: absolute; content: ''; inset: 0 -4px; }
.desktop-chat-page__detail-resizer:hover, .desktop-chat-page__detail-resizer:focus-visible, .is-resizing-detail .desktop-chat-page__detail-resizer { background: var(--buddy-focus-ring); outline: none; }
.desktop-chat-page__resize-shield { position: absolute; inset: 0; z-index: 3; cursor: col-resize; }
.desktop-chat-page.is-resizing-detail { user-select: none; }

.desktop-chat-page__node-detail {
  grid-area: detail;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--buddy-border-subtle);
  overflow: hidden;
}

.has-node-detail .desktop-chat-page__composer-dock {
  border-left: 1px solid var(--buddy-border-subtle);
  padding: 8px 12px 12px;
}

.desktop-chat-page__composer-stack {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  width: min(100%, var(--buddy-chat-reading-width));
  gap: 0.55rem;
  margin: 0 auto;
}
.desktop-chat-page__followup { display: flex; min-width: 0; align-items: center; gap: 12px; padding: 8px 12px; border: 1px solid var(--buddy-accent-border); border-radius: 8px; background: var(--buddy-accent-surface-subtle); color: var(--buddy-accent-on-surface); font-size: 12px; }
.desktop-chat-page__followup > span { min-width: 0; flex: 1; }
.desktop-chat-page__followup strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 400; color: var(--buddy-text-secondary); }
.desktop-chat-page__followup button { flex: none; border: 0; border-radius: 6px; padding: 5px 8px; background: transparent; color: var(--buddy-text-secondary); font-size: 11px; cursor: pointer; }
.desktop-chat-page__followup button:hover { background: var(--buddy-state-hover); }

@container task-pane (max-height: 620px) {
  .desktop-chat-page.is-empty {
    grid-template-rows: minmax(0, 1fr) auto;
    padding-block: 1rem;

    .desktop-chat-page__content {
      justify-content: center;
      overflow: hidden;
      container: welcome-region / size;
    }

    .desktop-chat-page__composer-dock {
      padding-top: 0.75rem;
    }
  }
}
</style>
