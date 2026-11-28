<script setup lang="ts">
import { computed, inject, shallowRef, useTemplateRef, watch } from 'vue'
import { markdownImageContextKey } from './markdownImage'
import { resolveMarkdownHtmlImages } from './resolveMarkdownHtmlImages'
import { isForbiddenMarkdownHtmlTag, markdownHtmlContextKey, sanitizeMarkdownHtmlFragment } from './safeMarkdownHtml'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  node: {
    type: 'html_inline'
    tag?: string
    content: string
    loading?: boolean
    autoClosed?: boolean
  }
}>()

const htmlContext = inject(markdownHtmlContextKey, undefined)
const imageContext = inject(markdownImageContextKey, undefined)
const host = useTemplateRef<HTMLElement>('host')
const empty = shallowRef(false)

const allowImages = computed(() => htmlContext?.allowImages.value ?? true)
const remoteImages = computed(() => htmlContext?.remoteImages.value ?? 'block')
const streamingTextFallback = computed(() => (
  Boolean(props.node.loading)
  && !props.node.autoClosed
  && !isForbiddenMarkdownHtmlTag(props.node.tag, allowImages.value)
))

watch(
  [host, streamingTextFallback, () => props.node.content, allowImages, remoteImages, () => imageContext?.resolve.value, () => props.node.loading, () => imageContext?.language.value],
  ([element, fallback, raw, images, remotePolicy, resolve, loading, language], _, onCleanup) => {
    if (!element || fallback)
      return
    const result = sanitizeMarkdownHtmlFragment(raw, {
      allowImages: images,
      remoteImages: remotePolicy,
      language,
    })
    empty.value = !result.hasContent
    element.replaceChildren(result.fragment)
    const cancel = resolveMarkdownHtmlImages(result.pendingImages, result.remoteImages, resolve, {
      loading: Boolean(loading),
      language,
    })
    onCleanup(cancel)
  },
  { immediate: true, flush: 'post' },
)
</script>

<template>
  <span v-if="streamingTextFallback" class="buddy-markdown-html-inline">{{ node.content }}</span>
  <span v-else v-show="!empty" ref="host" class="buddy-markdown-html-inline" />
</template>
