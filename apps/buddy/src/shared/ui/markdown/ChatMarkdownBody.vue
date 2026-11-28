<script setup lang="ts">
import type { NodeRendererProps, SmoothMarkdownStreamOptions } from 'markstream-vue'
import type { MarkdownRemoteImagePolicy } from './markdownImage'
import { usePreferredReducedMotion } from '@vueuse/core'
import MarkdownRender from 'markstream-vue'
import { computed, provide } from 'vue'
import { markdownHtmlContextKey } from './safeMarkdownHtml'
import { safeMarkdownCustomId } from './safeMarkdownRenderers'
import 'katex/dist/katex.min.css'
import 'markstream-vue/index.css'

const props = withDefaults(defineProps<{
  themeVariables?: Record<string, string>
  content: string
  customId?: string
  allowImages?: boolean
  remoteImages?: MarkdownRemoteImagePolicy
  codeOverflow?: 'wrap' | 'scroll'
  final?: boolean
  animate?: boolean
  isDark: boolean
  writeClipboardText: (text: string) => Promise<void>
}>(), { allowImages: true, remoteImages: 'block', final: true, animate: true })

const resolvedCustomId = computed(() => props.customId ?? safeMarkdownCustomId)
const disableImages: NonNullable<NodeRendererProps['customMarkdownIt']> = md => md.disable('image')
const codeBlockProps = computed<NonNullable<NodeRendererProps['codeBlockProps']>>(() => ({
  clipboardWriter: props.writeClipboardText,
}))
const mermaidProps = computed(() => ({
  fitPreviewHeight: true,
  clipboardWriter: props.writeClipboardText,
}))
const nestedRendererProps = computed<Partial<NodeRendererProps>>(() => ({
  batchRendering: false,
  codeBlockOptions: props.codeOverflow ? { overflow: props.codeOverflow } : undefined,
  codeBlockProps: codeBlockProps.value,
  customId: resolvedCustomId.value,
  customMarkdownIt: props.allowImages ? undefined : disableImages,
  fade: false,
  final: props.final,
  htmlPolicy: 'safe',
  isDark: props.isDark,
  mermaidProps: mermaidProps.value,
  mode: 'chat',
  renderCodeBlocksAsPre: true,
  smoothStreaming: false,
  typewriter: false,
}))
provide(markdownHtmlContextKey, {
  allowImages: computed(() => props.allowImages),
  remoteImages: computed(() => props.remoteImages),
  nestedRendererProps,
})

const smoothStreamingOptions = {
  minCharsPerSecond: 30,
  maxCharsPerSecond: 180,
  targetLatencyMs: 1_200,
  catchUpLatencyMs: 800,
  catchUpThreshold: 480,
  maxCommitFps: 30,
  startDelayMs: 40,
  maxCharsPerCommit: 6,
} satisfies SmoothMarkdownStreamOptions

const reducedMotion = usePreferredReducedMotion()
const animateStreaming = computed(() => (
  props.animate && !props.final && reducedMotion.value !== 'reduce'
))
</script>

<template>
  <div class="buddy-chat-markdown-host">
    <MarkdownRender
      :style="themeVariables"
      class="buddy-chat-markdown"
      :batch-rendering="animateStreaming"
      :content="content"
      :custom-id="resolvedCustomId"
      :custom-markdown-it="allowImages ? undefined : disableImages"
      :code-block-options="codeOverflow ? { overflow: codeOverflow } : undefined"
      :code-block-props="codeBlockProps"
      :fade="false"
      :final="final"
      html-policy="safe"
      :is-dark="isDark"
      :max-live-nodes="animateStreaming ? 0 : undefined"
      :mermaid-props="mermaidProps"
      mode="chat"
      :parse-coalesce-ms="32"
      :render-batch-budget-ms="4"
      :render-batch-delay="8"
      :render-batch-size="16"
      :render-code-blocks-as-pre="true"
      :smooth-streaming="animateStreaming ? 'auto' : false"
      :smooth-streaming-options="smoothStreamingOptions"
      :typewriter="animateStreaming ? 'simple' : false"
    />
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-markdown {
  width: 100%;
  min-width: 0;
}

.buddy-chat-markdown-host :deep(.markstream-vue) {
  --ms-font-sans: var(--buddy-font-body);
  --ms-font-mono: var(--buddy-font-mono);
  --ms-text-body: var(--buddy-chat-final-font-size);
  --ms-leading-body: var(--buddy-chat-final-line-height);
  --ms-text-h1: calc(var(--buddy-chat-final-font-size) * 22 / 14);
  --ms-text-h2: calc(var(--buddy-chat-final-font-size) * 19 / 14);
  --ms-text-h3: calc(var(--buddy-chat-final-font-size) * 16 / 14);
  --ms-text-h4: var(--buddy-chat-final-heading-font-size);
  --ms-text-h5: var(--buddy-chat-final-heading-font-size);
  --ms-text-h6: var(--buddy-chat-final-heading-font-size);
  --ms-leading-h1: 1.3;
  --ms-leading-h2: 1.3;
  --ms-leading-h3: 1.35;
  --ms-weight-h1: 600;
  --ms-flow-paragraph-y: 0.375rem;
  --ms-flow-list-y: 0.375rem;
  --ms-flow-list-item-y: 0.1875rem;
  --ms-flow-list-indent: 1.625em;
  --ms-flow-list-indent-mobile: 1.375em;
  --ms-flow-table-y: 0.625rem;
  --ms-flow-table-cell: 0.375rem 0.5rem;
  --ms-flow-blockquote-y: 0.5rem;
  --ms-flow-blockquote-indent: 0.75rem;
  --ms-flow-admonition-y: 0.625rem;
  --ms-flow-footnote-y: 0.375rem;
  --ms-flow-hr-y: 1rem;
  --ms-flow-diagram-y: 0.625rem;
  --ms-flow-codeblock-y: 0.5rem;
  --ms-flow-definition-term-mt: 0.5rem;
  --ms-flow-definition-desc-ml: 1rem;
  --ms-flow-definition-desc-mb: 0.375rem;
  --ms-flow-heading-1-mt: 1.125rem;
  --ms-flow-heading-1-mb: 0.5rem;
  --ms-flow-heading-2-mt: 1rem;
  --ms-flow-heading-2-mb: 0.375rem;
  --ms-flow-heading-3-mt: 0.875rem;
  --ms-flow-heading-3-mb: 0.375rem;
  --ms-flow-heading-4-mt: 0.75rem;
  --ms-flow-heading-4-mb: 0.25rem;
  --ms-flow-heading-5-mt: 0.75rem;
  --ms-flow-heading-5-mb: 0.25rem;
  --ms-flow-heading-6-mt: 0.75rem;
  --ms-flow-heading-6-mb: 0.25rem;
  --ms-inset-panel-body: 0.875rem;
}

