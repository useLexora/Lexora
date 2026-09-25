<script setup lang="ts">
import type { DesktopShellBindings } from './desktopShellBindings'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DesktopStartupScreen from '@/app/bootstrap/DesktopStartupScreen.vue'
import DesktopAppSidebar from '@/app/shell/DesktopAppSidebar.vue'
import DesktopTitleBar from '@/app/shell/window/DesktopTitleBar.vue'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import WorkbenchMountPoint from '@/workbench/browser/mounts/WorkbenchMountPoint.vue'
import WorkbenchHost from '@/workbench/browser/WorkbenchHost.vue'
import DesktopWorkbenchArea from '../workbench/DesktopWorkbenchArea.vue'
import DesktopWorkbenchView from '../workbench/DesktopWorkbenchView.vue'

const { bindings } = defineProps<{ bindings: DesktopShellBindings }>()
const route = useRoute()
const router = useRouter()
const { appSidebarCollapsed, language } = useDesktopUi()
const startupVisible = computed(() => !bindings.lifecycle.state.value.hasBeenReady && route.meta.settingsCategory !== 'logs')
const activeView = computed(() => bindings.pages.current.value)
const navigation = computed(() => bindings.pages.navigation.value)
function navigate(id: string) {
  const entry = navigation.value.find(entry => entry.id === id)
  if (entry)
    void bindings.navigation.navigate(entry.location)
}
</script>

<template>
  <div class="desktop-shell">
    <DesktopTitleBar
      :app-info="bindings.appInfo.value"
      :shortcut-bindings="bindings.shortcuts.bindings.value"
      :app-sidebar-collapsed="appSidebarCollapsed"
      :language="language"
      :context-available="bindings.contextPanelGlobal.value || activeView === 'lexora.tasks'"
      :context-open="bindings.resources.isOpen.value"
      @toggle-context="bindings.resources.toggle"
      @toggle-app-sidebar="bindings.toggleAppSidebar"
    />
    <div class="desktop-shell__body">
      <WorkbenchHost :keybindings="bindings.shortcuts.bindings.value" :platform="bindings.shortcuts.platform.value" :active="activeView === 'lexora.tasks'" :controller="bindings.workbench.controller" :copies="bindings.workbench.copies" :language="language" :backup-error="bindings.workbench.backupError.value" @drop-resource="bindings.workbench.dropResource" @retry-backup="bindings.workbench.persistence.flush()">
        <div class="desktop-shell__content" :class="{ 'is-starting': startupVisible }" :inert="startupVisible" :aria-hidden="startupVisible">
          <Transition name="desktop-app-sidebar">
            <DesktopAppSidebar
              v-if="!appSidebarCollapsed"
              :app-info="bindings.appInfo.value"
              :app-version="bindings.appInfo.value?.version ?? null"
              :profile-config="bindings.profileConfig.value"
              :update-profile="bindings.updateProfile"
              :language="language"
              :navigation="navigation"
              :notification-items="bindings.notifications.items.value"
              :notification-loading="bindings.notifications.isLoading.value"
              :notification-unseen-count="bindings.notifications.unseenCount.value"
              @navigate="navigate"
              @mark-all-notifications-seen="bindings.notifications.markAllSeen"
              @open-notification="bindings.navigation.openNotification"
              @refresh-notifications="bindings.notifications.load"
            />
          </Transition>
          <WorkbenchMountPoint target="workbench" class="desktop-shell__workbench">
            <DesktopWorkbenchArea :bindings="bindings" :tasks-visible="activeView === 'lexora.tasks'" />
          </WorkbenchMountPoint>
        </div>
        <template #view="{ view, visible }">
          <DesktopWorkbenchView :view="view" :visible="visible" />
        </template>
      </WorkbenchHost>
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
  background: var(--buddy-surface-canvas);
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
