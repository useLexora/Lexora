<script setup lang="ts">
import type { ImageNodeProps } from 'markstream-vue'
import { NButton } from 'naive-ui'
import { computed, inject, shallowRef, useTemplateRef, watch } from 'vue'
import { markdownImageContextKey } from './markdownImage'
import { classifyMarkdownImageSrc, formatBlockedRemoteImageLabel } from './safeMarkdownHtml'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  node: ImageNodeProps['node']
}>()

type ImageViewState
  = | { kind: 'loading' }
    | { kind: 'local', src: string }
    | { kind: 'remote', src: string }
    | { kind: 'blocked' }
    | { kind: 'unavailable', retryable: boolean }

const context = inject(markdownImageContextKey, undefined)
const state = shallowRef<ImageViewState>({ kind: 'loading' })
const image = useTemplateRef<HTMLImageElement>('image')
const attempt = shallowRef(0)

const labels = computed(() => context?.language.value === 'zh-CN'
  ? { loading: '正在加载图片…', failed: '图片加载失败', retry: '重试' }
  : { loading: 'Loading image…', failed: 'Image failed to load', retry: 'Retry' })

const blockedLabel = computed(() => formatBlockedRemoteImageLabel(props.node.alt ?? '', context?.language.value))
const unavailableLabel = computed(() => props.node.alt?.trim() || labels.value.failed)

watch(
  [() => props.node.src, () => props.node.loading, () => context?.resolve.value, () => context?.remoteImages.value, () => attempt.value],
  async ([rawSrc, loading, resolve, remotePolicy], _, onCleanup) => {
    let active = true
    onCleanup(() => {
      active = false
    })

    const src = rawSrc?.trim() ?? ''
    if (loading) {
      state.value = { kind: 'loading' }
      return
    }

    const kind = classifyMarkdownImageSrc(src)
    if (kind === 'remote-https') {
      state.value = remotePolicy === 'allow' ? { kind: 'remote', src } : { kind: 'blocked' }
      return
    }
    if (kind === 'remote-http') {
      state.value = { kind: 'blocked' }
      return
    }
    if (kind === 'local-protocol') {
      state.value = { kind: 'local', src }
      return
    }
    if (kind === 'blocked') {
      state.value = { kind: 'unavailable', retryable: false }
      return
    }

    if (!resolve) {
      state.value = { kind: 'unavailable', retryable: false }
      return
    }

    state.value = { kind: 'loading' }
    try {
      const result = await resolve(src)
      if (!active)
        return
      if (result.kind === 'local') {
        state.value = { kind: 'local', src: result.src }
        return
      }
      state.value = { kind: 'unavailable', retryable: true }
    }
    catch {
      if (active)
        state.value = { kind: 'unavailable', retryable: true }
    }
  },
  { immediate: true },
)

function imageFailed(event: Event) {
  if (event.currentTarget === image.value)
    state.value = { kind: 'unavailable', retryable: state.value.kind === 'local' }
}
</script>

<template>
  <img
    v-if="state.kind === 'local'"
    :key="state.src"
    ref="image"
    class="desktop-markdown-image inline-block max-w-full h-auto align-middle"
    :src="state.src"
    :alt="node.alt"
    loading="lazy"
    decoding="async"
    @error="imageFailed"
  >
  <img
    v-else-if="state.kind === 'remote'"
    :key="state.src"
    ref="image"
    class="desktop-markdown-image desktop-markdown-image--remote inline-block max-w-full h-auto align-middle"
    :src="state.src"
    :alt="node.alt"
    loading="lazy"
    decoding="async"
    referrerpolicy="no-referrer"
    @error="imageFailed"
  >
  <span v-else-if="state.kind === 'blocked'" class="desktop-markdown-image-blocked" role="status">
    {{ blockedLabel }}
  </span>
  <span v-else class="desktop-markdown-image-status inline-flex items-center gap-2 text-muted align-middle" role="status">
    <span>{{ state.kind === 'loading' ? labels.loading : (state.retryable ? labels.failed : unavailableLabel) }}</span>
    <NButton v-if="state.kind === 'unavailable' && state.retryable" text type="primary" size="small" @click="attempt++">
      {{ labels.retry }}
    </NButton>
  </span>
</template>
