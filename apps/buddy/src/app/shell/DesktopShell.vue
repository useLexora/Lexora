<script setup lang="ts">
import type { DesktopShellBindings } from './desktopShellBindings'
import { computed } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import DesktopStartupScreen from '@/app/bootstrap/DesktopStartupScreen.vue'
import DesktopAppSidebar from '@/app/shell/DesktopAppSidebar.vue'
import DesktopTitleBar from '@/app/shell/window/DesktopTitleBar.vue'
import { DesktopTaskResourcePanel } from '@/modules/tasks/ui'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopWorkbenchLayout from '@/shared/ui/workbench-layout/DesktopWorkbenchLayout.vue'

const { bindings } = defineProps<{ bindings: DesktopShellBindings }>()
const route = useRoute()
const router = useRouter()
const { appSidebarCollapsed, language } = useDesktopUi()
const startupVisible = computed(() => !bindings.lifecycle.state.value.hasBeenReady && route.meta.settingsCategory !== 'logs')
const activeView = computed(() => route.meta.desktopView ?? 'tasks')
const contextAvailable = computed(() => bindings.contextPanelGlobal.value || activeView.value === 'tasks')
</script>

<template>
  <div class="desktop-shell">
    <DesktopTitleBar
      :app-info="bindings.appInfo.value"
      :app-sidebar-collapsed="appSidebarCollapsed"
      :language="language"
      :context-available="contextAvailable"
      :context-open="bindings.resources.isOpen.value"
      @toggle-context="bindings.resources.toggle"
      @toggle-app-sidebar="bindings.toggleAppSidebar"
    />
    <div class="desktop-shell__body">
      <div class="desktop-shell__content" :class="{ 'is-starting': startupVisible }" :inert="startupVisible" :aria-hidden="startupVisible">
        <Transition name="desktop-app-sidebar">
          <DesktopAppSidebar
            v-if="!appSidebarCollapsed"
            :app-version="bindings.appInfo.value?.version ?? null"
            :conversations="bindings.taskIndex.tasks.value"
            :language="language"
            :mode="activeView"
            :notification-items="bindings.notifications.items.value"
            :notification-loading="bindings.notifications.isLoading.value"
            :notification-unseen-count="bindings.notifications.unseenCount.value"
            :spaces="bindings.taskIndex.spaces.value"
            @navigate-tasks="bindings.navigation.navigate(desktopRouteLocations.tasks())"
            @navigate-automations="bindings.navigation.navigate(desktopRouteLocations.automations())"
            @navigate-settings="bindings.navigation.navigate(desktopRouteLocations.settings())"
            @mark-all-notifications-seen="bindings.notifications.markAllSeen"
            @open-notification="bindings.navigation.openNotification"
            @open-task="bindings.navigation.openTask"
            @open-space="bindings.navigation.openSpace"
            @refresh-notifications="bindings.notifications.load"
          />
        </Transition>

        <div class="desktop-shell__workbench">
          <DesktopWorkbenchLayout :language="language" :workspace-minimum-width="480" :context-visible="contextAvailable">
            <RouterView />
            <template v-if="bindings.resources.isOpen.value" #context>
              <DesktopTaskResourcePanel :panel="bindings.resources" :context="bindings.resourceContext" :language="language" :visible="contextAvailable" />
            </template>
          </DesktopWorkbenchLayout>
        </div>
      </div>
      <Transition name="desktop-startup-reveal">
        <DesktopStartupScreen v-if="startupVisible" :failed="bindings.lifecycle.failed.value" :language="language" @retry="bindings.lifecycle.retry()" @open-logs="router.push(desktopRouteLocations.settings('logs'))" />
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.desktop-shell {
  display: flex;
  width: 100dvw;
  height: 100dvh;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--buddy-surface-canvas);
}

.desktop-shell__body,
.desktop-shell__content,
.desktop-shell__workbench {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
}

.desktop-shell__body { position: relative; }
.desktop-shell__content { transition: opacity 220ms ease; }
.desktop-shell__content.is-starting { opacity: 0; }
.desktop-startup-reveal-leave-active { transition: opacity 220ms ease; }
.desktop-startup-reveal-leave-to { opacity: 0; }

.desktop-shell__workbench {
  background: var(--buddy-surface-base);
}

.desktop-app-sidebar-enter-active,
.desktop-app-sidebar-leave-active {
  transition:
    width 140ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 100ms ease;
  will-change: width, opacity;
}

.desktop-app-sidebar-enter-from,
.desktop-app-sidebar-leave-to {
  width: 0;
  border-right-color: transparent;
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .desktop-shell__content,
  .desktop-startup-reveal-leave-active,
  .desktop-app-sidebar-enter-active,
  .desktop-app-sidebar-leave-active {
    transition: none;
  }
}
</style>
