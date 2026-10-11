<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'

const props = defineProps<{
  paused?: boolean
  text: string
}>()

const viewport = useTemplateRef<HTMLElement>('viewport')
const content = useTemplateRef<HTMLElement>('content')
const overflowDistance = shallowRef(0)
const hovered = shallowRef(false)
const scrolling = shallowRef(false)
const style = computed<Record<string, string>>(() => ({
  '--desktop-overflow-label-distance': `${overflowDistance.value}px`,
  '--desktop-overflow-label-duration': `${Math.max(1.8, overflowDistance.value / 32)}s`,
}))

function measure() {
  overflowDistance.value = Math.max(
    0,
    Math.ceil((content.value?.scrollWidth ?? 0) - (viewport.value?.clientWidth ?? 0)),
  )
  if (overflowDistance.value === 0)
    scrolling.value = false
}

function startScrolling() {
  hovered.value = true
  if (props.paused)
    return
  measure()
  scrolling.value = overflowDistance.value > 0
}

function stopScrolling() {
  hovered.value = false
  scrolling.value = false
}

useResizeObserver(viewport, measure)
useResizeObserver(content, measure)
watch(
  () => props.text,
  async () => {
    stopScrolling()
    await nextTick()
    measure()
  },
)
watch(
  () => props.paused,
  (paused) => {
    scrolling.value = false
    if (!paused && hovered.value)
      startScrolling()
  },
)
</script>

<template>
  <span
    ref="viewport"
    class="desktop-overflow-label block min-w-0 overflow-hidden relative whitespace-nowrap"
    :class="{ 'is-overflowing': overflowDistance > 0, 'is-scrolling': scrolling }"
    :style="style"
    @mouseenter="startScrolling"
    @mouseleave="stopScrolling"
  >
    <span class="desktop-overflow-label__ellipsis block overflow-hidden text-ellipsis whitespace-nowrap">{{ text }}</span>
    <span
      ref="content"
      aria-hidden="true"
      class="desktop-overflow-label__content block w-max min-w-full opacity-0 absolute"
    >{{ text }}</span>
  </span>
</template>

<style scoped lang="scss">
.desktop-overflow-label__content {
  inset: 0 auto auto 0;
  transform: translateX(0);
  transition: transform 160ms ease-out;
}

.desktop-overflow-label.is-scrolling .desktop-overflow-label__ellipsis {
  opacity: 0;
}

.desktop-overflow-label.is-overflowing.is-scrolling .desktop-overflow-label__content {
  opacity: 1;
  transform: translateX(calc(-1 * var(--desktop-overflow-label-distance)));
  transition:
    transform var(--desktop-overflow-label-duration) linear 320ms;
}

@media (prefers-reduced-motion: reduce) {
  .desktop-overflow-label__content,
  .desktop-overflow-label.is-overflowing.is-scrolling .desktop-overflow-label__content {
    transition-duration: 1ms;
    transition-delay: 0ms;
  }
}
</style>
