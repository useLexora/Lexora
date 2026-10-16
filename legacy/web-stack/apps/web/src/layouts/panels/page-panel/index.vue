<script setup lang="ts">
withDefaults(defineProps<{
  showHeader?: boolean
}>(), {
  showHeader: true,
})
</script>

<template>
  <header v-if="showHeader" class="page-panel__header">
    <div class="page-panel__header-content">
      <div class="page-panel__header-slot">
        <slot name="header" />
      </div>
    </div>
  </header>

  <div class="page-panel__body">
    <slot />
  </div>
</template>

<style scoped lang="scss">
.page-panel__header {
  position: sticky;
  top: 0;
  z-index: 20;
  flex: 0 0 var(--default-header-height);
  height: var(--default-header-height);
  padding: var(--page-panel-header-padding-block) var(--page-panel-header-padding-inline);
  border-bottom: 1px solid color-mix(in srgb, var(--brand-border-base) 72%, transparent);
  backdrop-filter: blur(18px);
  background: var(--brand-bg-overlay);
}

.page-panel__header-content {
  display: flex;
  align-items: center;
  gap: 1rem;
  height: 100%;
  min-height: 0;
}

.page-panel__header-slot {
  display: flex;
  align-items: center;
  flex: 1 1 0%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.page-panel__body {
  flex: 1 1 0%;
  min-height: 0;
  overflow-y: auto;
  background: var(--brand-bg-base);
}
</style>
