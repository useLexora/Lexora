<script setup lang="ts">
import type { NodeRendererProps } from 'markstream-vue'
import MarkdownRender from 'markstream-vue'
import { computed, inject, shallowRef, useTemplateRef, watch } from 'vue'
import { markdownImageContextKey } from './markdownImage'
import { resolveMarkdownHtmlImages } from './resolveMarkdownHtmlImages'
import { isAllowedMarkdownHtmlTag, markdownHtmlContextKey, sanitizeMarkdownHtmlAttrs, sanitizeMarkdownHtmlFragment } from './safeMarkdownHtml'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  node: HtmlBlockNodeLike
  customId?: string
}>()

interface HtmlBlockNodeLike {
  type?: string
  content: string
  raw?: string
  tag?: string
  attrs?: [string, string][] | null
  children?: NonNullable<NodeRendererProps['nodes']>
  loading?: boolean
}

const htmlContext = inject(markdownHtmlContextKey, undefined)
const imageContext = inject(markdownImageContextKey, undefined)
const host = useTemplateRef<HTMLElement>('host')
const empty = shallowRef(false)

const allowImages = computed(() => htmlContext?.allowImages.value ?? true)
const remoteImages = computed(() => htmlContext?.remoteImages.value ?? 'block')
const normalizedTag = computed(() => props.node.tag?.trim().toLowerCase() ?? '')
const children = computed(() => Array.isArray(props.node.children) ? props.node.children : [])

const isStructured = computed(() => (
  children.value.length > 0
  && Boolean(normalizedTag.value)
  && normalizedTag.value !== 'summary'
  && isAllowedMarkdownHtmlTag(normalizedTag.value, allowImages.value)
))

const containerAttrs = computed(() => sanitizeMarkdownHtmlAttrs(props.node.attrs, normalizedTag.value, {
  allowImages: allowImages.value,
  remoteImages: remoteImages.value,
}))

const summaryChild = computed<HtmlBlockNodeLike | null>(() => {
  if (!isStructured.value || normalizedTag.value !== 'details')
    return null
  const first = children.value[0] as HtmlBlockNodeLike | undefined
  return first?.type === 'html_block' && first.tag?.trim().toLowerCase() === 'summary' ? first : null
})

const summaryHost = useTemplateRef<HTMLElement>('summaryHost')
const summaryAttrs = computed(() => summaryChild.value
  ? sanitizeMarkdownHtmlAttrs(summaryChild.value.attrs, 'summary', {
      allowImages: allowImages.value,
      remoteImages: remoteImages.value,
    })
  : {})
const summaryInnerHtml = computed(() => {
  const raw = summaryChild.value?.content ?? ''
  return raw.replace(/^<summary\b[^>]*>/i, '').replace(/<\/summary>\s*$/i, '')
})

const bodyChildren = computed(() => summaryChild.value ? children.value.slice(1) : children.value)

const nestedProps = computed(() => ({
  ...htmlContext?.nestedRendererProps.value,
  customId: props.customId ?? htmlContext?.nestedRendererProps.value.customId,
}))

watch(
  [host, isStructured, () => props.node.content, allowImages, remoteImages, () => imageContext?.resolve.value, () => props.node.loading, () => imageContext?.language.value],
  ([element, structured, raw, images, remotePolicy, resolve, loading, language], _, onCleanup) => {
    if (!element || structured)
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

watch(
  [summaryHost, summaryInnerHtml, allowImages, remoteImages, () => imageContext?.resolve.value, () => props.node.loading, () => imageContext?.language.value],
  ([element, raw, images, remotePolicy, resolve, loading, language], _, onCleanup) => {
    if (!element)
      return
    const result = sanitizeMarkdownHtmlFragment(raw, {
      allowImages: images,
      remoteImages: remotePolicy,
      language,
    })
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
  <component :is="normalizedTag" v-if="isStructured" class="buddy-markdown-html-block" v-bind="containerAttrs">
    <summary v-if="summaryChild" ref="summaryHost" v-bind="summaryAttrs" />
    <MarkdownRender v-if="bodyChildren.length" v-bind="nestedProps" :nodes="bodyChildren" />
  </component>
  <div v-else v-show="!empty" ref="host" class="buddy-markdown-html-block" />
</template>
