<script setup lang="ts">
import type { ConversationCanvasDirection, ConversationCanvasNode } from '../../model/canvas/conversationCanvasLayout'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { getTeleport } from '@antv/x6-vue-shape'
import { computed, provide, shallowRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { conversationCanvasActions } from './conversationCanvasContext'
import ConversationCanvasToolbar from './ConversationCanvasToolbar.vue'
import { useConversationCanvas } from './useConversationCanvas'

const props = defineProps<{
  nodes: readonly ConversationCanvasNode[]
  conversationId: string | null
  canMutate: boolean
  language: BuddyLocale
  active: boolean
  loading: boolean
  error: string | null
  selectedNodeId: string | null
}>()
const emit = defineEmits<{
  followup: [id: string]
  retry: [id: string]
  open: [id: string]
  edit: [id: string]
  openArtifact: [id: string]
  openQuote: [messageId: string, quoteId: string]
  refresh: []
}>()
const { t } = useBuddyI18n(() => props.language)
const container = useTemplateRef<HTMLElement>('container')
const controls = useTemplateRef<HTMLElement>('controls')
const TeleportContainer = getTeleport()
const minimapContainer = useTemplateRef<HTMLElement>('minimapContainer')
const minimapVisible = shallowRef(false)
const direction = shallowRef<ConversationCanvasDirection>('horizontal')
const canvas = useConversationCanvas({
  container,
  controls,
  active: computed(() => props.active),
  nodes: computed(() => props.nodes),
  direction,
  minimapContainer,
  minimapVisible,
  canMutate: computed(() => props.canMutate),
  conversationId: computed(() => props.conversationId),
})

provide(conversationCanvasActions, {
  language: computed(() => props.language),
  active: computed(() => props.active),
  selectedNodeId: computed(() => props.selectedNodeId),
  open: id => emit('open', id),
  edit: id => emit('edit', id),
  retry: id => emit('retry', id),
  followup: id => emit('followup', id),
  openArtifact: id => emit('openArtifact', id),
  openQuote: (messageId, quoteId) => emit('openQuote', messageId, quoteId),
})

defineExpose({
  focusNode(id: string) {
    canvas.focus(id)
  },
})
</script>

<template>
  <section class="conversation-canvas" data-testid="conversation-canvas" :data-direction="direction">
    <div ref="container" class="conversation-canvas__graph" />
    <TeleportContainer />
    <div ref="controls" class="conversation-canvas__controls">
      <ConversationCanvasToolbar
        v-model:direction="direction" v-model:minimap-visible="minimapVisible"
        :zoom="canvas.zoom.value" :language="language"
        @arrange="canvas.resetLayout" @fit="canvas.fit" @zoom-by="canvas.zoomBy" @reset-zoom="canvas.resetZoom"
      />
      <div v-show="minimapVisible" ref="minimapContainer" class="conversation-canvas__minimap" data-testid="canvas-minimap" />
    </div>
    <div v-if="loading || error" class="conversation-canvas__notice" role="status">
      {{ error || t('desktop.canvas.loading') }}
      <button v-if="error" type="button" @click="emit('refresh')">
        {{ t('desktop.canvas.reload') }}
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.conversation-canvas { position: relative; flex: 1; min-height: 0; overflow: hidden; background: var(--buddy-surface-base); }
.conversation-canvas__graph { position: absolute; inset: 0; }
.conversation-canvas__controls { position: absolute; top: 16px; left: 16px; display: grid; width: 280px; gap: 8px; }
.conversation-canvas__notice { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); padding: 10px 16px; background: var(--buddy-surface-raised); border: 1px solid var(--buddy-border-subtle); border-radius: 8px; color: var(--buddy-text-secondary); font-size: 12px; }
.conversation-canvas__notice button { margin-left: 8px; border: 0; background: transparent; color: var(--buddy-accent-text); font-size: 12px; cursor: pointer; }
.conversation-canvas__minimap { width: 100%; height: 176px; overflow: hidden; border: 1px solid var(--buddy-border-subtle); border-radius: 10px; background: var(--buddy-surface-raised); box-shadow: 0 3px 12px rgb(0 0 0 / 3%); }
.conversation-canvas__minimap :deep(.x6-widget-minimap-viewport) { border-color: var(--buddy-accent-text); background: color-mix(in srgb, var(--buddy-accent-text) 8%, transparent); }
.conversation-canvas :deep(.x6-node foreignObject) { overflow: visible; }
.conversation-canvas :deep(.x6-widget-snapline-horizontal), .conversation-canvas :deep(.x6-widget-snapline-vertical) { stroke: var(--buddy-accent-text); }
</style>
