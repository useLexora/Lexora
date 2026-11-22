<script setup lang="ts">
import type { AnnotationHistoryCommand, ImageAnnotationRect } from './imageAnnotation'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { computed, shallowRef, watch } from 'vue'
import { annotationHistoryShortcut, annotationMarkLayout, annotationPointInside, annotationRectFromDrag, displayPointToImage, imageContentRect } from './imageAnnotation'

const props = defineProps<{ image: HTMLImageElement | null, rects: readonly ImageAnnotationRect[], disabled?: boolean, label?: string }>()
const emit = defineEmits<{ commit: [rect: ImageAnnotationRect], history: [command: AnnotationHistoryCommand] }>()
const draft = shallowRef<ImageAnnotationRect | null>(null)
const frame = shallowRef({ left: 0, top: 0, width: 0, height: 0 })
let drag: { pointerId: number, start: { x: number, y: number } } | null = null

const natural = computed(() => ({
  width: props.image?.naturalWidth ?? 0,
  height: props.image?.naturalHeight ?? 0,
}))
const visible = computed(() => props.rects.map((rect, index) => ({ rect, layout: annotationMarkLayout(rect, index + 1, natural.value) })))
const draftLayout = computed(() => draft.value ? annotationMarkLayout(draft.value, props.rects.length + 1, natural.value) : null)

function sync() {
  const image = props.image
  const host = image?.parentElement
  if (!image || !host || image.naturalWidth < 1 || image.naturalHeight < 1) {
    frame.value = { left: 0, top: 0, width: 0, height: 0 }
    return
  }
  const content = imageContentRect(image.getBoundingClientRect(), { width: image.naturalWidth, height: image.naturalHeight })
  const hostBox = host.getBoundingClientRect()
  frame.value = {
    left: content.left - hostBox.left + host.scrollLeft,
    top: content.top - hostBox.top + host.scrollTop,
    width: content.width,
    height: content.height,
  }
}

function point(event: PointerEvent) {
  const image = props.image
  if (!image)
    return null
  const bounds = { width: image.naturalWidth, height: image.naturalHeight }
  const content = imageContentRect(image.getBoundingClientRect(), bounds)
  return displayPointToImage(event.clientX, event.clientY, content, bounds)
}

function focusSurface(event: PointerEvent) {
  if (event.currentTarget instanceof SVGElement)
    event.currentTarget.focus({ preventScroll: true })
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0)
    return
  focusSurface(event)
  if (props.disabled)
    return
  const image = props.image
  const start = point(event)
  if (!image || !start || !annotationPointInside(start, { width: image.naturalWidth, height: image.naturalHeight }))
    return
  drag = { pointerId: event.pointerId, start }
  draft.value = null
  if (event.currentTarget instanceof Element)
    event.currentTarget.setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onKeydown(event: KeyboardEvent) {
  const surface = event.currentTarget
  if (!(surface instanceof Element) || !surface.contains(document.activeElement))
    return
  const command = annotationHistoryShortcut(event)
  if (!command)
    return
  event.preventDefault()
  event.stopPropagation()
  drag = null
  draft.value = null
  if (!props.disabled)
    emit('history', command)
}

function onPointerMove(event: PointerEvent) {
  const image = props.image
  if (!drag || drag.pointerId !== event.pointerId || !image)
    return
  const next = point(event)
  draft.value = next ? annotationRectFromDrag(drag.start, next, { width: image.naturalWidth, height: image.naturalHeight }) : null
}

function finish(event: PointerEvent, commit: boolean) {
  if (!drag || drag.pointerId !== event.pointerId)
    return
  const rect = draft.value
  drag = null
  draft.value = null
  if (commit && rect && !props.disabled)
    emit('commit', rect)
}

watch(() => [props.image, props.image?.naturalWidth, props.image?.naturalHeight], sync, { immediate: true })
useResizeObserver(() => props.image, sync)
useResizeObserver(() => props.image?.parentElement ?? null, sync)
useEventListener(() => props.image?.parentElement ?? null, 'scroll', sync)
useEventListener(window, 'resize', sync)
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || !drag)
    return
  event.preventDefault()
  event.stopPropagation()
  drag = null
  draft.value = null
})
</script>

<template>
  <svg
    v-show="frame.width > 0 && natural.width > 0"
    class="image-annotation-surface"
    data-testid="image-annotation-surface"
    role="group"
    tabindex="0"
    :aria-label="label"
    :viewBox="`0 0 ${natural.width} ${natural.height}`"
    preserveAspectRatio="none"
    :style="{ left: `${frame.left}px`, top: `${frame.top}px`, width: `${frame.width}px`, height: `${frame.height}px` }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="finish($event, true)"
    @pointercancel="finish($event, false)"
    @keydown="onKeydown"
    @contextmenu.prevent
  >
    <template v-for="(mark, index) in visible" :key="index">
      <rect :x="mark.rect.x" :y="mark.rect.y" :width="mark.rect.width" :height="mark.rect.height" fill="none" stroke="currentColor" :stroke-width="mark.layout.strokeWidth" />
      <rect :x="mark.layout.badge.x" :y="mark.layout.badge.y" :width="mark.layout.badge.size" :height="mark.layout.badge.size" fill="currentColor" />
      <text data-testid="image-annotation-marker" :x="mark.layout.badge.x + mark.layout.badge.size / 2" :y="mark.layout.badge.y + mark.layout.badge.size / 2" :font-size="Math.max(10, Math.round(mark.layout.badge.size * 0.72))">{{ mark.layout.marker }}</text>
    </template>
    <rect v-if="draft && draftLayout" :x="draft.x" :y="draft.y" :width="draft.width" :height="draft.height" fill="none" stroke="currentColor" :stroke-width="draftLayout.strokeWidth" />
  </svg>
</template>

<style scoped>
.image-annotation-surface {
  position: absolute;
  z-index: 1;
  overflow: visible;
  color: var(--buddy-accent-solid);
  fill: var(--buddy-text-on-accent);
  font-family: var(--buddy-font-ui);
  cursor: crosshair;
  touch-action: none;
  user-select: none;
}
.image-annotation-surface:focus { outline: none; }
.image-annotation-surface:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: 2px; }
.image-annotation-surface text { text-anchor: middle; dominant-baseline: central; }
</style>
