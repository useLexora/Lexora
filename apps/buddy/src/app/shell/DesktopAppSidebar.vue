<script setup lang="ts">
import type { DesktopShellBindings } from './desktopShellBindings'
import { useTemplateRef } from 'vue'
import { useWorkbenchAnchor } from '@/shared/ui/contributions/workbenchUiContext'
import WorkbenchMountPoint from '@/workbench/browser/mounts/WorkbenchMountPoint.vue'
import DesktopNavigationButton from './DesktopNavigationButton.vue'
import DesktopNavigationControls from './DesktopNavigationControls.vue'

const props = defineProps<{ bindings: DesktopShellBindings, compact: boolean }>()
defineEmits<{ navigate: [id: string] }>()
const sidebar = useTemplateRef<HTMLElement>('sidebar')
useWorkbenchAnchor('app.sidebar', () => sidebar.value)
</script>

<template>
  <aside
    id="desktop-app-sidebar" ref="sidebar"
    class="desktop-app-sidebar relative flex h-full min-h-0 flex-none flex-col overflow-hidden border-r-1 border-r-solid border-r-border bg-app-sidebar text-app-sidebar-fg"
    :class="compact ? 'is-compact w-13' : 'w-app-sidebar'" data-theme-surface="layout"
  >
    <component :is="compact ? 'div' : WorkbenchMountPoint" v-bind="compact ? {} : { target: 'app.sidebar' }" class="flex min-h-0 flex-1 flex-col">
      <header v-if="!compact" class="flex flex-none items-center gap-2 border-b-1 border-b-solid border-b-border px-3 h-region-header">
        <strong class="truncate text-strong text-sidebar-header [font-weight:var(--buddy-sidebar-header-font-weight)]">Lexora</strong>
        <span class="flex-none text-muted text-[11px]">{{ bindings.appInfo.value?.version ? `v${bindings.appInfo.value.version}` : '' }}</span>
      </header>
      <nav class="flex min-h-0 flex-1 flex-col overflow-y-auto" :class="compact ? 'items-center gap-1 py-2' : 'gap-[0.125rem] p-2'">
        <DesktopNavigationButton v-for="entry in bindings.pages.navigation.value" :key="entry.id" :entry="entry" :icon-only="compact" @navigate="$emit('navigate', $event)" />
      </nav>
      <footer class="flex-none border-t-1 border-t-solid border-t-border">
        <DesktopNavigationControls :bindings="props.bindings" :presentation="compact ? 'compact' : 'full'" />
      </footer>
    </component>
  </aside>
</template>
