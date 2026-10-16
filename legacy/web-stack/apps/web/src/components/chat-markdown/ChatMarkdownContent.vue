<script setup lang="ts">
import type { ChatMarkdownContentProps } from './typing'
import { useStreamingMarkdownBlocks } from './useStreamingMarkdownBlocks'
import 'katex/dist/katex.min.css'

const props = withDefaults(defineProps<ChatMarkdownContentProps>(), {
  phase: 'final',
})

const { blocks } = useStreamingMarkdownBlocks({
  messageId: () => props.messageId,
  partId: () => props.partId,
  source: () => props.source,
  phase: () => props.phase,
})

async function handleClick(event: MouseEvent) {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('.chat-markdown__code-copy')
    : null

  if (!target || target.disabled) {
    return
  }

  const encodedCode = target.dataset.code
  if (!encodedCode) {
    return
  }

  await navigator.clipboard?.writeText(decodeURIComponent(encodedCode))
}
</script>

<template>
  <div class="chat-markdown" @click="handleClick">
    <div
      v-for="block in blocks"
      :key="block.key"
      class="chat-markdown__block"
      v-html="block.html"
    />
  </div>
</template>

<style scoped lang="scss">
.chat-markdown {
  min-width: 0;
  max-width: 100%;
  color: var(--brand-text-primary);
  font-size: 0.875rem;
  line-height: 1.65;
  overflow-wrap: break-word;

  .chat-markdown__block + .chat-markdown__block {
    margin-top: 0.5rem;
  }

  :deep(p),
  :deep(ul),
  :deep(ol),
  :deep(blockquote),
  :deep(pre),
  :deep(table) {
    margin: 0;
  }

  :deep(p + p),
  :deep(p + ul),
  :deep(p + ol),
  :deep(ul + p),
  :deep(ol + p),
  :deep(blockquote + p) {
    margin-top: 0.5rem;
  }

  :deep(ul),
  :deep(ol) {
    padding-left: 1.375rem;
  }

  :deep(li + li) {
    margin-top: 0.25rem;
  }

  :deep(a) {
    color: var(--brand-primary);
    text-decoration-line: underline;
    text-underline-offset: 0.18em;
  }

  :deep(blockquote) {
    padding-left: 0.625rem;
    border-left: 3px solid color-mix(in srgb, var(--brand-primary) 42%, transparent);
    color: var(--brand-text-secondary);
  }

  :deep(code:not(.hljs, .chat-markdown__math-fallback)) {
    padding: 0.125rem 0.25rem;
    border-radius: 0.375rem;
    background: color-mix(in srgb, var(--brand-fill-light) 72%, transparent);
    font-size: 0.85em;
  }

  :deep(.chat-markdown__table-scroll) {
    max-width: 100%;
    overflow-x: auto;
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
    border-radius: 0.5rem;
  }

  :deep(table) {
    width: 100%;
    min-width: 28rem;
    border-collapse: collapse;
  }

  :deep(th),
  :deep(td) {
    padding: 0.5rem;
    border-bottom: 1px solid color-mix(in srgb, var(--brand-border-base) 56%, transparent);
    text-align: left;
    vertical-align: top;
  }

  :deep(tr:last-child td) {
    border-bottom: 0;
  }

  :deep(th) {
    background: color-mix(in srgb, var(--brand-fill-light) 58%, transparent);
    color: var(--brand-text-secondary);
    font-weight: 600;
  }

  :deep(.chat-markdown__task-checkbox) {
    margin-right: 0.375rem;
    vertical-align: -0.12em;
    pointer-events: none;
  }

  :deep(.chat-markdown__math-block) {
    overflow-x: auto;
  }

  :deep(.chat-markdown__math-fallback) {
    white-space: pre-wrap;
  }

  :deep(.chat-markdown__streaming-math) {
    color: var(--brand-text-secondary);
    white-space: pre-wrap;
  }

  :deep(.chat-markdown__code-block) {
    overflow: hidden;
    border: 1px solid var(--tiptap-code-block-border, color-mix(in srgb, var(--brand-border-base) 76%, transparent));
    border-radius: 0.5rem;
    background: var(--tiptap-code-block-background, color-mix(in srgb, var(--brand-fill-lighter) 74%, var(--brand-bg-surface)));
  }

  :deep(.chat-markdown__code-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.375rem;
    min-height: 1.75rem;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid color-mix(in srgb, var(--brand-border-base) 64%, transparent);
    background: var(--tiptap-code-block-toolbar-background, color-mix(in srgb, var(--brand-fill-light) 56%, var(--brand-bg-surface)));
  }

  :deep(.chat-markdown__code-language) {
    color: var(--brand-text-secondary);
    font-size: 0.75rem;
    font-weight: 600;
  }

  :deep(.chat-markdown__code-copy) {
    height: 1.375rem;
    padding: 0 0.375rem;
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 70%, transparent);
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--brand-bg-surface) 92%, var(--brand-fill-light));
    color: var(--brand-text-secondary);
    font-size: 0.75rem;
    line-height: 1;
    cursor: pointer;
  }

  :deep(.chat-markdown__code-copy:disabled) {
    cursor: not-allowed;
    opacity: 0.45;
  }

  :deep(.chat-markdown__code-copy:not(:disabled):hover) {
    color: var(--brand-text-primary);
    background: color-mix(in srgb, var(--brand-fill-light) 80%, transparent);
  }

  :deep(.chat-markdown__code-pre),
  :deep(.chat-markdown__streaming-code) {
    overflow-x: auto;
    padding: 0.5rem 0.625rem;
  }

  :deep(.chat-markdown__code-pre code),
  :deep(.chat-markdown__streaming-code code) {
    display: block;
    min-width: max-content;
    color: var(--brand-text-primary);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
    font-size: 0.8125rem;
    line-height: 1.65;
    white-space: pre;
  }

  :deep(.hljs-comment),
  :deep(.hljs-quote) {
    color: #787774;
  }

  :deep(.hljs-keyword),
  :deep(.hljs-selector-tag) {
    color: #9065b0;
  }

  :deep(.hljs-string),
  :deep(.hljs-doctag),
  :deep(.hljs-regexp) {
    color: #448361;
  }

  :deep(.hljs-number),
  :deep(.hljs-literal),
  :deep(.hljs-variable),
  :deep(.hljs-template-variable) {
    color: #d9730d;
  }

  :deep(.hljs-title),
  :deep(.hljs-section),
  :deep(.hljs-name),
  :deep(.hljs-selector-id),
  :deep(.hljs-selector-class) {
    color: #337ea9;
  }

  :deep(.hljs-attribute),
  :deep(.hljs-attr),
  :deep(.hljs-property),
  :deep(.hljs-built_in),
  :deep(.hljs-type) {
    color: #c14c8a;
  }

  :deep(.hljs-addition) {
    color: #448361;
  }

  :deep(.hljs-deletion) {
    color: #d44c47;
  }
}
</style>
