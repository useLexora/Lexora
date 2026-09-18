<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import DesktopRuntimePane from '@/platform/runtime/DesktopRuntimePane.vue'

defineProps<{ loading?: boolean, requiresRuntime?: boolean, fill?: boolean }>()

defineSlots<{
  actions?: () => unknown
  default: () => unknown
  description?: () => unknown
  title: () => unknown
}>()
</script>

<template>
  <section class="desktop-settings-page">
    <header class="desktop-settings-page__header">
      <div class="desktop-settings-page__header-copy">
        <h1 class="desktop-settings-page__title">
          <slot name="title" />
        </h1>
        <p v-if="$slots.description" class="desktop-settings-page__description">
          <slot name="description" />
        </p>
      </div>
      <div v-if="$slots.actions" class="desktop-settings-page__header-actions">
        <slot name="actions" />
      </div>
    </header>

    <DesktopRuntimePane :enabled="requiresRuntime" :loading="loading">
      <div v-if="fill" class="desktop-settings-page__fill">
        <div class="desktop-settings-page__fill-content">
          <slot />
        </div>
      </div>
      <NScrollbar v-else class="desktop-settings-page__scroll">
        <div class="desktop-settings-page__content">
          <slot />
        </div>
      </NScrollbar>
    </DesktopRuntimePane>
  </section>
</template>

<style scoped>
.desktop-settings-page {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--buddy-surface-base);
  container-type: inline-size;
}

.desktop-settings-page__header {
  display: flex;
  height: var(--buddy-region-header-height);
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid var(--buddy-border-subtle);
  padding: 0 1rem;
}

.desktop-settings-page__header-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 12px;
}

.desktop-settings-page__title {
  overflow: hidden;
  min-width: 0;
  max-width: 100%;
  flex: none;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-settings-page__description {
  overflow: hidden;
  min-width: 0;
  margin: 0;
  color: var(--buddy-text-secondary);
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translateY(1px);
}

.desktop-settings-page__header-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.desktop-settings-page__scroll {
  min-height: 0;
  flex: 1;
}

.desktop-settings-page__fill {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}

.desktop-settings-page__fill-content {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
}

.desktop-settings-page__content {
  display: grid;
  width: min(100%, 64rem);
  gap: 1.8rem;
  margin: 0 auto;
  padding: clamp(20px, 3cqw, 24px) clamp(1rem, 3cqw, 2.8rem) 3rem;
}
</style>
