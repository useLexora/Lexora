<script setup lang="ts">
import type { Node } from '@antv/x6'
import type { ConversationCanvasData } from './conversationCanvasContext'
import { Add20Regular, ArrowSync20Regular, Document20Regular, Edit20Regular, Keyboard20Regular, Wand20Regular } from '@vicons/fluent'
import { useIntervalFn } from '@vueuse/core'
import { computed, inject, onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { resolveBuddyAttachmentPreviewUrl } from '../../model/attachments/chatAttachmentView'
import { formatChatRunDuration } from '../../model/transcript/chatRunDuration'
import BuddyArtifactCard from '../artifacts/BuddyArtifactCard.vue'
import ChatQuoteStrip from '../quotes/ChatQuoteStrip.vue'
import BuddyChatTokenUsage from '../transcript/BuddyChatTokenUsage.vue'
import { conversationCanvasActions } from './conversationCanvasContext'

const props = defineProps<{ node: Node }>()
const actions = inject(conversationCanvasActions)!
const { t } = useBuddyI18n(actions.language)
const data = shallowRef(props.node.getData<ConversationCanvasData>())
const textRef = useTemplateRef<HTMLElement>('textRef')
const now = shallowRef(Date.now())
function update() {
  data.value = props.node.getData<ConversationCanvasData>()
}
props.node.on('change:data', update)
onBeforeUnmount(() => props.node.off('change:data', update))
const message = computed(() => data.value.message)
const selected = computed(() => actions.selectedNodeId.value === message.value.id)
const busy = computed(() => message.value.status === 'running' || message.value.status === 'queued')
const label = computed(() => t(`desktop.canvas.${message.value.kind}`))
const duration = computed(() => message.value.metadata
  ? formatChatRunDuration(message.value.metadata.startedAt, message.value.metadata.completedAt, now.value)
  : null)
const clock = useIntervalFn(() => now.value = Date.now(), 1000, { immediate: false })
watch(() => busy.value && actions.active.value, value => value ? clock.resume() : clock.pause(), { immediate: true })
watch(() => message.value.text, () => {
  if (busy.value && textRef.value)
    textRef.value.scrollTop = textRef.value.scrollHeight
}, { flush: 'post' })
let pointerStart: { x: number, y: number } | null = null
function pointerDown(event: PointerEvent) {
  pointerStart = { x: event.clientX, y: event.clientY }
}
function open(event: MouseEvent) {
  if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4)
    return
  actions.open(message.value.id)
}
</script>

