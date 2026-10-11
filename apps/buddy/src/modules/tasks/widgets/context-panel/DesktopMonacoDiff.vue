<script setup lang="ts">
import type { editor } from 'monaco-editor/editor/editor.api.js'
import { computed, shallowRef, useTemplateRef } from 'vue'
import { useMonacoDiff } from './useMonacoDiff'

const props = defineProps<{
  after: string
  before: string
  language: string | null
  path: string
  wrap?: boolean
  sideBySide?: boolean
  fitContent?: boolean
  initialHeight?: number
  viewState?: editor.IDiffEditorViewState | null
}>()
const emit = defineEmits<{
  height: [height: number]
  viewState: [state: editor.IDiffEditorViewState | null]
}>()

const container = useTemplateRef<HTMLDivElement>('container')
const contentHeight = shallowRef(props.initialHeight ?? 160)
const { failed, loading } = useMonacoDiff({
  container,
  language: computed(() => props.language),
  modified: computed(() => props.after),
  original: computed(() => props.before),
  path: computed(() => props.path),
  wrap: computed(() => props.wrap ?? false),
  sideBySide: computed(() => props.sideBySide ?? true),
  getViewState: () => props.viewState ?? null,
  onViewState: state => emit('viewState', state),
  onHeight: (height) => {
    const nextHeight = Math.min(800, Math.max(80, height))
    if (contentHeight.value !== nextHeight) {
      contentHeight.value = nextHeight
      emit('height', nextHeight)
    }
  },
})
</script>

<template>
  <div class="desktop-monaco-diff relative min-w-0 min-h-0 h-full bg-surface" :style="fitContent ? { height: `${contentHeight}px` } : undefined">
    <div ref="container" class="w-full h-full" />
    <div v-if="loading" class="desktop-monaco-diff__status absolute inset-0 grid place-items-center bg-surface text-muted text-[0.76rem]">
      <slot name="loading" />
    </div>
    <div v-else-if="failed" class="desktop-monaco-diff__status is-error absolute inset-0 grid place-items-center bg-surface text-muted text-[0.76rem]">
      <slot name="error" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-monaco-diff__status.is-error {
  color: var(--buddy-status-danger-text);
}
</style>
