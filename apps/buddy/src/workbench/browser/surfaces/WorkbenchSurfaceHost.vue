<script setup lang="ts">
import type { SurfaceLayout } from '@/shared/ui/surfaces/surfaceLayout'
import { onMounted, onScopeDispose } from 'vue'
import { SurfaceLayoutController } from './SurfaceLayoutController'

defineSlots<{ default: (props: { layout: SurfaceLayout }) => unknown }>()
const layout = new SurfaceLayoutController()
onMounted(() => layout.start())
onScopeDispose(() => layout.dispose())
</script>

<template>
  <div class="workbench-surface-host">
    <slot :layout="layout" />
  </div>
</template>

<style scoped>
.workbench-surface-host { display: contents; }
:global(body:has(.workbench.is-dragging, .workbench.is-resizing, .desktop-workbench-layout.is-resizing) [data-workbench-surface]) { pointer-events: none !important; }
</style>
