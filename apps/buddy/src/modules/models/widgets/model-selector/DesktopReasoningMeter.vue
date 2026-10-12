<script setup lang="ts">
import type { BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { ReasoningSelectorOption } from './typing'
import { computed, shallowRef } from 'vue'
import DesktopReasoningFieldCanvas from '@/modules/models/widgets/model-selector/DesktopReasoningFieldCanvas.vue'

const props = defineProps<{
  disabled?: boolean
  label: string
  options: ReadonlyArray<ReasoningSelectorOption>
  selectedEffort: BuddyThinkingLevel | null
}>()

const emit = defineEmits<{
  dragging: [value: boolean]
  preview: [value: BuddyThinkingLevel | null]
  select: [value: BuddyThinkingLevel]
}>()

const previewIndex = shallowRef<number | null>(null)
const isDragging = shallowRef(false)
const selectedIndex = computed(() => Math.max(
  0,
  props.options.findIndex(option => option.value === props.selectedEffort),
))
const visualIndex = computed(() => previewIndex.value ?? selectedIndex.value)
const visualOption = computed(() => props.options[visualIndex.value] ?? null)
const progressRatio = computed(() => (
  props.options.length <= 1
    ? 0
    : visualIndex.value / (props.options.length - 1)
))

function previewSelection(event: Event) {
  if (props.disabled)
    return
  const index = readSliderIndex(event)
  const option = props.options[index]
  if (!option)
    return
  previewIndex.value = index
  emit('preview', option.value)
}

function commitSelection(event: Event) {
  if (props.disabled)
    return
  const index = readSliderIndex(event)
  const option = props.options[index]
  if (!option)
    return
  emit('select', option.value)
  clearPreview()
}

function clearPreview() {
  previewIndex.value = null
  updateDragging(false)
  emit('preview', null)
}

function updateDragging(value: boolean) {
  if (isDragging.value === value)
    return
  isDragging.value = value
  emit('dragging', value)
}

function startDragging(event: PointerEvent) {
  if (props.disabled) {
    event.preventDefault()
    return
  }
  updateDragging(true)
}

function handleKeydown(event: KeyboardEvent) {
  if (props.disabled && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))
    event.preventDefault()
}

function readSliderIndex(event: Event): number {
  if (!(event.currentTarget instanceof HTMLInputElement))
    return selectedIndex.value
  return Math.max(0, Math.min(props.options.length - 1, Number(event.currentTarget.value)))
}
</script>

<template>
  <div
    class="desktop-reasoning-meter relative h-8 isolate select-none"
    :class="{ 'is-dragging': isDragging }"
  >
    <div class="desktop-reasoning-meter__stage absolute" aria-hidden="true">
      <span class="desktop-reasoning-meter__track absolute top-[50%] right-0 left-0 h-7 overflow-hidden rounded-[999px] isolate">
        <DesktopReasoningFieldCanvas
          :dragging="isDragging"
          :progress="progressRatio"
        />
        <span class="desktop-reasoning-meter__nodes absolute top-[50%] right-[var(--reasoning-track-inset)] left-[var(--reasoning-track-inset)] z-5 flex items-center justify-between pointer-events-none">
          <i
            v-for="(option, index) in options"
            :key="option.value"
            class="desktop-reasoning-meter__node block w-[0.27rem] h-[0.27rem] rounded-[0.07rem]"
            :class="{
              'is-active': index <= visualIndex,
              'is-selected': index === visualIndex,
            }"
          />
        </span>
      </span>
    </div>
    <input
      class="desktop-reasoning-meter__control absolute z-7 w-[calc(100%_-_0.1rem)] h-7 m-0 bg-transparent cursor-grab opacity-0 active:cursor-grabbing"
      type="range"
      min="0"
      :max="Math.max(0, options.length - 1)"
      step="1"
      :value="visualIndex"
      :aria-label="label"
      :aria-disabled="disabled"
      :aria-valuetext="visualOption?.label ?? ''"
      @pointerdown="startDragging"
      @keydown="handleKeydown"
      @pointerup="updateDragging(false)"
      @pointercancel="clearPreview"
      @input="previewSelection"
      @change="commitSelection"
    >
  </div>
