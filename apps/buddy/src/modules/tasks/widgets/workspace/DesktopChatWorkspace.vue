<script setup lang="ts">
import type { LocalConversationTreeNode } from '@buddy-shared/conversation/conversationTree'
import type { BuddyChatMessageListHandle } from '../transcript/chatMessageViewport'
import type { ChatWorkspaceEmits, ChatWorkspaceProps } from './typing'
import { readBuddyUserMessageContent } from '@buddy-shared/conversation/buddyUserContent'
import { computed, defineAsyncComponent, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopRuntimePane from '@/platform/runtime/DesktopRuntimePane.vue'
import WorkbenchSlot from '@/shared/ui/contributions/WorkbenchSlot.vue'
import { useThemeMaterial } from '@/theme/useThemeMaterial'
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

const props = withDefaults(defineProps<ChatWorkspaceProps>(), { active: true })
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
useThemeMaterial('workbench.pane', () => pageRef.value)
const { isEmpty, isLoading, language, transcriptBindings, viewport, welcomeVariant } = useChatWorkspace(props, messageList)
watch([pageRef, isLoading], ([element, loading], _, cleanup) => {
  if (!element || loading)
    return
  let cancelled = false
  cleanup(() => cancelled = true)
  void nextTick(() => {
    if (!cancelled)
      emit('ready')
  })
}, { flush: 'post' })
useTaskResultRead({
  root: pageRef,
  conversationId: computed(() => props.workspace.session.activeConversationId.value),
  marks: () => props.workspace.marks,
  disabled: computed(() => !props.active || isLoading.value || props.workspace.status.isClosing.value || props.workspace.status.runtimeState.value.status !== 'ready'),
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
  <DesktopRuntimePane :loading="isLoading" :language="language" :animate="false">
    <section ref="pageRef" class="desktop-chat-page relative grid min-w-0 min-h-0 flex-1 grid-cols-[minmax(0,_1fr)] grid-rows-[minmax(0,_1fr)_auto] bg-reading text-reading-fg" :class="{ 'is-loading': isLoading, 'is-empty': isEmpty && viewMode !== 'canvas', 'has-node-detail': detailVisible, 'is-question-preview': !composerVisible, 'is-resizing-detail': detailResize.dragging.value }" :style="{ '--conversation-detail-width': `${detailResize.width.value}px` }" :data-view-mode="viewMode">
      <main class="desktop-chat-page__content [grid-area:content] flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
        <DesktopConversationCanvas
          v-if="canvasVisited"
          v-show="viewMode === 'canvas'"
          ref="canvasRef"
          :active="active && viewMode === 'canvas'"
          :workspace="workspace"
          :selected-node-id="selectedNodeId"
          @focus-composer="focusComposer"
          @open-node="nodeDetail.open"
          @open-quote="quoteNavigation.locateStored"
          @edit-node="editNode"
          @open-node-artifact="nodeDetail.close(); emit('openNodeArtifact', $event)"
        />
        <WorkbenchSlot v-if="viewMode !== 'canvas' && isEmpty && !isLoading" target="task.welcome">
          <DesktopChatWelcome
            :language="language"
            :variant="welcomeVariant"
          />
        </WorkbenchSlot>

        <DesktopChatTranscript
          v-else-if="viewMode !== 'canvas' && transcriptBindings"
          ref="messageList"
          v-bind="transcriptBindings"
          :stopping-run-id="workspace.execution.stoppingRunId.value"
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
        v-if="detailVisible" class="desktop-chat-page__detail-resizer relative col-[2] row-[1_/_-1] justify-self-start w-[1px] z-4 cursor-col-resize" role="separator" tabindex="0" aria-orientation="vertical"
        :aria-label="t('desktop.canvas.resizeDetail')" :aria-valuenow="Math.round(detailResize.width.value)"
        :aria-valuemin="Math.round(detailResize.minimum.value)" :aria-valuemax="Math.round(detailResize.maximum.value)"
        data-testid="canvas-detail-resizer" @pointerdown="detailResize.begin" @keydown="detailResize.keydown"
      />
      <aside v-if="detailVisible && nodeDetail.target.value" class="[grid-area:detail] min-w-0 min-h-0 border-l-1 border-l-solid border-l-border overflow-hidden" data-testid="canvas-detail-pane">
        <ConversationNodeDetail
          :target="nodeDetail.target.value" :rows="nodeDetail.rows.value" :language="language"
          :stopping-run-id="workspace.execution.stoppingRunId.value"
          :loading="nodeDetail.loading.value" :error="nodeDetail.error.value"
          :can-edit="workspace.execution.canMutateBranch.value" :editing="editingQuestion"
          @close="nodeDetail.close" @reload="nodeDetail.refresh"
          @edit="editDetail"
          @open-artifact="openDetailArtifact" @open-changes="openDetailChanges"
        />
      </aside>

      <footer v-show="composerVisible" class="desktop-chat-page__composer-dock [grid-area:composer] relative z-2 flex-none pt-0 pr-[var(--buddy-chat-inline-gutter)] pb-4 pl-[var(--buddy-chat-inline-gutter)]" :data-composer-placement="composerVisible ? detailVisible ? 'detail' : 'bottom' : 'hidden'">
        <div class="grid grid-cols-[minmax(0,_1fr)] min-w-0 w-[min(100%,_var(--buddy-chat-reading-width))] gap-[0.55rem] my-0 mx-auto">
          <DesktopTaskNotices
            :execution="workspace.execution"
            :language="language"
            :restoration="workspace.restoration"
            :status="workspace.status"
            @open-settings="emit('openSettings', $event)"
            @select-model="openModelSelector"
          />
          <div v-if="followup" class="desktop-chat-page__followup flex min-w-0 items-center gap-[12px] py-[8px] px-[12px] border-1 border-solid border-accent-border rounded-[8px] bg-accent-subtle text-accent-on-surface text-[12px]" data-testid="canvas-followup-context">
            <span>{{ t('desktop.canvas.composerTarget') }}<strong>{{ followup.text }}</strong></span>
            <button type="button" :disabled="workspace.execution.isSending.value" @click="workspace.execution.cancelFollowup">
              {{ t('desktop.canvas.cancelFollowup') }}
            </button>
          </div>
          <DesktopTaskComposer
            ref="composerRef"
            :composer="workspace.composer"
            :skill-scope-id="workspace.session.spaceId.value"
            :focus-ready="active && composerVisible && !isLoading && workspace.status.runtimeState.value.status === 'ready'"
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
      <div v-if="detailResize.dragging.value" class="absolute inset-0 z-3 cursor-col-resize" />
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
  grid-template-areas: 'content' 'composer';
  container: desktop-chat-page / inline-size;
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

.desktop-chat-page.has-node-detail {
  grid-template-columns: minmax(0, 1fr) var(--conversation-detail-width);
  grid-template-areas: 'content detail' 'content composer';
}

.desktop-chat-page.is-question-preview { grid-template-rows: minmax(0, 1fr); grid-template-areas: 'content detail'; }
.desktop-chat-page__detail-resizer { touch-action: none; }
.desktop-chat-page__detail-resizer::before { position: absolute; content: ''; inset: 0 -4px; }
.desktop-chat-page__detail-resizer:hover, .desktop-chat-page__detail-resizer:focus-visible, .is-resizing-detail .desktop-chat-page__detail-resizer { background: var(--buddy-focus-ring); outline: none; }
.desktop-chat-page.is-resizing-detail { user-select: none; }

.has-node-detail .desktop-chat-page__composer-dock {
  border-left: 1px solid var(--buddy-border-subtle);
  padding: 8px 12px 12px;
}
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
