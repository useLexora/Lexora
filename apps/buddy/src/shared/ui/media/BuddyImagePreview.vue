<script setup lang="ts">
import type { ImageGroupProps } from 'naive-ui'
import type { VNode } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NImageGroup } from 'naive-ui'
import { computed, h } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { usePreviewWheelZoom } from './usePreviewWheelZoom'

const props = defineProps<{
  language: BuddyLocale
  sources: ReadonlyArray<string>
}>()
const current = defineModel<number>('current', { default: 0 })
const show = defineModel<boolean>('show', { default: false })

const { t } = useBuddyI18n(() => props.language)
const sourceList = computed(() => [...props.sources])
usePreviewWheelZoom()
const renderToolbar: NonNullable<ImageGroupProps['renderToolbar']> = ({ nodes }) => h(
  'div',
  { class: 'buddy-image-preview-toolbar' },
  [
    h('div', { class: 'buddy-image-preview-toolbar__group' }, [
      toolbarButton(nodes.prev, t('desktop.imagePreview.previous')),
      toolbarButton(nodes.next, t('desktop.imagePreview.next')),
    ]),
    h('span', { 'aria-hidden': 'true', 'class': 'buddy-image-preview-toolbar__divider' }),
    h('div', { class: 'buddy-image-preview-toolbar__group' }, [
      toolbarButton(nodes.zoomOut, t('desktop.imagePreview.zoomOut'), 'out'),
      toolbarButton(nodes.zoomIn, t('desktop.imagePreview.zoomIn'), 'in'),
    ]),
    h('span', { 'aria-hidden': 'true', 'class': 'buddy-image-preview-toolbar__divider' }),
    h('div', { class: 'buddy-image-preview-toolbar__group' }, [
      toolbarButton(nodes.download, t('desktop.imagePreview.download')),
      toolbarButton(nodes.close, t('desktop.imagePreview.close'), 'close'),
    ]),
  ],
)

function toolbarButton(node: VNode, label: string, action?: 'in' | 'out' | 'close'): VNode {
  return h('button', {
    'aria-label': label,
    'data-preview-zoom': action === 'close' ? undefined : action,
    'class': [
      'buddy-image-preview-toolbar__button',
      { 'is-close': action === 'close' },
    ],
    'type': 'button',
    'onClick': (event: MouseEvent) => invokeToolbarNode(node, event),
  }, [node])
}

function invokeToolbarNode(node: VNode, event: MouseEvent): void {
  const handler = node.props?.onClick as ((event: MouseEvent) => void) | ReadonlyArray<(
    event: MouseEvent,
  ) => void> | undefined
  if (typeof handler === 'function') {
    handler(event)
    return
  }
  for (const currentHandler of handler ?? [])
    currentHandler(event)
}
</script>

<template>
  <NImageGroup
    v-model:current="current"
    v-model:show="show"
    :show-toolbar-tooltip="false"
    :render-toolbar="renderToolbar"
    :src-list="sourceList"
  />
</template>

<style scoped>
:global(.n-image-preview-container .n-image-preview) {
  max-width: min(72vw, 64rem) !important;
  max-height: min(72vh, 48rem) !important;
}

:global(.n-image-preview-container .n-image-preview-toolbar) {
  height: auto !important;
  bottom: 20px !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 !important;
}

:global(.buddy-image-preview-toolbar) {
  display: flex;
  height: 34px;
  box-sizing: border-box;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--buddy-media-overlay-border);
  border-radius: 10px;
  background: var(--buddy-media-overlay-background);
  box-shadow: var(--buddy-media-overlay-shadow);
  padding: 2px 3px;
  backdrop-filter: blur(12px);
}

:global(.buddy-image-preview-toolbar__group) {
  display: flex;
  align-items: center;
  gap: 2px;
}

:global(.buddy-image-preview-toolbar__divider) {
  width: 1px;
  height: 16px;
  flex: none;
  background: var(--buddy-media-overlay-divider);
}

:global(.buddy-image-preview-toolbar__button) {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  border: 0;
  border-radius: var(--buddy-radius-micro);
  background: transparent;
  color: var(--buddy-media-overlay-text);
  cursor: pointer;
  padding: 0;
  transition:
    background-color 80ms ease,
    color 80ms ease;
}

:global(.buddy-image-preview-toolbar__button:hover) {
  background: var(--buddy-media-overlay-hover);
  color: var(--buddy-text-on-accent);
}

:global(.buddy-image-preview-toolbar__button:focus-visible) {
  outline: 2px solid var(--buddy-media-overlay-focus);
  outline-offset: 1px;
}

:global(.buddy-image-preview-toolbar__button.is-close:hover) {
  background: var(--buddy-media-overlay-danger-hover);
}

:global(.buddy-image-preview-toolbar__button .n-base-icon) {
  padding: 0 !important;
  font-size: 18px !important;
  pointer-events: none;
}
</style>