<template>
  <article
    class="conversation-node"
    :class="[message.kind, data.direction, { selected, busy }, message.status ? `status-${message.status}` : '']"
    :data-node-id="message.id" :data-kind="message.kind" :data-status="message.status"
    tabindex="0" :aria-label="label" :aria-current="selected ? 'true' : undefined"
    @keydown.enter.self.prevent="actions.open(message.id)"
    @keydown.space.self.prevent="actions.open(message.id)"
    @pointerdown.capture="pointerDown"
    @click="open"
  >
    <div class="conversation-node__card">
      <header class="conversation-node__header">
        <DesktopIcon class="conversation-node__role" :component="message.kind === 'answer' ? Wand20Regular : Keyboard20Regular" :title="label" />
        <span v-if="message.toolCount" class="conversation-node__tools">{{ t('desktop.canvas.tools', { count: message.toolCount }) }}</span>
        <div class="conversation-node__trailing">
          <span v-if="message.kind === 'draft'" class="conversation-node__status">{{ label }}</span>
          <span v-if="message.status && message.status !== 'completed'" class="conversation-node__status" :class="message.status">{{ t(`desktop.canvas.${message.status}`) }}</span>
          <div v-if="message.kind !== 'draft' && !busy" class="conversation-node__actions" role="toolbar" :aria-label="t('desktop.canvas.nodeActions')" @pointerdown.stop @mousedown.stop>
            <button v-if="message.kind === 'question'" type="button" :disabled="!data.canMutate" :aria-label="t('desktop.chat.editMessage')" :title="t('desktop.chat.editMessage')" data-testid="canvas-node-edit" @click.stop="actions.edit(message.id)">
              <DesktopIcon :component="Edit20Regular" />
            </button>
            <template v-else>
              <button type="button" :disabled="!data.canMutate" :aria-label="t('desktop.canvas.retry')" :title="t('desktop.canvas.retry')" data-testid="canvas-node-retry" @click.stop="actions.retry(message.id)">
                <DesktopIcon :component="ArrowSync20Regular" />
              </button>
              <button v-if="message.status === 'completed'" type="button" :disabled="!data.canMutate" :aria-label="t('desktop.canvas.followup')" :title="t('desktop.canvas.followup')" data-testid="canvas-node-followup" @click.stop="actions.followup(message.id)">
                <DesktopIcon :component="Add20Regular" />
              </button>
            </template>
          </div>
        </div>
      </header>
      <div v-if="message.text || message.quoteCount || message.attachmentCount || message.artifactCount || busy || message.kind === 'draft'" class="conversation-node__body" @mousedown.stop @pointerdown.stop>
        <div v-if="message.attachmentCount" class="conversation-node__attachments">
          <span v-for="attachment in message.attachments" :key="attachment.attachmentId" class="conversation-node__attachment" :title="attachment.name">
            <img v-if="attachment.kind === 'image'" :src="resolveBuddyAttachmentPreviewUrl(attachment) ?? undefined" :alt="attachment.name" loading="lazy" draggable="false">
            <DesktopIcon v-else :component="Document20Regular" />
            <span>{{ attachment.name }}</span>
          </span>
          <button v-if="message.attachmentCount > message.attachments.length" type="button" class="conversation-node__more" :aria-label="t('desktop.canvas.moreResources', { count: message.attachmentCount - message.attachments.length })" @click.stop="actions.open(message.id)">
            {{ t('desktop.canvas.more') }}
          </button>
        </div>
        <div v-if="message.quoteCount && message.messageId" class="conversation-node__quotes" @click.stop>
          <ChatQuoteStrip
            :quotes="message.quotes" :language="actions.language.value"
            :navigate="quote => actions.openQuote(message.messageId!, quote.id)"
          />
          <button v-if="message.quoteCount > message.quotes.length" type="button" class="conversation-node__more" @click="actions.open(message.id)">
            {{ t('desktop.canvas.more') }}
          </button>
        </div>
        <div v-if="message.text" ref="textRef" class="conversation-node__text">
          <p class="conversation-node__preview">
            {{ message.text }}
          </p>
        </div>
        <p v-else-if="busy || message.kind === 'draft'" class="conversation-node__placeholder">
          {{ t(message.kind === 'draft' ? 'desktop.canvas.writeInComposer' : 'desktop.canvas.generating') }}
        </p>
        <div v-if="message.artifactCount" class="conversation-node__artifacts">
          <BuddyArtifactCard
            v-for="artifact in message.artifacts" :key="artifact.artifactId"
            class="conversation-node__artifact" compact
            :artifact="artifact" :language="actions.language.value"
            @click.stop @open-artifact="actions.openArtifact"
          />
          <button v-if="message.artifactCount > message.artifacts.length" type="button" class="conversation-node__more" :aria-label="t('desktop.canvas.moreResources', { count: message.artifactCount - message.artifacts.length })" @click.stop="actions.open(message.id)">
            {{ t('desktop.canvas.more') }}
          </button>
        </div>
      </div>
      <footer v-if="message.metadata" class="conversation-node__footer" @mousedown.stop @pointerdown.stop>
        <span class="conversation-node__model" :title="message.metadata.modelId">{{ message.metadata.modelId }}</span>
        <BuddyChatTokenUsage v-if="message.metadata.usage" compact :language="actions.language.value" :usage="message.metadata.usage" />
        <span v-if="duration" class="conversation-node__duration">{{ duration }}</span>
      </footer>
    </div>
  </article>
