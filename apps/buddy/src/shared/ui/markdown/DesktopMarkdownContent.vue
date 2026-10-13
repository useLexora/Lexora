<script setup lang="ts">
import type { NodeRendererProps, SmoothMarkdownStreamOptions } from 'markstream-vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { usePreferredReducedMotion } from '@vueuse/core'
import MarkdownRender from 'markstream-vue'
import { computed } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { desktopThemeSnapshot } from '@/theme/desktopThemeState'
import { markdownThemeVariables } from '@/theme/markdownTheme'
import 'katex/dist/katex.min.css'
import 'markstream-vue/index.css'

const props = withDefaults(defineProps<{
  content: string
  allowImages?: boolean
  codeOverflow?: 'wrap' | 'scroll'
  final?: boolean
  language: BuddyLocale
  writeClipboardText: (text: string) => Promise<void>
}>(), {
  allowImages: true,
  final: true,
})

const emit = defineEmits<{
  openLink: [href: string]
}>()

const { isDark } = useDesktopUi()
const themeVariables = computed(() => markdownThemeVariables(desktopThemeSnapshot.value.active.colors))
const disableImages: NonNullable<NodeRendererProps['customMarkdownIt']> = md => md.disable('image')
const codeBlockProps = computed<NonNullable<NodeRendererProps['codeBlockProps']>>(() => ({
  clipboardWriter: props.writeClipboardText,
}))

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
  !props.final && reducedMotion.value !== 'reduce'
))

function handleLinkClick(event: MouseEvent) {
  if (event.defaultPrevented || !(event.target instanceof Element))
    return

  const anchor = event.target.closest<HTMLAnchorElement>('a')
  if (!anchor)
    return

  event.preventDefault()
  event.stopImmediatePropagation()

  const href = anchor.getAttribute('href')?.trim()
  if (!href)
    return

  if (/^https?:\/\//i.test(href)) {
    window.open(href, '_blank', 'noopener,noreferrer')
    return
  }

  emit('openLink', href)
}
</script>

<template>
  <div class="buddy-chat-markdown-host w-full min-w-0" @click="handleLinkClick">
    <MarkdownRender
      :style="themeVariables"
      class="buddy-chat-markdown"
      :batch-rendering="animateStreaming"
      :content="content"
      :custom-markdown-it="allowImages ? undefined : disableImages"
      :code-block-options="codeOverflow ? { overflow: codeOverflow } : undefined"
      :code-block-props="codeBlockProps"
      :fade="false"
      :final="final"
      html-policy="escape"
      :is-dark="isDark"
      :max-live-nodes="animateStreaming ? 0 : undefined"
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
  --ms-flow-list-indent: 1.375rem;
  --ms-flow-list-indent-mobile: 1.125rem;
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

.buddy-chat-markdown-host :deep(.blockquote) {
  margin-inline: 0;
}

.buddy-chat-markdown-host :deep(.table-node tbody tr:nth-child(even)) {
  background-color: var(--buddy-table-stripe);
}

.buddy-chat-markdown-host :deep(.table-node tbody tr:hover) {
  background-color: var(--buddy-table-hover);
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
