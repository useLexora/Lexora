<script setup lang="ts">
import { useTemplateRef } from 'vue'
import { useComposerToolbarLayout } from './useComposerToolbarLayout'

defineSlots<{
  leading: () => unknown
  actions: () => unknown
}>()

const toolbar = useTemplateRef<HTMLElement>('toolbar')
const leading = useTemplateRef<HTMLElement>('leading')
const actions = useTemplateRef<HTMLElement>('actions')
useComposerToolbarLayout(toolbar, leading, actions)
</script>

<template>
  <div ref="toolbar" class="desktop-composer-toolbar flex w-full min-w-0 items-center gap-2" data-testid="composer-toolbar">
    <div ref="leading" class="desktop-chat-composer__leading-actions inline-flex flex-none items-center gap-1">
      <slot name="leading" />
    </div>
    <div ref="actions" class="desktop-chat-composer__actions ml-auto inline-flex flex-none items-center gap-1">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-composer-toolbar {
  --composer-toolbar-font-size: 12.5px;
  --composer-effort-font-size: 12px;
  --composer-model-font-weight: 500;
  --buddy-composer-control-radius: var(--buddy-icon-button-radius);
  --composer-space-max-width: 12rem;
  --composer-model-max-width: 18rem;

  &[data-compact~='space-short'] {
    --composer-space-max-width: 7rem;
  }

  &[data-compact~='effort'] {
    --composer-effort-display: none;
  }

  &[data-compact~='space'] {
    --composer-space-width: var(--buddy-composer-control-height);
    --composer-space-padding: 0;
    --composer-space-gap: 0;
    --composer-space-label-display: none;
  }

  &[data-compact~='model-short'] {
    --composer-model-max-width: 8rem;
  }

  &[data-compact~='permission'] {
    --composer-permission-width: var(--buddy-composer-control-height);
    --composer-permission-padding: 0;
    --composer-permission-icon-margin: 0;
    --composer-permission-label-display: none;
  }

  &[data-compact~='model'] {
    --composer-model-width: var(--buddy-composer-control-height);
    --composer-model-padding: 0;
    --composer-model-gap: 0;
    --composer-model-label-display: none;
    --composer-model-icon-display: inline-flex;
    --composer-model-badge-position: absolute;
    --composer-model-badge-inset: 2px 1px auto auto;
    --composer-model-badge-size: 10px;
  }

  &[data-compact~='tight'] {
    gap: 0;
    overflow-x: auto;
    scrollbar-width: thin;

    > div {
      gap: 0;
    }
  }
}
</style>