.buddy-chat-markdown-host :deep(.code-block-header),
.buddy-chat-markdown-host :deep(.line-numbers),
.buddy-chat-markdown-host :deep(.line-number) {
  user-select: none;
}

.buddy-chat-markdown-host :deep(.code-block-container),
.buddy-chat-markdown-host :deep(pre.code-pre-fallback) {
  --markstream-code-fallback-bg: var(--code-bg) !important;
  --markstream-code-fallback-fg: var(--code-fg) !important;
  background-color: var(--code-bg) !important;
  color: var(--code-fg) !important;
}

.buddy-chat-markdown-host :deep(ol.list-node) {
  padding-inline-start: max(2.25em, 5ch);
}

.buddy-chat-markdown-host :deep(.blockquote) {
  margin-inline: 0;
}

.buddy-chat-markdown-host :deep(.table-node tbody tr:nth-child(even)) {
  background-color: var(--buddy-table-stripe);
}

.buddy-chat-markdown-host :deep(.table-node tbody tr:hover) {
  background-color: var(--buddy-table-hover);
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block) {
  margin-block: var(--ms-flow-paragraph-y);
  min-width: 0;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block > :first-child) {
  margin-top: 0;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block > :last-child) {
  margin-bottom: 0;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block [align='center']),
.buddy-chat-markdown-host :deep(.buddy-markdown-html-block[align='center']) {
  text-align: center;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block [align='right']),
.buddy-chat-markdown-host :deep(.buddy-markdown-html-block[align='right']) {
  text-align: right;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block [align='left']),
.buddy-chat-markdown-host :deep(.buddy-markdown-html-block[align='left']) {
  text-align: left;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block img),
.buddy-chat-markdown-host :deep(.buddy-markdown-html-inline img) {
  display: inline-block;
  max-width: 100%;
  height: auto;
  vertical-align: middle;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-img-fallback),
.buddy-chat-markdown-host :deep(.buddy-markdown-html-img-blocked),
.buddy-chat-markdown-host :deep(.desktop-markdown-image-blocked) {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 4px;
  background-color: var(--code-bg);
  color: var(--buddy-text-muted);
  font-size: 0.85em;
  line-height: 1.4;
  vertical-align: middle;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block table) {
  width: 100%;
  border-collapse: collapse;
  margin-block: var(--ms-flow-table-y);
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block th),
.buddy-chat-markdown-host :deep(.buddy-markdown-html-block td) {
  padding: var(--ms-flow-table-cell);
  border: 1px solid var(--buddy-border-subtle);
  vertical-align: top;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block [valign='middle']) {
  vertical-align: middle;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block [valign='bottom']) {
  vertical-align: bottom;
}

.buddy-chat-markdown-host :deep(details.buddy-markdown-html-block),
.buddy-chat-markdown-host :deep(.buddy-markdown-html-block details) {
  margin-block: var(--ms-flow-paragraph-y);
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 6px;
}

.buddy-chat-markdown-host :deep(details.buddy-markdown-html-block > summary),
.buddy-chat-markdown-host :deep(.buddy-markdown-html-block details > summary) {
  cursor: pointer;
  font-weight: 500;
}

.buddy-chat-markdown-host :deep(details.buddy-markdown-html-block[open] > summary),
.buddy-chat-markdown-host :deep(.buddy-markdown-html-block details[open] > summary) {
  margin-bottom: 0.5rem;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block kbd),
.buddy-chat-markdown-host :deep(.buddy-markdown-html-inline kbd) {
  display: inline-block;
  padding: 0.1em 0.4em;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 4px;
  background-color: var(--code-bg);
  font-family: var(--ms-font-mono);
  font-size: 0.85em;
  line-height: 1.25;
}

.buddy-chat-markdown-host :deep(.buddy-markdown-html-block mark),
.buddy-chat-markdown-host :deep(.buddy-markdown-html-inline mark) {
  padding: 0 0.2em;
  border-radius: 2px;
  background-color: color-mix(in srgb, var(--buddy-accent-solid) 22%, transparent);
  color: inherit;
}

:global(.buddy-chat-markdown > .node-slot:first-of-type .node-content > :first-child) {
  margin-top: 0;
}

:global(.buddy-chat-markdown > .node-slot:last-of-type .node-content > :last-child) {
  margin-bottom: 0;
}

:global(.buddy-chat-markdown.typewriter-simple-cursor .typewriter-simple-cursor-target::after) {
  display: none;
}
</style>
