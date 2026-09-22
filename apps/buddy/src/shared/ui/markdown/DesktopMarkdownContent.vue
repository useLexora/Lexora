<script setup lang="ts">
import type { SmoothMarkdownStreamOptions } from 'markstream-vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { usePreferredReducedMotion } from '@vueuse/core'
import MarkdownRender from 'markstream-vue'
import { computed, onBeforeUnmount } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import 'markstream-vue/index.css'

const props = withDefaults(defineProps<{
  content: string
  codeOverflow?: 'wrap' | 'scroll'
  final?: boolean
  language: BuddyLocale
  writeClipboardText: (text: string) => Promise<void>
}>(), {
  final: true,
})

const emit = defineEmits<{
  openLink: [href: string]
}>()

interface CopyButtonState {
  ariaLabel: string | null
  resetTimer: number
}

const { t } = useBuddyI18n(() => props.language)
const { isDark } = useDesktopUi()
const copyButtonStates = new Map<HTMLButtonElement, CopyButtonState>()

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

async function copyCodeBlock(event: MouseEvent) {
  if (!(event.target instanceof Element))
    return

  const button = event.target.closest<HTMLButtonElement>('.code-block-header .code-action-btn')
  const codeBlock = button?.closest<HTMLElement>('.code-block-container')
  const code = codeBlock?.querySelector<HTMLElement>('pre.code-pre-fallback > code')
  if (!button || !code)
    return

  event.preventDefault()
  event.stopImmediatePropagation()

  try {
    await props.writeClipboardText(code.textContent ?? '')
    showCopiedState(button)
  }
  catch (error) {
    console.error('[Lexora Buddy] Failed to copy code block.', error)
  }
}

function handleLinkClick(event: MouseEvent) {
  if (!(event.target instanceof Element))
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

function handleClick(event: MouseEvent) {
  void copyCodeBlock(event)
  if (event.defaultPrevented)
    return

  handleLinkClick(event)
}

function showCopiedState(button: HTMLButtonElement) {
  const currentState = copyButtonStates.get(button)
  if (currentState)
    window.clearTimeout(currentState.resetTimer)

  const ariaLabel = currentState?.ariaLabel ?? button.getAttribute('aria-label')
  button.classList.add('is-buddy-copied')
  button.setAttribute('aria-label', t('desktop.chat.copied'))
  const resetTimer = window.setTimeout(resetCopiedState, 1_000, button)
  copyButtonStates.set(button, { ariaLabel, resetTimer })
}

function resetCopiedState(button: HTMLButtonElement) {
  const state = copyButtonStates.get(button)
  if (!state)
    return

  button.classList.remove('is-buddy-copied')
  if (state.ariaLabel === null)
    button.removeAttribute('aria-label')
  else
    button.setAttribute('aria-label', state.ariaLabel)
  copyButtonStates.delete(button)
}

onBeforeUnmount(() => {
  for (const [button, state] of copyButtonStates) {
    window.clearTimeout(state.resetTimer)
    resetCopiedState(button)
  }
})
</script>

<template>
  <div class="buddy-chat-markdown-host" @click.capture="handleClick">
    <MarkdownRender
      class="buddy-chat-markdown"
      :batch-rendering="animateStreaming"
      :content="content"
      :code-block-options="codeOverflow ? { overflow: codeOverflow } : undefined"
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
.buddy-chat-markdown-host {
  width: 100%;
  min-width: 0;
}

.buddy-chat-markdown {
  width: 100%;
  min-width: 0;
}

.buddy-chat-markdown-host :deep(.markstream-vue) {
  --ms-font-sans: var(--buddy-font-ui);
  --ms-font-mono: var(--buddy-font-mono);
  --ms-text-body: var(--buddy-chat-final-font-size);
  --ms-leading-body: var(--buddy-chat-final-line-height);
  --ms-text-h1: 22px;
  --ms-text-h2: 19px;
  --ms-text-h3: 16px;
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

.buddy-chat-markdown-host :deep(.blockquote) {
  margin-inline: 0;
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

:global(.buddy-chat-markdown .code-action-btn.is-buddy-copied) {
  position: relative;
  background: var(--code-action-active-bg);
  color: var(--code-action-active-fg);
}

:global(.buddy-chat-markdown .code-action-btn.is-buddy-copied svg) {
  visibility: hidden;
}

:global(.buddy-chat-markdown .code-action-btn.is-buddy-copied::after) {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0.5rem;
  height: 0.25rem;
  border-bottom: 1.5px solid currentcolor;
  border-left: 1.5px solid currentcolor;
  content: '';
  transform: translate(-50%, -65%) rotate(-45deg);
}
</style>
