<script setup lang="ts">
import { RouterView } from 'vue-router'
import { useWorkspaceContainer } from '@/layouts/composables/useWorkspaceContainer'
import SidebarPanel from '@/layouts/panels/sidebar-panel'

const {
  brand,
  navigationItems,
} = useWorkspaceContainer()
</script>

<template>
  <div class="workspace-container">
    <SidebarPanel
      :brand="brand"
      :items="navigationItems"
    />

    <main class="workspace-container__main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped lang="scss">
.workspace-container {
  display: flex;
  height: var(--app-shell-height);
  overflow: hidden;
  background: var(--brand-bg-body);
  color: var(--brand-text-primary);
  font-family: var(--el-font-family);

  .workspace-container__main {
    display: flex;
    flex: 1 1 0%;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--brand-bg-base);
  }
}
</style>
