<script setup lang="ts">
import type { ImageNodeProps } from 'markstream-vue'
import { ImageNode } from 'markstream-vue'
import { computed, inject, shallowRef, watch } from 'vue'
import { markdownImageResolverKey } from './markdownImage'

// Markstream drops every URL scheme outside http, https and data from an image, so an image the app serves itself needs its own element.
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  node: ImageNodeProps['node']
}>()

const resolver = inject(markdownImageResolverKey, undefined)
const localSrc = computed(() => props.node.loading ? null : resolver?.value?.(props.node.src) ?? null)
const failed = shallowRef(false)
watch(localSrc, () => failed.value = false)
</script>

<template>
  <img
    v-if="localSrc && !failed"
    class="desktop-markdown-image inline-block max-w-full h-auto align-middle"
    :src="localSrc"
    :alt="node.alt"
    :title="node.title ?? undefined"
    loading="lazy"
    @error="failed = true"
  >
  <ImageNode v-else v-bind="$attrs" :node="node" />
</template>
