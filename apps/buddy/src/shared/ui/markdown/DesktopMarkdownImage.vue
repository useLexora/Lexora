<script setup lang="ts">
import type { ImageNodeProps } from 'markstream-vue'
import type { MarkdownImageResolution } from './markdownImage'
import { ImageNode } from 'markstream-vue'
import { NButton } from 'naive-ui'
import { computed, inject, shallowRef, useTemplateRef, watch } from 'vue'
import { markdownImageContextKey } from './markdownImage'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  node: ImageNodeProps['node']
}>()

const context = inject(markdownImageContextKey, undefined)
const state = shallowRef<MarkdownImageResolution | { kind: 'loading' }>({ kind: 'default' })
const image = useTemplateRef<HTMLImageElement>('image')
const attempt = shallowRef(0)
const labels = computed(() => context?.language.value === 'zh-CN'
  ? { loading: '正在加载图片…', failed: '图片加载失败', retry: '重试' }
  : { loading: 'Loading image…', failed: 'Image failed to load', retry: 'Retry' })

watch([() => props.node.src, () => props.node.loading, () => context?.resolve.value, attempt], async ([src, loading, resolve], _, onCleanup) => {
  let active = true
  onCleanup(() => active = false)
  if (!resolve || loading) {
    state.value = { kind: 'default' }
    return
  }
  state.value = { kind: 'loading' }
  try {
    const result = await resolve(src)
    if (active)
      state.value = result
  }
  catch {
    if (active)
      state.value = { kind: 'unavailable' }
  }
}, { immediate: true })

function imageFailed(event: Event) {
  if (event.currentTarget === image.value)
    state.value = { kind: 'unavailable' }
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
    @error="imageFailed"
  >
  <ImageNode v-else-if="state.kind === 'default'" v-bind="$attrs" :node="node" />
  <span v-else class="desktop-markdown-image-status inline-flex items-center gap-2 text-muted align-middle" role="status">
    <span>{{ state.kind === 'loading' ? labels.loading : labels.failed }}</span>
    <NButton v-if="state.kind === 'unavailable'" text type="primary" size="small" @click="attempt++">
      {{ labels.retry }}
    </NButton>
  </span>
</template>