</template>

<style scoped lang="scss">
.desktop-reasoning-meter {
  --reasoning-node-active-background: color-mix(in srgb, var(--buddy-surface-raised) 85%, var(--buddy-brand-gold));
  --reasoning-node-active-border: color-mix(in srgb, var(--buddy-brand-gold) 72%, var(--buddy-text-strong));
  --reasoning-node-active-shadow:
    0 0 0.14rem color-mix(in srgb, var(--buddy-surface-raised) 66%, transparent),
    0 0 0.3rem color-mix(in srgb, var(--buddy-brand-gold) 26%, transparent);
  --reasoning-node-background: color-mix(in srgb, var(--buddy-text-disabled) 50%, transparent);
  --reasoning-node-border: var(--buddy-border-strong);
  --reasoning-track-background:
    linear-gradient(180deg, var(--buddy-surface-raised), var(--buddy-surface-canvas));
  --reasoning-track-border: var(--buddy-border-strong);
  --reasoning-track-drag-border: var(--buddy-accent-border-hover);
  --reasoning-track-drag-shadow:
    inset 0 1px 0 var(--buddy-border-subtle),
    inset 0 -1px 0 var(--buddy-border-subtle),
    0 0 0.72rem color-mix(in srgb, var(--buddy-accent-text) 22%, transparent),
    var(--buddy-shadow-soft);
  --reasoning-track-hover-border: var(--buddy-accent-border);
  --reasoning-track-inset: 0.75rem;
  --reasoning-track-shadow:
    inset 0 1px 0 var(--buddy-border-subtle),
    inset 0 -1px 0 var(--buddy-border-subtle),
    var(--buddy-shadow-soft);
}

.desktop-reasoning-meter__stage {
  inset: 0.125rem 0.05rem;
}

.desktop-reasoning-meter__track {
  border: 1px solid var(--reasoning-track-border);
  background: var(--reasoning-track-background);
  box-shadow: var(--reasoning-track-shadow);
  transform: translateY(-50%);
  transition:
    border-color 140ms ease,
    box-shadow 180ms ease;
}

.desktop-reasoning-meter__track::after {
  position: absolute;
  inset: 1px 0 auto;
  z-index: 4;
  height: 34%;
  border-radius: 999px 999px 46% 46%;
  background: linear-gradient(180deg, color-mix(in srgb, var(--buddy-text-strong) 12%, transparent), transparent);
  content: '';
  pointer-events: none;
}

.desktop-reasoning-meter__nodes {
  transform: translateY(-50%);
}

.desktop-reasoning-meter__node {
  border: 1px solid var(--reasoning-node-border);
  background: var(--reasoning-node-background);
  transform: rotate(45deg);
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    box-shadow 180ms ease,
    filter 180ms ease,
    transform 180ms ease;
}

.desktop-reasoning-meter__node.is-active {
  border-color: var(--reasoning-node-active-border);
  background: var(--reasoning-node-active-background);
  box-shadow: var(--reasoning-node-active-shadow);
}

.desktop-reasoning-meter__control {
  inset: 0.125rem 0.05rem;
  appearance: none;
  touch-action: none;
}

.desktop-reasoning-meter__control::-webkit-slider-runnable-track {
  height: 1.75rem;
  border: 0;
  background: transparent;
}

.desktop-reasoning-meter__control::-webkit-slider-thumb {
  width: 1.5rem;
  height: 1.5rem;
  margin-top: 0.125rem;
  appearance: none;
  border: 0;
  background: transparent;
}

.desktop-reasoning-meter:hover .desktop-reasoning-meter__track {
  border-color: var(--reasoning-track-hover-border);
}

.desktop-reasoning-meter:has(.desktop-reasoning-meter__control:focus-visible) .desktop-reasoning-meter__track {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: 2px;
}

.desktop-reasoning-meter.is-dragging .desktop-reasoning-meter__track {
  border-color: var(--reasoning-track-drag-border);
  box-shadow: var(--reasoning-track-drag-shadow);
}

@media (prefers-reduced-motion: reduce) {
  .desktop-reasoning-meter__node {
    transition: none;
  }
}
</style>
