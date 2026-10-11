<script setup lang="ts">
import { NScrollbar } from 'naive-ui'

withDefaults(defineProps<{
  borderRadius?: string
  expanded?: boolean
  singleLineToolbar?: boolean
}>(), {
  expanded: false,
  singleLineToolbar: false,
})
</script>

<template>
  <div
    class="desktop-chat-composer-frame w-full min-w-0 my-0 mx-auto"
    :class="{
      'is-expanded': expanded,
      'has-single-line-toolbar': singleLineToolbar,
    }"
  >
    <slot name="attachments" />

    <div class="desktop-chat-composer relative w-full min-w-0 border-1 border-solid border-border-strong rounded-[6px] bg-composer text-composer-fg p-[0.65rem] focus-within:border-focus" :style="{ borderRadius }">
      <slot name="overlay" />

      <div class="relative">
        <NScrollbar class="desktop-chat-composer__editor-scrollbar">
          <slot name="editor" />
        </NScrollbar>
      </div>

      <div class="desktop-chat-composer__toolbar flex-wrap justify-between gap-[0.55rem] min-h-control">
        <div class="desktop-chat-composer__leading-actions max-w-full flex-wrap gap-[0.35rem]">
          <slot name="leading" />
        </div>
        <div class="desktop-chat-composer__actions max-w-full justify-end gap-[0.35rem] ml-auto">
          <slot name="actions" />
        </div>
      </div>
    </div>

    <slot name="footer" />
  </div>
</template>

<style scoped lang="scss">
@use '@/shared/ui/highlight/inlineHighlightToken' as highlight;

.desktop-chat-composer-frame {
  --desktop-chat-composer-editor-padding-top: 0.35rem;
  --desktop-chat-composer-editor-padding-bottom: 0.35rem;
  container: desktop-chat-composer / inline-size;
}

.desktop-chat-composer {
  transition: border-color 120ms ease
}

:deep(.desktop-chat-composer__editor-scrollbar) {
  min-height: calc(2lh + var(--desktop-chat-composer-editor-padding-top) + var(--desktop-chat-composer-editor-padding-bottom));
  max-height: calc(8lh + var(--desktop-chat-composer-editor-padding-top) + var(--desktop-chat-composer-editor-padding-bottom));
  font-size: 0.9rem;
  line-height: 1.58;
}

:deep(.desktop-chat-composer__prosemirror) {
  min-height: calc(2lh + var(--desktop-chat-composer-editor-padding-top) + var(--desktop-chat-composer-editor-padding-bottom));
  border: 0;
  outline: 0;
  color: var(--buddy-composer-fg);
  font-size: 0.9rem;
  line-height: 1.58;
  white-space: pre-wrap;
  word-break: break-word;

  p {
    margin: 0;
  }

  p.is-editor-empty:first-child::before {
    content: attr(data-placeholder);
    float: left;
    height: 0;
    color: var(--buddy-text-muted);
    pointer-events: none;
  }
}

.is-expanded :deep(.desktop-chat-composer__editor-scrollbar),
.is-expanded :deep(.desktop-chat-composer__prosemirror) {
  min-height: 9rem;
}

.is-expanded :deep(.desktop-chat-composer__editor-scrollbar) {
  max-height: 18rem;
}

:deep(.chat-prompt-token-node),
:deep([data-type='chat-resource-reference']) {
  @include highlight.inline-highlight-token;

  margin-inline: 0.12rem;
}

:deep([data-type='chat-resource-reference']) {
  &:hover {
    --inline-wave-highlight-active: 1;
  }
}

:deep(.desktop-chat-composer__prosemirror [data-type='chat-session-reference']) {
  display: inline-block;
  max-width: min(24rem, calc(100% - 0.24rem));
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}

:deep(.chat-prompt-token-node.ProseMirror-selectednode),
:deep([data-type='chat-resource-reference'].ProseMirror-selectednode) {
  --inline-wave-highlight-active: 1;
}

:deep(.chat-resource-reference__label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-chat-composer__toolbar,
.desktop-chat-composer__actions,
.desktop-chat-composer__leading-actions {
  display: flex;
  min-width: 0;
  align-items: center;
}

.has-single-line-toolbar {
  .desktop-chat-composer__toolbar {
    flex-wrap: nowrap;
    justify-content: normal;
  }

  .desktop-chat-composer__actions {
    flex: none;
    flex-wrap: nowrap;
  }

  .desktop-chat-composer__leading-actions {
    flex: 1 1 auto;
    flex-wrap: nowrap;
  }
}

@container desktop-chat-composer (max-width: 560px) {
  .desktop-chat-composer__leading-actions {
    flex-basis: 100%;
  }
}
</style>