</template>

<style scoped lang="scss">
@property --buddy-beam-angle {
  syntax: '<angle>';
  inherits: false;
  initial-value: 0deg;
}

.conversation-node { position: relative; display: flex; width: 100%; height: 100%; flex-direction: column; user-select: none; cursor: pointer; }
.conversation-node__card { position: relative; display: flex; flex: none; width: 100%; height: 100%; flex-direction: column; border: 1px solid var(--buddy-border-subtle); border-radius: 12px; background: var(--buddy-surface-base); color: var(--buddy-text-primary); box-shadow: 0 2px 8px rgb(0 0 0 / 3%); user-select: none; cursor: pointer; transition: border-color 160ms ease, opacity 160ms ease; }
.conversation-node.question .conversation-node__card { background: var(--buddy-user-message-surface); }
.conversation-node:hover .conversation-node__card { border-color: var(--buddy-border-strong); }
.conversation-node.selected .conversation-node__card { border-color: var(--buddy-focus-ring); box-shadow: 0 0 0 1px var(--buddy-focus-ring), 0 2px 8px rgb(0 0 0 / 3%); }
.conversation-node:focus-visible { outline: none; }
.conversation-node:focus-visible .conversation-node__card { outline: 2px solid var(--buddy-accent-border); outline-offset: 3px; }
.conversation-node.draft .conversation-node__card { border: 1.5px dashed var(--buddy-accent-text); background: color-mix(in srgb, var(--buddy-accent-text) 4%, var(--buddy-surface-base)); box-shadow: none; }

// Status borders: running (border beam animation)
.conversation-node.status-running .conversation-node__card,
.conversation-node[data-status="running"] .conversation-node__card {
  border-color: color-mix(in srgb, var(--buddy-accent-text) 24%, var(--buddy-border-subtle));
}
.conversation-node.status-running .conversation-node__card::before,
.conversation-node[data-status="running"] .conversation-node__card::before {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: 12px;
  padding: 1.5px;
  background: conic-gradient(
    from var(--buddy-beam-angle, 0deg),
    transparent 0deg,
    transparent 280deg,
    color-mix(in srgb, var(--buddy-accent-text) 30%, transparent) 320deg,
    var(--buddy-accent-text) 360deg
  );
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
  animation: conversation-node-beam 2.8s linear infinite;
  z-index: 1;
}

// Status borders: queued (standby dashed)
.conversation-node.status-queued .conversation-node__card,
.conversation-node[data-status="queued"] .conversation-node__card {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--buddy-accent-text) 50%, var(--buddy-border-subtle));
}
.conversation-node.status-queued:hover .conversation-node__card,
.conversation-node[data-status="queued"]:hover .conversation-node__card {
  border-color: var(--buddy-accent-text);
}

// Status borders: failed (danger border)
.conversation-node.status-failed .conversation-node__card,
.conversation-node[data-status="failed"] .conversation-node__card {
  border-color: var(--buddy-status-danger-border);
}
.conversation-node.status-failed:hover .conversation-node__card,
.conversation-node[data-status="failed"]:hover .conversation-node__card {
  border-color: var(--buddy-status-danger-text);
}
.conversation-node.status-failed.selected .conversation-node__card,
.conversation-node[data-status="failed"].selected .conversation-node__card {
  border-color: var(--buddy-status-danger-border);
  box-shadow: 0 0 0 1.5px var(--buddy-focus-ring), 0 2px 8px rgb(0 0 0 / 3%);
}

// Status borders: cancelled (muted border and dimmed)
.conversation-node.status-cancelled .conversation-node__card,
.conversation-node[data-status="cancelled"] .conversation-node__card {
  border-color: var(--buddy-border-subtle);
  opacity: 0.82;
}

