<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import { computed } from 'vue'
import { extensionLabels } from '../extensionLabels'

const props = defineProps<{ language: string }>()
defineSlots<{
  actions: () => unknown
  default: () => unknown
}>()
const section = defineModel<'marketplace' | 'installed'>('section', { required: true })
const labels = computed(() => extensionLabels(props.language))
</script>

<template>
  <section class="desktop-extension-workbench">
    <header class="desktop-extension-workbench__header">
      <nav class="desktop-extension-workbench__sections" :aria-label="labels.title">
        <button type="button" :class="{ 'is-active': section === 'marketplace' }" :aria-pressed="section === 'marketplace'" @click="section = 'marketplace'">
          {{ labels.marketplace }}
        </button>
        <button type="button" :class="{ 'is-active': section === 'installed' }" :aria-pressed="section === 'installed'" @click="section = 'installed'">
          {{ labels.installed }}
        </button>
      </nav>
      <div class="desktop-extension-workbench__actions">
        <slot name="actions" />
      </div>
    </header>
    <NScrollbar class="desktop-extension-workbench__scroll" content-style="min-height: 100%;">
      <div class="desktop-extension-workbench__content">
        <slot />
      </div>
    </NScrollbar>
  </section>
</template>

<style scoped lang="scss">
.desktop-extension-workbench {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  background: var(--buddy-surface-base);
  container-type: inline-size;
}

.desktop-extension-workbench__header {
  display: flex;
  height: var(--buddy-region-header-height);
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--buddy-border-subtle);
  padding: 0 18px;
}

.desktop-extension-workbench__sections {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 2px;
  border-radius: 6px;
  background: var(--buddy-surface-subtle);
  padding: 2px;

  > button {
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--buddy-text-secondary);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 580;
    line-height: 1;
    padding: 7px 12px;
    white-space: nowrap;

    &:hover { color: var(--buddy-text-strong); }
    &:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: 1px; }
    &.is-active { background: var(--buddy-surface-base); color: var(--buddy-text-strong); }
  }
}

.desktop-extension-workbench__actions { display: flex; flex: none; align-items: center; gap: 8px; }
.desktop-extension-workbench__scroll { min-height: 0; flex: 1; }
.desktop-extension-workbench__content { display: flex; min-height: 100%; box-sizing: border-box; flex-direction: column; gap: 12px; padding: 14px 18px 36px; }

@container (max-width: 600px) {
  .desktop-extension-workbench__header { gap: 8px; padding: 0 12px; }
  .desktop-extension-workbench__sections > button { padding-inline: 8px; }
  .desktop-extension-workbench__actions { gap: 4px; }
  .desktop-extension-workbench__content { padding: 10px 12px 28px; }
}
</style>
