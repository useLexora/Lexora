<script setup lang="ts">
import type { ConversationCanvasDirection } from '../../model/canvas/conversationCanvasLayout'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Add20Regular, ArrowDown20Regular, ArrowRight20Regular, Checkmark20Regular, Flowchart20Regular, Grid20Regular, Map20Regular, ScaleFit20Regular, Subtract20Regular } from '@vicons/fluent'
import { NPopover } from 'naive-ui'
import { shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ zoom: number, language: BuddyLocale }>()
const emit = defineEmits<{ arrange: [], fit: [], zoomBy: [delta: number], resetZoom: [] }>()
const direction = defineModel<ConversationCanvasDirection>('direction', { required: true })
const minimapVisible = defineModel<boolean>('minimapVisible', { required: true })
const { t } = useBuddyI18n(() => props.language)
const layoutOpen = shallowRef(false)
const layouts = [
  { value: 'horizontal', icon: ArrowRight20Regular },
  { value: 'vertical', icon: ArrowDown20Regular },
] as const
function setDirection(value: ConversationCanvasDirection) {
  direction.value = value
  layoutOpen.value = false
}
</script>

<template>
  <div class="conversation-canvas-toolbar flex w-full items-center justify-between gap-[2px] p-[5px] border-1 border-solid border-border rounded-[10px] bg-raised" role="toolbar" :aria-label="t('desktop.canvas.toolbar')" data-testid="canvas-toolbar">
    <NPopover v-model:show="layoutOpen" trigger="click" placement="bottom-start" :show-arrow="false" :theme-overrides="{ padding: '5px' }">
      <template #trigger>
        <button type="button" :class="{ active: layoutOpen }" :aria-expanded="layoutOpen" aria-haspopup="menu" :aria-label="t('desktop.canvas.layout')" :title="t('desktop.canvas.layout')" data-testid="canvas-layout-menu">
          <DesktopIcon :component="Flowchart20Regular" />
        </button>
      </template>
      <div class="conversation-canvas-layout grid w-[172px] gap-[2px]" role="menu" :aria-label="t('desktop.canvas.layout')" @keydown.esc="layoutOpen = false">
        <button v-for="layout in layouts" :key="layout.value" class="conversation-canvas-layout__option flex items-center gap-[10px] py-[9px] px-[10px] border-0 rounded-[4px] bg-transparent text-muted text-[12px] cursor-pointer" type="button" role="menuitemradio" :aria-checked="direction === layout.value" :data-testid="`canvas-layout-${layout.value}`" @click="setDirection(layout.value)">
          <DesktopIcon :component="layout.icon" />
          <span>{{ t(`desktop.canvas.${layout.value}`) }}</span>
          <DesktopIcon v-if="direction === layout.value" :component="Checkmark20Regular" />
        </button>
      </div>
    </NPopover>
    <button type="button" :aria-label="t('desktop.canvas.arrange')" :title="t('desktop.canvas.arrange')" data-testid="canvas-arrange" @click="emit('arrange')">
      <DesktopIcon :component="Grid20Regular" />
    </button>
    <span class="h-[16px] my-0 mx-[3px] border-l-1 border-l-solid border-l-border" />
    <button type="button" :aria-label="t('desktop.canvas.fit')" :title="t('desktop.canvas.fit')" data-testid="canvas-fit" @click="emit('fit')">
      <DesktopIcon :component="ScaleFit20Regular" />
    </button>
    <button type="button" :aria-label="t('desktop.canvas.zoomOut')" :title="t('desktop.canvas.zoomOut')" @click="emit('zoomBy', -0.1)">
      <DesktopIcon :component="Subtract20Regular" />
    </button>
    <button class="conversation-canvas-toolbar__scale" type="button" :aria-label="t('desktop.canvas.resetZoom')" :title="t('desktop.canvas.resetZoom')" data-testid="canvas-reset-zoom" @click="emit('resetZoom')">
      {{ zoom }}%
    </button>
    <button type="button" :aria-label="t('desktop.canvas.zoomIn')" :title="t('desktop.canvas.zoomIn')" @click="emit('zoomBy', 0.1)">
      <DesktopIcon :component="Add20Regular" />
    </button>
    <span class="h-[16px] my-0 mx-[3px] border-l-1 border-l-solid border-l-border" />
    <button type="button" :class="{ active: minimapVisible }" :aria-pressed="minimapVisible" :aria-label="t('desktop.canvas.minimap')" :title="t('desktop.canvas.minimap')" data-testid="canvas-minimap-toggle" @click="minimapVisible = !minimapVisible">
      <DesktopIcon :component="Map20Regular" />
    </button>
  </div>
</template>

<style scoped lang="scss">
.conversation-canvas-toolbar { box-shadow: 0 3px 12px rgb(0 0 0 / 4%); }
.conversation-canvas-toolbar button { display: inline-flex; width: 30px; height: 30px; flex: none; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--buddy-text-secondary); font-size: 14px; cursor: pointer; }
.conversation-canvas-toolbar button:hover, .conversation-canvas-layout__option:hover { background: var(--buddy-state-hover); }
.conversation-canvas-toolbar button.active { background: var(--buddy-accent-surface); color: var(--buddy-accent-on-surface); }
.conversation-canvas-toolbar button:focus-visible, .conversation-canvas-layout__option:focus-visible { outline: 2px solid var(--buddy-accent-border); }
.conversation-canvas-toolbar .conversation-canvas-toolbar__scale { width: 44px; font-size: 11px; font-variant-numeric: tabular-nums; }
.conversation-canvas-layout__option[aria-checked='true'] { color: var(--buddy-accent-text); }
.conversation-canvas-layout__option span { flex: 1; text-align: left; }
</style>