@keyframes conversation-node-beam {
  from {
    --buddy-beam-angle: 0deg;
  }
  to {
    --buddy-beam-angle: 360deg;
  }
}

@media (prefers-reduced-motion: reduce) {
  .conversation-node.status-running .conversation-node__card::before,
  .conversation-node[data-status="running"] .conversation-node__card::before {
    animation: none;
    background: var(--buddy-accent-text);
  }
}
.conversation-node__header { display: flex; height: 44px; flex: none; align-items: center; gap: 8px; padding: 0 14px; cursor: grab; }
.conversation-node__role { color: var(--buddy-text-secondary); font-size: 16px; }
.conversation-node__tools, .conversation-node__status { font-size: 10px; color: var(--buddy-text-muted); }
.conversation-node__status.running, .conversation-node__status.queued { color: var(--buddy-accent-text); }
.conversation-node__status.failed { color: var(--buddy-status-danger-text); }
.conversation-node__trailing { display: flex; flex: none; align-items: center; gap: 6px; margin-left: auto; }
.conversation-node__body { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 8px; padding: 0 16px 12px; overflow: hidden; }
.conversation-node__quotes { display: flex; flex: none; height: 88px; align-items: flex-start; gap: 6px; overflow: hidden; }
.conversation-node__quotes :deep(.chat-quote-strip) { flex: 1; }
.conversation-node__text { flex: 1; min-height: 0; overflow: hidden; }
.conversation-node__preview { margin: 0; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.65; }
.conversation-node.busy .conversation-node__preview { display: block; }
.conversation-node__placeholder { margin: 4px 0; color: var(--buddy-text-muted); font-size: 12px; line-height: 1.7; }
.conversation-node__footer { margin-top: auto; display: flex; flex: none; align-items: center; gap: 8px; min-height: 30px; padding: 0 16px 10px; color: var(--buddy-text-muted); font-size: 10px; }
.conversation-node__model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conversation-node__duration { flex: none; margin-left: auto; font-variant-numeric: tabular-nums; }
.conversation-node__actions { display: flex; flex: none; gap: 2px; opacity: 0; pointer-events: none; transition: opacity 120ms ease; }
.conversation-node:hover .conversation-node__actions, .conversation-node:focus-within .conversation-node__actions { opacity: 1; pointer-events: auto; }
.conversation-node__actions button { display: grid; width: 26px; height: 26px; flex: none; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--buddy-text-secondary); cursor: pointer; }
.conversation-node__actions button:hover { background: var(--buddy-state-hover); color: var(--buddy-text-primary); }
.conversation-node__actions button:focus-visible, .conversation-node__more:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: 1px; }
.conversation-node__actions button:disabled { opacity: 0.35; cursor: default; }
.conversation-node__attachments, .conversation-node__artifacts { display: flex; flex: none; gap: 6px; align-items: center; }
.conversation-node__attachments { height: 44px; }
.conversation-node__artifacts { height: 68px; }
.conversation-node__attachment { display: flex; height: 44px; flex: 0 1 120px; max-width: 120px; background: var(--buddy-surface-raised); align-items: center; gap: 5px; min-width: 0; padding: 5px; border: 1px solid var(--buddy-border-subtle); border-radius: 5px; color: var(--buddy-text-secondary); font-size: 10px; }
.conversation-node__attachment img { width: 32px; height: 32px; flex: none; object-fit: cover; border-radius: 3px; }
.conversation-node__attachment span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conversation-node__more { flex: none; padding: 6px 2px; border: 0; border-radius: 4px; background: transparent; color: var(--buddy-accent-text); font-size: 10px; cursor: pointer; }
.conversation-node__more:hover { background: var(--buddy-state-hover); }
@media (hover: none) { .conversation-node__actions { opacity: 1; pointer-events: auto; } }
</style>
